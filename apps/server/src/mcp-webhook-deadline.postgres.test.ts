import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from './database.js';
import { runMcpWebhookDelivery } from './rooms-mcp-members.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('MCP deadline proof requires isolated loopback PostgreSQL');
}

describe.skipIf(!url)('MCP deadline physical query budget', () => {
  it('reads one indexed candidate per queue, including claimed rows, in a non-UTC session', async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const schema = `mcp_due_${randomUUID().replaceAll('-', '')}`;
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`SET search_path TO ${schema}`);
      await pool.query("SET TIME ZONE 'America/New_York'");
      for (const [table, column, file] of [
        ['rooms_mcp_webhook_outbox', 'created_at', 'subscription-webhooks.ts'],
        ['rooms_mcp_event_deliveries', 'next_attempt_at', 'rooms-mcp-schema.ts'],
      ]) {
        await pool.query(`CREATE TABLE ${table} (${column} timestamptz, claimed_at timestamptz,
          delivered_at timestamptz, attempts integer NOT NULL)`);
        const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
        const index = source.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${table}_due[^;]+;`))?.[0];
        expect(index).toBeTruthy();
        await pool.query(index!);
        await pool.query(`INSERT INTO ${table} SELECT now()+n*interval '1 second',
          CASE WHEN n=1 THEN now() ELSE NULL END,NULL,0 FROM generate_series(1,10000) n`);
        await pool.query(`ANALYZE ${table}`);
      }
      let deadlineSql = '';
      const database = { query: async (sql: string) => {
        deadlineSql = sql;
        return pool.query(sql);
      } } as unknown as SqlDatabase;
      // Zero delivery budget isolates the production deadline query from claims.
      const delay = await runMcpWebhookDelivery(database, undefined, 0);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(2000);
      const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${deadlineSql}`);
      const plan = result.rows[0]['QUERY PLAN'][0].Plan;
      const serialized = JSON.stringify(plan);
      expect(serialized).toContain('rooms_mcp_webhook_outbox_due');
      expect(serialized).toContain('rooms_mcp_event_deliveries_due');
      expect(serialized).not.toContain('Seq Scan');
      expect(serialized).not.toContain('"Node Type":"Sort"');
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(20);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });
});
