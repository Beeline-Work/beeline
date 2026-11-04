import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase } from './database.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Lost-reply proof requires isolated loopback PostgreSQL');
}

describe.skipIf(!url)('PostgreSQL effects with lost replies', () => {
  it.each(['autocommit', 'commit'])('does not repeat a committed %s effect', async (boundary) => {
    const schema = `one_attempt_${randomUUID().replaceAll('-', '')}`;
    const observer = new Pool({ connectionString: url, max: 1 });
    const writer = new Pool({ connectionString: url, max: 1 });
    const failure = new Error('Connection terminated unexpectedly');
    const connect = writer.connect.bind(writer);
    let lost = false;
    let acquisitions = 0;
    // Lose only the reply, after PostgreSQL has performed the real effect.
    // Another physical checkout would reveal a forbidden replay, not hide it
    // behind a uniqueness constraint or a fake in-memory effect counter.
    writer.connect = (async () => {
      acquisitions++;
      const client = await connect();
      const query = client.query.bind(client);
      client.query = (async (sql: string, values?: unknown[]) => {
        const result = await query(sql, values);
        if (!lost && (boundary === 'commit' ? sql === 'COMMIT' : sql.startsWith('INSERT'))) {
          lost = true;
          throw failure;
        }
        return result;
      }) as typeof client.query;
      return client;
    }) as typeof writer.connect;
    const database = new PostgresDatabase('', 1, { pool: writer });
    try {
      await observer.query(`CREATE SCHEMA ${schema}`);
      await observer.query(`CREATE TABLE ${schema}.effects(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY)`);
      const insert = `INSERT INTO ${schema}.effects DEFAULT VALUES RETURNING id`;
      const work = vi.fn(async () => database.query(insert));
      if (boundary === 'autocommit') {
        await expect(work()).rejects.toBe(failure);
        expect(work).toHaveBeenCalledOnce();
      } else {
        const transaction = vi.fn(async (db: { query(sql: string): Promise<unknown> }) => db.query(insert));
        await expect(database.transaction(transaction)).rejects.toBe(failure);
        expect(transaction).toHaveBeenCalledOnce();
      }
      expect(lost).toBe(true);
      expect(acquisitions).toBe(1);
      expect((await observer.query(`SELECT count(*)::int count FROM ${schema}.effects`)).rows).toEqual([{ count: 1 }]);
    } finally {
      await database.close();
      await observer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await observer.end();
    }
  });
});
