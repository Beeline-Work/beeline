import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

const VIEWER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const FAILING = '33333333-3333-4333-8333-333333333331';
const mineId = (index: number) => `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`;
const otherId = (index: number) => `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`;

/**
 * Nine corners the viewer commissioned, opened first, then three newer ones
 * an agent opened for someone else. The newest is in `implement` with no
 * recorded outcome while its PR checks fail.
 */
async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'agent','Bot','bot')`,
    [VIEWER, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'alpha')`,
    [ROOM, WORKSPACE, VIEWER],
  );
  const corners: Array<[string, string, boolean]> = [
    ...Array.from({ length: 9 }, (_, index) => [mineId(index), `Mine ${index}`, true] as [string, string, boolean]),
    [otherId(1), 'Other 1', false],
    [otherId(2), 'Other 2', false],
    [FAILING, 'Failing checks', false],
  ];
  for (const [index, [id, name, mine]] of corners.entries()) {
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,created_at)
       VALUES($1,$2,$3,$4,$5,'2026-01-01T00:00:00Z'::timestamptz + make_interval(mins => $6))`,
      [id, WORKSPACE, ROOM, AGENT, name, index],
    );
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by) VALUES($1,$2,$3)`,
      [id, AGENT, mine ? VIEWER : null],
    );
  }
  await database.query(
    `UPDATE corner_facts SET workflow_state='implement',workflow_outcome=NULL,
       lifecycle='{"lifecycle":"open","checks":"failing","pr":{"url":"https://github.com/o/r/pull/1","number":1}}'
     WHERE corner_id=$1`,
    [FAILING],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT $1::uuid,NULL::uuid,$2::text,'owner' UNION ALL
     SELECT $1::uuid,id,$2::text,'owner' FROM rooms WHERE workspace_id=$1::uuid`,
    [WORKSPACE, VIEWER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT $1::uuid,id,$2::text,'member' FROM rooms WHERE workspace_id=$1::uuid`,
    [WORKSPACE, AGENT],
  );
  return { database, phone: new PhoneService(database, 'http://local.test') };
}

async function roomListRow(phone: PhoneService) {
  return (await phone.readChats(WORKSPACE, VIEWER))!.chats.find((item) => item.room.id === ROOM)!;
}

describe('one corner projection for the Room list read, the live frame and the Corners page', () => {
  it('reads review / checks-failed for implement with no outcome and failing checks everywhere', async () => {
    const { database, phone } = await fixture();
    // Mine, so the capped Room list carries it.
    await database.query(`UPDATE corner_facts SET commissioned_by=$2 WHERE corner_id=$1`, [FAILING, VIEWER]);
    const read = await roomListRow(phone);
    const frame = (await phone.liveChatCornerStatus(ROOM, VIEWER))!;
    const page = (await phone.readCorners(ROOM, VIEWER))!;
    const failing = (list: readonly { id: string; state: string }[] | undefined) =>
      list?.find((corner) => corner.id === FAILING)?.state;
    expect(failing(read.openCorners)).toBe('review');
    expect(failing(frame.openCorners)).toBe('review');
    expect(page.corners.find((item) => item.corner.id === FAILING)).toMatchObject({
      state: 'review',
      reason: 'checks-failed',
    });
  });

  it('keeps every Mine corner in the capped list and sends the same list and counts on read and frame', async () => {
    const { phone } = await fixture();
    const read = await roomListRow(phone);
    const frame = (await phone.liveChatCornerStatus(ROOM, VIEWER))!;
    expect(read.openCorners?.map((corner) => corner.id)).toEqual(
      Array.from({ length: 9 }, (_, index) => mineId(8 - index)),
    );
    expect(read).toMatchObject({ cornerCount: 12, mineCornerCount: 9 });
    expect({
      cornerCount: frame.cornerCount,
      waitingCornerCount: frame.waitingCornerCount,
      mineCornerCount: frame.mineCornerCount,
      openCorners: frame.openCorners,
    }).toEqual({
      cornerCount: read.cornerCount,
      waitingCornerCount: read.waitingCornerCount,
      mineCornerCount: read.mineCornerCount,
      openCorners: read.openCorners,
    });
  });

  it('marks the same corners Mine on the Corners page as on the Room list', async () => {
    const { phone } = await fixture();
    const read = await roomListRow(phone);
    const page = (await phone.readCorners(ROOM, VIEWER))!;
    const pageMine = page.corners.filter((item) => item.mine).map((item) => item.corner.id);
    const readMine = read.openCorners!.filter((corner) => corner.mine).map((corner) => corner.id);
    expect(pageMine).toEqual(readMine);
    expect(pageMine).toHaveLength(9);
  });

  it('names the approval actor on the read and the live frame alike', async () => {
    const { database, phone } = await fixture();
    await database.query(
      `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
       VALUES('perm-1',$1,$2,'request-1','{}'::jsonb,'pending')`,
      [FAILING, AGENT],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES('card-1',$1,$2,'','card','permission',
         jsonb_build_object('permissionId','perm-1','agent',jsonb_build_object('pubkey',$2::text)))`,
      [FAILING, AGENT],
    );
    const read = await roomListRow(phone);
    const frame = (await phone.liveChatCornerStatus(ROOM, VIEWER))!;
    expect(read.attentionReason).toEqual({ kind: 'approval', actor: 'Bot' });
    expect(frame.agentState).toBe('needs-you');
    expect(frame.attentionReason).toEqual(read.attentionReason);
  });

  it('never takes a deleted message as a corner latest message', async () => {
    const { database, phone } = await fixture();
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at,deleted_at) VALUES
        ('kept',$1,$2,'kept','2026-02-01T00:00:00Z',NULL),
        ('gone',$1,$2,'gone','2026-02-02T00:00:00Z','2026-02-03T00:00:00Z')`,
      [FAILING, AGENT],
    );
    const page = (await phone.readCorners(ROOM, VIEWER))!;
    expect(page.corners.find((item) => item.corner.id === FAILING)?.latestMessage?.id).toBe('kept');
  });
});
