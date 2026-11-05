import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { migrate } from './database.js';
import { PushDeliveryLoop } from './background.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { directMessageRoomId, ensureSystemDirectMessageRoom, systemLine } from './system-line.js';

const person = 'a'.repeat(64),
  teammate = 'b'.repeat(64),
  agent = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const personDevice = 'owner-device-token-12345678901234567890';
const teammateDevice = 'teammate-device-token-1234567890123456';
let db: PgliteDatabase;
let phone: PhoneService;
let loop: PushDeliveryLoop;
let humanDm: string, agentDm: string, systemDm: string;
const send = vi.fn().mockResolvedValue(undefined);
let sequence = 0;

async function post(channel: string, author: string, text: string) {
  const id = (++sequence).toString(16).padStart(64, '0');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    id,
    channel,
    author,
    text,
  ]);
  return id;
}
async function helperOffline() {
  return (
    await systemLine(db, {
      roomId: systemDm,
      authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: "Chad's helper" },
      verb: 'went offline',
      consequence: "@bee can't respond",
      cardType: 'machine-offline',
      card: { machineId: `machine-${++sequence}`, ownerId: person, agentIds: [agent], status: 'open' },
    })
  ).id;
}
async function dm(a: string, b: string) {
  const participants = [a, b].sort() as [string, string];
  const id = directMessageRoomId(workspace, participants);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
     VALUES($1,$2,$3,'Direct message','invite-only',$4::jsonb)`,
    [id, workspace, a, JSON.stringify(participants)],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,
    [workspace, id, a, b],
  );
  return id;
}
const mute = (roomId: string, muted: boolean, viewer = person) =>
  phone.execute('updateRoomPushState', { roomId, muted }, viewer);
const pushed = (token = personDevice) =>
  send.mock.calls.filter(([to]) => to === token).map(([, message]) => message.messageId);
const claimStatus = async (messageId: string, token = personDevice) =>
  (
    await db.query<{ status: string }>(
      `SELECT status FROM push_delivery_claims WHERE message_id=$1 AND device_token=$2`,
      [messageId, token],
    )
  ).rows[0]?.status;

beforeEach(async () => {
  db = new PgliteDatabase();
  sequence = 0;
  send.mockClear();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle,push_level)
     VALUES ($1,'human','Owner','owner','attention'),($2,'human','Teammate','teammate','attention'),
       ($3,'agent','Bee','bee','attention')`,
    [person, teammate, agent],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member')`,
    [workspace, person, teammate, agent],
  );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id,created_by) VALUES($1,$2,'Room',NULL,$3)`,
    [room, workspace, person],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
    [workspace, room, person, teammate, agent],
  );
  humanDm = await dm(person, teammate);
  agentDm = await dm(person, agent);
  systemDm = await ensureSystemDirectMessageRoom(db, workspace, person);
  await db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment)
     VALUES($1,$3,'android','physical'),($2,$4,'android','physical')`,
    [personDevice, teammateDevice, person, teammate],
  );
  phone = new PhoneService(db, 'https://example.test');
  loop = new PushDeliveryLoop(db, { send });
  await loop.runOnce();
});
afterEach(() => db.close());

describe('DM mute', () => {
  it('silences each muted DM, including System, and leaves other DMs untouched', async () => {
    await mute(humanDm, true);
    await mute(systemDm, true);
    const human = await post(humanDm, teammate, 'Are you there?');
    const notice = await helperOffline();
    const other = await post(agentDm, agent, 'Agent reply');
    await loop.runOnce();
    expect(pushed()).toEqual([other]);
    expect(await claimStatus(human)).toBe('suppressed');
    expect(await claimStatus(notice)).toBe('suppressed');

    await mute(agentDm, true);
    const agentLine = await post(agentDm, agent, 'Second agent reply');
    await loop.runOnce();
    expect(await claimStatus(agentLine)).toBe('suppressed');
    expect(pushed()).toEqual([other]);
    console.log('DM mute: human, agent and System DMs suppressed; unmuted DM delivered');
  });

  it("keeps the other participant's notifications and preference", async () => {
    await mute(humanDm, true);
    const reply = await post(humanDm, person, 'Reply from the muter');
    await loop.runOnce();
    expect(pushed(teammateDevice)).toEqual([reply]);
    const rows = await db.query<{ identity_id: string; push_muted: boolean }>(
      `SELECT identity_id,push_muted FROM memberships WHERE room_id=$1 ORDER BY identity_id`,
      [humanDm],
    );
    expect(rows.rows).toEqual([
      { identity_id: person, push_muted: true },
      { identity_id: teammate, push_muted: false },
    ]);
  });

  it('delivers new messages after unmute without replaying suppressed ones', async () => {
    await mute(systemDm, true);
    const muted = await helperOffline();
    await loop.runOnce();
    expect(pushed()).toEqual([]);
    expect(await mute(systemDm, false)).toEqual({ muted: false });
    const fresh = await helperOffline();
    await loop.runOnce();
    await loop.runOnce();
    expect(pushed()).toEqual([fresh]);
    expect(await claimStatus(muted)).toBe('suppressed');
    console.log('DM unmute: next System notice delivered, suppressed one not replayed');
  });

  it('persists the mute in the viewer read only', async () => {
    await mute(systemDm, true);
    expect((await phone.readRoom(systemDm, person))?.viewer.pushMuted).toBe(true);
    await mute(humanDm, true);
    expect((await phone.readRoom(humanDm, person))?.viewer.pushMuted).toBe(true);
    expect((await phone.readRoom(humanDm, teammate))?.viewer.pushMuted).toBeUndefined();
  });

  it('refuses writes from non-members and agents', async () => {
    await expect(mute(systemDm, true, teammate)).rejects.toThrow('room not found');
    await expect(mute(agentDm, true, agent)).rejects.toThrow('room not found');
    const rows = await db.query(`SELECT 1 FROM memberships WHERE push_muted`);
    expect(rows.rowCount).toBe(0);
  });

  it('keeps Room mute letting tags and DMs through', async () => {
    await db.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [person]);
    await mute(room, true);
    const chatter = await post(room, teammate, 'Room chatter');
    const tag = await post(room, teammate, '@owner please look');
    const direct = await post(humanDm, teammate, 'Direct note');
    await loop.runOnce();
    expect(pushed().sort()).toEqual([tag, direct].sort());
    expect(await claimStatus(chatter)).toBe('suppressed');
  });
});
