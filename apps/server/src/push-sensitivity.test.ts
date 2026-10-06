import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PushDeliveryLoop } from './background.js';
import { PgliteDatabase } from './test-support.js';

const person = 'a'.repeat(64),
  teammate = 'b'.repeat(64),
  agent = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase;
const send = vi.fn().mockResolvedValue(undefined);
let loop: PushDeliveryLoop;
let sequence = 0;
async function post(text: string, author = agent, channel = corner, request: string | null = null) {
  const id = (++sequence).toString(16).padStart(64, '0');
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,request_id) VALUES($1,$2,$3,$4,$5)`,
    [id, channel, author, text, request],
  );
  return id;
}
beforeEach(async () => {
  db = new PgliteDatabase();
  sequence = 0;
  send.mockClear();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES ($1,'human','Owner','owner'),($2,'human','Teammate','teammate'),($3,'agent','Bee','bee')`,
    [person, teammate, agent],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id,created_by) VALUES($1,$3,'Room',NULL,$4),($2,$3,'Corner',$1,$4)`,
    [room, corner, workspace, person],
  );
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective) VALUES($1,$2,$3,'Work')`,
    [corner, agent, person],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member')`,
    [workspace, person, teammate, agent],
  );
  for (const channel of [room, corner]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
      [workspace, channel, person, teammate, agent],
    );
  }
  await db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
    [person],
  );
  loop = new PushDeliveryLoop(db, { send });
  await loop.runOnce();
});
afterEach(() => db.close());
describe('push sensitivity service path', () => {
  it('Reproduction PUSH-LEVELS: delivers the final untagged turn in my corner', async () => {
    const turn = 'd'.repeat(64);
    await db.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'complete')`,
      [corner, turn, agent],
    );
    const id = await post('Finished your work', agent, corner, turn);
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ messageId: id, text: 'Bee: Finished your work' }),
    );
    console.log(
      'Reproduction PUSH-LEVELS: My work → finished untagged agent turn → one push with final text',
    );
  });
});

describe('sensitivity boundaries and replacement slots', () => {
  it.each(['direct', 'mine', 'all'] as const)(
    'delivers human messages at %s through the phone API',
    async (level) => {
      const { PhoneService } = await import('./phone-service.js');
      const phone = new PhoneService(db, 'https://example.test');
      await phone.execute('updateIdentityPushLevel', { pushLevel: level }, person);
      const outside = '44444444-4444-4444-8444-444444444444';
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id,created_by) VALUES($1,$2,'Other work',$3,$4)`,
        [outside, workspace, room, teammate],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'owner')`,
        [workspace, outside, person, teammate],
      );
      const ids: string[] = [];
      for (const channel of [room, corner, outside]) {
        const messageId = (++sequence).toString(16).padStart(64, '0');
        await phone.execute(
          'sendRoomMessage',
          { roomId: channel, messageId, text: 'Human update', mentions: [], attachments: [] },
          teammate,
        );
        ids.push(messageId);
      }
      const tag = await post('@owner please read', teammate, room);
      const authored = await post('My message', person, room);
      const reply = (++sequence).toString(16).padStart(64, '0');
      await phone.execute(
        'sendRoomReply',
        {
          roomId: room,
          messageId: reply,
          parentMessageId: authored,
          text: 'Explicit reply',
          mentions: [],
          attachments: [],
        },
        teammate,
      );
      await loop.runOnce();
      const actual = send.mock.calls.map(([, message]) => message.messageId);
      expect(actual).toEqual(expect.arrayContaining([tag, reply]));
      const ordinary = actual.filter((id) => ids.includes(id));
      expect(ordinary).toEqual(level === 'direct' ? [] : level === 'mine' ? [ids[1]] : ids);
      console.log(
        `Phone API ${level}: human activity=${ordinary.length}, tags and explicit replies delivered`,
      );
    },
  );

  it('waits for final agent prose and uses tags, replies and choice metadata only once per turn', async () => {
    await db.query(`UPDATE identities SET push_level='direct' WHERE id=$1`, [person]);
    const turn = 'd'.repeat(64);
    await db.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'working')`,
      [corner, turn, agent],
    );
    await post('@owner partial output', agent, corner, turn);
    expect(await loop.runOnce()).toBe(0);
    const choice = await post('Please choose', agent, corner, turn);
    await db.query(
      `UPDATE messages SET presentation='card',card_type='room-choice',card=$2::jsonb WHERE id=$1`,
      [choice, JSON.stringify({ mode: 'question', status: 'open', mentionIds: [person] })],
    );
    const final = await post('The final result', agent, corner, turn);
    await db.query(
      `UPDATE agent_turns SET status='complete',created_at=now() WHERE room_id=$1 AND request_id=$2`,
      [corner, turn],
    );
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        messageId: final,
        text: 'Bee: The final result',
        collapseId: final,
      }),
    );
    expect(await loop.runOnce()).toBe(0);
  });

  it('collapses room activity while keeping human messages and attention separate', async () => {
    await db.query(`UPDATE identities SET push_level='all' WHERE id=$1`, [person]);
    const human = await post('Human update', teammate, room);
    await loop.runOnce();
    const first = await post('Agent finished', agent, room);
    await loop.runOnce();
    const second = await post('Agent finished again', agent, room);
    await loop.runOnce();
    const mention = await post('@owner read this', agent, room);
    await loop.runOnce();
    const byId = new Map(
      send.mock.calls.map(([, message]) => [message.messageId, message.collapseId]),
    );
    expect(byId.get(human)).toBe(room);
    expect(byId.get(first)).toBe(`agent:${room}`);
    expect(byId.get(second)).toBe(byId.get(first));
    expect(byId.get(mention)).toBe(mention);
  });

  it('updates consecutive human attention within 20 seconds but starts a new slot after an intervening sender', async () => {
    const first = await post('@owner first', teammate, room);
    await loop.runOnce();
    const second = await post('@owner second', teammate, room);
    await loop.runOnce();
    await post('Intervening agent', agent, room);
    const third = await post('@owner third', teammate, room);
    await loop.runOnce();
    const slots = new Map(
      send.mock.calls.map(([, message]) => [message.messageId, message.collapseId]),
    );
    expect(slots.get(first)).toBe(first);
    expect(slots.get(second)).toBe(first);
    expect(slots.get(third)).toBe(third);
  });

  it.each(['mute', 'view', 'recent-read', 'already-read'] as const)(
    'consumes %s suppression without replaying later',
    async (reason) => {
      const { PhoneService } = await import('./phone-service.js');
      const phone = new PhoneService(db, 'https://example.test');
      // Mute is the Room's and lets tags through, so it is proven on plain chatter.
      const message = await post(reason === 'mute' ? 'Corner chatter' : '@owner new message');
      if (reason === 'mute')
        await phone.execute('updateRoomPushState', { roomId: room, muted: true }, person);
      if (reason === 'view')
        await phone.execute(
          'updateRoomPushState',
          { roomId: corner, viewing: true, sessionId: 'device-one' },
          person,
        );
      if (reason === 'recent-read' || reason === 'already-read') {
        const read = reason === 'recent-read' ? await post('Old read', person) : message;
        await db.query(
          `INSERT INTO room_read_marks(room_id,identity_id,message_id,message_created_at,updated_at) SELECT $1,$2,id,created_at,now() FROM messages WHERE id=$3`,
          [corner, person, read],
        );
        if (reason === 'already-read')
          await db.query(`UPDATE room_read_marks SET updated_at=now()-interval '1 minute'`);
      }
      expect(await loop.runOnce()).toBe(0);
      expect(
        (await db.query(`SELECT status FROM push_delivery_claims WHERE message_id=$1`, [message]))
          .rows[0]?.status,
      ).toBe('suppressed');
      await db.query(`UPDATE memberships SET push_muted=false`);
      await db.query(`DELETE FROM room_push_views`);
      await db.query(`DELETE FROM room_read_marks`);
      expect(await loop.runOnce()).toBe(0);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('limits mute and viewing writes to the human member and preserves another device view', async () => {
    const { PhoneService } = await import('./phone-service.js');
    const phone = new PhoneService(db, 'https://example.test');
    await expect(
      phone.execute('updateRoomPushState', { roomId: corner, muted: true }, agent),
    ).rejects.toThrow('room not found');
    await expect(
      phone.execute('updateRoomPushState', { roomId: corner, viewing: true }, person),
    ).rejects.toThrow('invalid push state');
    for (const sessionId of ['device-one', 'device-two'])
      await phone.execute(
        'updateRoomPushState',
        { roomId: corner, viewing: true, sessionId },
        person,
      );
    await phone.execute(
      'updateRoomPushState',
      { roomId: corner, viewing: false, sessionId: 'device-one' },
      person,
    );
    await post('@owner while another device views');
    expect(await loop.runOnce()).toBe(0);
    await db.query(`UPDATE room_push_views SET expires_at=now()-interval '1 second'`);
    await post('@owner after crash lease expires');
    expect(await loop.runOnce()).toBe(1);
  });

  it('never widens membership or infers a reply from adjacency', async () => {
    await db.query(`UPDATE identities SET push_level='direct' WHERE id=$1`, [person]);
    await post('My preceding message', person, room);
    await post('The next message', teammate, room);
    expect(await loop.runOnce()).toBe(0);
    await db.query(`UPDATE identities SET push_level='all' WHERE id=$1`, [person]);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`, [
      person,
      room,
    ]);
    await post('@owner outside membership', agent, room);
    expect(await loop.runOnce()).toBe(0);
  });
});

it.each(['direct', 'mine', 'all'] as const)(
  'selects finished agent turns at %s and never tool or system chatter',
  async (level) => {
    await db.query(`UPDATE identities SET push_level=$2 WHERE id=$1`, [person, level]);
    const expected: string[] = [];
    for (const channel of [room, corner]) {
      const turn = `turn-${channel}`;
      await db.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'working')`,
        [channel, turn, agent],
      );
      await post('Partial narration', agent, channel, turn);
      expect(await loop.runOnce()).toBe(0);
      const final = await post('Finished final turn', agent, channel, turn);
      await db.query(
        `UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND request_id=$2`,
        [channel, turn],
      );
      await loop.runOnce();
      if (level === 'all' || (level === 'mine' && channel === corner)) expected.push(final);
    }
    const chatter = await post('Tool output', agent, room);
    await db.query(`UPDATE messages SET presentation='activity' WHERE id=$1`, [chatter]);
    const system = await post('Bee started a workflow', agent, room);
    await db.query(
      `UPDATE messages SET presentation='system',card_type='workflow-handoff' WHERE id=$1`,
      [system],
    );
    expect(await loop.runOnce()).toBe(0);
    expect(send.mock.calls.map(([, message]) => message.messageId)).toEqual(expected);
  },
);

it('keeps human DMs and an opener-only corner in scope and respects the human burst timeout', async () => {
  await db.query(`UPDATE corner_facts SET commissioned_by=NULL WHERE corner_id=$1`, [corner]);
  await post('Opened-corner update', agent, corner);
  expect(await loop.runOnce()).toBe(1);
  await db.query(`UPDATE identities SET push_level='direct' WHERE id=$1`, [person]);
  await db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`, [
    room,
    JSON.stringify([person, teammate]),
  ]);
  const first = await post('Human DM', teammate, room);
  await loop.runOnce();
  const second = await post('Consecutive DM', teammate, room);
  await loop.runOnce();
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ messageId: second, collapseId: first });
  await db.query(`UPDATE messages SET created_at=now()-interval '21 seconds' WHERE room_id=$1`, [
    room,
  ]);
  const third = await post('Next DM burst', teammate, room);
  await loop.runOnce();
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ messageId: third, collapseId: third });
});
