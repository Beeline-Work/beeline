import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresDatabase } from './database.js';

function result<Row>(rows: Row[]) {
  return { rows, rowCount: rows.length };
}

describe('PostgresDatabase reconnects', () => {
  it('retries a transient pool query with a fresh attempt', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce(result([{ answer: 1 }]));
    const pool = { query, on: vi.fn(), connect: vi.fn(), end: vi.fn() } as unknown as Pool;
    const database = new PostgresDatabase('', 5, { pool, pause: async () => {} });

    await expect(database.query<{ answer: number }>('SELECT 1')).resolves.toEqual(
      result([{ answer: 1 }]),
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('does not retry non-connection errors', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    const query = vi.fn().mockRejectedValue(uniqueViolation);
    const pool = { query, on: vi.fn(), connect: vi.fn(), end: vi.fn() } as unknown as Pool;
    const database = new PostgresDatabase('', 5, { pool, pause: async () => {} });

    await expect(database.query('SELECT 1')).rejects.toBe(uniqueViolation);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('retries transaction acquisition but does not replay transaction work', async () => {
    const client = {
      query: vi.fn().mockResolvedValue(result([])),
      release: vi.fn(),
    };
    const connect = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('server closed the connection'), { code: '08006' }))
      .mockResolvedValueOnce(client);
    const pool = { query: vi.fn(), on: vi.fn(), connect, end: vi.fn() } as unknown as Pool;
    const database = new PostgresDatabase('', 5, { pool, pause: async () => {} });
    const work = vi.fn().mockResolvedValue('complete');

    await expect(database.transaction(work)).resolves.toBe('complete');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(2, 'COMMIT');
  });
});
