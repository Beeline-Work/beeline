import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate, PostgresDatabase } from './database.js';
import { DaemonService } from './daemon-service.js';
import { GitHubOperations } from './github-operations.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Deadlock regressions require isolated loopback PostgreSQL');
const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const offer = '44444444-4444-4444-8444-444444444444';

async function waiting(observer: PoolClient, pid: number, blocker: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const row = (await observer.query<{ blocked: boolean }>(
      'SELECT $2::int=ANY(pg_blocking_pids($1)) blocked', [pid, blocker],
    )).rows[0];
    if (row?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Backend ${pid} never waited for ${blocker}`);
}

// Full migrated triggers matter: mocks/PGlite serialize away these cycles.
// Each writer has its own physical connection; only the test barrier controls
// scheduling. PostgreSQL's deadlock detector remains enabled.
describe.skipIf(!url)('production transaction lock ordering', () => {
  const databaseName = `deadlocks_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const isolatedUrl = new URL(url ?? 'postgresql://localhost/postgres');
  isolatedUrl.pathname = `/${databaseName}`;
  const config = { connectionString: isolatedUrl.toString(), options: '-c statement_timeout=8000', max: 1 };
  const observerPool = new Pool(config);
  const first = new PostgresDatabase('', 1, { pool: new Pool(config) });
  const second = new PostgresDatabase('', 1, { pool: new Pool(config) });
  let observer: PoolClient, firstPid: number, secondPid: number, observerPid: number;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    observer = await observerPool.connect();
    await migrate(first);
    firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    observerPid = (await observer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
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
    await observer?.query('SELECT pg_advisory_unlock_all()');
    await Promise.all([first.close(), second.close()]);
    observer?.release(); await observerPool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  it.each(['pending', 'reconnect'] as const)('vault report and %s connector acceptance both commit without agent-row / authority-lock inversion', async mode => {
    await first.query('DELETE FROM connector_offers');
    await first.query(`UPDATE agents SET squire_report=NULL,squire_work=$2::jsonb WHERE agent_id=$1`,
      [agent, JSON.stringify(mode === 'reconnect' ? { errorMessage: 'Retry sign-in' } : {})]);
    await first.query(`INSERT INTO connector_offers(id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id)
      VALUES($1,$2,$3,$4,$5,'trusty-squire','Proof','machine')`, [offer, agent, workspace, room, owner]);
    if (mode === 'reconnect') await first.query(`UPDATE connector_offers
      SET status='connecting',intent='reconnect',accepted_by=$2,accepted_at=now() WHERE id=$1`, [offer, owner]);
    await observer.query(`CREATE FUNCTION pause_vault_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.squire_report IS DISTINCT FROM OLD.squire_report THEN PERFORM pg_advisory_xact_lock(730001,1); END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER aa_pause_vault_report BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION pause_vault_report();
      SELECT pg_advisory_lock(730001,1);`);
    const daemon = new DaemonService(first, new LiveHub());
    const report = daemon.execute('postConnectorVault', { connections: [],
      ...(mode === 'reconnect' ? { errorMessage: 'Broker unavailable' } : {}) }, agent);
    void report.catch(() => {});
    const results: PromiseSettledResult<unknown>[] = [];
    let acceptance: Promise<unknown> | undefined;
    try {
      await waiting(observer, firstPid, observerPid);
      // acceptConnectorOffer claims the offer (its BEFORE trigger takes the
      // router authority lock) before armConnectorPairing queues agent work.
      acceptance = new PhoneService(second, 'https://beeline.invalid').execute('acceptConnectorOffer', { offerId: offer }, owner);
      void acceptance.catch(() => {});
      await waiting(observer, secondPid, firstPid);
    } finally {
      await observer.query('SELECT pg_advisory_unlock(730001,1)');
      results.push(...await Promise.allSettled([report, ...(acceptance ? [acceptance] : [])]));
      await observer.query('DROP TRIGGER aa_pause_vault_report ON agents; DROP FUNCTION pause_vault_report()');
    }
    for (const result of results) if (result.status === 'rejected') console.error('vault lock cycle', result.reason);
    expect(results).toEqual([{ status: 'fulfilled', value: expect.anything() }, { status: 'fulfilled', value: expect.objectContaining({ status: 'connecting' }) }]);
    expect((await first.query<{ status: string }>(`SELECT squire_report->>'status' status FROM agents WHERE agent_id=$1`, [agent])).rows[0]?.status).toBe(mode === 'reconnect' ? 'error' : 'connected');
    expect((await first.query<{ install: string }>(`SELECT squire_work->>'install' install FROM agents WHERE agent_id=$1`, [agent])).rows[0]?.install).toBe('true');
  });

  it('merged webhook and merge reconciliation commit one repository note without message-id / journal inversion', async () => {
    await first.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`, [corner, workspace, room, agent]);
    await first.query('INSERT INTO corner_facts(corner_id) VALUES($1)', [corner]);
    await first.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [corner, JSON.stringify({
      pr: { number: 1, headSha: '1'.repeat(40), url: 'https://github.com/owner/widgets/pull/1' },
    })]);
    await observer.query(`CREATE FUNCTION pause_repository_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.card_type='github-event' THEN PERFORM pg_advisory_xact_lock(730001,2); END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER aa_pause_repository_note AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION pause_repository_note();
      SELECT pg_advisory_lock(730001,2);`);
    const app = {} as GitHubAppClient;
    const webhook = new GitHubOperations(first, {} as GitHubOAuthClient, app, 'secret');
    const reconciliation = new GitHubOperations(second, {} as GitHubOAuthClient, app, 'secret');
    vi.spyOn(reconciliation, 'deleteCornerBranch').mockResolvedValue(undefined);
    const pullRequest = { repository: 'owner/widgets', branch: 'feature/proof', title: 'Proof',
      url: 'https://github.com/owner/widgets/pull/1', number: 1, targetBranch: 'main',
      headSha: '1'.repeat(40), mergedBy: 'owner', commits: 1, files: 1 };
    const delivery = webhook['processRepositoryEvent']('pull_request', {
      action: 'closed', repository: { full_name: pullRequest.repository }, sender: { login: 'owner' },
      pull_request: { merged: true, title: pullRequest.title, html_url: pullRequest.url,
        head: { ref: pullRequest.branch }, base: { ref: 'main' } },
    }, 77);
    void delivery.catch(() => {});
    let merged: Promise<unknown> | undefined;
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await waiting(observer, firstPid, observerPid);
      merged = reconciliation['mergeCorner']({ corner_id: corner, parent_id: room, author_id: agent,
        corner_name: 'Corner', summary: '', repository_id: '101', installation_id: '77' }, pullRequest);
      void merged.catch(() => {});
      await waiting(observer, secondPid, firstPid);
    } finally {
      await observer.query('SELECT pg_advisory_unlock(730001,2)');
      results = await Promise.allSettled([delivery, ...(merged ? [merged] : [])]);
      await observer.query('DROP TRIGGER aa_pause_repository_note ON messages; DROP FUNCTION pause_repository_note()');
    }
    for (const result of results) if (result.status === 'rejected') console.error('GitHub lock cycle', result.reason);
    expect(results).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
    expect((await first.query(`SELECT count(*)::int count FROM messages WHERE card_type='github-event'`)).rows).toEqual([{ count: 1 }]);
    expect((await first.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [corner])).rows[0]?.archived).toBe(true);
    await first.query(`DELETE FROM messages WHERE card_type='github-event'`);
    await reconciliation['mergeCorner']({ corner_id: corner, parent_id: room, author_id: agent,
      corner_name: 'Corner', summary: '', repository_id: '101', installation_id: '77' }, pullRequest);
    expect((await first.query(`SELECT count(*)::int count FROM messages WHERE card_type='github-event'`)).rows).toEqual([{ count: 1 }]);
  });
});
