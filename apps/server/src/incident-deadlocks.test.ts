import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { GitHubOperations } from './github-operations.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { systemLine } from './system-line.js';
import { lockCornerLifecycle } from './corner-lifecycle.js';
import { createAgentCommand } from './agent-command.js';

const url = process.env.BEELINE_INCIDENT_TEST_POSTGRES_URL;
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('incident proofs require isolated loopback PostgreSQL');
const H = 'a'.repeat(64), A = 'b'.repeat(64), B = 'c'.repeat(64), F = 'd'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const headSha = '1'.repeat(40);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Two real transactions form a deterministic cycle around the production
// lifecycle lock. PostgreSQL, not an injected JS exception, chooses the victim.
// The second transaction models an older writer that acquired its lock first.
function contention(db: SqlDatabase) {
  const entered = deferred(), contenderLocked = deferred();
  let attempts = 0;
  const errors: string[] = [];
  const statements: string[][] = [];
  const victim: SqlDatabase = {
    query: db.query.bind(db),
    transaction: async work => {
      const attempt = ++attempts;
      const seen: string[] = []; statements.push(seen);
      try {
        return await db.transaction(async tx => {
          await tx.query(`SET LOCAL deadlock_timeout='10ms'`);
          const wrapped: SqlDatabase = {
            query: async (sql, values) => {
              seen.push(sql);
              return tx.query(sql, values);
            },
            transaction: async nested => nested(wrapped),
          };
          const result = await work(wrapped);
          if (attempt === 1) {
            entered.resolve();
            await contenderLocked.promise;
            await tx.query(`SELECT pg_advisory_xact_lock(1695,37)`);
          }
          return result;
        });
      } catch (error) {
        errors.push((error as { code: string }).code);
        throw error;
      }
    },
  };
  const other: SqlDatabase = {
    query: db.query.bind(db),
    transaction: work => db.transaction(async tx => {
      await tx.query(`SET LOCAL deadlock_timeout='5s'`);
      await tx.query(`SELECT pg_advisory_xact_lock(1695,37)`);
      contenderLocked.resolve();
      return work(tx);
    }),
  };
  return { victim, other, entered: entered.promise, errors, statements, attempts: () => attempts };
}

describe.skipIf(!url)('production incident deadlocks on real PostgreSQL', () => {
  let db: PostgresDatabase, admin: Pool, databaseName: string;
  beforeAll(async () => {
    databaseName = `incident_${randomUUID().replaceAll('-', '')}`;
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolated = new URL(url!); isolated.pathname = `/${databaseName}`;
    db = new PostgresDatabase(isolated.toString(), 8, { mode: 'migration' });
    await migrate(db);
  }, 30_000);
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    await db.query(`DELETE FROM workspaces WHERE id=$1`, [W]);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),($2,'agent','Worker','worker'),
      ($3,'agent','Reviewer','reviewer'),($4,'agent','Fallback','fallback')
      ON CONFLICT(id) DO NOTHING`, [H,A,B,F]);
    await db.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES
      ($1,$4,NULL),($2,$4,'opus-4-5'),($3,$4,'opus-4-5') ON CONFLICT(agent_id) DO NOTHING`, [A,B,F,H]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Incident proof')`, [W]);
    await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
      VALUES(77,$1,'42','owner','User','selected','active') ON CONFLICT DO NOTHING`, [H]);
    await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(101,77,'owner/widgets','main') ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,repository_remote,
      repository_resolution,github_installation_id) VALUES($1,$2,$3,'Parent','owner/widgets',
      'https://github.com/owner/widgets.git','repository',77)`, [R,W,H]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Incident')`, [C,W,R,A]);
    await db.query(`INSERT INTO corner_facts(corner_id,objective,owner_agent_id,feature_branch,lifecycle,workflow_state)
      VALUES($1,'Prove recovery',$2,'feature/incident',$3::jsonb,'implement')`, [C,A,JSON.stringify({checks:'passing',
      pr:{number:1,headSha,url:'https://github.com/owner/widgets/pull/1',mergeability:'clean'}})]);
    for (const who of [H,A,B,F]) for (const room of [null,R])
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [W,room,who]);
  });

  it('R-BRIEF-DEADLOCK: brief revision recovers a real PostgreSQL lifecycle deadlock', async () => {
    const source = 'e'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Clarify the brief')`, [source,R,H]);
    const command = await createAgentCommand(db,{roomId:R,agentId:A,sourceMessageId:source,reason:'human_tag'});
    const daemon = new DaemonService(db,new LiveHub());
    await daemon.execute('claimAgentCommand',{roomId:R,commandId:command!.id,generationId:'brief-proof'},A);
    const turn = {roomId:R,requestId:command!.turn_request_id,generationId:'brief-proof'};
    await daemon.execute('reviseCornerBrief',{...turn,cornerId:C,expectedRevision:0,
      brief:{spec:'Build the widget',change:'Record scope'}},A);
    const race = contention(db);
    const watched = new DaemonService(race.victim,new LiveHub());
    const revision = watched.execute('reviseCornerBrief',{...turn,cornerId:C,expectedRevision:1,
      brief:{spec:'Build the clarified widget',change:'Clarify scope'}},A);
    await race.entered;
    const [result] = await Promise.all([revision,race.other.transaction(tx => lockCornerLifecycle(tx,C))]);
    expect(race.errors).toEqual(['40P01']);
    expect(race.attempts()).toBe(2);
    expect(result.revision).toBe(2);
    expect((await daemon.execute('getCornerRestoreState',{cornerId:C},A)).brief?.spec).toBe('Build the clarified widget');
    expect((await db.query(`SELECT 1 FROM corner_brief_revisions WHERE corner_id=$1`,[C])).rowCount).toBe(2);
    expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%Revision 2%'`,[C])).rowCount).toBe(1);
  });

  it('BEELINE-SERVER-1W: concurrent refreshes recover a PostgreSQL deadlock and commit one rollup event', async () => {
    const race = contention(db);
    const app = {
      installationToken: async () => ({token:'fixture'}),
      readCommitCheckRollup: vi.fn(async () => ({state:'failed',total:1,failing:['lint'],checks:[{name:'lint',status:'failed'}]})),
      readPullRequest: async () => ({number:1,headSha,mergeability:'clean'}),
    } as unknown as GitHubAppClient;
    const payload = {action:'completed',installation:{id:77},repository:{full_name:'owner/widgets'},
      check_run:{name:'lint',status:'completed',conclusion:'failure',head_sha:headSha,
        check_suite:{head_branch:'feature/incident',head_sha:headSha}}};
    const first = new GitHubOperations(race.victim, {} as GitHubOAuthClient, app, 'secret');
    const second = new GitHubOperations(race.other, {} as GitHubOAuthClient, app, 'secret');
    const refresh = first.processWebhook('check_run', payload);
    await race.entered;
    await Promise.all([refresh, second.processWebhook('check_run', payload)]);
    expect(race.errors).toEqual(['40P01']);
    // Includes the later mergeability transaction; the owning refresh retried once.
    expect(race.attempts()).toBeGreaterThanOrEqual(2);
    expect(race.attempts()).toBeLessThanOrEqual(3);
    for (const seen of race.statements.slice(0,2)) {
      const lock = seen.findIndex(sql => sql.includes('pg_advisory_xact_lock'));
      const fact = seen.findIndex(sql => sql.includes('SELECT lifecycle,updated_at::text,merge_attempt_head'));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(fact).toBeGreaterThan(lock);
    }
    expect((await db.query(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`, [C])).rows[0]?.checks).toBe('failing');
    expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'kind'='check-failed'`, [C])).rowCount).toBe(1);
    expect((await db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='corner_check'`, [C])).rowCount).toBe(1);
    expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(2);
  });

});
