import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PushDeliveryLoop } from './background.js';
import { PhoneViewing } from './phone-viewing.js';
import { PgliteDatabase } from './test-support.js';

const person = 'a'.repeat(64),
  stranger = 'b'.repeat(64),
  agent = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
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
async function views(): Promise<{ session_id: string; expires_at: Date }[]> {
  return (
    await db.query<{ session_id: string; expires_at: Date }>(
      `SELECT session_id,expires_at FROM room_push_views ORDER BY session_id`,
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
  viewing = new PhoneViewing(db);
});
afterEach(async () => {
  viewing.dispose();
  await db.close();
});

describe('phone viewing over the live socket', () => {
  it('holds pushes for the viewed Room until the socket that viewed it closes', async () => {
    const loop = new PushDeliveryLoop(db, { send });
    await loop.runOnce();

    await viewing.view('socket-1', person, room, true);
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

  it('keeps a held view alive from the server side, with nothing from the phone', async () => {
    await viewing.view('socket-1', person, room, true);
    await db.query(`UPDATE room_push_views SET expires_at=now()+interval '1 second'`);
    await viewing.renew();
    const [view] = await views();
    expect(view!.expires_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });
});
