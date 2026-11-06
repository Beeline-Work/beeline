import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AgentScheduleLoop } from './agent-schedules.js';
import type { SqlDatabase } from './database.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Schedule clock proof requires isolated loopback PostgreSQL');
}
describe.skipIf(!url)('Persisted schedule clock admission', () => {
  it('uses PostgreSQL time under host clock skew and skips indexed parked occurrences', async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const schema = `schedule_due_${randomUUID().replaceAll('-', '')}`;
    const room = randomUUID();
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`SET search_path TO ${schema}`);
      // Minimal physical-plan fixture; full migrated schema behavior is covered
      // by agent-schedules/postgres-live tests, not claimed by this fixture.
      await pool.query(`CREATE TABLE rooms(id uuid PRIMARY KEY,archived_at timestamptz);
        CREATE TABLE identities(id text PRIMARY KEY,kind text,hidden_from_roster boolean DEFAULT false,
          created_at timestamptz DEFAULT now(),last_app_active_at timestamptz,away_warning_at timestamptz);
        CREATE TABLE agents(agent_id text PRIMARY KEY,owner_id text);
        CREATE TABLE agent_subscriptions(id uuid,room_id uuid,agent_id text,paused_at timestamptz);
        CREATE TABLE memberships(room_id uuid,identity_id text,removed_at timestamptz);
        CREATE VIEW room_access AS SELECT * FROM memberships;
        CREATE TABLE agent_schedules(id uuid PRIMARY KEY,room_id uuid,agent_id text,creator_id text,
          owner_id text,workflow_slug text,human_command_message_id text,cadence jsonb,message text,
          max_runs int,run_count int DEFAULT 0,next_run_at timestamptz,updated_at timestamptz DEFAULT now(),
          workflow_run jsonb,paused_at timestamptz,failed_due_at timestamptz,failed_revision timestamptz);`);
      const source = readFileSync(new URL('./database.ts', import.meta.url), 'utf8');
      const index = source.match(/CREATE INDEX IF NOT EXISTS agent_schedules_admitted_due_idx[^;]+;/)?.[0];
      expect(index).toBeTruthy(); await pool.query(index!);
      await pool.query('INSERT INTO rooms(id) VALUES($1)', [room]);
      await pool.query("INSERT INTO identities(id,kind) VALUES('agent','agent'),('human','human')");
      await pool.query("INSERT INTO memberships VALUES($1,'agent',NULL),($1,'human',NULL)", [room]);
      await pool.query(`INSERT INTO agent_schedules(id,room_id,agent_id,creator_id,cadence,message,next_run_at,failed_due_at,failed_revision)
        SELECT gen_random_uuid(),$1,'agent','human','{"kind":"interval","everyMinutes":5}',
          'Synthetic',now()-interval '1 day',now()-interval '1 day',now() FROM generate_series(1,10000)`, [room]);
      await pool.query(`INSERT INTO agent_schedules(id,room_id,agent_id,creator_id,cadence,message,next_run_at)
        VALUES(gen_random_uuid(),$1,'agent','human','{"kind":"interval","everyMinutes":5}','Future',now()+interval '1 hour')`, [room]);
      await pool.query('ANALYZE agent_schedules');
      let deadlineSql = '';
      const transaction = vi.fn(async () => { throw new Error('future work was dispatched'); });
      const database = { query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('ORDER BY schedule.next_run_at')) deadlineSql = sql;
        return pool.query(sql, values);
      }, transaction } as unknown as SqlDatabase;
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2099-01-01'));
      const owner = new AgentScheduleLoop(database);
      await expect(owner.runOnce()).resolves.toBe(0);
      expect(transaction).not.toHaveBeenCalled();
      const delay = await owner.nextDelayMs();
      expect(delay).toBeGreaterThan(3_500_000); expect(delay).toBeLessThanOrEqual(3_600_000);
      const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${deadlineSql}`)).rows[0]['QUERY PLAN'][0].Plan;
      expect(JSON.stringify(plan)).toContain('agent_schedules_admitted_due_idx');
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(40);
    } finally {
      vi.useRealTimers();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end();
    }
  });
});
