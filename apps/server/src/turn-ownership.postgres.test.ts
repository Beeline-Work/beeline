import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { authorizeCommandOutput } from './agent-command.js';
import { PostgresDatabase } from './database.js';
import { TURN_OWNERSHIP_SCHEMA, commandOwnerLiveSql } from './turn-ownership.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Turn ownership proofs require isolated loopback PostgreSQL');
const room = '11111111-1111-4111-8111-111111111111';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function blocked(admin: Pool, pid: number): Promise<void> {
  // Test synchronization against one known nonempty lock obligation only.
  // This is not a runtime retry or discovery owner.
  for (let i = 0; i < 200; i += 1) {
    if ((await admin.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0]!.blocked) return;
    await new Promise(done => setTimeout(done, 5));
  }
  throw new Error('Expected competing PostgreSQL connection to wait on its exact source row');
}

describe.skipIf(!url)('real PostgreSQL execution ownership contention', () => {
  it('serializes replacement with an admitted writer, survives rollback, and keeps generation bindings across requeue', async () => {
    const schema = 'turn_owner_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: url, max: 1 }); await admin.query(`CREATE SCHEMA ${schema}`);
    const config = { connectionString: url, options: `-c search_path=${schema},public`, max: 2 };
    const left = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const right = new PostgresDatabase('', 2, { pool: new Pool(config) });
    const entered = deferred<void>(), releaseWriter = deferred<void>(), replacementEntered = deferred<void>(), rollBack = deferred<void>(), waitingPid = deferred<number>();
    const expiryEntered = deferred<void>(), releaseExpired = deferred<void>();
    let writer: Promise<unknown> | undefined, replacement: Promise<unknown> | undefined;
    let temporary: Promise<unknown> | undefined, afterRollback: Promise<unknown> | undefined;
    let writerError: unknown;
    let overdue: Promise<unknown> | undefined, overdueError: unknown;
    try {
      await left.query(`CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,
          action text,state text,generation_id text,lease_expires_at timestamptz,created_at timestamptz DEFAULT now());
        CREATE TABLE agent_turns(room_id uuid,request_id text,agent_id text,status text,generation_id text,created_at timestamptz DEFAULT now());
        CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
        CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);
        CREATE TABLE ownership_effects(id text PRIMARY KEY,epoch bigint);`);
      await left.query(TURN_OWNERSHIP_SCHEMA);
      await left.query(`INSERT INTO live_server_instances VALUES('old-server',clock_timestamp()),('new-server',clock_timestamp());
        INSERT INTO agent_connections VALUES('agent','old-connection',1,'old-server',NULL);`);
      await left.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,state,generation_id,
          turn_owner_connection_id,turn_owner_epoch) VALUES('command',$1,'agent','request','input','claimed','generation','old-connection',1)`, [room]);
      await left.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id) VALUES($1,'request','agent','working','generation')`, [room]);

      writer = left.transaction(async db => {
        await authorizeCommandOutput(db, room, 'agent', 'request', 'generation');
        await authorizeCommandOutput(db, room, 'agent', 'request', 'generation');
        expect(Number((await db.query<{ count: string }>('SELECT count(*)::text count FROM turn_owned_effect_fences')).rows[0]!.count)).toBe(1);
        entered.resolve(); await releaseWriter.promise;
        await db.query(`INSERT INTO ownership_effects VALUES('admitted-old-effect',1)`);
      });
      void writer.catch(error => { writerError = error; entered.resolve(); });
      await entered.promise;
      // Surface an early authorization error immediately rather than leaving
      // an unresolved fixture barrier until the suite deadline.
      if (writerError) throw writerError;
      let replaced = false;
      replacement = right.transaction(async db => {
        const pid = Number((await db.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid);
        waitingPid.resolve(pid);
        await db.query(`UPDATE agent_connections SET connection_id='new-connection',epoch=2,instance_id='new-server' WHERE agent_id='agent'`);
        replaced = true;
      });
      await blocked(admin, await waitingPid.promise); expect(replaced).toBe(false);
      releaseWriter.resolve(); await writer; await replacement;
      expect((await left.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
      expect((await left.query(`SELECT id FROM ownership_effects`)).rows).toEqual([{ id: 'admitted-old-effect' }]);
      await expect(left.transaction(db => authorizeCommandOutput(db, room, 'agent', 'request', 'generation')))
        .rejects.toThrow('command output authority rejected');

      await left.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='command'`);
      await expect(right.query(`UPDATE agent_commands SET state='claimed',generation_id='generation',
        turn_owner_connection_id='new-connection',turn_owner_epoch=2 WHERE id='command'`)).rejects.toThrow('generation owner changed');
      await right.transaction(async db => {
        await db.query(`UPDATE agent_commands SET state='claimed',generation_id='new-generation',turn_owner_connection_id='new-connection',turn_owner_epoch=2 WHERE id='command'`);
        await db.query(`UPDATE agent_turns SET generation_id='new-generation'`);
      });
      const before = (await left.query(`SELECT command.xmin::text command_version,turn.xmin::text turn_version,
        command.created_at::text command_created,turn.created_at::text turn_created FROM agent_commands command CROSS JOIN agent_turns turn`)).rows;
      await right.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp() WHERE instance_id='new-server'`);
      expect((await left.query(`SELECT command.xmin::text command_version,turn.xmin::text turn_version,
        command.created_at::text command_created,turn.created_at::text turn_created FROM agent_commands command CROSS JOIN agent_turns turn`)).rows).toEqual(before);

      temporary = right.transaction(async db => {
        await db.query(`UPDATE agent_connections SET connection_id='uncommitted-replacement',epoch=3 WHERE agent_id='agent'`);
        replacementEntered.resolve(); await rollBack.promise; throw new Error('synthetic rollback');
      });
      const rolledBack = temporary.catch(error => { expect(error.message).toBe('synthetic rollback'); });
      await replacementEntered.promise;
      const leftPid = deferred<number>();
      afterRollback = left.transaction(async db => {
        leftPid.resolve(Number((await db.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid));
        await authorizeCommandOutput(db, room, 'agent', 'request', 'new-generation');
        await db.query(`INSERT INTO ownership_effects VALUES('same-owner-after-rollback',2)`);
      });
      await blocked(admin, await leftPid.promise);
      rollBack.resolve(); await rolledBack; await afterRollback;
      expect((await left.query(`SELECT id FROM ownership_effects ORDER BY id`)).rows).toEqual([
        { id: 'admitted-old-effect' }, { id: 'same-owner-after-rollback' },
      ]);
      expect((await left.query<{ live: boolean }>(`SELECT ${commandOwnerLiveSql('command')} live FROM agent_commands command`)).rows[0]!.live).toBe(true);
      overdue = left.transaction(async db => {
        await authorizeCommandOutput(db, room, 'agent', 'request', 'new-generation');
        expiryEntered.resolve(); await releaseExpired.promise;
        await db.query(`INSERT INTO ownership_effects VALUES('must-rollback-after-expiry',2)`);
      });
      void overdue.catch(error => { overdueError = error; expiryEntered.resolve(); });
      await expiryEntered.promise; if (overdueError) throw overdueError;
      await right.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds' WHERE instance_id='new-server'`);
      releaseExpired.resolve();
      await expect(overdue).rejects.toThrow('authority expired before commit');
      expect((await left.query(`SELECT id FROM ownership_effects WHERE id='must-rollback-after-expiry'`)).rowCount).toBe(0);
      expect((await left.query('SELECT * FROM turn_owned_effect_fences')).rowCount).toBe(0);
      await expect(left.transaction(db => authorizeCommandOutput(db, room, 'agent', 'request', 'new-generation')))
        .rejects.toThrow('command output authority rejected');
    } finally {
      releaseWriter.resolve(); rollBack.resolve(); releaseExpired.resolve();
      await Promise.allSettled([writer, replacement, temporary, afterRollback, overdue].filter((work): work is Promise<unknown> => work !== undefined));
      await left.close(); await right.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 20_000);
});
