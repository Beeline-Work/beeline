import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { backfillYoloModeDefault, migrate, PostgresDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';

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

  it('handles an error emitted by a dedicated client', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(),
      release: vi.fn(),
    });
    const pool = {
      query: vi.fn(),
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
      end: vi.fn(),
    } as unknown as Pool;
    const database = new PostgresDatabase('', 5, { pool, pause: async () => {} });
    const error = new Error('Connection terminated unexpectedly');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const dedicated = await database.connectDedicated();

    expect(client.listenerCount('error')).toBe(1);
    expect(() => dedicated.emit('error', error)).not.toThrow();
    expect(errorLog).toHaveBeenCalledWith('dedicated postgres client error', error);
  });
});

describe('the yolo default migration', () => {
  const OWNER = 'a'.repeat(64);
  const ON_AGENT = '1'.repeat(64);
  const OFF_AGENT = '2'.repeat(64);
  const ALREADY_ON_AGENT = '3'.repeat(64);
  const FRESH_AGENT = '4'.repeat(64);
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
      OWNER,
    ]);
  });
  afterEach(() => database.close());

  it('flips every existing agent, including one an owner had explicitly turned off, and reports the count', async () => {
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'agent','On'),($2,'agent','Off'),($3,'agent','AlreadyOn')`,
      [ON_AGENT, OFF_AGENT, ALREADY_ON_AGENT],
    );
    // Simulates rows written before this migration: the pre-change default (false),
    // an owner's explicit off, and an agent an owner had already turned on.
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,yolo_mode) VALUES($1,$4,false),($2,$4,false),($3,$4,true)`,
      [ON_AGENT, OFF_AGENT, ALREADY_ON_AGENT, OWNER],
    );
    await expect(backfillYoloModeDefault(database)).resolves.toBe(2);
    const rows = await database.query<{ agent_id: string; yolo_mode: boolean }>(
      `SELECT agent_id,yolo_mode FROM agents ORDER BY agent_id`,
    );
    expect(rows.rows).toEqual([
      { agent_id: ON_AGENT, yolo_mode: true },
      { agent_id: OFF_AGENT, yolo_mode: true },
      { agent_id: ALREADY_ON_AGENT, yolo_mode: true },
    ]);
    // A second run is a no-op: nothing left to flip.
    await expect(backfillYoloModeDefault(database)).resolves.toBe(0);
  });

  it('defaults a newly created agent to yolo on', async () => {
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Fresh')`, [
      FRESH_AGENT,
    ]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [
      FRESH_AGENT,
      OWNER,
    ]);
    const rows = await database.query<{ yolo_mode: boolean }>(
      `SELECT yolo_mode FROM agents WHERE agent_id=$1`,
      [FRESH_AGENT],
    );
    expect(rows.rows).toEqual([{ yolo_mode: true }]);
  });
});
