import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { migrate } from './database.js';
import { DurableLiveReplay, LIVE_REPLAY_LIMIT } from './durable-live.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

const VIEWER = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const snapshot = await (async () => {
  const db = new PgliteDatabase();
  try { await migrate(db); return await db.snapshot(); }
  finally { await db.close(); }
})();

type Frame = Record<string, any>;
describe('R-DURABLE-REPLAY: database writes → reconnect → phone socket', () => {
  let database: PgliteDatabase;
  const servers: ReturnType<typeof createBeelineServer>[] = [];
  const sockets: WebSocket[] = [];
  const unlisten: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    database = PgliteDatabase.fromSnapshot(snapshot);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader')`, [VIEWER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,
      [ROOM, WORKSPACE, VIEWER]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [WORKSPACE, ROOM, VIEWER]);
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const release of unlisten.splice(0)) await release();
    await database.close();
  });

  async function start(durable = true) {
    const live = new LiveHub();
    // PGlite's LISTEN callback is the same notification boundary used by the
    // production listener, without a separate PostgreSQL network process.
    unlisten.push(await database.client.listen(POSTGRES_LIVE_CHANNEL, raw => {
      const payload = JSON.parse(raw);
      if (payload.journalStreams) live.journalChanged(payload.journalStreams);
    }));
    const phone = new PhoneService(database, 'http://127.0.0.1');
    const server = createBeelineServer({ database, live, phone,
      ...(durable ? { replay: new DurableLiveReplay(database, live) } : {}),
      auth: { authenticatePhone: async () => VIEWER } as unknown as TokenAuth,
      daemon: {} as DaemonService, mediaMaximumBytes: 1 });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, live, port: (server.address() as AddressInfo).port };
  }
  async function connect(port: number) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    sockets.push(socket);
    const frames: Frame[] = [];
    const waiters = new Set<() => void>();
    socket.on('message', raw => { frames.push(JSON.parse(raw.toString())); for (const wake of waiters) wake(); });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const wait = (predicate: (frames: Frame[]) => boolean) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`frames: ${frames.length}`)); }, 30_000);
      const check = () => { if (!predicate(frames)) return; clearTimeout(timer); waiters.delete(check); resolve(); };
      waiters.add(check); check();
    });
    return { socket, frames, wait, send: (value: unknown) => socket.send(JSON.stringify(value)),
      close: () => new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.close(); }) };
  }
  async function post(count: number) {
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT 'message-' || n,$1,$2,'Missed ' || n,now()+n*interval '1 millisecond'
      FROM generate_series(1,$3) n`, [ROOM, VIEWER, count]);
  }
  async function seedCursor(client: Awaited<ReturnType<typeof connect>>) {
    client.send({ type: 'subscribe', roomId: ROOM });
    await client.wait(frames => frames.some(f => f.type === 'subscribed'));
    const ack = client.frames.find(f => f.type === 'subscribed')!;
    return { epoch: ack.epoch, base: ack.cursor, seen: [] };
  }

  it('records the old process-local path losing resume after a server restart', async () => {
    const first = await start(false);
    const client = await connect(first.port);
    const cursor = await seedCursor(client);
    await client.close();
    await post(300);
    await new Promise<void>(resolve => first.server.close(() => resolve()));
    const second = await start(false);
    const resumed = await connect(second.port);
    resumed.send({ type: 'subscribe', roomId: ROOM, cursors: { [ROOM]: cursor } });
    await resumed.wait(frames => frames.some(f => f.type === 'subscribed'));
    expect(resumed.frames.find(f => f.type === 'subscribed')).toMatchObject({ resumed: false });
    expect(resumed.frames.filter(f => f.type === 'message-delta')).toEqual([]);
  });

  it.each(['restart', 'second instance'])('delivers all missed messages in order after %s', async mode => {
    const first = await start();
    const client = await connect(first.port);
    const cursor = await seedCursor(client);
    await client.close();
    await post(300);
    if (mode === 'restart') await new Promise<void>(resolve => first.server.close(() => resolve()));
    const second = await start();
    const resumed = await connect(second.port);
    resumed.send({ type: 'subscribe', roomId: ROOM, cursors: { [ROOM]: cursor } });
    await resumed.wait(frames => frames.some(f => f.type === 'cursor' && f.sequence === cursor.base + 300));
    expect(resumed.frames.find(f => f.type === 'subscribed')).toMatchObject({ resumed: true });
    const messages = resumed.frames.filter(f => f.type === 'message-delta');
    expect(messages.map(f => f.message.id)).toEqual(Array.from({ length: 300 }, (_, n) => `message-${n + 1}`));
    expect(new Set(messages.map(f => `${f.epoch}:${f.sequence}`)).size).toBe(300);
    // A second resume at the delivered cursor sends none of them again.
    await resumed.close();
    const again = await connect(second.port);
    again.send({ type: 'subscribe', roomId: ROOM, cursors: { [ROOM]: {
      epoch: cursor.epoch, base: cursor.base + 300, seen: [] } } });
    await again.wait(frames => frames.some(f => f.type === 'cursor'));
    expect(again.frames.filter(f => f.type === 'message-delta')).toEqual([]);
  }, 120_000);

  it('reloads unknown/expired cursors and bounds durable storage', async () => {
    const instance = await start();
    const client = await connect(instance.port);
    const cursor = await seedCursor(client);
    await client.close();
    await post(LIVE_REPLAY_LIMIT + 1);
    const resumed = await connect(instance.port);
    resumed.send({ type: 'subscribe', roomId: ROOM, cursors: { [ROOM]: cursor } });
    await resumed.wait(frames => frames.some(f => f.type === 'subscribed'));
    expect(resumed.frames.find(f => f.type === 'subscribed')).toMatchObject({ resumed: false });
    expect((await database.query(`SELECT count(*)::int count FROM live_journal WHERE stream_id=$1`,
      [`room:${ROOM}`])).rows[0]?.count).toBe(LIVE_REPLAY_LIMIT);
    await resumed.close();
    const unknown = await connect(instance.port);
    unknown.send({ type: 'subscribe', roomId: ROOM, cursors: { [ROOM]: { ...cursor, epoch: 'unknown' } } });
    await unknown.wait(frames => frames.some(f => f.type === 'subscribed'));
    expect(unknown.frames.find(f => f.type === 'subscribed')).toMatchObject({ resumed: false });
  }, 120_000);

  it('replays workspace list changes missed while disconnected', async () => {
    const first = await start();
    const client = await connect(first.port);
    client.send({ type: 'sync', workspaceCursors: {} });
    await client.wait(frames => frames.some(f => f.type === 'sync-ok'));
    const ack = client.frames.find(f => f.type === 'workspace-cursor')!;
    await client.close();
    await database.query(`UPDATE rooms SET name='Renamed' WHERE id=$1`, [ROOM]);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name)
      VALUES('33333333-3333-4333-8333-333333333333',$1,$2,'New Room')`, [WORKSPACE, VIEWER]);
    await database.query(`UPDATE memberships SET role='member' WHERE room_id=$1`, [ROOM]);
    await database.query(`INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
      VALUES($1,$2,now(),'read-mark')`, [ROOM, VIEWER]);
    await database.query(`DELETE FROM rooms WHERE id='33333333-3333-4333-8333-333333333333'`);
    const second = await start();
    const resumed = await connect(second.port);
    resumed.send({ type: 'sync', workspaceCursors: {
      [WORKSPACE]: { epoch: ack.epoch, base: ack.sequence, seen: [] } } });
    await resumed.wait(frames => frames.some(f => f.type === 'sync-ok'));
    expect(resumed.frames.filter(f => f.type === 'invalidate' && f.reason === 'workspace-replay'))
      .toHaveLength(5);
    expect(resumed.frames.find(f => f.type === 'workspace-cursor')).toMatchObject({ reload: false });
  });

  it('delivers a write racing initial replay once', async () => {
    const instance = await start();
    const client = await connect(instance.port);
    const cursor = await seedCursor(client);
    await client.close();
    await post(10);
    const resumed = await connect(instance.port);
    resumed.send({ type: 'subscribe', roomId: ROOM, cursors: { [ROOM]: cursor } });
    await resumed.wait(frames => frames.some(f => f.type === 'subscribed'));
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('racing',$1,$2,'Racing')`,
      [ROOM, VIEWER]);
    await resumed.wait(frames => frames.some(f => f.type === 'cursor' && f.sequence === cursor.base + 11));
    const messages = resumed.frames.filter(f => f.type === 'message-delta');
    expect(messages).toHaveLength(11);
    expect(messages.filter(f => f.message.id === 'racing')).toHaveLength(1);
  });

  it('replays parent corner status after a disconnected corner creation', async () => {
    const instance = await start();
    const client = await connect(instance.port);
    const cursor = await seedCursor(client);
    await client.close();
    const corner = '44444444-4444-4444-8444-444444444444';
    await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
      VALUES($1,$2,$3,$4,'Corner')`, [corner, WORKSPACE, ROOM, VIEWER]);
    await database.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,objective)
      VALUES($1,$2,'Catch up')`, [corner, VIEWER]);
    const resumed = await connect(instance.port);
    resumed.send({ type: 'subscribe', roomId: ROOM, cursors: { [ROOM]: cursor } });
    await resumed.wait(frames => frames.some(f => f.type === 'cursor'));
    expect(resumed.frames.find(f => f.type === 'corner-status')).toMatchObject({ cornerCount: 1 });
  });

  it('replays edits, reactions, deletes, activity, and turn state through the existing projections', async () => {
    const instance = await start();
    const client = await connect(instance.port);
    const cursor = await seedCursor(client);
    await client.close();
    await post(2);
    await database.query(`UPDATE messages SET text='Edited',reactions=$1::jsonb WHERE id='message-1'`,
      [JSON.stringify({ '👍': [VIEWER] })]);
    await database.query(`DELETE FROM messages WHERE id='message-2'`);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
      VALUES('activity',$1,$2,'Did work','activity')`, [ROOM, VIEWER]);
    await database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status)
      VALUES($1,'turn',$2,'working')`, [ROOM, VIEWER]);
    await database.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`, [ROOM]);
    const resumed = await connect(instance.port);
    resumed.send({ type: 'subscribe', roomId: ROOM, cursors: { [ROOM]: cursor } });
    await resumed.wait(frames => frames.some(f => f.type === 'cursor' && f.sequence === cursor.base + 7));
    expect(resumed.frames.find(f => f.type === 'message-delta' && f.message.id === 'message-1'))
      .toMatchObject({ message: { text: 'Edited', reactions: [{ emoji: '👍', count: 1, reacted: true }] } });
    expect(resumed.frames.some(f => f.type === 'invalidate' && f.reason.startsWith('delta-fallback:'))).toBe(true);
    expect(resumed.frames.some(f => f.type === 'turn-delta' && f.turn.status === 'complete')).toBe(true);
    const journal = await database.query<{ event: { reason: string } }>(
      `SELECT event FROM live_journal WHERE stream_id=$1 AND sequence>$2 ORDER BY sequence`,
      [`room:${ROOM}`, cursor.base]);
    expect(journal.rows.filter(row => row.event.reason === 'postgres:messages')).toHaveLength(5);
  });

  it('does not journal a rolled-back write or replay an inaccessible Room', async () => {
    const instance = await start();
    const client = await connect(instance.port);
    const cursor = await seedCursor(client);
    await client.close();
    await expect(database.transaction(async db => {
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('rollback',$1,$2,'No commit')`,
        [ROOM, VIEWER]);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    const head = await new DurableLiveReplay(database, instance.live).read(`room:${ROOM}`, cursor);
    expect(head.resumed).toBe(true);
    expect(head.sequence).toBe(cursor.base);
    expect(head.replay).toEqual([]);
    await post(1);
    await database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1`, [ROOM]);
    const resumed = await connect(instance.port);
    resumed.send({ type: 'subscribe', roomId: ROOM, cursors: { [ROOM]: cursor } });
    // Sync is ordered after subscribe; once acknowledged, no unauthorized
    // Room frame can still be waiting behind subscription admission.
    resumed.send({ type: 'sync', workspaceCursors: {} });
    await resumed.wait(frames => frames.some(f => f.type === 'sync-ok'));
    expect(resumed.frames.some(f => f.roomId === ROOM)).toBe(false);
  });
});
