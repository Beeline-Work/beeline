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
