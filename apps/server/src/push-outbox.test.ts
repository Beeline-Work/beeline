import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { migrate, PostgresDatabase, postgresPoolConfig, type SqlDatabase } from './database.js';
import { PushDeliveryLoop } from './background.js';
import { backfillPushOutbox } from './push-outbox.js';
import { PgliteDatabase } from './test-support.js';

const person = 'a'.repeat(64), author = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
async function setup(db: SqlDatabase) {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle,push_level)
    VALUES($1,'human','Owner','owner','full'),($2,'human','Peer','peer','full')`, [person, author]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')`, [room, workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [workspace, room, person, author]);
  await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
    VALUES('proof-device',$1,'android','physical',now()-interval '1 day')`, [person]);
  await db.query(`INSERT INTO push_delivery_floors(id,started_at)
    VALUES('message-delivery',now()-interval '1 day')`);
}
async function post(db: SqlDatabase, id: string) {
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner hello')`, [id, room, author]);
}

it('rolls back fanout with the message, backfills cutover once, and honors old claims', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await expect(db.transaction(async tx => {
      await post(tx, 'rolled-back');
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(0);
    await post(db, 'old-delivered');
    await post(db, 'old-pending');
    await post(db, 'old-retry');
    await post(db, 'old-failed');
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner')`, [workspace, person]);
    await db.query(`INSERT INTO workspace_join_notifications(id,workspace_id,room_id,joining_identity_id,text)
      VALUES('join-pending',$1,$2,$3,'Peer joined'),('join-delivered',$1,$2,$3,'Peer joined')`,
      [workspace, room, author]);
    await db.query(`INSERT INTO workspace_join_notification_devices(notification_id,device_token)
      VALUES('join-pending','proof-device'),('join-delivered','proof-device')`);
    await db.query(`DELETE FROM push_outbox`);
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status)
      VALUES('old-delivered','proof-device','delivered'),('join-delivered','proof-device','delivered'),
        ('old-failed','proof-device','failed')`);
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,attempts,next_retry_at)
      VALUES('old-retry','proof-device','retryable',2,now()+interval '1 minute')`);
    await backfillPushOutbox(db);
    await backfillPushOutbox(db);
    expect((await db.query(`SELECT * FROM push_outbox`)).rows).toHaveLength(6);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(2);
    expect(send.mock.calls.map(([, message]) => message.messageId).sort()).toEqual(['join-pending','old-pending']);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(0);
    await db.query(`UPDATE push_delivery_claims SET next_retry_at=now()-interval '1 second'
      WHERE message_id='old-retry'`);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(1);
    expect((await db.query(`SELECT status,attempts FROM push_delivery_claims WHERE message_id='old-retry'`)).rows)
      .toEqual([{ status: 'delivered', attempts: 3 }]);
  } finally { await db.close(); }
});

it('recovers a leased entry after restart and a claim abandoned before provider send', async () => {
  const db = new PgliteDatabase();
  try {
    await setup(db);
    await post(db, 'abandoned');
    await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,claimed_at)
      VALUES('abandoned','proof-device','claimed',now()-interval '2 minutes')`);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(1);
    expect(await new PushDeliveryLoop(db, { send }).runOnce()).toBe(0);
    expect(send).toHaveBeenCalledOnce();
  } finally { await db.close(); }
});

const postgresUrl = process.env.BEELINE_PUSH_TEST_POSTGRES_URL;
if (postgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(postgresUrl).hostname))
  throw new Error('push proofs require isolated loopback PostgreSQL');

describe.skipIf(!postgresUrl)('R-PUSH-SCAN-LOCK', () => {
  it('delivers under load while messages ACCESS EXCLUSIVE is acquired without migration retries', async () => {
    const schema = `push_proof_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config = postgresPoolConfig(postgresUrl!, 2, 'long-running');
    config.options = `${config.options} -c search_path=${schema},public`;
    const jobs = new PostgresDatabase('', 2, { mode: 'long-running', pool: new Pool(config) });
    const owner = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
      connectionString: postgresUrl, max: 1, options: `-c search_path=${schema},public -c lock_timeout=1000ms`,
    }) });
    let running: Promise<number> | undefined;
    let releaseSend: (() => void) | undefined;
    try {
      await setup(owner);
      expect((await jobs.query(`SHOW statement_timeout`)).rows[0]!.statement_timeout).toBe('2s');
      expect((await jobs.query(`SHOW lock_timeout`)).rows[0]!.lock_timeout).toBe('500ms');
      // Write the fixture before enabling triggers, as though this history predated cutover.
      await owner.query(`ALTER TABLE messages DISABLE TRIGGER message_push_outbox`);
      await owner.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
        SELECT 'history-'||n,$1,$2,repeat('@owner historical message ',100),now()-interval '1 day'
        FROM generate_series(1,50000) n`, [room, author]);
      await owner.query(`ALTER TABLE messages ENABLE TRIGGER message_push_outbox`);
      await owner.query(`INSERT INTO messages(id,room_id,author_id,text)
        SELECT 'fresh-'||n,$1,$2,'@owner fresh' FROM generate_series(1,300) n`, [room, author]);
      // Negative control matches the long-held ACCESS SHARE incident. No retries.
      const legacy = await admin.connect();
      try {
        await legacy.query('BEGIN');
        await legacy.query(`SELECT id FROM ${schema}.messages LIMIT 1`);
        await expect(owner.transaction(async tx => {
          await tx.query(`LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`);
        })).rejects.toMatchObject({ code: '55P03' });
      } finally { await legacy.query('ROLLBACK'); legacy.release(); }
      let startedSend!: () => void;
      const sending = new Promise<void>(resolve => { releaseSend = resolve; });
      const started = new Promise<void>(resolve => { startedSend = resolve; });
      const send = vi.fn(async () => { startedSend(); await sending; });
      const loop = new PushDeliveryLoop(jobs, { send });
      const query = vi.spyOn(jobs, 'query');
      running = loop.runOnce();
      await Promise.race([started, running.then(() => { throw new Error("no delivery started"); })]);
      const lockDurations: number[] = [];
      for (let n = 0; n < 20; n++) {
        const began = Date.now();
        await owner.transaction(async tx => { await tx.query(`LOCK TABLE messages IN ACCESS EXCLUSIVE MODE`); });
        lockDurations.push(Date.now() - began);
        releaseSend!();
      }
      expect(Math.max(...lockDurations)).toBeLessThan(1000);
      console.info(`R-PUSH-SCAN-LOCK: 300 deliveries; 20 locks; max lock handoff ${Math.max(...lockDurations)}ms`);
      expect(await running).toBe(300);
      expect(send).toHaveBeenCalledTimes(300);
      const candidate = query.mock.calls.find(([sql]) => sql.includes('FROM unclaimed'))!;
      expect(candidate[0]).toContain('SELECT * FROM messages WHERE id=queued.message_id OFFSET 0');
      const explain = await jobs.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${candidate[0]}`, candidate[1]);
      const visit = (node: Record<string, unknown>) => {
        if (node['Relation Name'] === 'messages') {
          expect(node['Node Type']).not.toBe('Seq Scan');
          expect(String(node['Index Cond'] ?? node['Recheck Cond'])).toMatch(/\bid\b/);
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
      };
      visit((explain.rows[0]!['QUERY PLAN'] as { Plan: Record<string, unknown> }[])[0]!.Plan);
    } finally {
      releaseSend?.();
      await running?.catch(() => undefined);
      await jobs.close(); await owner.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    }
  }, 120_000);
});
