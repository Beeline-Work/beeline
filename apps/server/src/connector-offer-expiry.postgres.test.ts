import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { ConnectorOfferExpiryLoop } from './connector-offer-expiry.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Connector expiry proof requires isolated loopback PostgreSQL');
}
describe.skipIf(!url)('Connector offer expiry index and clock', () => {
  it('seeks the first connecting deadline under host clock skew without scanning terminal or future offers', async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const schema = `offer_due_${randomUUID().replaceAll('-', '')}`;
    try {
      await pool.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
      // Minimal physical fixture; real transitions and migrated source behavior
      // are covered by integration and connector-offer-expiry tests.
      await pool.query(`CREATE TABLE connector_offers(id uuid PRIMARY KEY,status text,accepted_at timestamptz,created_at timestamptz);
        INSERT INTO connector_offers SELECT gen_random_uuid(),'accepted',now()-interval '1 day',now()-interval '1 day' FROM generate_series(1,10000);
        INSERT INTO connector_offers SELECT gen_random_uuid(),'connecting',now()+interval '1 day',now() FROM generate_series(1,10000);
        INSERT INTO connector_offers VALUES(gen_random_uuid(),'connecting',now(),now());`);
      const source = readFileSync(new URL('./connector-offer-expiry.ts', import.meta.url), 'utf8');
      const index = source.match(/CREATE INDEX IF NOT EXISTS connector_offers_due_idx[^;]+;/)?.[0];
      expect(index).toBeTruthy(); await pool.query(index!);
      await pool.query('ANALYZE connector_offers');
      const statements: string[] = [];
      const db = { query: (sql: string, values?: unknown[]) => { statements.push(sql); return pool.query(sql, values); },
        transaction: async <T>(work: (db: SqlDatabase) => Promise<T>) => {
          await pool.query('BEGIN');
          try { const value=await work(db);await pool.query('COMMIT');return value; }
          catch(error) {await pool.query('ROLLBACK');throw error;}
        } } as SqlDatabase;
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2099-01-01'));
      const delay = await new ConnectorOfferExpiryLoop(db).runOnce();
      expect(delay).toBeGreaterThan(800_000);expect(delay).toBeLessThanOrEqual(900_000);
      expect(statements).toHaveLength(2);
      for (const sql of statements) {
        const plan=(await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'][0].Plan;
        expect(JSON.stringify(plan)).toContain('connector_offers_due_idx');
        expect(plan['Shared Hit Blocks']+plan['Shared Read Blocks']).toBeLessThan(40);
      }
    } finally {
      vi.useRealTimers();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();
    }
  });
});
