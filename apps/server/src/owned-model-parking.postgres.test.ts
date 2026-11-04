import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase } from './database.js';
import { TURN_OWNERSHIP_SCHEMA } from './turn-ownership.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { ROUTER_PROJECTION_SCHEMA } from './router-projection-schema.js';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import { parkOwnedModelTerminal } from './owned-model-parking.js';
import { MODEL, MODEL_AGENT, MODEL_CLAIM, MODEL_ROOM, MODEL_SOURCE, seedOwnedModelFixture } from './test-fixtures/owned-model.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Model parking proof requires isolated loopback PostgreSQL');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const ONE = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const schema = 'model_park_' + randomUUID().replaceAll('-', ''), admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config = { connectionString: url, options: `-c search_path=${schema},public -c statement_timeout=8000`, max: 2 };
  const left = new PostgresDatabase('', 2, { pool: new Pool(config) }), right = new PostgresDatabase('', 2, { pool: new Pool(config) });
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
      CREATE TABLE agent_turns(room_id uuid,request_id text,agent_id text,status text,generation_id text);
      CREATE TABLE live_outputs(room_id uuid,agent_id text,turn_id text,kind text,body jsonb);`);
    await left.query(DURABLE_LIVE_SCHEMA); await left.query(ROUTER_PROJECTION_SCHEMA); await left.query(TURN_OWNERSHIP_SCHEMA);
    const seeded = await seedOwnedModelFixture(left);
    return { ...seeded, left, right, admin, close: async () => { await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
  } catch (error) { await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); throw error; }
}
describe.skipIf(!url)('real PostgreSQL causal model owner end', () => {
  it('serializes an admitted owner end against a competing old-code generation claim and prevents final provider entry', async () => {
    const f = await fixture(), admitted = deferred<void>(), release = deferred<void>(), writerPid = deferred<number>();
    let park: Promise<unknown> | undefined, claim: Promise<unknown> | undefined;
    try {
      const attempts = new OwnedModelAttempts(f.left, f.credentials);
      const reserved = await attempts.reserve(f.actor, ONE, { model: MODEL, messages: [] }, async () => ({
        reservation: { day: '2026-11-02', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 }, payload: { model: MODEL, messages: [], max_tokens: 8 },
      }));
      await f.left.query(`INSERT INTO agent_turns VALUES($1,'synthetic-request',$2,'working',$3)`, [MODEL_ROOM, MODEL_AGENT, MODEL_CLAIM.generationId]);
      park = f.left.transaction(async tx => {
        await parkOwnedModelTerminal(tx, { roomId: MODEL_ROOM, agentId: MODEL_AGENT, requestId: 'synthetic-request', generationId: MODEL_CLAIM.generationId,
          status: 'failed', modelOwnerEnd: { requestId: ONE } }, MODEL_AGENT, MODEL_SOURCE);
        admitted.resolve(); await release.promise;
      });
      await admitted.promise;
      claim = f.right.transaction(async tx => {
        writerPid.resolve(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
        await tx.query(`UPDATE agent_commands SET generation_id='late-old-code-generation' WHERE id=$1`, [MODEL_CLAIM.commandId]);
      });
      void claim.catch(() => {});
      const pid = await writerPid.promise;
      let waiting = false;
      // Synchronize only against the actual admitted row-lock contention.
      for (let count = 0; count < 200; count++) {
        waiting = (await f.admin.query<{ waiting: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 waiting', [pid])).rows[0]!.waiting;
        if (waiting) break; await new Promise(done => setTimeout(done, 5));
      }
      expect(waiting).toBe(true); release.resolve(); await park;
      await expect(claim).rejects.toThrow('owner has ended');
      let entries = 0;
      await expect(attempts.handoff(reserved.permit!, async () => { entries++; return 'must not enter'; })).rejects.toThrow('authority is unavailable');
      expect(entries).toBe(0);
      expect((await f.right.query('SELECT state,generation_id FROM agent_commands')).rows).toEqual([{ state: 'claimed', generation_id: MODEL_CLAIM.generationId }]);
      expect((await f.right.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'unknown' }]);
      expect((await f.right.query('SELECT * FROM agent_turns')).rowCount).toBe(0);
    } finally { release.resolve(); await Promise.allSettled([park, claim].filter((value): value is Promise<unknown> => value !== undefined)); await f.close(); }
  }, 20_000);
});
