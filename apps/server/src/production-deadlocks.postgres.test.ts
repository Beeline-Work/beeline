import { subscribeConfiguredReviewers } from './agent-subscriptions.js';
import { seedSquireMachine } from './test-fixtures/squire-machines.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate, PostgresDatabase } from './database.js';
import { DaemonService } from './daemon-service.js';
import { GitHubOperations } from './github-operations.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { LiveHub } from './live.js';
import {concurrentWriters} from './test-fixtures/concurrent-writers.js';
import {reconcileConfiguredCornerReviewers} from './agent-command.js';
import {postgresErrorContext} from './postgres-error.js';
import {announceAgentLifecycle,claimAgentConnection,releaseAgentConnection} from './connection-presence.js';
import { PhoneService } from './phone-service.js';
import { refreshCornerAttention } from './corner-attention.js';
import { ensureSystemIdentity } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Deadlock regressions require isolated loopback PostgreSQL');
const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const offer = '44444444-4444-4444-8444-444444444444';

// Full migrated triggers matter: mocks/PGlite serialize away these cycles.
// Each writer has its own physical connection; only the test barrier controls
// scheduling. PostgreSQL's deadlock detector remains enabled.
describe.skipIf(!url)('production transaction lock ordering', () => {
  const databaseName = `deadlocks_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const isolatedUrl = new URL(url ?? 'postgresql://localhost/postgres');
  isolatedUrl.pathname = `/${databaseName}`;
  const config = { connectionString: isolatedUrl.toString(), options: '-c statement_timeout=8000', max: 1 };
  const first = new PostgresDatabase('', 1, { pool: new Pool(config) });
  const second = new PostgresDatabase('', 1, { pool: new Pool(config) });
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    await migrate(first);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`, [owner, agent]);
    await first.query(`INSERT INTO workspaces(id,name) VALUES($1,'Deadlock proof')`, [workspace]);
    await first.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'machine')`, [agent, owner]);
    await first.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
      VALUES(77,$1,'42','owner','User','selected','active')`, [owner]);
    await first.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(101,77,'owner/widgets','main')`);
    await first.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,github_installation_id)
      VALUES($1,$2,$3,'Room','owner/widgets',77)`, [room, workspace, owner]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, owner, agent, room]);
  }, 60_000);
  afterAll(async () => {
    await Promise.all([first.close(), second.close()]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  it('concurrent connections keep monotonic epochs and stale releases cannot erase the latest presence',async()=>{
    await first.query(`INSERT INTO live_server_instances(instance_id) VALUES('connection-proof') ON CONFLICT DO NOTHING`);
    let sequence=0;
    const epochs=await concurrentWriters(first,second,db=>claimAgentConnection(db,new LiveHub(),agent,
      {lifecycleId:'live-'+sequence},{connectionId:'connection-'+sequence++,instanceId:'connection-proof'}),
      'INSERT INTO agent_connections(');
    expect(epochs[1]).toBe(epochs[0]!+1);
    const results=await Promise.all([
      releaseAgentConnection(first,new LiveHub(),agent,'connection-0'),
      announceAgentLifecycle(second,new LiveHub(),room,agent,{releaseVersion:'new-release'}),
    ]);
    expect(results[0]).toBe(false);
    expect((await first.query(`SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,[agent])).rows)
      .toMatchObject([{body:{held:true,connectionId:'connection-1',releaseVersion:'new-release',status:'online'}}]);
  });

  it('concurrent first presence announcements in different Rooms choose one persistent row',async()=>{
    const otherRoom=randomUUID(),newAgent=randomUUID().replaceAll('-','').repeat(2);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Presence')`,[newAgent]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[newAgent,owner]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other presence')`,[otherRoom,workspace]);
    let sequence=0;
    await concurrentWriters(first,second,db=>announceAgentLifecycle(db,new LiveHub(),sequence++===0?room:otherRoom,newAgent,
      {releaseVersion:'fixture'}),'INSERT INTO live_outputs(');
    const rows=await first.query<{body:{observedAt:number}}>(`SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,[newAgent]);
    expect(rows.rowCount).toBe(1);expect(rows.rows[0]!.body.observedAt).toBeGreaterThan(0);
    await first.query('DELETE FROM live_outputs WHERE agent_id=$1',[newAgent]);
    await first.query('DELETE FROM agents WHERE agent_id=$1',[newAgent]);
    await first.query('DELETE FROM identities WHERE id=$1',[newAgent]);
    await first.query('DELETE FROM rooms WHERE id=$1',[otherRoom]);
  });

  it.each([true,false])('Sentry 3Z: access and view replacement have no lock inversion (planted old view=%s)',async oldView=>{
    const command=randomUUID(),message=randomUUID();
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Access ordering proof')`,[message,room,owner]);
    await first.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
      root_command_id,root_source_message_id,agent_depth,state)
      VALUES($1,$2,$3,$4,$1,'input','human_tag',$1,$4,0,'pending')`,[command,room,agent,message]);
    let announceReader!:()=>void,announceView!:()=>void;
    const readerHeld=new Promise<void>(resolve=>{announceReader=resolve;});
    const viewHeld=new Promise<void>(resolve=>{announceView=resolve;});
    const reading=first.transaction(async db=>{
      await db.query(`UPDATE agent_commands SET cancellation_reason='access-proof' WHERE id=$1`,[command]);
      announceReader(); await viewHeld;
      if(oldView) await db.query('SELECT 1 FROM room_access WHERE room_id=$1 AND identity_id=$2',[room,agent]);
      else {
        const service=new DaemonService(db,new LiveHub()) as unknown as {access(room:string,agent:string):Promise<{isCorner:boolean}>};
        expect(await service.access(room,agent)).toMatchObject({isCorner:false});
      }
    });
    const replacement=readerHeld.then(()=>second.transaction(async db=>{
      await db.query('ALTER VIEW room_access SET (security_barrier=true)');
      announceView();
      await db.query(`UPDATE agent_commands SET cancellation_reason='replacement-proof' WHERE id=$1`,[command]);
    }));
    const results=await Promise.allSettled([reading,replacement]);
    if(oldView){
      const failure=results.find(result=>result.status==='rejected');
      expect(failure).toMatchObject({status:'rejected',reason:{code:'40P01'}});
      if(failure?.status==='rejected') expect(postgresErrorContext(failure.reason)).toMatchObject({
        code:'40P01',detail:expect.stringContaining('Process'),statement_fingerprint:expect.stringMatching(/^[a-f0-9]{16}$/)});
    } else expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
    await first.query('ALTER VIEW room_access RESET(security_barrier)');
    await first.query('DELETE FROM agent_commands WHERE id=$1',[command]);
    await first.query('DELETE FROM messages WHERE id=$1',[message]);
  });

  it('Sentry 40: reviewer reconciliation is one native subscription batch and does not lock the access view',async()=>{
    const otherRoom=randomUUID(),overridden=randomUUID(),ids=[room,otherRoom,overridden];
    await first.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1',[room,agent]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name,reviewer_agent_id,parent_id)
      VALUES($1,$3,'Second parent',$4,NULL),($2,$3,'Override',NULL,$5)`,[otherRoom,overridden,workspace,agent,room]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[workspace,otherRoom,agent]);
    await first.query(`INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)`,[overridden,agent]);
    await first.query(`DELETE FROM agent_subscriptions WHERE room_id=ANY($1::uuid[]) AND event='check-passed'`,[ids]);
    const results=await concurrentWriters(first,second,db=>db.transaction(tx=>reconcileConfiguredCornerReviewers(tx)),
      'WITH configured AS MATERIALIZED');
    expect(results).toEqual([{subscriptions:2,commands:0},{subscriptions:0,commands:0}]);
    expect((await first.query(`SELECT room_id FROM agent_subscriptions WHERE room_id=ANY($1::uuid[]) AND event='check-passed'`,[ids])).rows
      .map(row=>row.room_id).sort()).toEqual([...ids].sort());
    await first.query(`DELETE FROM agent_subscriptions WHERE room_id=ANY($1::uuid[]) AND event='check-passed'`,[ids]);
    await first.transaction(async db=>{
      await db.query('ALTER VIEW room_access SET (security_barrier=true)');
      expect((await subscribeConfiguredReviewers(second,[null])).rowCount).toBe(2);
    });
    await first.query('ALTER VIEW room_access RESET(security_barrier)');
    await first.query(`DELETE FROM agent_subscriptions WHERE room_id=ANY($1::uuid[]) AND event='check-passed'`,[ids]);
    await first.query('DELETE FROM rooms WHERE id=ANY($1::uuid[])',[[otherRoom,overridden]]);
    await first.query('UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1',[room]);
  });

  it.each(['pending', 'reconnect'] as const)('vault report and %s connector acceptance both commit without agent-row / authority-lock inversion', async mode => {
    await first.query('DELETE FROM connector_offers');
    await seedSquireMachine(first, agent, { squire_report: null, squire_work: mode === 'reconnect' ? { errorMessage: 'Retry sign-in' } : {} });
    await first.query(`INSERT INTO connector_offers(id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id)
      VALUES($1,$2,$3,$4,$5,'trusty-squire','Proof','machine')`, [offer, agent, workspace, room, owner]);
    if (mode === 'reconnect') await first.query(`UPDATE connector_offers
      SET status='connecting',intent='reconnect',accepted_by=$2,accepted_at=now() WHERE id=$1`, [offer, owner]);
    let writer=0;
    const results=await concurrentWriters<unknown>(first,second,db=>writer++===0
      ? new DaemonService(db,new LiveHub()).execute('postConnectorVault',{connections:[],
          ...(mode==='reconnect'?{errorMessage:'Broker unavailable'}:{})},agent)
      : new PhoneService(db,'https://beeline.invalid').execute('acceptConnectorOffer',{offerId:offer},owner),
      'UPDATE squire_machines');
    expect(results).toEqual([expect.anything(),expect.objectContaining({status:'connecting'})]);
    expect((await first.query<{ status: string }>(`SELECT squire_report->>'status' status FROM squire_machines WHERE (owner_id,machine_id)=(SELECT owner_id,COALESCE(machine_id,agent_id) FROM agents WHERE agent_id=$1)`, [agent])).rows[0]?.status).toBe(mode === 'reconnect' ? 'error' : 'connected');
    expect((await first.query<{ install: string }>(`SELECT squire_work->>'install' install FROM squire_machines WHERE (owner_id,machine_id)=(SELECT owner_id,COALESCE(machine_id,agent_id) FROM agents WHERE agent_id=$1)`, [agent])).rows[0]?.install).toBe('true');
  });

  it.each(['refresh', 'open'] as const)('SERVER-49/4A/45: %s does not update the shared System identity', async path => {
    let id = randomUUID();
    const daemon = new HelperDaemonService(first, new LiveHub());
    const phone = new PhoneService(first, 'https://beeline.invalid');
    const messageId = randomUUID().replaceAll('-', '').repeat(2);
    if (path === 'refresh') {
      await first.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Independent corner')`, [id, workspace, room, agent]);
      await first.query('INSERT INTO corner_facts(corner_id) VALUES($1)', [id]);
    } else {
      await first.query(`UPDATE identities SET handle='lockhelper' WHERE id=$1`, [agent]);
      await phone.execute('sendRoomMessage', { roomId: room, messageId, text: '@lockhelper open this corner' }, owner);
    }
    const command = path === 'open'
      ? (await daemon.execute('getAgentCommands', { roomId: room }, agent)).commands.find(command => command.sourceMessageId === messageId)
      : undefined;
    if (command) await daemon.execute('claimAgentCommand', { roomId: room, commandId: command.id, generationId: 'lock-proof' }, agent);
    await ensureSystemIdentity(first);
    await observer.query('BEGIN');
    await observer.query('SELECT id FROM identities WHERE id=$1 FOR NO KEY UPDATE', [SYSTEM_IDENTITY_ID]);
    try {
      await first.query("SET lock_timeout='500ms'");
      if (path === 'refresh') expect(await refreshCornerAttention(first, id)).toEqual({ parentId: room });
      else {
        expect(command).toBeDefined();
        id = (await daemon.execute('createCorner', { roomId: room, requestId: command!.turnRequestId,
          generationId: 'lock-proof', name: 'Independent-corner', objective: 'Prove independent corner opening',
          brief: { spec: 'Prove independent corner opening', approval: { sourceMessageId: messageId } } }, agent)).cornerId;
      }
      const visible = (await phone.readCorners(room, owner))?.corners.find(item => item.corner.id === id);
      expect(visible?.state).toBe(path === 'open' ? 'working' : 'idle');
    } finally {
      await observer.query('ROLLBACK');
      await first.query('RESET lock_timeout');
    }
  });

  it('SERVER-1W: mergeability and check webhooks commit without cache-row / lifecycle inversion', async () => {
    const id = randomUUID(), head = '2'.repeat(40);
    await first.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Webhook corner')`, [id, workspace, room, agent]);
    await first.query('INSERT INTO corner_facts(corner_id) VALUES($1)', [id]);
    await first.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [id, JSON.stringify({
      lifecycle: 'in-review', checks: 'pending', pr: { number: 2, headSha: head, targetBranch: 'main', mergeability: 'unknown', url: 'https://github.com/owner/widgets/pull/2' },
    })]);
    const pr = { number: 2, headSha: head, state: 'open', merged: false, mergeability: 'dirty',
      url: 'https://github.com/owner/widgets/pull/2', baseRef: 'main' } as const;
    const app = { installationToken: vi.fn().mockResolvedValue({ token: 'fixture' }), readPullRequest: vi.fn().mockResolvedValue(pr) } as unknown as GitHubAppClient;
    const mergeability = new GitHubOperations(first, {} as GitHubOAuthClient, app, 'secret');
    const checks = new GitHubOperations(second, {} as GitHubOAuthClient, app, 'secret');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await observer.query(`CREATE FUNCTION pause_mergeability() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.lifecycle->'pr'->>'mergeability'='dirty' THEN PERFORM pg_advisory_xact_lock(730001,3); END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER aa_pause_mergeability BEFORE UPDATE ON corner_github_cache FOR EACH ROW EXECUTE FUNCTION pause_mergeability();
      SELECT pg_advisory_lock(730001,3);`);
    const refresh = mergeability.refreshStaleMergeability(id);
    let check: Promise<unknown> | undefined;
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await waiting(observer, firstPid, observerPid);
      check = checks.refreshCheckRollup({ corner_id: id, parent_id: room, author_id: agent, corner_name: 'Webhook corner',
        summary: '', repository_id: '101', installation_id: '77', has_pr: true, pr_number: '2' }, 'owner/widgets',
        { name: 'Tests', status: 'pending', headSha: head }, second, { snapshot: { token: 'fixture', pr,
          fetchStartedAt: Date.now() / 1000, rollup: { state: 'pending', total: 1, failing: [], checks: [{ name: 'Tests', status: 'pending' }] } } });
      void check.catch(() => {});
      await waiting(observer, secondPid, firstPid);
    } finally {
      await observer.query('SELECT pg_advisory_unlock(730001,3)');
      results = await Promise.allSettled([refresh, ...(check ? [check] : [])]);
      await observer.query('DROP TRIGGER aa_pause_mergeability ON corner_github_cache; DROP FUNCTION pause_mergeability()');
    }
    const logged = [...errors.mock.calls];
    errors.mockRestore();
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(logged).toEqual([]);
    const lifecycle = await checks.lifecycle(id);
    expect(lifecycle.pr?.mergeability).toBe('dirty');
    expect(lifecycle.checksSummary?.total).toBe(1);
  });

  it('merged webhook and merge reconciliation commit one repository note without message-id / journal inversion', async () => {
    await first.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`, [corner, workspace, room, agent]);
    await first.query('INSERT INTO corner_facts(corner_id) VALUES($1)', [corner]);
    await first.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [corner, JSON.stringify({
      pr: { number: 1, headSha: '1'.repeat(40), url: 'https://github.com/owner/widgets/pull/1' },
    })]);
    const app = {} as GitHubAppClient;
    const reconciliation = new GitHubOperations(second, {} as GitHubOAuthClient, app, 'secret');
    vi.spyOn(reconciliation, 'deleteCornerBranch').mockResolvedValue(undefined);
    const pullRequest = { repository: 'owner/widgets', branch: 'feature/proof', title: 'Proof',
      url: 'https://github.com/owner/widgets/pull/1', number: 1, targetBranch: 'main',
      headSha: '1'.repeat(40), mergedBy: 'owner', commits: 1, files: 1 };
    let writer=0;
    const results=await concurrentWriters(first,second,db=>{
      const operations=new GitHubOperations(db,{} as GitHubOAuthClient,app,'secret');
      vi.spyOn(operations,'deleteCornerBranch').mockResolvedValue(undefined);
      return writer++===0 ? operations['processRepositoryEvent']('pull_request',{
        action:'closed',repository:{full_name:pullRequest.repository},sender:{login:'owner'},
        pull_request:{merged:true,title:pullRequest.title,html_url:pullRequest.url,
          head:{ref:pullRequest.branch},base:{ref:'main'}},
      },77) : operations['mergeCorner']({corner_id:corner,parent_id:room,author_id:agent,
        corner_name:'Corner',summary:'',repository_id:'101',installation_id:'77'},pullRequest);
    },'INSERT INTO messages(');
    expect(results).toEqual([undefined,undefined]);
    expect((await first.query(`SELECT count(*)::int count FROM messages WHERE card_type='github-event'`)).rows).toEqual([{ count: 1 }]);
    expect((await first.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [corner])).rows[0]?.archived).toBe(true);
    await first.query(`DELETE FROM messages WHERE card_type='github-event'`);
    await reconciliation['mergeCorner']({ corner_id: corner, parent_id: room, author_id: agent,
      corner_name: 'Corner', summary: '', repository_id: '101', installation_id: '77' }, pullRequest);
    expect((await first.query(`SELECT count(*)::int count FROM messages WHERE card_type='github-event'`)).rows).toEqual([{ count: 1 }]);
  });
});
