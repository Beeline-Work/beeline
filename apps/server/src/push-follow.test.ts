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
async function post(text: string, author: string, channel = corner) {
  const id = (++sequence).toString(16).padStart(64, '0');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    id,
    channel,
    author,
    text,
  ]);
  return id;
}
async function delivered() {
  await loop.runOnce();
  return send.mock.calls.map(([, message]) => message.messageId as string);
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
  // The teammate opened and commissioned the corner; the person did neither.
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id,created_by) VALUES($1,$3,'Room',NULL,$4),($2,$3,'Corner',$1,$4)`,
    [room, corner, workspace, teammate],
  );
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective) VALUES($1,$2,$3,'Work')`,
    [corner, agent, teammate],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member')`,
    [workspace, person, teammate, agent],
  );
  for (const channel of [room, corner]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'owner'),($1,$2,$5,'member')`,
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

describe('Followed level follows corners', () => {
  it('stays quiet in a corner the person never touched', async () => {
    await post('Untagged update', teammate);
    expect(await delivered()).toEqual([]);
  });

  it('follows a corner the person posted in', async () => {
    await post('I have a thought', person);
    const update = await post('Untagged update', teammate);
    expect(await delivered()).toEqual([update]);
  });

  it('follows a corner the person steered from its Room', async () => {
    const ask = await post('@bee tell the corner to use Postgres', person, room);
    const relay = await post('Use Postgres', agent);
    await db.query(
      `INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth)
       VALUES('steer',$1,$2,$3,'turn','input','relay_steer','root',$4,1)`,
      [corner, agent, relay, ask],
    );
    send.mockClear();
    const update = await post('Untagged update', teammate);
    expect(await delivered()).toContain(update);
  });

  it('follows a corner the person was tagged in', async () => {
    const tag = await post('@owner can you look', teammate);
    const update = await post('Untagged update', teammate);
    expect(await delivered()).toEqual([tag, update]);
  });

  it('ends the follow when the corner is archived', async () => {
    await post('I have a thought', person);
    await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]);
    await post('Untagged update', teammate);
    expect(await delivered()).toEqual([]);
  });
});

describe('Room mute', () => {
  it("silences the Room and its corners but lets the person's tags through", async () => {
    await db.query(`UPDATE identities SET push_level='all' WHERE id=$1`, [person]);
    await db.query(`UPDATE memberships SET push_muted=true WHERE room_id=$1 AND identity_id=$2`, [
      room,
      person,
    ]);
    await post('Room chatter', teammate, room);
    await post('Corner chatter', teammate);
    const roomTag = await post('@owner in the Room', teammate, room);
    const cornerTag = await post('@owner in the corner', teammate);
    expect(await delivered()).toEqual([roomTag, cornerTag]);
  });

  it('ignores and clears a corner-level mute', async () => {
    await db.query(`UPDATE identities SET push_level='all' WHERE id=$1`, [person]);
    await db.query(`UPDATE memberships SET push_muted=true WHERE room_id=$1 AND identity_id=$2`, [
      corner,
      person,
    ]);
    const update = await post('Corner chatter', teammate);
    expect(await delivered()).toEqual([update]);
    await migrate(db);
    const muted = await db.query<{ push_muted: boolean }>(
      `SELECT push_muted FROM memberships WHERE room_id=$1 AND identity_id=$2`,
      [corner, person],
    );
    expect(muted.rows[0]?.push_muted).toBe(false);
  });
});
