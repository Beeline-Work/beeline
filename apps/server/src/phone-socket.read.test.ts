import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { phoneReadHost } from './test-fixtures/test-support-phone-read-host.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const VIEWER = 'a'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase;
let server: Server | undefined;
let connection: any;
let host: Awaited<ReturnType<typeof phoneReadHost>>;
const sockets: WebSocket[] = [];
beforeAll(async () => { host = await phoneReadHost(); });
afterAll(async () => { await host?.close(); });
afterEach(async () => {
  connection?.dispose(); connection = undefined;
  for (const socket of sockets.splice(0)) socket.terminate();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  await db?.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function setup() {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Proof reader')`, [VIEWER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof Workspace')`, [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'proof')`, [ROOM, WS, VIEWER]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [WS, ROOM, VIEWER]);
  const live = new LiveHub(), phone = new PhoneService(db, 'https://synthetic.test', undefined, undefined, live);
  server = createBeelineServer({ database: db, phone, live,
    auth: { authenticatePhone: async () => VIEWER } as unknown as TokenAuth,
    daemon: {} as DaemonService, mediaMaximumBytes: 1 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  class NativeSocket extends WebSocket {
    constructor(url: string, protocols: string[]) { super(url, protocols); sockets.push(this); }
  }
  vi.stubGlobal('WebSocket', NativeSocket);
  connection = new host.phone.LiveConnection({
    authorization: async () => 'proof-viewer'.repeat(8),
    liveUrl: () => `ws://127.0.0.1:${port}/v1/phone/live`,
    subscribeIdentityChange: () => () => {},
  });
  return { phone, live };
}

it('plain reads load the list and a busy Room with 1,900 active Rooms', async () => {
  const { phone } = await setup();
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name)
    SELECT ('33333333-3333-4333-8333-'||lpad(n::text,12,'0'))::uuid,$1,$2,'Proof Room '||n
    FROM generate_series(1,1899) n`, [WS, VIEWER]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,id,$2,'member' FROM rooms WHERE workspace_id=$1 AND id<>$3`, [WS, VIEWER, ROOM]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text)
    SELECT md5('busy-'||n)||md5('proof-'||n),$1,$2,repeat('Busy Room history ',200) FROM generate_series(1,100) n`, [ROOM, VIEWER]);
  // Bulk fixture writes need planner statistics before exercising the real read.
  await db.query('ANALYZE');
  const chats = vi.spyOn(phone, 'readChats'), room = vi.spyOn(phone, 'readRoom');
  const list = await connection.request('readChats', { workspaceId: WS }, { afterRoomDraw: false });
  const view = await connection.request('readRoom', { roomId: ROOM });
  expect(list.chats).toHaveLength(200);
  expect(list.truncated).toBe(true);
  expect(list.chats).toContainEqual(expect.objectContaining({ room: expect.objectContaining({ id: ROOM }) }));
  expect(view).toMatchObject({ room: { id: ROOM } }); expect(view.messages.length).toBeGreaterThan(0);
  expect(chats.mock.calls.length).toBeLessThanOrEqual(3); expect(room.mock.calls.length).toBeLessThanOrEqual(3);
  expect(sockets.filter(socket => socket.readyState === WebSocket.OPEN)).toHaveLength(1);
}, 120_000);

it('a socket killed mid-read reconnects and reads the Room again', async () => {
  const { phone } = await setup();
  const original = phone.readRoom.bind(phone);
  const read = vi.spyOn(phone, 'readRoom').mockImplementationOnce(async () => {
    sockets[0]!.terminate();
    return original(ROOM, VIEWER);
  });
  const value = await connection.request('readRoom', { roomId: ROOM });
  expect(value).toMatchObject({ room: { id: ROOM }, messages: [] });
  expect(read).toHaveBeenCalledTimes(2); expect(sockets).toHaveLength(2);
});

it('three server errors settle the read; a later Retry reads successfully', async () => {
  const { phone } = await setup();
  const read = vi.spyOn(phone, 'readRoom').mockRejectedValue(new Error('Synthetic unavailable read'));
  await expect(connection.request('readRoom', { roomId: ROOM })).rejects.toThrow('Synthetic unavailable read');
  expect(read).toHaveBeenCalledTimes(3); expect(sockets).toHaveLength(3);
  read.mockRestore();
  await expect(connection.request('readRoom', { roomId: ROOM })).resolves.toMatchObject({ room: { id: ROOM } });
  expect(sockets).toHaveLength(4);
});
