import { randomUUID } from 'node:crypto';
import { Pool, type QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import { OwnedModelCredentials, OWNED_MODEL_UNKNOWN_GENERATION_MESSAGE } from './owned-model-credential.js';
import { MODEL, MODEL_AGENT, MODEL_KEY, MODEL_ROOM, seedOwnedModelFixture } from './test-fixtures/owned-model.js';
import { MEMBERSHIP_AUTHORITY_SCHEMA } from './membership-authority-schema.js';
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';
import { TURN_OWNERSHIP_SCHEMA } from './turn-ownership.js';
import { FreeAgentService, freeAgentConfigFromEnv, sealSecrets, tokenHash } from './free-agents.js';
import { retireAgentFromWorkspace } from './agent-retirement.js';
import { lockDaemonCredentialLifetime } from './daemon-credential-lifetime.js';
import { MODEL_OWNER, MODEL_WORKSPACE } from './test-fixtures/owned-model.js';
import type { FreeAgentMachines } from './fly-machines.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Owned model proofs require isolated loopback PostgreSQL');
const ONE = '11111111-1111-4111-8111-111111111111', TWO = '22222222-2222-4222-8222-222222222222';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function blocked(admin: Pool, pid: number): Promise<void> {
  // Fixture synchronization against an already admitted, exact lock obligation.
  for (let index = 0; index < 200; index++) {
    if ((await admin.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0]!.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Expected exact model/source writer to wait behind admitted work');
}
function observe(database: SqlDatabase, after: (sql: string, tx: SqlDatabase) => Promise<void>): SqlDatabase {
  return {
    query: (sql, values) => database.query(sql, values),
    transaction: work => database.transaction(tx => work({
      query: async <Row extends QueryResultRow>(sql: string, values?: unknown[]) => {
        const result = await tx.query<Row>(sql, values); await after(sql, tx); return result;
      }, transaction: nested => tx.transaction(nested),
    })),
  };
}
async function fixture() {
  const schema = 'owned_model_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url, max: 1 }); await admin.query(`CREATE SCHEMA ${schema}`);
  const config = { connectionString: url, options: `-c search_path=${schema},public -c statement_timeout=8000`, max: 2 };
  const left = new PostgresDatabase('', 2, { pool: new Pool(config) });
  const right = new PostgresDatabase('', 2, { pool: new Pool(config) });
  try {
    await left.query(`CREATE TABLE identities(id text PRIMARY KEY,kind text,name text);
      CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text);
      CREATE TABLE workspaces(id uuid PRIMARY KEY,name text);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,name text,parent_id uuid,archived_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
      CREATE TABLE free_agents(agent_id text PRIMARY KEY,workspace_id uuid,owner_id text,sealed_keys text,
        model_token_hash text,state text,model text,removed_at timestamptz);
      CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);
      CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
      CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,action text,reason text,
        root_command_id text,root_source_message_id text,agent_depth integer,state text,generation_id text,claimed_at timestamptz,
        lease_expires_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE agent_turns(room_id uuid,request_id text,agent_id text,status text,generation_id text);`);
    // Install actual authority writer triggers and actual owned source/commit
    // predicates, rather than a fake lock in the proof's membership adapter.
    await left.query(DURABLE_LIVE_SCHEMA); await left.query(MEMBERSHIP_AUTHORITY_SCHEMA); await left.query(TURN_OWNERSHIP_SCHEMA);
    const seeded = await seedOwnedModelFixture(left);
    return { ...seeded, left, right, admin, close: async () => {
      await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    } };
  } catch (error) {
    await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw error;
  }
}
const payload = (text = 'synthetic private history') => ({ model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: text }] });
const reserve = async (tx: SqlDatabase) => {
  await tx.query(`INSERT INTO owned_model_test_accounting(id,amount) VALUES($1,16)`, [randomUUID()]);
  return { reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 }, payload: payload() };
};

describe.skipIf(!url)('real PostgreSQL owned model primitive contention', () => {
  it('serializes competing admissions across pools and gives only the actual committed reservation a one-use permit', async () => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), pid = deferred<number>();
    let first: ReturnType<OwnedModelAttempts['reserve']> | undefined, second: ReturnType<OwnedModelAttempts['reserve']> | undefined;
    let early: unknown;
    try {
      const owner = new OwnedModelAttempts(f.left, f.credentials);
      const otherKeys = new OwnedModelCredentials({ currentVersion: 'test-v1', key: () => MODEL_KEY }, () => MODEL, () => 900_000);
      const otherActor = await otherKeys.authenticate(f.right, f.issued.token);
      const other = new OwnedModelAttempts(f.right, otherKeys);
      // Resolve PID before the actual blocking global-budget lock, which is
      // acquired before owner lock by both real admissions.
      const competing = new OwnedModelAttempts({ query: (sql, args) => f.right.query(sql, args), transaction: work => f.right.transaction(async tx => {
        pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid)); return work(tx);
      }) }, otherKeys);
      const winningHook = vi.fn(async (tx: SqlDatabase) => { const value = await reserve(tx); entered.resolve(); await release.promise; return value; });
      first = owner.reserve(f.actor, ONE, payload(), winningHook);
      void first.catch(error => { early = error; entered.resolve(); }); await entered.promise; if (early) throw early;
      const losingHook = vi.fn(reserve); second = competing.reserve(otherActor, ONE, payload(), losingHook);
      await blocked(f.admin, await pid.promise); expect(losingHook).not.toHaveBeenCalled();
      release.resolve(); const admitted = await first, replayed = await second;
      expect(replayed).toEqual({ receipt: admitted.receipt }); expect(winningHook).toHaveBeenCalledOnce(); expect(losingHook).not.toHaveBeenCalled();
      expect((await f.right.query('SELECT * FROM owned_model_test_accounting')).rowCount).toBe(1);
      expect((await f.right.query('SELECT * FROM owned_model_attempts')).rowCount).toBe(1);
      const start = vi.fn(async () => 'synthetic result'); await owner.handoff(admitted.permit!, start);
      await expect(other.handoff(admitted.permit!, start)).rejects.toThrow('UNKNOWN'); expect(start).toHaveBeenCalledOnce();
    } finally { release.resolve(); await Promise.allSettled([first, second].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close(); }
  }, 20_000);

  it.each(['membership', 'source', 'rotation'] as const)('serializes actual %s change through final synchronous handoff, without awaiting provider completion', async change => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), pid = deferred<number>(), provider = deferred<string>();
    let pause = false, early: unknown, handoff: ReturnType<OwnedModelAttempts['handoff']> | undefined, writer: Promise<unknown> | undefined;
    try {
      const owner = new OwnedModelAttempts(observe(f.left, async sql => {
        if (pause && sql.includes('FROM owned_model_attempts') && sql.includes('FOR SHARE NOWAIT')) { pause = false; entered.resolve(); await release.promise; }
      }), f.credentials);
      const first = await owner.reserve(f.actor, ONE, payload(), reserve);
      const next = await owner.reserve(f.actor, TWO, payload('synthetic next tool history'), async tx => ({ ...(await reserve(tx)), payload: payload('synthetic next tool history') }));
      const start = vi.fn(() => provider.promise); pause = true;
      handoff = owner.handoff(first.permit!, start); void handoff.catch(error => { early = error; entered.resolve(); });
      await entered.promise; if (early) throw early;
      let written = false;
      writer = f.right.transaction(async tx => {
        pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
        if (change === 'membership') await tx.query('UPDATE memberships SET removed_at=clock_timestamp() WHERE room_id=$1', [MODEL_ROOM]);
        if (change === 'source') await tx.query(`UPDATE agent_connections SET connection_id='replacement',epoch=2 WHERE agent_id=$1`, [MODEL_AGENT]);
        if (change === 'rotation') await tx.query('UPDATE free_agents SET model_token_hash=$2 WHERE agent_id=$1', [MODEL_AGENT, 'e'.repeat(64)]);
        written = true;
      });
      await blocked(f.admin, await pid.promise); expect(written).toBe(false); expect(start).not.toHaveBeenCalled();
      release.resolve(); expect((await handoff).state).toBe('started'); await writer;
      expect(start).toHaveBeenCalledOnce(); expect(written).toBe(true); // provider Promise remains unresolved
      await expect(owner.handoff(next.permit!, start)).rejects.toThrow(); expect(start).toHaveBeenCalledOnce();
      expect((await f.right.query(`SELECT state FROM owned_model_attempts`)).rows).toEqual([{ state: 'unknown' }, { state: 'unknown' }]);
    } finally {
      release.resolve(); provider.resolve('synthetic completion');
      await Promise.allSettled([handoff, writer].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close();
    }
  }, 20_000);

  it('rechecks actual lease expiry after queue/source admission and refuses entry while retaining the committed UNKNOWN reservation', async () => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>(); let pause = false, early: unknown;
    let handoff: ReturnType<OwnedModelAttempts['handoff']> | undefined;
    try {
      const owner = new OwnedModelAttempts(observe(f.left, async sql => {
        if (pause && sql.includes('FROM owned_model_attempts') && sql.includes('FOR SHARE NOWAIT')) { pause = false; entered.resolve(); await release.promise; }
      }), f.credentials);
      const admitted = await owner.reserve(f.actor, ONE, payload(), reserve), start = vi.fn(async () => 'must not enter'); pause = true;
      handoff = owner.handoff(admitted.permit!, start); void handoff.catch(error => { early = error; entered.resolve(); });
      await entered.promise; if (early) throw early;
      await f.right.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds'`);
      release.resolve(); await expect(handoff).rejects.toThrow('authority'); expect(start).not.toHaveBeenCalled();
      expect((await f.right.query('SELECT state,evidence FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown', evidence: null }]);
      expect((await f.right.query('SELECT * FROM owned_model_test_accounting')).rowCount).toBe(1);
      await expect(owner.handoff(admitted.permit!, start)).rejects.toThrow('UNKNOWN');
    } finally { release.resolve(); await Promise.allSettled(handoff ? [handoff] : []); await f.close(); }
  }, 20_000);

  it('refuses a reverse-order free-agent writer promptly instead of deadlocking or retrying provider entry', async () => {
    const f = await fixture(), rowHeld = deferred<void>(), authorityHeld = deferred<void>(), requestAuthority = deferred<void>();
    const releaseHandoff = deferred<void>(), pid = deferred<number>(); let pause = false, early: unknown;
    let writer: Promise<unknown> | undefined, handoff: ReturnType<OwnedModelAttempts['handoff']> | undefined;
    try {
      const owner = new OwnedModelAttempts(observe(f.left, async sql => {
        if (pause && sql.includes('pg_advisory_xact_lock_shared')) { pause = false; authorityHeld.resolve(); await releaseHandoff.promise; }
      }), f.credentials);
      const admitted = await owner.reserve(f.actor, ONE, payload(), reserve), start = vi.fn(async () => 'must not enter');
      writer = f.right.transaction(async tx => {
        await tx.query('SELECT agent_id FROM free_agents WHERE agent_id=$1 FOR UPDATE', [MODEL_AGENT]);
        pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
        rowHeld.resolve(); await requestAuthority.promise;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
      });
      void writer.catch(error => { early = error; rowHeld.resolve(); }); await rowHeld.promise; if (early) throw early;
      pause = true; handoff = owner.handoff(admitted.permit!, start);
      void handoff.catch(error => { early = error; authorityHeld.resolve(); }); await authorityHeld.promise; if (early) throw early;
      requestAuthority.resolve(); await blocked(f.admin, await pid.promise); releaseHandoff.resolve();
      await expect(handoff).rejects.toMatchObject({ code: '55P03' }); await writer;
      expect(start).not.toHaveBeenCalled(); await expect(owner.handoff(admitted.permit!, start)).rejects.toThrow('UNKNOWN');
      expect((await f.right.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
    } finally {
      requestAuthority.resolve(); releaseHandoff.resolve();
      await Promise.allSettled([writer, handoff].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close();
    }
  }, 20_000);

  it('accounts for the complete final DB response delay instead of handing off with an expired observed lifetime', async () => {
    const f = await fixture(); let delay = false, delayed = false;
    try {
      const owner = new OwnedModelAttempts(observe(f.left, async (sql, tx) => {
        if (delay && sql.startsWith('SELECT command.agent_id')) {
          delay = false; delayed = true; await tx.query('SELECT pg_sleep(1.2)');
        }
      }), f.credentials);
      const admitted = await owner.reserve(f.actor, ONE, payload(), reserve), start = vi.fn(async () => 'must not enter');
      await f.right.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '89 seconds'`); delay = true;
      await expect(owner.handoff(admitted.permit!, start)).rejects.toThrow(); expect(delayed).toBe(true); expect(start).not.toHaveBeenCalled();
      expect((await f.right.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
    } finally { await f.close(); }
  }, 20_000);

  it('refuses behind the actual bootstrap token-rotation row owner without retrying or blocking its legacy credential completion', async () => {
    const f = await fixture(), held = deferred<void>(), release = deferred<void>(); let early: unknown;
    let bootstrap: ReturnType<FreeAgentService['bootstrap']> | undefined;
    try {
      await f.left.query(`ALTER TABLE agents ADD COLUMN soul jsonb;
        ALTER TABLE free_agents ADD COLUMN bootstrap_hash text,ADD COLUMN updated_at timestamptz;
        CREATE TABLE free_agent_events(id bigserial PRIMARY KEY,agent_id text,kind text,detail jsonb);`);
      const key = 'synthetic-sealing-key', bootstrapToken = 'bfb_synthetic';
      await f.left.query('UPDATE free_agents SET sealed_keys=$1,bootstrap_hash=$2', [sealSecrets(key, { agent: 'synthetic-agent-key', body: 'synthetic-body-key' }), tokenHash(bootstrapToken)]);
      const owner = new OwnedModelAttempts(f.left, f.credentials), admitted = await owner.reserve(f.actor, ONE, payload(), reserve);
      const noMachine = vi.fn(async () => { throw new Error('No lifecycle effect is authorized by this fixture'); });
      const machines: FreeAgentMachines = { create: noMachine, find: noMachine, start: noMachine, suspend: noMachine, stop: noMachine, destroy: noMachine, state: noMachine, waitFor: noMachine };
      const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: key, FLY_FREE_AGENT_IMAGE: 'synthetic-image' }, 'https://synthetic.invalid')!;
      const service = new FreeAgentService(observe(f.right, async sql => {
        if (sql.includes('FOR UPDATE OF f')) { held.resolve(); await release.promise; }
      }), config, machines, async (agent, tx) => {
        await lockDaemonCredentialLifetime(tx, agent); return { exchangeToken: 'synthetic-exchange' };
      });
      bootstrap = service.bootstrap(bootstrapToken); void bootstrap.catch(error => { early = error; held.resolve(); });
      await held.promise; if (early) throw early;
      const start = vi.fn(async () => 'must not enter'); await expect(owner.handoff(admitted.permit!, start)).rejects.toMatchObject({ code: '55P03' });
      release.resolve(); expect((await bootstrap)?.daemonExchangeToken).toBe('synthetic-exchange');
      expect(start).not.toHaveBeenCalled(); expect(noMachine).not.toHaveBeenCalled();
      await expect(f.credentials.authenticate(f.left, f.issued.token)).rejects.toThrow('authority');
      expect((await f.left.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
    } finally { release.resolve(); await Promise.allSettled(bootstrap ? [bootstrap] : []); await f.close(); }
  }, 20_000);

  it('releases final authority on NOWAIT refusal so actual retirement can finish its reverse-order membership write', async () => {
    const f = await fixture(), rowHeld = deferred<void>(), authorityHeld = deferred<void>(), releaseRetire = deferred<void>(), releaseHandoff = deferred<void>();
    const pid = deferred<number>(); let early: unknown, pause = false;
    let retirement: Promise<unknown> | undefined, handoff: ReturnType<OwnedModelAttempts['handoff']> | undefined;
    try {
      await f.left.query(`ALTER TABLE free_agents ADD COLUMN bootstrap_hash text,ADD COLUMN wake_requested_at timestamptz,ADD COLUMN updated_at timestamptz;
        ALTER TABLE identities ADD COLUMN hidden_from_roster boolean,ADD COLUMN updated_at timestamptz;
        ALTER TABLE agents ADD COLUMN usage_snapshot jsonb,ADD COLUMN usage_account_id text,ADD COLUMN soul jsonb,
          ADD COLUMN chosen_voices jsonb,ADD COLUMN selected_model text,ADD COLUMN selected_effort text,ADD COLUMN model_catalog jsonb,
          ADD COLUMN model_unavailable jsonb,ADD COLUMN commands jsonb,ADD COLUMN schedule_ids jsonb,ADD COLUMN squire_report jsonb,
          ADD COLUMN squire_work jsonb,ADD COLUMN yolo_mode boolean,ADD COLUMN yolo_set_by text,ADD COLUMN yolo_set_at timestamptz,
          ADD COLUMN access_policy jsonb,ADD COLUMN updated_at timestamptz;
        CREATE TABLE free_agent_events(id bigserial PRIMARY KEY,agent_id text,kind text,detail jsonb);
        CREATE TABLE daemon_token_exchanges(agent_id text,consumed_at timestamptz);
        CREATE TABLE daemon_tokens(agent_id text,revoked_at timestamptz);
        CREATE TABLE agent_schedules(agent_id text,workspace_id uuid);
        CREATE TABLE agent_grants(id text,room_id uuid,agent_id text,workspace_id uuid,status text,decided_by text,decided_at timestamptz);`);
      const owner = new OwnedModelAttempts(observe(f.left, async sql => {
        if (pause && sql.includes('pg_advisory_xact_lock_shared')) { pause = false; authorityHeld.resolve(); await releaseHandoff.promise; }
      }), f.credentials), admitted = await owner.reserve(f.actor, ONE, payload(), reserve);
      const writer = observe(f.right, async (sql, tx) => {
        if (sql.includes('UPDATE free_agents SET removed_at=')) {
          pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid)); rowHeld.resolve(); await releaseRetire.promise;
        }
      });
      retirement = writer.transaction(tx => retireAgentFromWorkspace(tx, { workspaceId: MODEL_WORKSPACE, agentId: MODEL_AGENT,
        remover: { pubkey: MODEL_OWNER, name: 'Synthetic owner', kind: 'human' }, removed: { pubkey: MODEL_AGENT, name: 'Synthetic agent', kind: 'agent' } }));
      void retirement.catch(error => { early = error; rowHeld.resolve(); }); await rowHeld.promise; if (early) throw early;
      const start = vi.fn(async () => 'must not enter'); pause = true; handoff = owner.handoff(admitted.permit!, start);
      void handoff.catch(error => { early = error; authorityHeld.resolve(); }); await authorityHeld.promise; if (early) throw early;
      releaseRetire.resolve(); await blocked(f.admin, await pid.promise); releaseHandoff.resolve();
      await expect(handoff).rejects.toMatchObject({ code: '55P03' }); await retirement; expect(start).not.toHaveBeenCalled();
      await expect(f.credentials.authenticate(f.left, f.issued.token)).rejects.toThrow('authority');
      expect((await f.left.query('SELECT hidden_from_roster FROM identities WHERE id=$1', [MODEL_AGENT])).rows).toEqual([{ hidden_from_roster: true }]);
    } finally {
      releaseRetire.resolve(); releaseHandoff.resolve();
      await Promise.allSettled([retirement, handoff].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close();
    }
  }, 20_000);

  it('serializes a generation writer behind old reservation COMMIT, then rolls its new credential composition back on UNKNOWN', async () => {
    const f = await fixture(), reserved = deferred<void>(), release = deferred<void>(), pid = deferred<number>(); let early: unknown;
    let first: ReturnType<OwnedModelAttempts['reserve']> | undefined, next: Promise<unknown> | undefined;
    try {
      const owner = new OwnedModelAttempts(f.left, f.credentials);
      first = owner.reserve(f.actor, ONE, payload(), async tx => { const value = await reserve(tx); reserved.resolve(); await release.promise; return value; });
      void first.catch(error => { early = error; reserved.resolve(); }); await reserved.promise; if (early) throw early;
      const issue = vi.spyOn(f.credentials, 'issueInTransaction');
      next = f.right.transaction(async tx => {
        pid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
        await tx.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='synthetic-command'`);
        await tx.query(`UPDATE agent_commands SET state='claimed',generation_id='next-generation',claimed_at=clock_timestamp(),
          turn_owner_connection_id='synthetic-connection',turn_owner_epoch=1 WHERE id='synthetic-command'`);
        return f.credentials.issueInTransaction(tx, { agentId: MODEL_AGENT, commandId: 'synthetic-command', generationId: 'next-generation',
          source: { connectionId: 'synthetic-connection', epoch: 1 } });
      });
      const rejected = expect(next).rejects.toMatchObject({ code: '23514', message: OWNED_MODEL_UNKNOWN_GENERATION_MESSAGE });
      await blocked(f.admin, await pid.promise); release.resolve(); expect((await first).permit).toBeDefined(); await rejected;
      expect(issue).not.toHaveBeenCalled(); // persisted SQL floor protects old callers without this hook
      expect((await f.left.query('SELECT generation_id,state FROM agent_commands')).rows).toEqual([{ generation_id: 'synthetic-generation', state: 'claimed' }]);
      expect((await f.left.query(`SELECT 1 FROM agent_command_generation_owners WHERE generation_id='next-generation'`)).rowCount).toBe(0);
      expect((await f.left.query('SELECT * FROM owned_model_credentials')).rowCount).toBe(1);
      expect((await f.left.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
    } finally { release.resolve(); await Promise.allSettled([first, next].filter((work): work is NonNullable<typeof work> => work !== undefined)); await f.close(); }
  }, 20_000);

  it('refuses an old actor reservation promptly behind an uncommitted generation writer, before its quota hook can run', async () => {
    const f = await fixture(), held = deferred<void>(), release = deferred<void>(); let early: unknown, writer: Promise<unknown> | undefined;
    try {
      writer = f.right.transaction(async tx => {
        await tx.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='synthetic-command'`);
        held.resolve(); await release.promise;
      });
      void writer.catch(error => { early = error; held.resolve(); }); await held.promise; if (early) throw early;
      const quota = vi.fn(reserve);
      await expect(new OwnedModelAttempts(f.left, f.credentials).reserve(f.actor, ONE, payload(), quota)).rejects.toMatchObject({ code: '55P03' });
      expect(quota).not.toHaveBeenCalled(); expect((await f.left.query('SELECT * FROM owned_model_attempts')).rowCount).toBe(0);
      release.resolve(); await writer;
    } finally { release.resolve(); await Promise.allSettled(writer ? [writer] : []); await f.close(); }
  }, 20_000);
});
