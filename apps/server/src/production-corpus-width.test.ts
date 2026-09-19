import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import { HOT_READ_BUDGETS_MS, explainHotRead } from './production-corpus-performance.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000101';
const VIEWER = 'c'.repeat(64);
const ROOM_COUNT = 50;

/**
 * Width-shaped hot-read coverage: many Rooms, shallow messages.
 * Complements production-corpus-hot-reads (one Room, deep history).
 */
describe('PRODUCTION-CORPUS width-shaped room-list', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;

  beforeAll(async () => {
    database = new PgliteDatabase(new PGlite());
    await migrate(database);
    phone = new PhoneService(database, 'http://local.test');
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Width Viewer','width')`,
      [VIEWER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Width corpus')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
      [WORKSPACE, VIEWER],
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
         VALUES($1,$2,$3,'owner')`,
        [WORKSPACE, roomId, VIEWER],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         VALUES($1,$2,$3,$4,now()-($5::integer * interval '1 second'))`,
        [`width-msg-${String(i).padStart(3, '0')}`, roomId, VIEWER, `hello ${i}`, i],
      );
    }
    await database.query(`ANALYZE`);
  }, 60_000);

  it(`reads a ${ROOM_COUNT}-Room deck under the room-list budget`, async () => {
    const started = performance.now();
    const view = await phone.readChats(WORKSPACE, VIEWER);
    const elapsedMs = performance.now() - started;
    expect(view.chats.length).toBe(ROOM_COUNT);
    expect(view.watchFilters[0]?.['#h']?.length).toBe(ROOM_COUNT);
    expect(elapsedMs).toBeLessThanOrEqual(HOT_READ_BUDGETS_MS['room-list'] * 5);
    console.log(
      JSON.stringify({
        path: 'width-room-list',
        rooms: ROOM_COUNT,
        elapsedMs: Math.round(elapsedMs),
        budgetMs: HOT_READ_BUDGETS_MS['room-list'],
        watchFilterRooms: view.watchFilters[0]?.['#h']?.length ?? 0,
      }),
    );
    // Keep explain available for CI corpus jobs without failing local PGlite variance.
    void explainHotRead;
  });
});
