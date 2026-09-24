import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from '@beeline/api-contract/phone';
import {
  assertSchemaCurrent,
  backfillAgentHandles,
  backfillYoloModeDefault,
  MESSAGE_CURSOR_MS_SQL,
  migrate,
  APP_POOL_WAIT_TIMEOUT_MS,
  APP_STATEMENT_TIMEOUT_MS,
  ENRICHMENT_POOL_WAIT_TIMEOUT_MS,
  ENRICHMENT_STATEMENT_TIMEOUT_MS,
  postgresPoolConfig,
  markSchemaCurrent,
  PostgresDatabase,
  HEALTH_POOL_WAIT_TIMEOUT_MS,
} from './database.js';
import { backfillInheritedCornerMemberships } from './membership-join.js';
import { PgliteDatabase } from './test-support.js';
import { normalizeRoomNames, requireRoomSlug, reserveRoomName } from './room-names.js';

function result<Row>(rows: Row[]) {
  return { rows, rowCount: rows.length };
}

const TERMINATED = () => new Error('Connection terminated unexpectedly');

describe('Room slugs', () => {
  it('normalizes old names deterministically and retains unambiguous references', async () => {
    const db = new PgliteDatabase();
    await migrate(db);
    await db.query('DROP INDEX rooms_workspace_slug_idx');
    const workspace = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Slug test')`, [workspace]);
    const ids = Array.from(
      { length: 4 },
      (_, index) => `bbbbbbbb-bbbb-4bbb-bbbb-${String(index + 1).padStart(12, '0')}`,
    );
    for (const [index, name] of ['Road Map', 'Road Map', 'Café & Tea', 'cafe-tea'].entries())
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,$3)`, [
        ids[index],
        workspace,
        name,
      ]);
    await normalizeRoomNames(db);
    const names = await db.query<{ id: string; name: string }>(
      'SELECT id,name FROM rooms WHERE workspace_id=$1 ORDER BY id',
      [workspace],
    );
    expect(names.rows.map((row) => row.name)).toEqual([
      'road-map',
      'road-map-2',
      'cafe-tea-2',
      'cafe-tea',
    ]);
    const aliases = await db.query<{ room_id: string; name: string }>(
      'SELECT room_id,name FROM room_name_aliases WHERE workspace_id=$1 ORDER BY room_id',
      [workspace],
    );
    expect(aliases.rows).toEqual([{ room_id: ids[2], name: 'Café & Tea' }]);
    await normalizeRoomNames(db);
    expect(
      (await db.query('SELECT * FROM room_name_aliases WHERE workspace_id=$1', [workspace]))
        .rowCount,
    ).toBe(1);
  });

  it('keeps duplicate legacy names ambiguous and unavailable after migration', async () => {
    const db = new PgliteDatabase();
    await migrate(db);
    await db.query('DROP INDEX rooms_workspace_slug_idx');
    const workspace = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const first = 'bbbbbbbb-bbbb-4bbb-bbbb-000000000001';
    const second = 'bbbbbbbb-bbbb-4bbb-bbbb-000000000002';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Ambiguous names')`, [workspace]);
    for (const id of [first, second])
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'foo')`, [
        id,
        workspace,
      ]);

    await normalizeRoomNames(db);
    expect(
      (await db.query<{ name: string }>(
        'SELECT name FROM rooms WHERE workspace_id=$1 ORDER BY id',
        [workspace],
      )).rows.map((row) => row.name),
    ).toEqual(['foo-2', 'foo-3']);
    expect(
      (await db.query('SELECT 1 FROM room_name_aliases WHERE workspace_id=$1', [workspace]))
        .rowCount,
    ).toBe(0);
    expect(
      (await db.query<{ name: string }>(
        'SELECT name FROM room_name_ambiguities WHERE workspace_id=$1',
        [workspace],
      )).rows,
    ).toEqual([{ name: 'foo' }]);
    await expect(reserveRoomName(db, workspace, 'foo')).rejects.toThrow(/conflict/);
    await expect(reserveRoomName(db, workspace, 'foo', first)).rejects.toThrow(/conflict/);
    await normalizeRoomNames(db);
    expect(
      (await db.query<{ name: string }>(
        'SELECT name FROM rooms WHERE workspace_id=$1 ORDER BY id',
        [workspace],
      )).rows.map((row) => row.name),
    ).toEqual(['foo-2', 'foo-3']);
    await expect(reserveRoomName(db, workspace, 'foo')).rejects.toThrow(/conflict/);
    await db.query('DELETE FROM rooms WHERE workspace_id=$1', [workspace]);
    await expect(reserveRoomName(db, workspace, 'foo')).rejects.toThrow(/conflict/);
  });

  it('requires a bounded lowercase slug for new names', () => {
    expect(requireRoomSlug('room-name-2')).toBe('room-name-2');
    for (const value of ['Room Name', 'room--name', '-room', 'room-', ''])
      expect(() => requireRoomSlug(value)).toThrow(/invalid Room name/);
  });
});

function stubClient() {
  const client = new EventEmitter() as EventEmitter & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  client.query = vi.fn().mockResolvedValue(result([]));
  client.release = vi.fn();
  return client;
}

function poolHandingOut(clients: unknown[]) {
  const connect = vi.fn();
  clients.forEach((client) => connect.mockResolvedValueOnce(client));
  return { query: vi.fn(), on: vi.fn(), connect, end: vi.fn() } as unknown as Pool;
}

describe('a terminated checked-out connection never wedges the pool', () => {
  it('frees a checked-out transaction client that errors while no query is pending, and the pool recovers', async () => {
    const dying = stubClient();
    dying.query
      .mockResolvedValueOnce(result([])) // BEGIN
      .mockRejectedValue(TERMINATED()); // COMMIT (and ROLLBACK) on the dead socket
    const healthy = stubClient();
    const database = new PostgresDatabase('', 5, { pool: poolHandingOut([dying, healthy]) });

    let releaseWork: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      releaseWork = resolve;
    }).then(() => 'first work');
    const first = database.transaction(() => work);
    await vi.waitFor(() => expect(dying.query).toHaveBeenCalledWith('BEGIN'));

    // The socket dies while the transaction body is doing non-database work:
    // nothing in the app is awaiting this client, so nothing else will free it.
    dying.emit('error', TERMINATED());
    expect(dying.release).toHaveBeenCalledWith(expect.any(Error));

    releaseWork!();
    await expect(first).rejects.toThrow(/Connection terminated/);
    // The app's own finally must not double-release the reclaimed client.
    expect(dying.release).toHaveBeenCalledTimes(1);

    // The freed slot hands out a fresh client: the pool recovered.
    await expect(database.transaction(() => 'second work')).resolves.toBe('second work');
    expect(healthy.query).toHaveBeenCalledWith('BEGIN');
  });

  it('releases and recovers when a pool query hits a terminated connection', async () => {
    const pool = {
      query: vi
        .fn()
        .mockRejectedValueOnce(TERMINATED())
        .mockResolvedValueOnce(result([{ answer: 2 }])),
      on: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(),
    } as unknown as Pool;
    const database = new PostgresDatabase('', 5, { pool, pause: async () => {} });

    await expect(database.query<{ answer: number }>('SELECT 2')).resolves.toEqual(
      result([{ answer: 2 }]),
    );
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('bounds every pool acquisition and keeps half-open connections from hanging silently', () => {
    expect(postgresPoolConfig('postgres://app', 1, 'long-running')).toMatchObject({
      connectionTimeoutMillis: APP_POOL_WAIT_TIMEOUT_MS,
      keepAlive: true,
    });
    expect(postgresPoolConfig('postgres://app', 1, 'diagnostics')).toMatchObject({
      connectionTimeoutMillis: HEALTH_POOL_WAIT_TIMEOUT_MS,
      keepAlive: true,
    });
  });
});

describe('release-owned schema readiness', () => {
  it('fails boot clearly until the release migration writes its final marker', async () => {
    const database = new PgliteDatabase();
    await expect(assertSchemaCurrent(database)).rejects.toThrow(
      /database schema is not ready.*release migration step/,
    );
    await migrate(database);
    await expect(assertSchemaCurrent(database)).rejects.toThrow(/release migration step/);
    await markSchemaCurrent(database);
    await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
    database.close();
  });
});

describe('PostgresDatabase reconnects', () => {
  it('bounds app and enrichment statements and pool checkout waits', () => {
    expect(postgresPoolConfig('postgres://app', 7)).toMatchObject({
      max: 7,
      statement_timeout: APP_STATEMENT_TIMEOUT_MS,
      connectionTimeoutMillis: APP_POOL_WAIT_TIMEOUT_MS,
      application_name: 'beeline_app',
    });
    expect(postgresPoolConfig('postgres://app', 2, 'enrichment')).toMatchObject({
      max: 2,
      statement_timeout: ENRICHMENT_STATEMENT_TIMEOUT_MS,
      connectionTimeoutMillis: ENRICHMENT_POOL_WAIT_TIMEOUT_MS,
      application_name: 'beeline_enrichment',
    });
    expect(postgresPoolConfig('postgres://owner', 1, 'long-running')).not.toHaveProperty(
      'statement_timeout',
    );
  });

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
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue(result([])),
      release: vi.fn(),
    });
    const connect = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('server closed the connection'), { code: '08006' }),
      )
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

describe('the membership inviter migration', () => {
  const OWNER = 'a'.repeat(64);
  const MEMBER = 'b'.repeat(64);
  const WORKSPACE = '11111111-1111-4111-8111-111111111111';
  let database: PgliteDatabase;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
  });

  afterEach(() => database.close());

  it('upgrades legacy inviter references so deleting an inviter preserves the member', async () => {
    await database.query(`ALTER TABLE memberships DROP CONSTRAINT memberships_invited_by_fkey`);
    await database.query(
      `ALTER TABLE memberships ADD CONSTRAINT memberships_invited_by_fkey
       FOREIGN KEY (invited_by) REFERENCES identities(id)`,
    );
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Member')`,
      [OWNER, MEMBER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role,invited_by)
       VALUES($1,NULL,$2,'member',$3)`,
      [WORKSPACE, MEMBER, OWNER],
    );

    await migrate(database);
    await database.query(`DELETE FROM identities WHERE id=$1`, [OWNER]);

    expect(
      (
        await database.query<{ invited_by: string | null }>(
          `SELECT invited_by FROM memberships WHERE workspace_id=$1 AND identity_id=$2`,
          [WORKSPACE, MEMBER],
        )
      ).rows,
    ).toEqual([{ invited_by: null }]);
  });
});

describe('the three-level push migration', () => {
  const OWNER = 'a'.repeat(64);
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
  });
  afterEach(() => database.close());

  it('maps every stored all level to mine and refuses new all rows', async () => {
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [
      OWNER,
    ]);
    // Simulate a legacy database still carrying the retired level.
    await database.query(`ALTER TABLE identities DROP CONSTRAINT identities_push_level_check`);
    await database.query(`UPDATE identities SET push_level='all' WHERE id=$1`, [OWNER]);
    // The migration maps it to the nearest surviving level, and the CHECK
    // constraint no longer accepts 'all'.
    await migrate(database);
    expect(
      (
        await database.query<{ push_level: string }>(
          `SELECT push_level FROM identities WHERE id=$1`,
          [OWNER],
        )
      ).rows[0]?.push_level,
    ).toBe('mine');
    await expect(
      database.query(`UPDATE identities SET push_level='all' WHERE id=$1`, [OWNER]),
    ).rejects.toThrow();
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

describe('the agent handle migration', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
  });
  afterEach(() => database.close());

  it('replaces unrelated and duplicate legacy handles with unique name-derived addresses', async () => {
    const human = 'a'.repeat(64);
    const goosy = 'b'.repeat(64);
    const lumen = 'c'.repeat(64);
    const secondLumen = 'd'.repeat(64);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Alice','alice'),
       ($2,'agent','Goosy','nora'),
       ($3,'agent','Lumen','una'),
       ($4,'agent','Lumen','nora')`,
      [human, goosy, lumen, secondLumen],
    );
    const workspace = '11111111-1111-4111-8111-111111111111';
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Tubing Crew')`, [workspace]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,NULL,$4,'member'),($1,NULL,$5,'member')`,
      [workspace, human, goosy, lumen, secondLumen],
    );

    await expect(backfillAgentHandles(database)).resolves.toBe(3);
    const rows = await database.query<{ name: string; handle: string }>(
      `SELECT name,handle FROM identities WHERE kind='agent' ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { name: 'Goosy', handle: 'goosy' },
      { name: 'Lumen', handle: 'lumen' },
      { name: 'Lumen', handle: 'lumen_2' },
    ]);
    await expect(backfillAgentHandles(database)).resolves.toBe(0);
  });

  it('allocates after the welcome membership backfill', async () => {
    const human = 'e'.repeat(64);
    const agent = 'f'.repeat(64);
    const otherWorkspace = '22222222-2222-4222-8222-222222222222';
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Lumen','lumen'),($2,'agent','Lumen','nora')`,
      [human, agent],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Elsewhere')`, [
      otherWorkspace,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'member'),($3,NULL,$4,'member')`,
      [DEFAULT_WORKSPACE_ID, agent, otherWorkspace, human],
    );

    await migrate(database);

    expect(
      (await database.query(`SELECT handle FROM identities WHERE id=$1`, [agent])).rows,
    ).toEqual([{ handle: 'lumen_2' }]);
  });
});

describe('the inherited corner membership migration', () => {
  const OWNER = 'a'.repeat(64);
  const LATE_MEMBER = 'b'.repeat(64);
  const REMOVED_MEMBER = 'c'.repeat(64);
  const WORKSPACE = '11111111-1111-4111-8111-111111111111';
  const ROOM = '22222222-2222-4222-8222-222222222222';
  const CORNER = '33333333-3333-4333-8333-333333333333';
  let database: PgliteDatabase;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Owner'),($2,'human','Late'),($3,'agent','Removed')`,
      [OWNER, LATE_MEMBER, REMOVED_MEMBER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Corner')`,
      [CORNER, WORKSPACE, ROOM],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role,removed_at) VALUES
       ($1,$2,$3,'owner',NULL),($1,$2,$4,'member',NULL),
       ($1,$2,$5,'member',NULL),($1,$6,$5,'member',now())`,
      [WORKSPACE, ROOM, OWNER, LATE_MEMBER, REMOVED_MEMBER, CORNER],
    );
    await database.query(
      `UPDATE memberships SET event_subscriptions='["check-passed"]'::jsonb
       WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, LATE_MEMBER],
    );
  });

  afterEach(() => database.close());

  it('adds absent late joiners without restoring an explicitly removed corner member', async () => {
    await expect(backfillInheritedCornerMemberships(database)).resolves.toBe(2);
    const memberships = await database.query<{
      identity_id: string;
      role: string;
      removed_at: Date | null;
      event_subscriptions: string[];
    }>(
      `SELECT identity_id,role,removed_at,event_subscriptions FROM memberships
       WHERE room_id=$1 ORDER BY identity_id`,
      [CORNER],
    );
    expect(memberships.rows).toEqual([
      { identity_id: OWNER, role: 'owner', removed_at: null, event_subscriptions: [] },
      {
        identity_id: LATE_MEMBER,
        role: 'member',
        removed_at: null,
        event_subscriptions: ['check-passed'],
      },
      {
        identity_id: REMOVED_MEMBER,
        role: 'member',
        removed_at: expect.any(Date),
        event_subscriptions: [],
      },
    ]);
    await expect(backfillInheritedCornerMemberships(database)).resolves.toBe(0);
  });
});

describe('the top-level shared Room role migration', () => {
  it('repairs shared Room roles without changing corner or DM authority', async () => {
    const database = new PgliteDatabase();
    await migrate(database);
    const workspace = '41111111-1111-4111-8111-111111111111';
    const room = '42222222-2222-4222-8222-222222222222';
    const corner = '43333333-3333-4333-8333-333333333333';
    const dm = '44444444-4444-4444-8444-444444444444';
    const member = 'd'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Admin')`, [
      member,
    ]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [workspace]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,direct_participants) VALUES
       ($1,$4,NULL,'Room',NULL),($2,$4,$1,'Corner',NULL),($3,$4,NULL,'DM',$5::jsonb)`,
      [room, corner, dm, workspace, JSON.stringify([member])],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'admin'),($1,$3,$2,'member'),($1,$4,$2,'owner'),($1,$5,$2,'owner')`,
      [workspace, member, room, corner, dm],
    );

    await migrate(database);

    const roles = await database.query<{ room_id: string | null; role: string }>(
      `SELECT room_id,role FROM memberships WHERE workspace_id=$1 AND identity_id=$2
       ORDER BY room_id NULLS FIRST`,
      [workspace, member],
    );
    expect(roles.rows).toEqual([
      { room_id: null, role: 'admin' },
      { room_id: room, role: 'admin' },
      { room_id: corner, role: 'owner' },
      { room_id: dm, role: 'owner' },
    ]);
    database.close();
  });
});

describe('the workspace_connectors machine_id migration ordering', () => {
  let database: PgliteDatabase;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
  });

  afterEach(() => database.close());

  it('adds machine_id before the unique index when the table already exists without it', async () => {
    // Simulate the pre-migration production shape: a workspace_connectors
    // table that already exists WITHOUT the machine_id column. This is what
    // happens when migrate() runs against a database created by an older
    // release: the CREATE TABLE IF NOT EXISTS is a no-op.
    await database.query(`DROP TABLE IF EXISTS connection_receipts CASCADE`);
    await database.query(`DROP TABLE IF EXISTS workspace_connections CASCADE`);
    await database.query(`DROP TABLE IF EXISTS workspace_connectors CASCADE`);

    // Recreate the old schema: same columns but no machine_id / sign_in / etc.
    await database.query(`
      CREATE TABLE workspace_connectors (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
        connector_type text NOT NULL,
        helper_agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'installing'
          CHECK (status IN ('installing','connected','error','disconnected')),
        status_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
        status_error text,
        pending_ops jsonb NOT NULL DEFAULT '[]'::jsonb,
        connected_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Recreate the old unique index that the migration will replace
    await database.query(`
      CREATE UNIQUE INDEX workspace_connectors_owner_unique
        ON workspace_connectors(workspace_id, owner_identity_id, connector_type)
    `);

    // This must NOT throw: after the fix, ADD COLUMN IF NOT EXISTS machine_id
    // runs before the unique index that references it.
    await expect(migrate(database)).resolves.toBeUndefined();

    // Verify machine_id column exists
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='workspace_connectors' AND column_name='machine_id'`,
    );
    expect(columns.rows.length).toBe(1);

    // Verify the unique index on machine_id exists
    const indexes = await database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='workspace_connectors' AND indexname='workspace_connectors_machine_unique'`,
    );
    expect(indexes.rows.length).toBe(1);
  });
});

describe('the agent_grants kind vocabulary migration', () => {
  let database: PgliteDatabase;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
  });

  afterEach(() => database.close());

    it('widens the agent_grants kind check so an upgraded database accepts an mcp route', async () => {
      // The pre-migration production shape: agent_grants already exists, so the
      // CREATE TABLE IF NOT EXISTS is a no-op and the old CHECK survives.
      await database.query(`ALTER TABLE agent_grants DROP CONSTRAINT IF EXISTS agent_grants_kind_check`);
      await database.query(`ALTER TABLE agent_grants ADD CONSTRAINT agent_grants_kind_check
        CHECK (kind IN ('path','host','secret','device','budget','command'))`);
      const owner = 'a'.repeat(64);
      const agent = 'b'.repeat(64);
      await database.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [owner, agent],
      );
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
      const storeRoute = (kind: string) =>
        database.query(
          `INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status)
           VALUES(gen_random_uuid(),$3,$1,$5,$2,'squire','route it',$4,'pending')`,
          [DEFAULT_WORKSPACE_ID, kind, agent, owner, WELCOME_ROOM_ID],
        );

      await expect(storeRoute('mcp')).rejects.toThrow();

      await migrate(database);

      await expect(storeRoute('mcp')).resolves.toBeDefined();
      // Widening the vocabulary is not removing it: an unknown kind is still refused.
      await expect(storeRoute('nonsense')).rejects.toThrow();
      expect(
        (await database.query<{ kind: string }>(`SELECT kind FROM agent_grants`)).rows,
      ).toEqual([{ kind: 'mcp' }]);
    });
});
