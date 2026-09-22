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

async function fixture() {
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
  return new PhoneService(database, 'http://local.test');
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1_000);

describe('readCorners', () => {
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

  it('keeps the Room header and viewer on the archived read', async () => {
    const phone = await fixture();
    const view = await phone.readCorners(ROOM, VIEWER, false, true);
    expect(view?.room.id).toBe(ROOM);
    expect(view?.viewer.identity.pubkey).toBe(VIEWER);
  });
});
