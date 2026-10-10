import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { migrate } from './database.js';
import { PushDeliveryLoop } from './background.js';
import { clearStalePhoneViews, PhoneViewing } from './phone-viewing.js';
import { PgliteDatabase } from './test-support.js';
import { createBeelineServer } from './server.js';
import { LiveHub } from './live.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';
import type { ConnectionPresence } from './connection-presence.js';

const person = 'a'.repeat(64),
  stranger = 'b'.repeat(64),
  agent = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const instance = 'fly-a:process-1';
let db: PgliteDatabase;
let viewing: PhoneViewing;
let sequence = 0;
const send = vi.fn().mockResolvedValue(undefined);

async function tagOwner(): Promise<string> {
  const id = (++sequence).toString(16).padStart(64, '0');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner look')`, [
    id,
    room,
    agent,
  ]);
  return id;
}
async function views(): Promise<{ session_id: string; instance_id: string | null; expires_at: Date | null }[]> {
  return (
    await db.query<{ session_id: string; instance_id: string | null; expires_at: Date | null }>(
      `SELECT session_id,instance_id,expires_at FROM room_push_views ORDER BY session_id`,
    )
  ).rows;
}

beforeEach(async () => {
  db = new PgliteDatabase();
  sequence = 0;
  send.mockClear();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES ($1,'human','Owner','owner'),($2,'human','Stranger','stranger'),($3,'agent','Bee','bee')`,
    [person, stranger, agent],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id,created_by) VALUES($1,$2,'Room',NULL,$3)`,
    [room, workspace, person],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
    [workspace, person, agent, room],
  );
  await db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
    [person],
  );
  await db.query(`INSERT INTO live_server_instances(instance_id) VALUES($1)`, [instance]);
  viewing = new PhoneViewing(db, instance);
});
afterEach(async () => {
  await db.close();
});

describe('phone viewing over the live socket', () => {
  it('holds pushes for the viewed Room until the socket that viewed it closes', async () => {
    const loop = new PushDeliveryLoop(db, { send });
    await loop.runOnce();

    await viewing.view('socket-1', person, room, true);
    expect(await views()).toEqual([{ session_id: 'socket-1', instance_id: instance, expires_at: null }]);
    await tagOwner();
    expect(await loop.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();

    // No heartbeat from the phone: the socket closing is what ends the view.
    await viewing.end('socket-1');
    expect(await views()).toEqual([]);
    const pushed = await tagOwner();
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ messageId: pushed }),
    );
  });

  it('ends one Room on leave and leaves the socket viewing nothing else', async () => {
    await viewing.view('socket-1', person, room, true);
    await viewing.view('socket-1', person, room, false);
    expect(await views()).toEqual([]);
    // A later close has nothing left to release.
    await viewing.end('socket-1');
    expect(await views()).toEqual([]);
  });

  it('records no view for someone who is not a member of the Room', async () => {
    await viewing.view('socket-2', stranger, room, true);
    expect(await views()).toEqual([]);
  });

  it('drops a view whose socket closed while it was being written', async () => {
    const query = db.query.bind(db);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const spy = vi.spyOn(db, 'query').mockImplementationOnce(async (...args) => {
      await held;
      return query(...(args as Parameters<typeof query>));
    });
    const pending = viewing.view('socket-3', person, room, true);
    const closed = viewing.end('socket-3');
    release();
    await Promise.all([pending, closed]);
    spy.mockRestore();
    expect(await views()).toEqual([]);
  });

  it('does not arm a renewal interval while a socket views a Room', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    await viewing.view('socket-1', person, room, true);
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  it('clears the previous process on restart while preserving a live peer', async () => {
    await viewing.view('old-socket', person, room, true);
    await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('fly-b:process-1')`);
    const peer = new PhoneViewing(db, 'fly-b:process-1');
    await peer.view('peer-socket', person, room, true);

    await clearStalePhoneViews(db, 'fly-a:process-2');
    expect(await views()).toEqual([
      { session_id: 'peer-socket', instance_id: 'fly-b:process-1', expires_at: null },
    ]);
  });

  it('clears a crashed peer whose instance record is stale', async () => {
    await viewing.view('old-socket', person, room, true);
    await db.query(`UPDATE live_server_instances SET renewed_at=now()-interval '2 minutes'`);
    await clearStalePhoneViews(db, 'fly-b:process-1');
    expect(await views()).toEqual([]);
  });

  it('resumes pushes when a crashed process loses its existing instance lease', async () => {
    const loop = new PushDeliveryLoop(db, { send });
    await loop.runOnce();
    await viewing.view('socket-1', person, room, true);
    await tagOwner();
    expect(await loop.runOnce()).toBe(0);
    await db.query(`UPDATE live_server_instances SET renewed_at=now()-interval '2 minutes'`);
    const pushed = await tagOwner();
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ messageId: pushed }),
    );
  });

  it('releases the view when its actual phone WebSocket closes', async () => {
    const server = createBeelineServer({
      database: db,
      auth: { authenticatePhone: vi.fn().mockResolvedValue(person) } as unknown as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      connectionPresence: { instanceId: instance } as ConnectionPresence,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.send(JSON.stringify({ type: 'viewing', roomId: room, viewing: true }));
      await vi.waitFor(async () => expect(await views()).toHaveLength(1));

      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.close();
      await closed;
      await vi.waitFor(async () => expect(await views()).toEqual([]));
    } finally {
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
