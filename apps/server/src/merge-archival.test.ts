import { randomUUID } from 'node:crypto';
import { Pool, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { GitHubOperations } from './github-operations.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';

const H = 'a'.repeat(64), A = 'b'.repeat(64), B = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const postgresUrl = process.env.BEELINE_MERGE_TEST_POSTGRES_URL;
if (postgresUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('Merge archival proof requires isolated loopback PostgreSQL');
let db: SqlDatabase, close: () => Promise<void>;
let requestId: string;
const app = {
  deleteBranch: vi.fn(async () => undefined),
  installationToken: vi.fn(async () => ({ token: 'github-test-token' })),
  branchDeletionSafety: vi.fn(async () => ({ defaultBranch: 'main', aheadBy: 0, protected: false, openBasePullRequest: false })),
  openPullRequestsForBranch: vi.fn(async () => []),
};
const event = {
  action: 'closed', installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' },
  pull_request: { number: 1, title: 'Fix archival', html_url: 'https://github.com/owner/widgets/pull/1',
    head: { ref: 'feature/archival', sha: '1'.repeat(40) }, base: { ref: 'main' },
    merged: true, merged_at: '2026-10-19T18:33:00Z', merge_commit_sha: 'f'.repeat(40) },
};

beforeEach(async () => {
  vi.clearAllMocks();
  if (postgresUrl) {
    const schema = `merge_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const postgres = new PostgresDatabase('', 5, { mode: 'migration', pool: new Pool({
      connectionString: postgresUrl, options: `-c search_path=${schema},public`,
    }) });
    db = postgres;
    close = async () => {
      await postgres.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    };
  } else {
    const pglite = new PgliteDatabase();
    db = pglite;
    close = () => pglite.close();
  }
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle)
    VALUES($1,'human','Owner','owner'),($2,'agent','Author','author'),($3,'agent','Peer','peer')`, [H,A,B]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [A,B,H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Archival proof')`, [W]);
  await db.query(`INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')`, [W]);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
    VALUES(77,$1,'42','owner','User','selected','active')`, [H]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
    VALUES(101,77,'owner/widgets','main')`);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_remote,github_installation_id)
    VALUES($1,$2,$3,'Parent','https://github.com/owner/widgets.git',77)`, [R,W,H]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`, [C,W,R,H]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member'),($1,$2,$4,'member'),($1,$2,$5,'owner')`, [W,R,A,B,H]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role)
    VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'owner')`, [W,A,B,H]);
  await db.query(`INSERT INTO corner_facts(corner_id,objective,owner_agent_id,feature_branch,lifecycle)
    VALUES($1,'Fix archival',$2,'feature/archival',$3::jsonb)`, [C,A,JSON.stringify({
      checks: 'passing', pr: { number: 1, headSha: '1'.repeat(40), url: event.pull_request.html_url },
    })]);
  const command = await createAgentCommand(db, { roomId: C, agentId: A, sourceMessageId: null, reason: 'system' });
  requestId = command!.turn_request_id;
  await db.transaction(tx => claimAgentCommand(tx, C, A, command!.id, 'generation'));
});
afterEach(async () => { await close?.(); });

function operations(database = db) {
  return new GitHubOperations(database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
}

async function assertArchived(stoppedAgent = A, merged = true) {
  expect((await db.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL`, [C])).rowCount).toBe(1);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND action='stop' AND agent_id=$2`, [C,stoppedAgent])).rowCount).toBe(1);
  expect((await db.query(`SELECT agent_id,turn_request_id FROM agent_commands
    WHERE room_id=$1 AND action='stop' GROUP BY agent_id,turn_request_id HAVING count(*)>1`, [C])).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND action IN ('input','resume') AND state IN ('pending','claimed')`, [C])).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND status='working'`, [C])).rowCount).toBe(0);
  if (!merged) return;
  expect((await db.query(`SELECT lifecycle->>'outcome' outcome FROM corner_facts WHERE corner_id=$1`, [C])).rows)
    .toEqual([{ outcome: 'landed' }]);
  expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card->>'type'='corner-complete'`, [R])).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'kind'='merged'`, [C])).rowCount).toBe(1);
  expect((await db.query(`SELECT 1 FROM institutional_memory_outcomes WHERE room_id=$1 AND kind='merged'`, [C])).rowCount).toBe(1);
}

it('Reproduction MERGE-DEADLOCK-1: rolls back a deadlocked archival and commits cleanup once', async () => {
  let attempts = 0;
  const retryDatabase: SqlDatabase = {
    query: db.query.bind(db),
    transaction: work => db.transaction(async tx => {
      const result = await work(tx);
      // Fail after all writes: the retry must reconstruct the entire transaction.
      const archived = await tx.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL`, [C]);
      if (archived.rowCount && ++attempts === 1)
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return result;
    }),
  };
  await operations(retryDatabase).processWebhook('pull_request', event);
  expect(attempts).toBe(2);
  await assertArchived();
  expect(app.branchDeletionSafety).toHaveBeenCalledTimes(1);
  expect((await db.query(`SELECT attempts,finished_at,last_error FROM corner_branch_deletions WHERE corner_id=$1`, [C])).rows[0])
    .toMatchObject({ attempts: 1, finished_at: expect.anything(), last_error: null });
  expect(app.deleteBranch).toHaveBeenCalledTimes(1);
  await operations().processWebhook('pull_request', event);
  await assertArchived();
  expect(app.deleteBranch).toHaveBeenCalledTimes(1);
});

it.each([['40P01', 3], ['XX000', 1]] as const)('bounds archival retries for %s', async (code, expectedAttempts) => {
  let attempts = 0;
  const error = Object.assign(new Error('forced transaction failure'), { code });
  const failing: SqlDatabase = {
    query: db.query.bind(db),
    transaction: work => db.transaction(async tx => {
      const result = await work(tx);
      const archived = await tx.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL`, [C]);
      if (archived.rowCount) { attempts++; throw error; }
      return result;
    }),
  };
  await expect(operations(failing).processWebhook('pull_request', event)).rejects.toBe(error);
  expect(attempts).toBe(expectedAttempts);
  expect((await db.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NULL`, [C])).rowCount).toBe(1);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND action='stop'`, [C])).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM messages WHERE card->>'type'='corner-complete'`)).rowCount).toBe(0);
  expect(app.deleteBranch).not.toHaveBeenCalled();
  expect((await db.query(`SELECT 1 FROM corner_branch_deletions WHERE corner_id=$1`, [C])).rowCount).toBe(0);
});

it.skipIf(!postgresUrl).each(['merge webhook', 'agent close', 'phone close'] as const)(
  'Reproduction MERGE-DEADLOCK-1: tagged final reply and %s both commit', async path => {
  if (path !== 'merge webhook') await db.query(`UPDATE corner_facts SET lifecycle=lifecycle-'pr' WHERE corner_id=$1`, [C]);
  await createAgentCommand(db, { roomId: C, agentId: B, sourceMessageId: null, reason: 'system' });
  let releaseReply!: () => void, replyLocked!: () => void, cancellationStarted!: () => void;
  const resume = new Promise<void>(resolve => { releaseReply = resolve; });
  const locked = new Promise<void>(resolve => { replyLocked = resolve; });
  const cancelling = new Promise<void>(resolve => { cancellationStarted = resolve; });
  let paused = false;
  const sqlErrors: string[] = [];
  const wrap = (tx: SqlDatabase): SqlDatabase => ({
    query: async <Row extends QueryResultRow>(sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT * FROM agent_commands') && sql.includes('ORDER BY created_at DESC,id DESC FOR UPDATE'))
        cancellationStarted();
      const result = await tx.query<Row>(sql, values).catch(error => {
        sqlErrors.push(error.code);
        throw error;
      });
      if (!paused && sql.includes('turn_cancelled') && sql.includes('FOR UPDATE OF command')) {
        paused = true;
        replyLocked();
        await resume;
      }
      return result;
    },
    transaction: work => tx.transaction(nested => work(wrap(nested))),
  });
  const hooked = wrap(db);
  const daemon = new DaemonService(hooked, new LiveHub());
  const reply = daemon.execute('postRoomMessage', {
    roomId: C, requestId, generationId: 'generation', text: '@peer finished the fix',
  }, A);
  await locked;
  const archive = path === 'merge webhook'
    ? operations(hooked).processWebhook('pull_request', event)
    : path === 'agent close'
      ? daemon.execute('archiveCorner', { cornerId: C }, A)
      : new PhoneService(hooked, 'http://test').execute('requestCornerClose', { roomId: C }, H);
  await cancelling;
  releaseReply();
  const results = await Promise.allSettled([reply, archive]);
  console.log('Reproduction MERGE-DEADLOCK-1:', results.map(result => result.status === 'fulfilled'
    ? 'committed' : { code: result.reason.code, message: result.reason.message }));
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(sqlErrors).toEqual([]);
  await assertArchived(B, path === 'merge webhook');
  expect(app.deleteBranch).toHaveBeenCalledTimes(path === 'merge webhook' ? 1 : 0);
});
