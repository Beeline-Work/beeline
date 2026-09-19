import { PGlite } from '@electric-sql/pglite';
import type { QueryResultRow } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate, type QueryResult, type SqlDatabase } from './database.js';
import { PhoneService } from './phone-service.js';
import {
  assertHotRead,
  explainHotRead,
  HOT_READ_BUDGETS_MS,
  type HotReadName,
  type HotReadResult,
} from './production-corpus-performance.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000101';
const VIEWER = 'c'.repeat(64);
const AGENT = 'd'.repeat(64);
const ROOM_COUNT = 200;
const CORNER_COUNT = 40;
const WIDE_ROOM = '20000000-0000-4000-8000-000000000000';

/**
 * Width-shaped hot-read coverage: many Rooms, and one Room with many corners.
 * Complements production-corpus-hot-reads (one Room, deep history).
 */
describe('PRODUCTION-CORPUS width-shaped room-list', () => {
  let database: PgliteDatabase;
  let hotReads: HotReadDatabase;
  let phone: PhoneService;

  beforeAll(async () => {
    database = new PgliteDatabase(new PGlite());
    await migrate(database);
    hotReads = new HotReadDatabase(database);
    phone = new PhoneService(hotReads, 'http://local.test');
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Width Viewer','width'),($2,'agent','Width Agent','wagent')`,
      [VIEWER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, VIEWER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Width corpus')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [WORKSPACE, VIEWER, AGENT],
    );
    for (let i = 0; i < ROOM_COUNT; i += 1) {
      const roomId = `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
         VALUES($1,$2,NULL,$3,$4)`,
        [roomId, WORKSPACE, VIEWER, `Room ${i}`],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [WORKSPACE, roomId, VIEWER, AGENT],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         VALUES($1,$2,$3,$4,now()-($5::integer * interval '1 second'))`,
        [`width-msg-${String(i).padStart(3, '0')}`, roomId, VIEWER, `hello ${i}`, i],
      );
    }
    for (let i = 0; i < CORNER_COUNT; i += 1) {
      const cornerId = `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
         VALUES($1,$2,$3,$4,$5)`,
        [cornerId, WORKSPACE, WIDE_ROOM, VIEWER, `Corner ${i}`],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [WORKSPACE, cornerId, VIEWER, AGENT],
      );
      await database.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle)
         VALUES($1,$2,$3,'{"lifecycle":"working","checks":"unknown"}')`,
        [cornerId, AGENT, `Width corner ${i}`],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         VALUES($1,$2,$3,$4,now()-($5::integer * interval '1 second'))`,
        [`width-corner-msg-${String(i).padStart(3, '0')}`, cornerId, AGENT, `corner ${i}`, i],
      );
    }
    await database.query(`ANALYZE`);
  }, 120_000);

  it(`reads a ${ROOM_COUNT}-Room deck under the room-list budget with explainHotRead`, async () => {
    await phone.readChats(WORKSPACE, VIEWER);
    const measurement = await hotReads.awaitResult('room-list');
    assertHotRead(measurement);

    const started = performance.now();
    const view = await phone.readChats(WORKSPACE, VIEWER);
    const elapsedMs = performance.now() - started;
    expect(view.chats.length).toBe(ROOM_COUNT);
    expect(view.watchFilters[0]?.['#h']?.length).toBe(ROOM_COUNT);
    expect(elapsedMs).toBeLessThanOrEqual(HOT_READ_BUDGETS_MS['room-list']);
    console.log(
      JSON.stringify({
        path: 'width-room-list',
        rooms: ROOM_COUNT,
        elapsedMs: Math.round(elapsedMs),
        budgetMs: HOT_READ_BUDGETS_MS['room-list'],
        explainP95Ms: Math.round(measurement.p95Ms),
        watchFilterRooms: view.watchFilters[0]?.['#h']?.length ?? 0,
      }),
    );
  });

  it(`reads a Room with ${CORNER_COUNT} corners under the room-view budget with explainHotRead`, async () => {
    await phone.readRoom(WIDE_ROOM, VIEWER);
    const measurement = await hotReads.awaitResult('room-view');
    assertHotRead(measurement);

    const started = performance.now();
    const view = await phone.readRoom(WIDE_ROOM, VIEWER);
    const elapsedMs = performance.now() - started;
    expect(view.room.id).toBe(WIDE_ROOM);
    expect(view.corners.length).toBe(CORNER_COUNT);
    expect(elapsedMs).toBeLessThanOrEqual(HOT_READ_BUDGETS_MS['room-view']);
    console.log(
      JSON.stringify({
        path: 'width-many-corners',
        corners: CORNER_COUNT,
        elapsedMs: Math.round(elapsedMs),
        budgetMs: HOT_READ_BUDGETS_MS['room-view'],
        explainP95Ms: Math.round(measurement.p95Ms),
      }),
    );
  });
});

const matchers: ReadonlyArray<readonly [HotReadName, (sql: string) => boolean]> = [
  [
    'room-view',
    (sql) => sql.includes('WITH authorized_room AS') && sql.includes('transcript_rows AS'),
  ],
  ['room-list', (sql) => sql.includes('peer_activity_at') && sql.includes('FROM rooms r')],
];

class HotReadDatabase implements SqlDatabase {
  readonly results = new Map<HotReadName, HotReadResult>();
  readonly pending = new Map<HotReadName, Promise<HotReadResult>>();

  constructor(private readonly database: SqlDatabase) {}

  async awaitResult(name: HotReadName): Promise<HotReadResult> {
    const ready = this.results.get(name);
    if (ready) return ready;
    const pending = this.pending.get(name);
    if (!pending) throw new Error(`explainHotRead never ran for ${name}`);
    return pending;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const match = matchers.find(([, matches]) => matches(sql));
    if (match && !this.results.has(match[0]) && !this.pending.has(match[0])) {
      const measurement = explainHotRead(this.database, match[0], sql, values).then((result) => {
        this.results.set(match[0], result);
        return result;
      });
      this.pending.set(match[0], measurement);
      await measurement;
    }
    return this.database.query<Row>(sql, values);
  }

  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.database.transaction((database) => work(new HotReadDatabase(database)));
  }
}
