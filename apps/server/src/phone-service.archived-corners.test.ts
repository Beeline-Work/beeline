import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

const VIEWER = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const LIVE = '33333333-3333-4333-8333-333333333331';
const OPENED_FIRST = '33333333-3333-4333-8333-333333333332';
const OPENED_SECOND = '33333333-3333-4333-8333-333333333333';

/**
 * The corner that opened FIRST closes LAST, so closure order and creation
 * order disagree. Any list that happens to be ordered by `created_at` reads
 * these two the wrong way round.
 */
const OPENED_FIRST_CLOSED_AT = '2026-03-02T00:00:00Z';
const OPENED_SECOND_CLOSED_AT = '2026-03-01T00:00:00Z';

async function fixture(seed?: (database: PgliteDatabase) => Promise<unknown>) {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada')`,
    [VIEWER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'alpha')`,
    [ROOM, WORKSPACE, VIEWER],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,created_at,archived_at) VALUES
      ($1,$5,$4,$6,'Live work','2026-01-01T00:00:00Z',NULL),
      ($2,$5,$4,$6,'Opened first','2026-01-02T00:00:00Z',$7),
      ($3,$5,$4,$6,'Opened second','2026-01-03T00:00:00Z',$8)`,
    [
      LIVE,
      OPENED_FIRST,
      OPENED_SECOND,
      ROOM,
      WORKSPACE,
      VIEWER,
      OPENED_FIRST_CLOSED_AT,
      OPENED_SECOND_CLOSED_AT,
    ],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$4,$2,'owner'),
      ($1,$5,$2,'owner'),($1,$6,$2,'owner')`,
    [WORKSPACE, VIEWER, ROOM, LIVE, OPENED_FIRST, OPENED_SECOND],
  );
  await seed?.(database);
  return new PhoneService(database, 'http://local.test');
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1_000);

describe('readCorners', () => {
  it('projects the ordered live list into its parent status frame', async () => {
    const phone = await fixture();
    const status = await phone.liveChatCornerStatus(ROOM, VIEWER);
    expect(status?.cornerCount).toBe(1);
    expect(status?.corners.map((item) => item.corner.id)).toEqual([LIVE]);
    expect(status?.corners).toEqual((await phone.readCorners(ROOM, VIEWER))?.corners);
  });
  it('leaves closed work out of the live list', async () => {
    const phone = await fixture();
    const view = await phone.readCorners(ROOM, VIEWER);
    expect(view?.corners.map((item) => item.corner.id)).toEqual([LIVE]);
    expect(view?.corners[0]?.closedAt).toBeUndefined();
  });

  it('pages open corners in creation order without repeating a row', async () => {
    const phone = await fixture(async (database) => {
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,created_at)
         SELECT ('44444444-4444-4444-8444-' || lpad(series::text,12,'0'))::uuid,
           $1,$2,$3,'Open ' || series,'2026-01-04T00:00:00Z'::timestamptz
         FROM generate_series(1,31) series`,
        [WORKSPACE, ROOM, VIEWER],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         SELECT $1,id,$2,'owner' FROM rooms WHERE parent_id=$3 AND name LIKE 'Open %'`,
        [WORKSPACE, VIEWER, ROOM],
      );
    });
    const first = (await phone.readCorners(ROOM, VIEWER))!;
    expect(first.corners).toHaveLength(30);
    expect(first.nextOpen).toBeDefined();
    const live = (await phone.liveChatCornerStatus(ROOM, VIEWER))!;
    expect(live.cornerCount).toBe(32);
    expect(live.corners).toEqual(first.corners);
    expect(live.nextOpen).toBe(first.nextOpen);
    const cursor = first.nextOpen!.split(',');
    const second = (await phone.readCorners(ROOM, VIEWER, false, false, undefined, {
      micros: cursor[0]!, id: cursor[1]!,
    }))!;
    expect(second.corners).toHaveLength(2);
    expect(second.nextOpen).toBeUndefined();
    expect(new Set([...first.corners, ...second.corners].map((row) => row.corner.id)).size).toBe(32);
  });

  it('answers the archived read with closed work alone, newest closure first', async () => {
    const phone = await fixture();
    const view = await phone.readCorners(ROOM, VIEWER, false, true);
    expect(view?.corners.map((item) => item.corner.id)).toEqual([OPENED_FIRST, OPENED_SECOND]);
    expect(view?.corners.map((item) => item.state)).toEqual(['archived', 'archived']);
    expect(view?.corners.map((item) => item.closedAt)).toEqual([
      unix(OPENED_FIRST_CLOSED_AT),
      unix(OPENED_SECOND_CLOSED_AT),
    ]);
  });

  it("names each corner's latest brief revision, and none on a corner without a brief", async () => {
    const phone = await fixture((database) =>
      database.query(
        `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
         VALUES($1,1,'First brief',$2,$3),($1,2,'Revised brief',$2,$3)`,
        [LIVE, VIEWER, ROOM],
      ),
    );
    const live = await phone.readCorners(ROOM, VIEWER);
    expect(live?.corners.map((item) => [item.corner.id, item.briefRevision])).toEqual([[LIVE, 2]]);
    const archived = await phone.readCorners(ROOM, VIEWER, false, true);
    expect(archived?.corners.every((item) => !('briefRevision' in item))).toBe(true);
  });

  it('keeps the Room header and viewer on the archived read', async () => {
    const phone = await fixture();
    const view = await phone.readCorners(ROOM, VIEWER, false, true);
    expect(view?.room.id).toBe(ROOM);
    expect(view?.viewer.identity.pubkey).toBe(VIEWER);
  });
});
