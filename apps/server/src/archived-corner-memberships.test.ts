import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { closeCornerState } from './corner-close.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { resolveCurrentMemberMentions } from './message-mentions.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import type { TokenAuth } from './auth.js';
import { createBeelineServer } from './server.js';

let db: PgliteDatabase;
let phone: PhoneService;
const person = 'a'.repeat(64),
  agent = 'b'.repeat(64),
  outsider = 'c'.repeat(64);
let workspace: string, room: string, corner: string;

beforeEach(async () => {
  db = await migratedDatabase();
  phone = new PhoneService(db, 'http://local.test');
  workspace = randomUUID();
  room = randomUUID();
  corner = randomUUID();
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Agent','agent'),($3,'human','Outsider','outsider')`,
    [person, agent, outsider],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, person]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Fixture')`, [workspace]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES
    ($1,$3,NULL,'Room',$4),($2,$3,$1,'Corner',$4)`,
    [room, corner, workspace, person],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,surface,identity_id,'owner' FROM unnest(ARRAY[NULL,$2]::uuid[]) surface
    CROSS JOIN unnest(ARRAY[$4,$5,$6]::text[]) identity_id
    WHERE (identity_id<>$6 OR surface IS NULL) AND $3::uuid IS NOT NULL`,
    [workspace, room, corner, person, agent, outsider],
  );
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by) VALUES($1,$2,$3)`,
    [corner, agent, person],
  );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('history',$1,$2,'Keep corner history')`,
    [corner, person],
  );
});
afterEach(async () => {
  await db?.close();
});

it('parent membership authorizes live corner updates and departure revokes access', async () => {
  const live = new LiveHub();
  const server = createBeelineServer({
    database: db,
    phone,
    live,
    auth: { authenticatePhone: async () => person } as unknown as TokenAuth,
    daemon: new DaemonService(db, live),
    mediaMaximumBytes: 1,
  });
  let socket: WebSocket | undefined;
  const frames: Record<string, unknown>[] = [];
  const wait = (predicate: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(JSON.stringify(frames)));
      }, 5_000);
      const poll = setInterval(() => {
        if (predicate()) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    socket = new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/live`,
      ['bearer.fixture'],
    );
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', roomId: corner }));
    await wait(() =>
      frames.some((frame) => frame.type === 'subscribed' && frame.roomId === corner),
    );
    const mark = frames.length;
    live.publish({ type: 'invalidate', roomId: corner, reason: 'parent-access-proof' });
    await wait(() =>
      frames.slice(mark).some((frame) => frame.type === 'invalidate' && frame.roomId === corner),
    );
    expect((await db.query(`SELECT 1 FROM memberships WHERE room_id=$1`, [corner])).rowCount).toBe(
      0,
    );
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      room,
      person,
    ]);
    expect((await phone.canReadRooms([corner], person)).size).toBe(0);
  } finally {
    socket?.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('active corners open, post and delete through parent access without creating any memberships', async () => {
  const id = 'd'.repeat(64);
  await phone.execute(
    'sendRoomMessage',
    { roomId: corner, messageId: id, text: 'Active corner post' },
    person,
  );
  expect(
    (await phone.readRoom(corner, person))?.messages.some(
      (message) => message.text === 'Active corner post',
    ),
  ).toBe(true);
  expect((await phone.canReadRooms([corner], person)).has(corner)).toBe(true);
  await phone.execute('deleteRoomMessage', { roomId: corner, messageId: id }, person);
  expect((await db.query(`SELECT 1 FROM memberships WHERE room_id=$1`, [corner])).rowCount).toBe(0);
  expect(
    (await db.query(`SELECT owner_agent_id FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0]
      ?.owner_agent_id,
  ).toBe(agent);
  await expect(
    db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`,
      [workspace, corner, person],
    ),
  ).rejects.toThrow(/corner.*membership/i);
  await db.transaction((tx) => closeCornerState(tx, corner));
  expect((await db.query(`SELECT 1 FROM room_access WHERE room_id=$1`, [corner])).rowCount).toBe(0);
  expect(await resolveCurrentMemberMentions(db, corner, '@agent hello', person)).toEqual([]);
});

it('release migration removes ALL active and archived corner memberships for every user and is idempotent', async () => {
  // Model a database written before the archival guard existed.
  await db.query(`DROP TRIGGER IF EXISTS guard_corner_membership ON memberships`);
  const archived = randomUUID();
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at) VALUES($1,$2,$3,'Archived',now())`,
    [archived, workspace, room],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,surface,identity,'member' FROM unnest(ARRAY[$2,$3]::uuid[]) surface CROSS JOIN unnest(ARRAY[$4,$5]::text[]) identity`,
    [workspace, corner, archived, person, agent],
  );
  await migrate(db);
  expect(
    (
      await db.query(
        `SELECT 1 FROM memberships member JOIN rooms corner ON corner.id=member.room_id WHERE corner.parent_id IS NOT NULL`,
      )
    ).rowCount,
  ).toBe(0);
  await migrate(db);
  expect(
    (
      await db.query(
        `SELECT 1 FROM memberships member JOIN rooms corner ON corner.id=member.room_id WHERE corner.parent_id IS NOT NULL`,
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (await db.query(`SELECT 1 FROM memberships WHERE room_id=$1 AND removed_at IS NULL`, [room]))
      .rowCount,
  ).toBe(2);
});

it('archived history stays readable through the parent, without granting subscriptions or access to outsiders', async () => {
  await db.transaction((tx) => closeCornerState(tx, corner));
  expect(await phone.canReadRoom(corner, person)).toBe(true);
  const history = await phone.readRoom(corner, person);
  expect(history?.messages.some((message) => message.text === 'Keep corner history')).toBe(true);
  expect(history?.watchFilters).toEqual([]);
  expect(
    (await phone.readHistory(corner, person))?.messages.some(
      (message) => message.text === 'Keep corner history',
    ),
  ).toBe(true);
  expect(
    (await phone.readHistoryAround(corner, person, 'history'))?.messages.some(
      (message) => message.text === 'Keep corner history',
    ),
  ).toBe(true);
  expect(await phone.readHistoryOutline(corner, person, 'UTC')).not.toBeNull();
  expect(await phone.canReadRoom(corner, outsider)).toBe(false);
  expect(await phone.readRoom(corner, outsider)).toBeNull();
  expect((await phone.canReadRooms([room, corner], person)).has(corner)).toBe(false);
  expect(
    (await phone.readCorners(room, person, false, true))?.corners.map((row) => row.corner.id),
  ).toContain(corner);
  const daemon = new DaemonService(db, new LiveHub());
  const conversation = await daemon.execute('getRoomConversation', { roomId: corner }, agent);
  expect(conversation.items.some((message) => message.body === 'Keep corner history')).toBe(true);
  expect(
    await daemon.execute('getRoomMessage', { roomId: corner, messageId: 'history' }, agent),
  ).toMatchObject({ body: 'Keep corner history' });
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1`, [room]);
  expect(await phone.canReadRoom(corner, person)).toBe(false);
  expect(await phone.readRoom(corner, person)).toBeNull();
});

it('phone startup and sync exclude 1,146 archived corners and their membership expansion', async () => {
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
    SELECT md5('archived-'||n)::uuid,$1,$2,'Archived '||n,now() FROM generate_series(1,1146) n`,
    [workspace, room],
  );
  const read = await phone.readChats(workspace, person);
  expect(read?.chats.map((chat) => chat.room.id)).toEqual([room]);
  expect(read?.watchFilters.flatMap((filter) => filter['#h'] ?? [])).toEqual([room]);
  expect(JSON.stringify(read)).not.toContain('Archived ');
  expect(
    (
      await db.query(
        `SELECT count(*)::int count FROM room_access WHERE identity_id=$1 AND room_id IS NOT NULL`,
        [person],
      )
    ).rows[0]?.count,
  ).toBe(2);
  await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]);
  const sync = await phone.readChats(workspace, person);
  expect(sync?.chats.flatMap((chat) => chat.openCorners ?? [])).toEqual([]);
  expect(sync?.watchFilters.flatMap((filter) => filter['#h'] ?? [])).toEqual([room]);
  expect(
    (
      await db.query(
        `SELECT count(*)::int count FROM room_access WHERE identity_id=$1 AND room_id IS NOT NULL`,
        [person],
      )
    ).rows[0]?.count,
  ).toBe(1);
});
