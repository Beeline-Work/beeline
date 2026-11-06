import { randomUUID } from 'node:crypto';
import { Pool,type QueryResultRow } from 'pg';
import { concurrentWriters } from './test-fixtures/concurrent-writers.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, markSchemaCurrent, PostgresDatabase, REQUIRED_SCHEMA_VERSION, type SqlDatabase } from './database.js';
import { runInstitutionalCuratorCycle } from './institutional-curator.js';
import { retireWelcomeWorkspace } from './welcome-retirement.js';
import { seedWelcomeVideoWorkflow, WELCOME_VIDEO_SLUG } from './welcome-video-workflow.js';
import { deleteSkill } from './institutional-skills.js';
import { createAgentCommand,type CommandRow } from './agent-command.js';
import { saveInstitutionalMemory } from './institutional-memory-shadow.js';
import { completeServiceReview, readServiceReviewPage, reserveServiceReviewWorkspaces } from './service-review.js';
import { reserveAllowance, settleAllowance } from './free-agent-accounting.js';
import { handoff, saveWorkflow, settleWorkflowGate, startWorkflow } from './workflow-runs.js';
import { applySkillRevision } from './institutional-skills.js';
import { advanceCorner, confirmCornerMergeAuthority, createCornerFacts } from './corner-lifecycle.js';
import { sendSystemNotices,systemLine } from './system-line.js';
import { recordFreeAgentGuideStarted, warnFreeAgentOwner } from './free-agent-warning.js';
import {createHash} from 'node:crypto';
import {canonicalUsageAccountSnapshot} from '@beeline/api-contract/helper-usage';
import type {AgentUsage} from '@beeline/api-contract/daemon';
import {publishUsageAccount} from './helper-usage.js';
import {TokenAuth} from './auth.js';
import {PhoneService} from './phone-service.js';
import {DaemonService} from './daemon-service.js';
import {LiveHub} from './live.js';
import {reportAgentFeedback} from './feedback.js';
import {postWalletNotice,walletNoticeId,type WalletNotice} from './wallet-notices.js';
import {ComposioApps} from './composio-apps.js';
import {McpRegistryClient} from './mcp-registry.js';
import {armRegistryConnector,connectApp,disconnectApp,selectRegistryApp} from './app-connections.js';
import { AgentVoiceService } from './agent-voice.js';
import { assignVoiceAgents,savedAuraVoice } from './voice-providers.js';
import { postRepositoryOnboarding } from './repository-onboarding.js';
import {setRoomEventSubscriptions,listAgentSubscriptions,deleteRoomSubscription} from './agent-subscriptions.js';
import {revokeDaemonCredentials} from './daemon-credential-lifetime.js';
import {flushSentryWakes} from './sentry-wake.js';
import {SENTRY_TRIAGE_ROOM} from './sentry-wake-source.js';
import {normalizeLegacyWorkflowRuns,saveUnsavedWorkflowRunStatus} from './migrations/workflow-cleanup.js';
import {createFreeAgentInWorkspace,freeAgentConfigFromEnv,FreeAgentService} from './free-agents.js';
import { DEFAULT_FREE_AGENT_LIMITS } from './free-agent-limits.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Lock replacement regressions require isolated loopback PostgreSQL');

describe.skipIf(!url)('atomic claims replace advisory serialization', () => {
  const name = `lock_replacements_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const isolated = new URL(url ?? 'postgresql://localhost/postgres');
  isolated.pathname = `/${name}`;
  const config = { connectionString: isolated.toString(), options: '-c statement_timeout=8000', max: 1 };
  const first = new PostgresDatabase('', 1, { pool: new Pool(config) });
  const second = new PostgresDatabase('', 1, { pool: new Pool(config) });
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${name}`);
    await migrate(first);
    await first.query(`INSERT INTO workspaces(id,name) VALUES($1,'Atomic claims')`, [workspace]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Shared')`, [room, workspace]);
  }, 60_000);
  afterAll(async () => {
    await first.close();
    await second.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  const overlap=<T>(run:(db:SqlDatabase)=>Promise<T>,claim:string)=>concurrentWriters(first,second,run,claim);

  it('concurrent full event-set replacements keep the last whole set rather than unioning stale snapshots',async()=>{
    const agent=randomUUID().replaceAll('-','').repeat(2);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Subscriber')`,[agent]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[workspace,room,agent]);
    let writer=0;
    await overlap(db=>setRoomEventSubscriptions(db,room,agent,writer++===0?['joined','left']:['schedule-ran']),'FOR UPDATE OF member');
    const subscriptions=await listAgentSubscriptions(first,room,agent);
    expect(subscriptions.subscriptions.map(subscription=>subscription.event)).toEqual(['schedule-ran']);
    const results=await overlap(db=>deleteRoomSubscription(db,room,subscriptions.subscriptions[0]!.id)
      .then(()=>({removed:true}),error=>({error:String(error)})),'FOR UPDATE OF member');
    expect(results).toEqual([{removed:true},{error:expect.stringContaining('subscription not found')}]);
    expect((await listAgentSubscriptions(first,room,agent)).subscriptions).toEqual([]);
  });

  it('two pairing consumers can consume the same exchange only once',async()=>{
    const agent=randomUUID().replaceAll('-','').repeat(2);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Pairing')`,[agent]);
    const verify=async()=>({subject:'unused',login:'unused',name:'Unused'});
    const exchange=await new TokenAuth(first,verify).createDaemonExchange(agent);
    expect(await overlap(db=>db.transaction(tx=>new TokenAuth(tx,verify).consumeDaemonExchangeAgent(exchange.exchangeToken)),
      'DELETE FROM daemon_token_exchanges')).toEqual([agent,null]);
  });

  it.each([true,false])('native daemon consumption and revocation order correctly (mint first: %s)',async mintFirst=>{
    const agent=randomUUID().replaceAll('-','').repeat(2);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Credential')`,[agent]);
    const auth=new TokenAuth(first,async()=>({subject:'unused',login:'unused',name:'Unused'}));
    const exchange=await auth.createDaemonExchange(agent);
    let writer=0;
    const results=await overlap<unknown>(db=>{
      const mint=writer++===0?mintFirst:!mintFirst;
      return mint?new TokenAuth(db,async()=>({subject:'unused',login:'unused',name:'Unused'})).exchangeDaemonToken(exchange.exchangeToken)
        :db.transaction(tx=>revokeDaemonCredentials(tx,agent));
    },'daemon_token_exchanges');
    const minted=results.find(result=>result && typeof result==='object' && 'daemonToken' in result) as {daemonToken:string}|undefined;
    if(mintFirst){expect(minted).toBeDefined();expect(await auth.authenticateDaemon(minted!.daemonToken)).toBeNull();}
    else expect(results[1]).toBeNull();
    expect((await first.query('SELECT token_hash FROM daemon_tokens WHERE agent_id=$1 AND revoked_at IS NULL',[agent])).rowCount).toBe(0);
  });

  it('concurrent Workspace creations reserve one whole funded starter team across the owner account',async()=>{
    const owner=randomUUID().replaceAll('-','').repeat(2),workspaces=[randomUUID(),randomUUID()],rooms=[randomUUID(),randomUUID()];
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Funded owner')`,[owner]);
    for(let index=0;index<2;index++){
      await first.query(`INSERT INTO workspaces(id,name,allow_fix_sweep) VALUES($1,'Funded team',false)`,[workspaces[index]]);
      await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'general')`,[rooms[index],workspaces[index]]);
      await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,[workspaces[index],owner,rooms[index]]);
    }
    const config={...freeAgentConfigFromEnv({BEELINE_FREE_AGENT_SEAL_KEY:'test',FLY_FREE_AGENT_IMAGE:'test'},'https://test.invalid')!,maxPerOwner:2};
    const never=async()=>{throw new Error('Creation must not call Fly or issue a daemon token');};
    const machines={create:never,start:never,stop:never,remove:never,get:never,find:never,list:never};
    let writer=0;
    const results=await overlap(db=>{
      const index=writer++;
      return db.transaction(tx=>new FreeAgentService(tx,config,machines as never,never).createInWorkspace(tx,
        {workspaceId:workspaces[index]!,creatorId:owner,roomId:rooms[index]!,team:true}));
    },'INSERT INTO free_agent_creation_budget(');
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await first.query('SELECT workspace_id,starter_role FROM free_agents WHERE owner_id=$1 ORDER BY starter_role',[owner])).rows)
      .toEqual([{workspace_id:workspaces[0],starter_role:'beebee'},{workspace_id:workspaces[0],starter_role:'luna'}]);
    expect((await first.query('SELECT agents::int FROM free_agent_creation_budget WHERE owner_id=$1',[owner])).rows).toEqual([{agents:2}]);
  });

  it('concurrent Sentry flushers admit one digest through the existing singleton row',async()=>{
    const agent=randomUUID().replaceAll('-','').repeat(2),issue=String(Date.now());
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Triage')`,[agent]);
    await first.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$1)`,[agent]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Triage')`,[SENTRY_TRIAGE_ROOM,workspace]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,[workspace,agent,SENTRY_TRIAGE_ROOM]);
    await first.query(`INSERT INTO sentry_wake_issues(issue_id,event_type,title,level,culprit,permalink,first_seen,last_seen,event_count,delivery_hash,pending)
      VALUES($1,'issue.created','Fixture','error','','https://test.invalid',now(),now(),1,'fixture',true)`,[issue]);
    const results=await overlap(db=>flushSentryWakes(db,agent),'FROM sentry_wake_state WHERE singleton FOR UPDATE');
    expect(results).toEqual([true,false]);
    expect((await first.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2`,[SENTRY_TRIAGE_ROOM,agent])).rowCount).toBe(1);
    expect((await first.query('SELECT pending FROM sentry_wake_issues WHERE issue_id=$1',[issue])).rows).toEqual([{pending:false}]);
  });

  it('concurrent workflow cleanup numbers old attempts and stamps status once',async()=>{
    const author=randomUUID().replaceAll('-','').repeat(2),runId=randomUUID().replaceAll('-','').repeat(2);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Migration writer')`,[author]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES($1,$2,$3,'Legacy step','card','workflow-handoff',$4::jsonb)`,
      [runId,room,author,JSON.stringify({runId,toState:'write',workflowSlug:'missing-legacy-contract'})]);
    await overlap(db=>normalizeLegacyWorkflowRuns(db),'WITH missing AS');
    expect((await first.query(`SELECT card->>'seq' seq FROM messages WHERE id=$1`,[runId])).rows).toEqual([{seq:'0'}]);
    expect(await overlap(db=>db.transaction(tx=>saveUnsavedWorkflowRunStatus(tx)),'UPDATE messages start SET card='))
      .toEqual([1,0]);
    expect((await first.query(`SELECT card->>'runStatus' status FROM messages WHERE id=$1`,[runId])).rows).toEqual([{status:'live'}]);
    await first.query('DELETE FROM messages WHERE id=$1',[runId]);
    await first.query('DELETE FROM identities WHERE id=$1',[author]);
  });

  it('concurrent Luna creation claims one agent without orphan identities, memberships or duplicate greetings',async()=>{
    const owner=randomUUID().replaceAll('-','').repeat(2),target=randomUUID(),general=randomUUID();
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Luna owner')`,[owner]);
    await first.query(`INSERT INTO workspaces(id,name,allow_fix_sweep) VALUES($1,'Luna claim',false)`,[target]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'general')`,[general,target]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,[target,owner,general]);
    const config=freeAgentConfigFromEnv({BEELINE_FREE_AGENT_SEAL_KEY:'test',FLY_FREE_AGENT_IMAGE:'test'},'https://test.invalid')!;
    const before=Number((await first.query('SELECT count(*) count FROM identities')).rows[0]!.count);
    const results=await overlap(db=>db.transaction(tx=>createFreeAgentInWorkspace(tx,config,
      {workspaceId:target,creatorId:owner,roomId:general,name:'Luna',team:true})),
      'INSERT INTO free_agent_creation_budget(');
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await first.query(`SELECT agent_id FROM free_agents WHERE workspace_id=$1 AND starter_role='luna'`,[target])).rows)
      .toEqual([{agent_id:results.find(Boolean)}]);
    expect(Number((await first.query('SELECT count(*) count FROM identities')).rows[0]!.count)).toBe(before+1);
    expect((await first.query(`SELECT id FROM messages WHERE room_id=$1 AND author_id=$2 AND system_event IS NULL`,[general,results.find(Boolean)])).rowCount).toBe(1);
    expect(await first.transaction(tx=>createFreeAgentInWorkspace(tx,config,
      {workspaceId:target,creatorId:owner,roomId:general,name:'Luna',team:true}))).toBeUndefined();
    expect((await first.query(`SELECT identity_id FROM memberships WHERE workspace_id=$1 AND identity_id<>$2`,[target,owner])).rowCount).toBe(2);
  });

  it('concurrent quota publishers keep the newer complete read and return the superseding revision',async()=>{
    const owner=randomUUID().replaceAll('-','').repeat(2),agents=[randomUUID().replaceAll('-','').repeat(2),randomUUID().replaceAll('-','').repeat(2)];
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','One'),($3,'agent','Two')`,[owner,...agents]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)',[...agents,owner]);
    await first.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
      VALUES($1,1,'quota-source','fixture'),($2,1,'quota-source','fixture')`,agents);
    const at=Date.now()/1000-100;
    const report=(key:string,newer:boolean):AgentUsage=>({updatedAt:at+(newer?1:0),
      windows:[{rateLimitType:'five_hour',status:'allowed',utilization:newer?0.75:0.25,updatedAt:at+(newer?1:0)}],
      read:{status:'fresh',at:at+(newer?1:0)},account:{provider:'claude',key}});
    for(const newerFirst of [false,true]){
      let writer=0;
      const key='id:'+randomUUID().replaceAll('-','');
      const results=await overlap(db=>{
        const index=writer++,usage=report(key,index===0?newerFirst:!newerFirst);
        return publishUsageAccount(db,agents[index]!,{ownerId:owner,usage,source:{connectionId:'quota-source',epoch:1},
          revision:createHash('sha256').update(canonicalUsageAccountSnapshot(usage,owner)).digest('hex')});
      },'INSERT INTO usage_accounts(');
      expect(results[0]!.accountId).toBe(results[1]!.accountId);
      if(newerFirst) expect(results[1]).toMatchObject({revision:results[0]!.revision,superseded:true});
      else expect(results[0]!.revision).not.toBe(results[1]!.revision);
      expect((await first.query('SELECT usage FROM usage_accounts WHERE id=$1',[results[0]!.accountId])).rows)
        .toMatchObject([{usage:{windows:[{utilization:0.75}],read:{status:'fresh',at:at+1}}}]);
    }
  });

  it('concurrent automatic handles reserve stable numbers and never reuse or renumber them',async()=>{
    const prefix=randomUUID().replaceAll('-','').slice(0,4),stem='stable'+randomUUID().slice(0,8);
    const ids=[prefix+'0'.repeat(60),prefix+'1'.repeat(60)];
    let writer=0;
    const handles=await overlap(db=>{
      const id=ids[writer++]!;
      return db.transaction(tx=>tx.query<{handle:string}>(`INSERT INTO identities(id,kind,name,handle)
        VALUES($1,'agent',$2,beeline_identity_handle($1,$2)) RETURNING handle`,[id,stem]));
    },'INSERT INTO identities');
    expect(handles.map(result=>result.rows[0]!.handle)).toEqual([stem,stem+'_2']);
    await first.query(`UPDATE identities SET name='Renamed display' WHERE id=ANY($1)`,[ids]);
    await migrate(first);
    expect((await first.query('SELECT handle FROM identities WHERE id=ANY($1) ORDER BY id',[ids])).rows)
      .toEqual([{handle:stem},{handle:stem+'_2'}]);
    await first.query('DELETE FROM identities WHERE id=$1',[ids[1]]);
    await migrate(first);
    const next=randomUUID().replaceAll('-','').repeat(2);
    expect((await first.query(`INSERT INTO identities(id,kind,name,handle)
      VALUES($1,'agent',$2,beeline_identity_handle($1,$2)) RETURNING handle`,[next,stem])).rows)
      .toEqual([{handle:stem+'_3'}]);
    const legacy=randomUUID().replaceAll('-','').repeat(2),base='seed'+randomUUID().slice(0,8);
    await first.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3)`,[legacy,base,base+'_7']);
    await migrate(first);
    expect((await first.query('SELECT beeline_identity_handle($1,$2) handle',[randomUUID().replaceAll('-','').repeat(2),base])).rows)
      .toEqual([{handle:base+'_8'}]);
    expect((await first.query('SELECT handle FROM identities WHERE id=$1',[legacy])).rows).toEqual([{handle:base+'_7'}]);
  });

  it('two concurrent manual handle claims keep the winner without reseating another identity',async()=>{
    const ids=[randomUUID().replaceAll('-','').repeat(2),randomUUID().replaceAll('-','').repeat(2)];
    await first.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','One','old-one'),($2,'human','Two','old-two')`,ids);
    const handle='chosen-'+randomUUID().slice(0,8);
    let writer=0;
    const results=await overlap(db=>{
      const id=ids[writer++]!;
      return new PhoneService(db,'https://beeline.invalid').execute('updatePersonProfile',{handle},id)
        .then(()=>true).catch(error=>error.message);
    },'WITH target AS MATERIALIZED');
    expect(results).toEqual([true,'managed handle is already claimed']);
    expect((await first.query('SELECT handle FROM identities WHERE id=ANY($1) ORDER BY handle',[ids])).rows)
      .toEqual([{handle},{handle:'old-two'}]);
  });

  it('a Google link winning during sign-in issues tokens only for the linked identity',async()=>{
    const owner=randomUUID().replaceAll('-','').repeat(2),subject=randomUUID();
    await first.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','original-identity')`,[owner]);
    const auth=(db:SqlDatabase)=>new TokenAuth(db,async()=>({subject:'unused',login:'unused',name:'Unused'}),()=>new Date(),
      async()=>({subject,name:'Google',audience:'client'}));
    let writer=0;
    const results=await overlap(db=>writer++===0
      ? db.transaction(tx=>auth(tx).linkGoogleOidc(owner,'ticket')).then(()=>owner)
      : auth(db).exchangeGoogleOidc('ticket').then(tokens=>tokens.identityId),'INSERT INTO identity_external_links');
    expect(results).toEqual([owner,owner]);
    expect((await first.query('SELECT id,handle FROM identities WHERE id=$1 OR id=$2',[owner,
      (await import('./auth.js')).tokenHash('google:'+subject)])).rows)
      .toEqual([{id:owner,handle:'original-identity'}]);
  });

  it('concurrent GitHub sign-ins issue sessions for one stable identity',async()=>{
    const subject=randomUUID();
    const sessions=await overlap(db=>new TokenAuth(db,async()=>({subject,login:'Same Name',name:'Person'}))
      .exchangeGitHubOidc('ticket'),'INSERT INTO identities');
    expect(sessions[0]!.identityId).toBe(sessions[1]!.identityId);
    expect((await first.query('SELECT id,handle FROM identities WHERE id=$1',[sessions[0]!.identityId])).rows)
      .toEqual([{id:sessions[0]!.identityId,handle:'samename'}]);
  });

  it('concurrent Google links admit only one identity and concurrent sign-in follows the winning link',async()=>{
    const ids=[randomUUID().replaceAll('-','').repeat(2),randomUUID().replaceAll('-','').repeat(2)];
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','One'),($2,'human','Two')`,ids);
    const subject=randomUUID();
    const auth=(db:SqlDatabase)=>new TokenAuth(db,async()=>({subject:'unused',login:'unused',name:'Unused'}),()=>new Date(),
      async()=>({subject,name:'Google',audience:'client'}));
    let writer=0;
    const results=await overlap(db=>{const id=ids[writer++]!;return db.transaction(tx=>auth(tx).linkGoogleOidc(id,'ticket')).then(()=>true).catch(error=>error.message);},
      'INSERT INTO identity_external_links');
    expect(results).toEqual([true,'Google account already linked to another Beeline account']);
    expect((await auth(second).exchangeGoogleOidc('ticket')).identityId).toBe(ids[0]);
    expect((await first.query(`SELECT identity_id FROM identity_external_links WHERE provider='google' AND subject=$1`,[subject])).rows)
      .toEqual([{identity_id:ids[0]}]);
  });

  it('concurrent explicit Registry choices claim one app and one route receipt',async()=>{
    const owner=randomUUID().replaceAll('-','').repeat(2),helper=randomUUID().replaceAll('-','').repeat(2);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`,[owner,helper]);
    const connector=await armRegistryConnector(first,{workspaceId:workspace,ownerId:owner,machineId:helper,
      helperAgentId:helper,installRoomId:room,installCommandId:null,
      manifest:{name:'app.atomic/explicit',version:'1',remotes:[],packages:[],secretInputNames:[]}});
    const input={workspaceId:workspace,ownerId:owner,appKey:'atomic-explicit',connectorId:connector.id,
      machineId:helper,name:'Atomic',domain:null};
    const results=await overlap(db=>db.transaction(tx=>selectRegistryApp(tx,input)).catch(error=>error.message),
      'WITH selected AS');
    expect(results[1]).toBe('This app already has a connection');
    expect((await first.query('SELECT id FROM workspace_apps WHERE owner_identity_id=$1',[owner])).rows)
      .toEqual([{id:results[0]}]);
    expect((await first.query('SELECT app_id FROM workspace_app_routes WHERE app_id=$1',[results[0]])).rows)
      .toEqual([{app_id:results[0]}]);
  });

  it('provider revocation runs before conditional app disconnection without a held row lock',async()=>{
    const owner=randomUUID().replaceAll('-','').repeat(2),id=randomUUID();
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`,[owner]);
    await first.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route,composio_account_id)
      VALUES($1,$2,$3,'atomic-disconnect','Atomic','composio','composio','old-account')`,[id,workspace,owner]);
    let revoked=false;
    await disconnectApp(first,{ownerId:owner,appId:id,revokeComposio:async account=>{
      expect(account).toBe('old-account');
      // A separate connection can take the row lock while provider revocation is in flight.
      expect((await second.query(`SELECT id FROM workspace_apps WHERE id=$1 AND state='active' FOR UPDATE`,[id])).rows)
        .toEqual([{id}]);
      revoked=true;
    }});
    expect(revoked).toBe(true);
    expect((await first.query('SELECT state FROM workspace_apps WHERE id=$1',[id])).rows).toEqual([{state:'disconnected'}]);
    await first.query(`UPDATE workspace_apps SET state='active',composio_account_id='old-account' WHERE id=$1`,[id]);
    await expect(disconnectApp(first,{ownerId:owner,appId:id,revokeComposio:async()=>{
      await second.query(`UPDATE workspace_apps SET composio_account_id='successor-account' WHERE id=$1`,[id]);
    }})).rejects.toThrow('changed while disconnecting');
    expect((await first.query('SELECT state,composio_account_id FROM workspace_apps WHERE id=$1',[id])).rows)
      .toEqual([{state:'active',composio_account_id:'successor-account'}]);
  });

  it('concurrent app routes keep one row and OAuth wins over an API route',async()=>{
    const owner=randomUUID().replaceAll('-','').repeat(2),helper=randomUUID().replaceAll('-','').repeat(2);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`,[owner,helper]);
    await first.query('INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,$3)',[helper,owner,helper]);
    const params={workspaceId:workspace,ownerId:owner,machineId:helper,helperAgentId:helper,requestedBy:helper,
      app:'atomic-'+randomUUID()+'.example.com',issueLink:false};
    let writer=0;
    const routes=await overlap(db=>{
      const oauth=writer++===1;
      return connectApp(db,{} as McpRegistryClient,{...params,
        composio:{supportsOAuth:async()=>oauth} as ComposioApps});
    },'WITH changed AS (INSERT INTO workspace_apps');
    expect(routes[1]).toMatchObject({transport:'composio'});
    const row=(await first.query<{id:string;transport:string}>('SELECT id,transport FROM workspace_apps WHERE owner_identity_id=$1',[owner])).rows;
    expect(row).toHaveLength(1);
    expect(row[0]!.transport).toBe('composio');
    expect((await first.query('SELECT transport FROM workspace_app_routes WHERE app_id=$1 ORDER BY created_at,id',[row[0]!.id])).rows
      .map(row=>row.transport).sort()).toEqual(['composio','squire-api']);
  });

  it('concurrent Registry admission reuses one generation and refuses a different pinned version',async()=>{
    const owner=randomUUID().replaceAll('-','').repeat(2),helper=randomUUID().replaceAll('-','').repeat(2);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`,[owner,helper]);
    const input={workspaceId:workspace,ownerId:owner,machineId:randomUUID(),helperAgentId:helper,
      installRoomId:room,installCommandId:null,
      manifest:{name:'app.atomic/example',version:'1',remotes:[],packages:[],secretInputNames:[]}};
    const arm=(db:SqlDatabase)=>db.transaction(tx=>armRegistryConnector(tx,input));
    const admitted=await overlap(arm,'INSERT INTO workspace_connectors');
    expect(admitted[0]).toEqual(admitted[1]);
    const id=admitted[0]!.id;
    expect((await first.query('SELECT pairing_generation FROM workspace_connectors WHERE id=$1',[id])).rows)
      .toEqual([{pairing_generation:1}]);
    await first.query(`UPDATE workspace_connectors SET status='error',registry_handoff_attempt='old',registry_squire_relayed_attempt='old' WHERE id=$1`,[id]);
    const rearmed=await overlap(arm,'INSERT INTO workspace_connectors');
    expect(rearmed[0]).toEqual(rearmed[1]);
    expect(rearmed[0]).toMatchObject({id,status:'installing',registry_handoff_attempt:null,registry_squire_relayed_attempt:null});
    expect((await first.query('SELECT pairing_generation FROM workspace_connectors WHERE id=$1',[id])).rows)
      .toEqual([{pairing_generation:2}]);
    const mismatch=await overlap(db=>db.transaction(tx=>armRegistryConnector(tx,{...input,manifest:{...input.manifest,version:'2'}})),
      'INSERT INTO workspace_connectors');
    expect(mismatch.every(row=>row.versionConflict&&row.registry_version==='1')).toBe(true);
    expect((await first.query('SELECT pairing_generation FROM workspace_connectors WHERE id=$1',[id])).rows)
      .toEqual([{pairing_generation:2}]);
  });

  it('concurrent memory saves insert one active fact and its complete provenance',async()=>{
    const owner=randomUUID().replaceAll('-','').repeat(2),agent=randomUUID().replaceAll('-','').repeat(2),source=randomUUID();
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Writer')`,[owner,agent]);
    await first.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,owner]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,[workspace,room,owner,agent]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Deploy writes its marker last.')`,[source,room,owner]);
    const command=(await createAgentCommand(first,{roomId:room,agentId:agent,sourceMessageId:source,reason:'human_tag'}))!;
    const scheduled:unknown[]=[];
    const key='deploy.'+randomUUID();
    const saved=await overlap(db=>db.transaction(tx=>saveInstitutionalMemory(tx,command,{
      memoryKind:'workspace_fact',canonicalKey:key,body:'Deploy writes its marker last.',keywords:['deploy'],
      sourceMessageIds:[source],personAsked:false,confidence:0.95,
    },task=>scheduled.push(task))).catch(error=>error.message),'INSERT INTO institutional_memory_items');
    expect(saved[0]).toMatchObject({version:1,itemId:expect.any(String)});
    expect(saved[1]).toContain(`already has item ${saved[0].itemId} (version 1)`);
    expect((await first.query(`SELECT item_id,message_id FROM institutional_memory_item_sources WHERE item_id=$1`,[saved[0].itemId])).rows)
      .toEqual([{item_id:saved[0].itemId,message_id:source}]);
    expect((await first.query(`SELECT id FROM institutional_memory_items WHERE canonical_key=$1 AND state='active'`,[key])).rows)
      .toEqual([{id:saved[0].itemId}]);
    expect(scheduled).toHaveLength(1);
  });

  it('concurrent identical saved voice preferences succeed and still produce distinct speakers',async()=>{
    const identity=()=>randomUUID().replaceAll('-','').repeat(2);
    const owner=identity(),agents=[identity(),identity()];
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','One'),($3,'agent','Two')`,[owner,...agents]);
    await first.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`,[...agents,owner]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,NULL,$5,'member'),
      ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,[workspace,room,owner,...agents]);
    let writer=0;
    const saved=await overlap(db=>{
      const agent=agents[writer++]!;
      return db.transaction(tx=>new AgentVoiceService(tx,async()=>({voices:['apollo','luna'],synthesize:async function*(){}}))
        .save(workspace,agent,owner,'apollo'));
    },'UPDATE agents agent SET');
    expect(saved.map(profile=>profile.currentVoiceId)).toEqual(['apollo','apollo']);
    const rows=(await first.query<{agent_id:string;chosen_voices:Record<string,string>}>(
      'SELECT agent_id,chosen_voices FROM agents WHERE agent_id=ANY($1::text[])',[agents])).rows;
    expect(rows.map(row=>row.chosen_voices)).toEqual([{'aura-2':'apollo'},{'aura-2':'apollo'}]);
    const speakers=assignVoiceAgents(rows.map(row=>({id:row.agent_id,name:'Speaker',handle:'speaker',soul:'',
      chosenVoice:savedAuraVoice(row.chosen_voices)})),['apollo','luna']);
    expect(new Set(speakers.map(agent=>agent.voice)).size).toBe(2);
  });

  it.each([false,true])('repository cards keep one open winner (different authors: %s)',async(differentAuthors)=>{
    const identity=()=>randomUUID().replaceAll('-','').repeat(2);
    const owner=identity(),agents=[identity(),identity()];
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','One'),($3,'agent','Two')`,[owner,...agents]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,NULL,$5,'member'),
      ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,[workspace,room,owner,...agents]);
    let writer=0;
    const results=await overlap(db=>{
      const agentId=agents[differentAuthors?writer++:0]!;
      return db.transaction(tx=>postRepositoryOnboarding(tx,undefined,{roomId:room,agentId,requesterId:owner,kind:'repository'}))
        .catch(error=>{expect(error.status).toBe(409);return 'superseded' as const;});
    },'INSERT INTO messages(');
    const winner=results[0];
    expect(winner).not.toBe('superseded');
    expect(results[1]).toEqual(differentAuthors?'superseded':winner);
    const rows=(await first.query<{id:string;card:{status:string;defaultName:string}}>(`SELECT id,card FROM messages
      WHERE card_type='repository-onboarding' AND card->>'requesterId'=$1`,[owner])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.card.status).toBe('open');
    await first.query(`UPDATE messages SET card=jsonb_set(card,'{status}','"settled"') WHERE id=$1`,[rows[0]!.id]);
    const next=await postRepositoryOnboarding(first,undefined,{roomId:room,agentId:agents[0]!,requesterId:owner,kind:'repository'});
    expect(next.id).not.toBe(rows[0]!.id);
    expect((await first.query(`SELECT card->>'status' status FROM messages WHERE id=$1`,[rows[0]!.id])).rows)
      .toEqual([{status:'settled'}]);
  });

  it('two workflow seeds leave one complete skill version', async () => {
    await overlap(db => db.transaction(tx => seedWelcomeVideoWorkflow(tx, workspace, room)),
      'WITH saved AS');
    const rows = (await first.query<{ current_version: number; version: number; markdown: string }>(
      `SELECT skill.current_version,version.version,version.markdown FROM workspace_skills skill
       JOIN workspace_skill_versions version ON version.skill_id=skill.id
       WHERE skill.workspace_id=$1 AND skill.slug=$2`, [workspace, WELCOME_VIDEO_SLUG])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ current_version: 1, version: 1 });
    expect(JSON.parse(rows[0]!.markdown).description).toBeTruthy();
  });

  it('two seed refreshes append one current version and preserve the pinned seed',async()=>{
    await first.query(`UPDATE workspace_skill_versions version SET content_hash=repeat('0',64)
      FROM workspace_skills skill WHERE skill.id=version.skill_id AND skill.workspace_id=$1 AND skill.slug=$2`,[workspace,WELCOME_VIDEO_SLUG]);
    await overlap(db=>db.transaction(tx=>seedWelcomeVideoWorkflow(tx,workspace,room)),'WITH saved AS');
    expect((await first.query(`SELECT skill.current_version,version.version FROM workspace_skills skill
      JOIN workspace_skill_versions version ON version.skill_id=skill.id
      WHERE skill.workspace_id=$1 AND skill.slug=$2 ORDER BY version.version`,[workspace,WELCOME_VIDEO_SLUG])).rows)
      .toEqual([{current_version:2,version:1},{current_version:2,version:2}]);
  });

  it('two curator writers complete one weekly cycle', async () => {
    await overlap(db => runInstitutionalCuratorCycle(db, { enabled: true, live: false },
      new Date('2026-11-05T12:00:00Z')), 'INSERT INTO institutional_curator_cycles');
    expect((await first.query(`SELECT id FROM institutional_curator_cycles
      WHERE workspace_id=$1 AND completed_at IS NOT NULL`, [workspace])).rows).toHaveLength(1);
  });

  it('two retirement writers agree on the committed completion detail', async () => {
    const results = await overlap(db => retireWelcomeWorkspace(db, { greeterAgentId: 'absent-greeter' }),
      'INSERT INTO beeline_release_steps');
    expect(results).toEqual([{ status: 'absent' }, { status: 'already-complete', detail: { absent: true } }]);
  });

  it('two skill deletions archive the cited version once and refuse the second deletion', async () => {
    const agent = 'a'.repeat(64), source = 'atomic-skill-deletion';
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Writer')`, [agent]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Delete the welcome workflow')`,
      [source, room, agent]);
    await seedWelcomeVideoWorkflow(first, workspace, room);
    const command = { room_id: room, agent_id: agent, root_source_message_id: source } as CommandRow;
    const results = await overlap(db => deleteSkill(db, command,
      { slug: WELCOME_VIDEO_SLUG, version: 2, sourceMessageIds: [source] })
      .then(() => 'deleted')
      .catch((error: Error) => error.message), 'UPDATE workspace_skills SET');
    expect(results).toEqual(['deleted', `no procedure or workflow is named ${WELCOME_VIDEO_SLUG}`]);
    expect((await first.query(`SELECT state,current_version,revision FROM workspace_skills
      WHERE workspace_id=$1 AND slug=$2`, [workspace, WELCOME_VIDEO_SLUG])).rows)
      .toEqual([{ state: 'archived', current_version: 2, revision: '3' }]);
  });

  it('concurrent service-review reservations claim each workspace once for the run',async()=>{
    const run='reservation-'+randomUUID();
    const results=await overlap(db=>db.transaction(tx=>reserveServiceReviewWorkspaces(tx,'reviewer',run)),
      'INSERT INTO service_review_visits');
    expect(results).toEqual([[workspace],[]]);
    expect((await first.query('SELECT workspace_id FROM service_review_visits WHERE run_id=$1',[run])).rows)
      .toEqual([{workspace_id:workspace}]);
  });

  it('two service-review completions retain the same validated receipt', async () => {
    const agent = 'service-review-agent', run = 'atomic-review';
    await first.query('UPDATE workspaces SET allow_fix_sweep=true WHERE id=$1', [workspace]);
    await reserveServiceReviewWorkspaces(first, agent, run);
    const page = await readServiceReviewPage(first, agent, run, workspace);
    const times = page.rows.map(row => (row.activity as {createdAt?:string}).createdAt)
      .filter((at):at is string => typeof at==='string').map(at => new Date(at).toISOString()).sort();
    const receipts = [{ workspace, rowsRead: page.rows.length,
      firstMessageTime: times[0], lastMessageTime: times.at(-1), findings: 'none' }];
    await overlap(db => db.transaction(tx => completeServiceReview(tx, agent, run, receipts)),
      'WITH targets AS MATERIALIZED');
    expect((await first.query(`SELECT receipt FROM service_review_visits
      WHERE agent_id=$1 AND run_id=$2 AND completed_at IS NOT NULL`, [agent, run])).rows)
      .toEqual([{ receipt: receipts[0] }]);
  });

  it('two handoffs from the same workflow state create one successor and one wake', async () => {
    const agent='a'.repeat(64),source='workflow-cas-source';
    await first.query(`INSERT INTO identities(id,kind,name) VALUES('9999999999999999999999999999999999999999999999999999999999999999','human','CAS owner')`);
    await first.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,'9999999999999999999999999999999999999999999999999999999999999999')`,[agent]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`,[workspace,room,agent]);
    await first.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
      VALUES($1,$2,'presence','presence','{"status":"online"}')`,[room,agent]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Start')`,[source,room,agent]);
    const contract={version:1,name:'atomic-transition',description:'Atomic transition',roles:['writer'],start:'write',handoffs:{
      write:{role:'writer',requires:[],on:{done:'verify'}},verify:{role:'writer',requires:[],on:{done:'done'}},done:{kind:'terminal',status:'done'},
    }};
    await applySkillRevision(first,{workspaceId:workspace,sourceRoomId:room,slug:contract.name,
      description:contract.description,markdown:JSON.stringify(contract),kind:'workflow',sourceMessageIds:[source]},()=>{});
    const command={id:'workflow-cas-command',room_id:room,agent_id:agent,root_source_message_id:source} as CommandRow;
    const start=await startWorkflow(first,command,{name:contract.name,roleBindings:{writer:agent}});
    const results=await overlap(db=>handoff(db,command,{runId:start.runId,outcome:'done',contents:{},attempt:0}),
      'UPDATE messages SET version=version+1');
    expect(results.filter(result=>'alreadyAdvanced' in result)).toHaveLength(1);
    const cards=(await first.query(`SELECT id FROM messages WHERE card_type='workflow-handoff'
      AND card->>'runId'=$1 AND card->>'seq'='1'`,[start.runId])).rows;
    expect(cards).toHaveLength(1);
    expect((await first.query(`SELECT id FROM agent_commands WHERE source_message_id=$1`,[cards[0]!.id])).rows).toHaveLength(1);
  });

  it('two workflow starts insert one live run and dispatch its wake once', async () => {
    const agent='a'.repeat(64),slug='atomic-start';
    const contract={version:1,name:slug,description:'Atomic start',roles:['writer'],start:'write',handoffs:{
      write:{role:'writer',requires:[],on:{done:'done'}},done:{kind:'terminal',status:'done'},
    }};
    await applySkillRevision(first,{workspaceId:workspace,sourceRoomId:room,slug,
      description:contract.description,markdown:JSON.stringify(contract),kind:'workflow',sourceMessageIds:['workflow-cas-source']},()=>{});
    const results=await overlap(db=>startWorkflow(db,{room_id:room,agent_id:agent},
      {name:slug,roleBindings:{writer:agent}}).then(value=>value,error=>({error:String(error)})),'INSERT INTO messages(');
    expect(results[0]).toHaveProperty('runId');
    const run=(results[0] as {runId:string}).runId;
    expect(results[1]).toHaveProperty('error',expect.stringContaining(run));
    expect((await first.query(`SELECT id FROM messages WHERE room_id=$1 AND card->>'workflowSlug'=$2`,[room,slug])).rows).toHaveLength(1);
    expect((await first.query(`SELECT id FROM agent_commands WHERE source_message_id=$1`,[run])).rows).toHaveLength(1);
  });

  it('two notice batches restore both recipients and insert each notice once', async () => {
    const recipients=['1'.repeat(64),'2'.repeat(64)].map((identityId,index)=>({identityId,messageId:'batch-notice-'+index}));
    await first.query(`INSERT INTO identities(id,kind,name) SELECT id,'human','Notice recipient' FROM unnest($1::text[]) id`,[recipients.map(row=>row.identityId)]);
    await overlap(db=>db.transaction(tx=>sendSystemNotices(tx,workspace,recipients,
      {subject:{kind:'system',name:'Workflow'},verb:'finished'})),'INSERT INTO identities');
    expect((await first.query(`SELECT id FROM messages WHERE id=ANY($1::text[])`,[recipients.map(row=>row.messageId)])).rows).toHaveLength(2);
    expect((await first.query(`SELECT identity_id FROM memberships WHERE identity_id=ANY($1::text[]) AND removed_at IS NULL`,[recipients.map(row=>row.identityId)])).rows).toHaveLength(2);
  });

  it('two answers to the same workflow gate settle its choice and successor once', async () => {
    const agent='a'.repeat(64),owner='9'.repeat(64),source='atomic-gate-source',slug='atomic-gate';
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner') ON CONFLICT DO NOTHING`,[workspace,room,owner]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please start the gate')`,[source,room,owner]);
    const contract={version:1,name:slug,description:'Atomic gate',roles:['writer'],start:'choose',handoffs:{
      choose:{kind:'gate',role:'writer',on:{yes:'done',no:'failed'}},done:{kind:'terminal',status:'done'},failed:{kind:'terminal',status:'failed'},
    }};
    await applySkillRevision(first,{workspaceId:workspace,sourceRoomId:room,slug,
      description:contract.description,markdown:JSON.stringify(contract),kind:'workflow',sourceMessageIds:[source]},()=>{});
    const started=await startWorkflow(first,{room_id:room,agent_id:agent,root_source_message_id:source},
      {name:slug,roleBindings:{writer:agent}});
    const choice=(await first.query<{id:string;options:{optionId:string}[]}>(`SELECT id,options FROM room_choices WHERE workflow_run_id=$1`,[started.runId])).rows[0]!;
    const results=await overlap(db=>db.transaction(tx=>settleWorkflowGate(tx,
      {choiceId:choice.id,viewerId:owner,optionId:choice.options[0]!.optionId})).then(value=>({value}),error=>({error:String(error)})),
      'UPDATE messages SET version=version+1');
    expect(results.filter(result=>'value' in result)).toHaveLength(1);
    expect((await first.query(`SELECT status FROM room_choices WHERE id=$1`,[choice.id])).rows).toEqual([{status:'answered'}]);
    expect((await first.query(`SELECT id FROM messages WHERE card->>'runId'=$1 AND card->>'seq'='1'`,[started.runId])).rows).toHaveLength(1);
  });

  it('two corner closures retain one native transition and archive once', async () => {
    const corner=randomUUID();
    await first.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Native corner')`,[corner,workspace,room]);
    await createCornerFacts(first,corner);
    const results=await overlap(db=>advanceCorner(db,corner,{kind:'closed'}),'FOR UPDATE OF fact');
    expect(results.filter(result=>result.archived)).toHaveLength(1);
    expect((await first.query(`SELECT machine->>'state' state FROM corner_facts WHERE corner_id=$1`,[corner])).rows)
      .toEqual([{state:'archived'}]);
    expect((await first.query(`SELECT id FROM messages WHERE room_id=$1 AND card_type='corner-workflow-handoff'`,[corner])).rowCount).toBe(0);
  });

  it('merge authority cannot combine an old repository brief with a newly committed yes',async()=>{
    const corner=randomUUID(),owner=randomUUID().replaceAll('-','').repeat(2),head='f'.repeat(40);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Snapshot owner')`,[owner]);
    await first.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`,[workspace,owner]);
    await first.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Snapshot corner')`,[corner,workspace,room]);
    await createCornerFacts(first,corner);
    await first.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [corner,JSON.stringify({lifecycle:'working',checks:'passing',pr:{number:1,headSha:head}})]);
    await first.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id,approval_basis)
      VALUES($1,1,'Repository work',$2,$3,'{"repositoryWork":true}')`,[corner,owner,room]);
    let changed=false;
    const wrap=(db:SqlDatabase):SqlDatabase=>({
      ...db,transaction:work=>db.transaction(tx=>work(wrap(tx))),
      query:async<Row extends QueryResultRow>(sql:string,values?:unknown[])=>{
        const result=await db.query<Row>(sql,values);
        if(!changed&&sql.includes('FROM corner_brief_revisions brief')){
          changed=true;
          await second.transaction(async tx=>{
            await tx.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id,approval_basis)
              VALUES($1,2,'Local work',$2,$3,'{"repositoryWork":false}')`,[corner,owner,room]);
            await tx.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha)
              VALUES($1,$2,1,$3)`,[corner,owner,head]);
          });
        }
        return result;
      },
    });
    expect(await confirmCornerMergeAuthority(wrap(first),corner,head)).toBe(false);
    expect(changed).toBe(true);
    await expect(confirmCornerMergeAuthority(first,corner,head)).rejects.toThrow('does not assign repository work');
  });

  it('two allowance-warning writers deliver one message and one event pair', async () => {
    const agent='a'.repeat(64),owner='9'.repeat(64),day=new Date().toISOString().slice(0,10);
    await first.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys) VALUES($1,$2,$3,'fixture')`,[agent,workspace,owner]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner') ON CONFLICT DO NOTHING`,[workspace,room,owner]);
    await first.query(`INSERT INTO free_agent_events(agent_id,kind,detail) VALUES($1,'model_usage',$2::jsonb)`,[agent,JSON.stringify({day,tokens:800})]);
    await overlap(db=>db.transaction(tx=>warnFreeAgentOwner(tx,agent,owner,day,1000,room)),'WITH candidate AS');
    expect((await first.query(`SELECT kind FROM free_agent_events WHERE agent_id=$1 AND kind IN ('allowance_warning','nudge_shown') ORDER BY kind`,[agent])).rows)
      .toEqual([{kind:'allowance_warning'},{kind:'nudge_shown'}]);
    expect((await first.query(`SELECT id FROM messages WHERE room_id=$1 AND text LIKE 'I''ve used 80%'`,[room])).rows).toHaveLength(1);
  });

  it('two Add agent commands record one guide start for their warning', async () => {
    await overlap(db=>db.transaction(tx=>recordFreeAgentGuideStarted(tx,'9'.repeat(64),workspace)),'INSERT INTO free_agent_events');
    expect((await first.query(`SELECT id FROM free_agent_events WHERE agent_id=$1 AND kind='guide_started'`,['a'.repeat(64)])).rows).toHaveLength(1);
  });

  it('two procedure saves allocate successive immutable versions with one SQL statement each', async () => {
    let writer=0;
    const result=await overlap(db=>{
      const markdown=['First revision.','Second revision.'][writer++]!;
      return db.transaction(tx=>applySkillRevision(tx,{workspaceId:workspace,sourceRoomId:room,slug:'atomic-procedure',
        description:'Atomic procedure',markdown,kind:'procedure',sourceMessageIds:['workflow-cas-source']},()=>{}));
    },'WITH revised AS');
    expect(result.map(row=>row.version)).toEqual([1,2]);
    expect(result[0]!.skillId).toBe(result[1]!.skillId);
    expect((await first.query(`SELECT version,markdown FROM workspace_skill_versions WHERE skill_id=$1 ORDER BY version`,[result[0]!.skillId])).rows)
      .toEqual([{version:1,markdown:'First revision.'},{version:2,markdown:'Second revision.'}]);
  });

  it.each([false,true])('two new workflow saves preserve creation authority (different body: %s)', async different => {
    const slug=different?'atomic-save-conflict':'atomic-save-same';
    const contract={version:1,name:slug,description:'Original workflow',summary:'Write and finish',roles:['writer'],start:'write',handoffs:{
      write:{does:'Write the work.',role:'writer',requires:[],on:{done:'done',timeout:'done'},timeoutSeconds:86400},
      done:{does:'Finish the work.',kind:'terminal',status:'done'},
    }};
    let writer=0;
    const command={room_id:room,agent_id:'a'.repeat(64),root_source_message_id:'workflow-cas-source'} as CommandRow;
    const results=await overlap(db=>{
      const next=writer++>0&&different?{...contract,description:'Competing workflow'}:contract;
      return saveWorkflow(db,command,{contract:next},()=>{}).then(value=>({value}),error=>({error:String(error)}));
    },'WITH revised AS');
    expect(results[0]).toEqual({value:{slug,version:1}});
    expect(results[1]).toEqual(different?{error:expect.stringContaining('workspace admins only')}:{value:{slug,version:1}});
    expect((await first.query(`SELECT description,current_version FROM workspace_skills WHERE workspace_id=$1 AND slug=$2`,[workspace,slug])).rows)
      .toEqual([{description:'Original workflow',current_version:1}]);
  });

  const prices = { ...DEFAULT_FREE_AGENT_LIMITS, dailyBudgetUsd: 1000,
    inputUsdPerMillion: 1_000_000, outputUsdPerMillion: 1_000_000 };
  it('two owner-budget writers receive 610 then 390 and never exceed either budget', async () => {
    const owner = 'b'.repeat(64), now = new Date('2026-11-11T12:00:00Z');
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Budget owner')`, [owner]);
    const results = await overlap(db => reserveAllowance(db,owner,now,
      { dailyTokenCap:1000,lifetimeTokenCap:1000 },10,600,prices), 'INSERT INTO free_agent_call_rate');
    expect(results).toEqual([
      { reserved:610,maxOutput:600,reservedUsd:610,credit:0 },
      { reserved:390,maxOutput:380,reservedUsd:390,credit:0 },
    ]);
    expect((await first.query(`SELECT tokens::int FROM free_agent_usage WHERE owner_id=$1`, [owner])).rows)
      .toEqual([{ tokens:1000 }]);
    expect((await first.query(`SELECT lifetime_tokens::int FROM free_agent_call_rate WHERE owner_id=$1`, [owner])).rows)
      .toEqual([{ lifetime_tokens:1000 }]);
    expect(Number((await first.query(`SELECT usd FROM free_agent_budget WHERE day=$1`, ['2026-11-11'])).rows[0]!.usd)).toBe(1000);
  });

  it('two owners share the dollar budget and refund the smaller shared grant to its owner', async () => {
    const owners = ['d'.repeat(64),'e'.repeat(64)], now = new Date('2026-11-12T12:00:00Z');
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','First owner'),($2,'human','Second owner')`, owners);
    let writer = 0;
    const results = await overlap(db => reserveAllowance(db,owners[writer++]!,now,
      { dailyTokenCap:1000,lifetimeTokenCap:0 },10,600,prices), 'INSERT INTO free_agent_budget');
    expect(results.map(result => 'reserved' in result ? result.reserved : result.limit)).toEqual([610,390]);
    expect((await first.query(`SELECT lifetime_tokens::int FROM free_agent_call_rate WHERE owner_id=ANY($1::text[]) ORDER BY owner_id`, [owners])).rows)
      .toEqual([{ lifetime_tokens:610 },{ lifetime_tokens:390 }]);
    expect((await first.query(`SELECT tokens::int FROM free_agent_usage WHERE owner_id=ANY($1::text[]) ORDER BY owner_id`, [owners])).rows)
      .toEqual([{ tokens:610 },{ tokens:390 }]);
    expect(Number((await first.query(`SELECT usd FROM free_agent_budget WHERE day=$1`, ['2026-11-12'])).rows[0]!.usd)).toBe(1000);
  });

  it('two settlements reconcile owner, daily and shared counters together', async () => {
    const owner = 'f'.repeat(64), now = new Date('2026-11-13T12:00:00Z'), day = '2026-11-13';
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Settlement owner')`, [owner]);
    await reserveAllowance(first,owner,now,{ dailyTokenCap:1000,lifetimeTokenCap:0 },10,400,prices);
    await reserveAllowance(second,owner,now,{ dailyTokenCap:1000,lifetimeTokenCap:0 },10,400,prices);
    let writer = 0;
    await overlap(db => db.transaction(tx => {
      const spent = [100,200][writer++]!;
      return settleAllowance(tx,owner,owner,day,spent-410,0,spent-410,{ day,tokens:spent,usd:spent });
    }), 'WITH owner AS');
    expect((await first.query(`SELECT lifetime_tokens::int FROM free_agent_call_rate WHERE owner_id=$1`, [owner])).rows)
      .toEqual([{ lifetime_tokens:300 }]);
    expect((await first.query(`SELECT tokens::int FROM free_agent_usage WHERE owner_id=$1`, [owner])).rows)
      .toEqual([{ tokens:300 }]);
    expect(Number((await first.query(`SELECT usd FROM free_agent_budget WHERE day=$1`, [day])).rows[0]!.usd)).toBe(300);
    expect((await first.query(`SELECT 1 FROM free_agent_events WHERE agent_id=$1 AND kind='model_usage'`, [owner])).rowCount).toBe(2);
  });
  it.each([['confirmed',false],['confirmed',true],['failed',false],['failed',true]] as const)(
    'wallet %s verdict survives concurrent attribution (provider first: %s)',async(status,providerFirst)=>{
      const owner=randomUUID().replaceAll('-','').repeat(2),txUrl='https://basescan.org/tx/'+randomUUID();
      await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Wallet owner')`,[owner]);
      const base:WalletNotice={walletNotice:true,status:'pending',operation:'transfer',amountText:'Unknown',
        counterparty:'Unknown',chain:'base',txUrl};
      await postWalletNotice(first,workspace,owner,base);
      const execution:WalletNotice={...base,status:'submitted',execution:true,operation:'swap',
        amountText:'5 USDC → ETH',counterparty:'Execution venue',agentName:'Writer',reason:'Submitting',transfers:{outgoing:'−5 USDC'}};
      const provider:WalletNotice={...base,status,amountText:'+7 ETH',counterparty:'Provider venue',
        reason:'Provider '+status,transfers:{incoming:'+7 ETH'}};
      let writer=0;
      await overlap(db=>postWalletNotice(db,workspace,owner,
        (providerFirst?[provider,execution]:[execution,provider])[writer++]!), 'UPDATE messages SET card=');
      const rows=(await first.query<{card:WalletNotice;text:string;durable_fact:string}>(
        'SELECT card,text,durable_fact FROM messages WHERE id=$1',[walletNoticeId(owner,'base',txUrl)])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.card).toMatchObject({status,execution:true,operation:'swap',amountText:'5 USDC → ETH',
        counterparty:'Execution venue',agentName:'Writer',reason:'Provider '+status,
        transfers:{outgoing:'−5 USDC',incoming:'+7 ETH'}});
      expect(rows[0]!.text).toContain('5 USDC → ETH');
      expect(rows[0]!.text).toContain('Writer');
      expect(rows[0]!.durable_fact).toBe(status==='failed'?'failure':'action');
    });

  it.each([undefined,'read'])('concurrent feedback merges both agents and immediate repeats (tool %s)',async(toolName)=>{
    const identity=()=>randomUUID().replaceAll('-','').repeat(2);
    const owner=identity(),agents=[identity(),identity()],source=randomUUID(),summary='Atomic feedback '+randomUUID();
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','First'),($3,'agent','Second')`,[owner,...agents]);
    await first.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`,[...agents,owner]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Something failed')`,[source,room,owner]);
    const command={room_id:room,source_message_id:source,turn_request_id:'feedback-request'} as CommandRow;
    let writer=0;
    const saved=await overlap(db=>{
      const agent=agents[writer++]!;
      return db.transaction(tx=>reportAgentFeedback(tx,command,agent,{category:'bug',summary,toolName}));
    },'INSERT INTO feedback_items(');
    expect(saved[0]).toEqual({itemId:expect.any(String),duplicate:false});
    expect(saved[1]).toEqual({itemId:saved[0]!.itemId,duplicate:true});
    expect(await reportAgentFeedback(first,command,agents[0]!,{category:'bug',summary,toolName})).toEqual(saved[1]);
    const rows=(await first.query<{reporter_identity_id:string;occurrence_count:number;occurrences:{agentId:string}[]}>(
      'SELECT reporter_identity_id,occurrence_count,occurrences FROM feedback_items WHERE id=$1',[saved[0]!.itemId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reporter_identity_id).toBe(agents[0]);
    expect(rows[0]!.occurrence_count).toBe(3);
    expect(rows[0]!.occurrences.map(occurrence=>occurrence.agentId)).toEqual([agents[1],agents[0]]);
  });

  it('current message and vault readers work after the retired compatibility columns are removed',async()=>{
    const identity=()=>randomUUID().replaceAll('-','').repeat(2);
    const owner=identity(),agent=identity(),message=identity();
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Writer')`,[owner,agent]);
    await first.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,owner]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,[workspace,room,owner,agent]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Contract-safe message')`,[message,room,owner]);
    const restore=new Error('restore fixture schema');
    await expect(first.transaction(async tx=>{
      await tx.query('ALTER TABLE agents DROP COLUMN squire_report; ALTER TABLE messages DROP COLUMN event_woken');
      const phone=new PhoneService(tx,'https://beeline.invalid');
      expect(await phone.readLiveDelta(room,owner,{type:'message',messageId:message}))
        .toMatchObject({type:'message-delta',message:{id:message,text:'Contract-safe message'}});
      await new DaemonService(tx,new LiveHub()).execute('postConnectorVault',{connections:[]},agent);
      expect((await tx.query('SELECT squire_report FROM squire_machines WHERE owner_id=$1 AND machine_id=$2',[owner,agent])).rows)
        .toMatchObject([{squire_report:{status:'connected'}}]);
      throw restore;
    })).rejects.toBe(restore);
  });

  it('concurrent caused events retain both traces without sharing a counter or depth gate',async()=>{
    const identity=()=>randomUUID().replaceAll('-','').repeat(2);
    const owner=identity(),agent=identity(),cause=identity();
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Writer')`,[owner,agent]);
    await first.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,owner]);
    await first.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,[workspace,room,owner,agent]);
    await first.query(`INSERT INTO messages(id,room_id,author_id,text,event_root_cause_id,event_depth,event_woken)
      VALUES($1,$2,$3,'Cause',$1,4,1000)`,[cause,room,owner]);
    const events=await overlap(db=>systemLine(db,{roomId:room,subject:{kind:'person',id:owner,name:'Owner'},
      verb:'joined',kind:'joined',causeId:cause,wakes:[agent]}),'INSERT INTO messages(');
    expect(events.map(event=>event.inserted)).toEqual([true,true]);
    const ids=events.map(event=>event.id);
    expect(new Set(ids).size).toBe(2);
    expect((await first.query(`SELECT event_cause_id,event_root_cause_id,event_depth,event_woken FROM messages
      WHERE id=ANY($1::text[])`,[ids])).rows).toEqual([
      {event_cause_id:cause,event_root_cause_id:cause,event_depth:5,event_woken:null},
      {event_cause_id:cause,event_root_cause_id:cause,event_depth:5,event_woken:null},
    ]);
    expect((await first.query('SELECT source_message_id FROM agent_commands WHERE source_message_id=ANY($1::text[])',[ids])).rowCount).toBe(2);
    expect((await first.query('SELECT event_woken FROM messages WHERE id=$1',[cause])).rows).toEqual([{event_woken:1000}]);
  });

  it('a failed unique index build cannot advance schema readiness or silently skip admission',async()=>{
    await markSchemaCurrent(first);
    await first.query('DROP INDEX feedback_items_open_match_unique');
    await first.query('UPDATE beeline_schema_state SET version=$1',[REQUIRED_SCHEMA_VERSION-1]);
    let attempts=0;
    const unavailable:SqlDatabase={
      query:async <Row extends QueryResultRow>(sql:string,values?:unknown[])=>{
        if(sql.includes('CREATE UNIQUE INDEX CONCURRENTLY feedback_items_open_match_unique')){
          attempts++;
          throw Object.assign(new Error('planted index lock timeout'),{code:'55P03'});
        }
        return first.query<Row>(sql,values);
      },
      transaction:work=>first.transaction(work),
    };
    try {
      await expect((async()=>{await migrate(unavailable);await markSchemaCurrent(unavailable);})())
        .rejects.toMatchObject({code:'55P03'});
      expect(attempts).toBe(1);
      expect((await first.query('SELECT version FROM beeline_schema_state')).rows)
        .toEqual([{version:REQUIRED_SCHEMA_VERSION-1}]);
    } finally { await migrate(first);await markSchemaCurrent(first); }
  },60_000);

});
