import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  backfillYoloModeDefault,
  MESSAGE_CURSOR_MS_SQL,
  migrate,
  PostgresDatabase,
} from './database.js';
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

describe('the message cursor index', () => {
  const AUTHOR = 'a'.repeat(64);
  const WORKSPACE = '11111111-1111-4111-8111-111111111111';
  const ROOM = '22222222-2222-4222-8222-222222222222';
  let database: PgliteDatabase;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [
      AUTHOR,
    ]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,
      [ROOM, WORKSPACE, AUTHOR],
    );
  });

  afterEach(() => database.close());

  it('uses the expression index for the seeded inbox query plan', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT lpad(value::text,64,'0'),$1,$2,'message',
              '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 millisecond'
       FROM generate_series(1,10000) value`,
      [ROOM, AUTHOR],
    );
    await database.query(`ANALYZE messages`);

    const explained = await database.query<Record<'QUERY PLAN', unknown>>(
      `EXPLAIN (FORMAT JSON)
       SELECT id,${MESSAGE_CURSOR_MS_SQL} cursor_ms FROM messages
       WHERE room_id=$1 AND (${MESSAGE_CURSOR_MS_SQL},id)>($2::bigint,$3)
       ORDER BY cursor_ms,id LIMIT 101`,
      [ROOM, Date.parse('2026-01-01T00:00:05Z'), '0'.repeat(64)],
    );
    const plan = JSON.stringify(explained.rows[0]?.['QUERY PLAN']);
    expect(plan).toContain('messages_room_cursor_idx');
    expect(plan).not.toMatch(/"Node Type":"Seq Scan"[^}]*"Relation Name":"messages"/);
  });

  it('keeps same-millisecond order and cursor round-trips tied to the message id', async () => {
    const lowerId = '1'.repeat(64);
    const higherId = '2'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
       ($1,$3,$4,'later microsecond','2026-09-06T12:00:00.000900Z'),
       ($2,$3,$4,'earlier microsecond','2026-09-06T12:00:00.000100Z')`,
      [lowerId, higherId, ROOM, AUTHOR],
    );

    const first = await database.query<{ id: string; cursor_ms: number | string }>(
      `SELECT id,${MESSAGE_CURSOR_MS_SQL} cursor_ms FROM messages
       WHERE room_id=$1 ORDER BY cursor_ms,id LIMIT 1`,
      [ROOM],
    );
    expect(first.rows).toEqual([{ id: lowerId, cursor_ms: 1_788_696_000_000 }]);
    const cursor = first.rows[0]!;
    const after = await database.query<{ id: string }>(
      `SELECT id FROM messages WHERE room_id=$1
       AND (${MESSAGE_CURSOR_MS_SQL},id)>($2::bigint,$3)
       ORDER BY ${MESSAGE_CURSOR_MS_SQL},id`,
      [ROOM, cursor.cursor_ms, cursor.id],
    );
    expect(after.rows).toEqual([{ id: higherId }]);
  });

  it('matches the persisted cursor expression across time-zone edge cases', async () => {
    const timestamps = [
      '1965-03-14T07:00:00.123456Z',
      '2026-03-08T06:59:59.999999Z',
      '2026-03-08T07:00:00.000001Z',
      '2026-11-01T05:59:59.999999Z',
      '2026-11-01T06:00:00.000001Z',
      '2200-01-01T00:00:00.654321Z',
    ];
    const result = await database.query<{ old_cursor: string; indexed_cursor: string }>(
      `SELECT floor(extract(epoch FROM created_at)*1000)::bigint old_cursor,
              ${MESSAGE_CURSOR_MS_SQL} indexed_cursor
       FROM unnest($1::timestamptz[]) created_at`,
      [timestamps],
    );

    expect(result.rows.every((row) => row.old_cursor === row.indexed_cursor)).toBe(true);
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
