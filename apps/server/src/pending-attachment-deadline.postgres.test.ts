import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { PendingAttachmentCleanupLoop } from './pending-attachment-cleanup.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Attachment retention proof requires isolated loopback PostgreSQL');
}
describe.skipIf(!url)('Pending attachment deadline ownership', () => {
  it('uses database time and waits for a locked due row so rollback cannot silently lose retention', async () => {
    const pool = new Pool({ connectionString: url, max: 3 });
    const schema = `attachment_due_${randomUUID().replaceAll('-', '')}`;
    const owner = await pool.connect(), writer = await pool.connect();
    try {
      await owner.query(`CREATE SCHEMA ${schema}`);
      await owner.query(`SET search_path TO ${schema}`);
      await writer.query(`SET search_path TO ${schema}`);
      // Minimal concurrency fixture. Migrated-schema coverage is in data-cleanup
      // and postgres-live; the indexed-future fixture is not a rollout-cost proof.
      await owner.query(`CREATE TABLE rooms(id text PRIMARY KEY,archived_at timestamptz);
        CREATE TABLE agent_pending_attachments(id serial PRIMARY KEY,room_id text,agent_id text,request_id text,created_at timestamptz);
        CREATE TABLE agent_commands(room_id text,agent_id text,turn_request_id text,action text,state text);
        CREATE TABLE agent_turns(room_id text,agent_id text,request_id text,status text);
        INSERT INTO rooms VALUES('room',NULL);
        INSERT INTO agent_pending_attachments(room_id,agent_id,request_id,created_at)
          VALUES('room','agent','request',now()+interval '1 hour'-interval '24 hours');`);
      const source = readFileSync(new URL('./pending-attachment-source.ts', import.meta.url), 'utf8');
      for (const index of source.match(/CREATE INDEX IF NOT EXISTS[^;]+;/g) ?? []) await owner.query(index);
      await owner.query(`INSERT INTO agent_pending_attachments(room_id,agent_id,request_id,created_at)
        SELECT 'room','agent','later',now()+interval '1 day' FROM generate_series(1,10000)`);
      await owner.query('ANALYZE agent_pending_attachments');
      let deadlineSql = '';
      const db = { query: (sql: string, values?: unknown[]) => {
        if (sql.includes('delay_ms')) deadlineSql = sql;
        return owner.query(sql, values);
      } } as unknown as SqlDatabase;
      const loop = new PendingAttachmentCleanupLoop(db);
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2099-01-01'));
      expect(await loop.runOnce()).toBe(0);
      const future = await loop.nextDelayMs();
      expect(future).toBeGreaterThan(3_500_000); expect(future).toBeLessThanOrEqual(3_600_000);
      const plan = (await owner.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${deadlineSql}`)).rows[0]['QUERY PLAN'][0].Plan;
      expect(JSON.stringify(plan)).toContain('agent_pending_attachments_due_idx');
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(60);
      await owner.query("DELETE FROM agent_pending_attachments WHERE request_id='later'");
      await owner.query("UPDATE agent_pending_attachments SET created_at=now()-interval '2 days'");
      await writer.query('BEGIN');
      await writer.query('SELECT * FROM agent_pending_attachments FOR UPDATE');
      expect(await loop.runOnce()).toBe(0);
      const pid = (await owner.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const pending = loop.nextDelayMs();
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          waiting = (await pool.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(waiting).toBe(true);
      } finally { await writer.query('ROLLBACK'); }
      expect(await pending).toBe(0);
      expect(await loop.runOnce()).toBe(1);
      expect(await loop.nextDelayMs()).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await writer.query('ROLLBACK');
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      owner.release(); writer.release(); await pool.end();
    }
  });
});
