import { EventEmitter } from 'node:events';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomHistoryOutline } from '@beeline/api-contract/phone';
import type { TokenAuth } from './auth.js';
import { migrate } from './database.js';
import type { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { HistoryOutlineCache } from './history-outline-cache.js';
import { IdentityRateLimit, phoneReadLimits } from './phone-read-limit.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase } from './test-support.js';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const MALLORY = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const TOKENS: Record<string, string> = {
  [`bat_alice_${'x'.repeat(16)}`]: ALICE,
  [`bat_bob_${'x'.repeat(18)}`]: BOB,
  [`bat_mallory_${'x'.repeat(14)}`]: MALLORY,
};
const tokenOf = (identity: string) =>
  Object.entries(TOKENS).find(([, value]) => value === identity)![0];

const DATABASE_SNAPSHOT = await (async () => {
  const database = new PgliteDatabase();
  try {
    await migrate(database);
    return await database.snapshot();
  } finally {
    await database.close();
  }
})();

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private release?: () => Promise<void>;

  constructor(private readonly database: PgliteDatabase) {
    super();
  }

  async connect(): Promise<void> {}

  async query(sql: string): Promise<void> {
    if (sql !== `LISTEN ${POSTGRES_LIVE_CHANNEL}`) throw new Error(`unexpected query: ${sql}`);
    this.release = await this.database.client.listen(POSTGRES_LIVE_CHANNEL, (payload) =>
      this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload }));
  }

  async end(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    await release?.();
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

describe('identity rate limit', () => {
  it('trips after the window budget, resets when the window ends, and logs one line', () => {
    let now = 1_000;
    const log = vi.fn();
    const limit = new IdentityRateLimit('phone-history', 3, { now: () => now, log });
    expect([1, 2, 3].map(() => limit.admit(ALICE))).toEqual([true, true, true]);
    expect(limit.admit(ALICE)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[phone-history] rate-limited', `identity=${ALICE}`);
    now += 59_999;
    expect(limit.admit(ALICE)).toBe(false);
    now += 1;
    expect(limit.admit(ALICE)).toBe(true);
  });

  it("never limits one identity for another's traffic", () => {
    const limit = new IdentityRateLimit('phone-outline', 2, { now: () => 0, log: () => undefined });
    limit.admit(MALLORY);
    limit.admit(MALLORY);
    expect(limit.admit(MALLORY)).toBe(false);
    expect([limit.admit(ALICE), limit.admit(ALICE), limit.admit(ALICE)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limit.admit(BOB)).toBe(true);
  });
});

describe('history outline cache', () => {
  it('does not keep an outline counted while its Room changed', async () => {
    const live = new LiveHub();
    const cache = new HistoryOutlineCache(live);
    const counted = (total: number) => ({ roomId: ROOM, timeZone: 'UTC', total, days: [] });
    let finish!: (outline: RoomHistoryOutline) => void;
    const racing = cache.read(ROOM, 'UTC', 'n', () => new Promise((resolve) => (finish = resolve)));
    live.publish({ type: 'invalidate', roomId: ROOM, reason: 'postgres:messages' });
    finish(counted(1));
    expect((await racing).total).toBe(1);
    const compute = vi.fn(async () => counted(2));
    expect((await cache.read(ROOM, 'UTC', 'n', compute)).total).toBe(2);
    expect((await cache.read(ROOM, 'UTC', 'n', compute)).total).toBe(2);
    expect(compute).toHaveBeenCalledTimes(1);
    // A read mark or other Room event is not a message change.
    live.publish({ type: 'invalidate', roomId: ROOM, reason: 'postgres:room_read_marks' });
    await cache.read(ROOM, 'UTC', 'n', compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe('phone history and outline reads', () => {
  let database: PgliteDatabase;
  let live: LiveHub;
  let listener: PostgresLiveListener;
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;
  let outlineCounts: number;
  let messageEvents: number;
  let now: number;
  const log = vi.fn();

  const message = async (id: string, createdAt: string) =>
    database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'hi',$4)`,
      [id.repeat(64), ROOM, ALICE, createdAt],
    );
  const get = (path: string, identity = ALICE) =>
    fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${tokenOf(identity)}` } });
  const outline = async (identity = ALICE, tz = 'UTC') => {
    const response = await get(`/v1/phone/rooms/${ROOM}/outline?tz=${tz}`, identity);
    return { status: response.status, body: (await response.json()) as RoomHistoryOutline };
  };
  /** Waits until the listener has carried this many message notifications into the hub. */
  const notified = (count: number) => eventually(() => messageEvents >= count);

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    log.mockReset();
    now = 0;
    database = PgliteDatabase.fromSnapshot(DATABASE_SNAPSHOT);
    for (const [id, name] of [[ALICE, 'Alice'], [BOB, 'Bob'], [MALLORY, 'Mallory']])
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$2)`, [id, name]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,
      [ROOM, WORKSPACE, ALICE],
    );
    for (const identity of [ALICE, BOB])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
        [WORKSPACE, identity, ROOM],
      );
    await message('1', '2026-09-01T10:00:00Z');
    await message('2', '2026-09-02T10:00:00Z');

    outlineCounts = 0;
    const query = database.query.bind(database);
    database.query = (async (sql: string, values?: unknown[]) => {
      if (sql.includes('count(*) OVER (PARTITION BY local.day)')) outlineCounts += 1;
      return query(sql, values);
    }) as typeof database.query;

    live = new LiveHub();
    messageEvents = 0;
    live.subscribeAll((event) => {
      if (event.type === 'invalidate' && event.reason === 'postgres:messages') messageEvents += 1;
    });
    listener = new PostgresLiveListener(database, live, () => new PgliteListenClient(database), 1);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);

    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined, live);
    server = createBeelineServer({
      database,
      auth: {
        authenticatePhone: async (token: string) => TOKENS[token] ?? null,
        authenticateDaemon: async () => null,
      } as unknown as TokenAuth,
      phone,
      daemon: {} as DaemonService,
      live,
      mediaMaximumBytes: 1,
      phoneReadLimits: phoneReadLimits({
        history: { maxRequestsPerWindow: 3, now: () => now, log },
        outline: { maxRequestsPerWindow: 3, now: () => now, log },
        search: { maxRequestsPerWindow: 3, now: () => now, log },
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listener.stop();
    await database.close();
    vi.restoreAllMocks();
  });

  it('answers 429 to one identity over the history limit while another keeps paging', async () => {
    for (let request = 0; request < 3; request += 1)
      expect((await get(`/v1/phone/rooms/${ROOM}/history`)).status).toBe(200);
    const limited = await get(`/v1/phone/rooms/${ROOM}/history`);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'too_many_requests' });
    expect(log.mock.calls).toEqual([['[phone-history] rate-limited', `identity=${ALICE}`]]);

    const other = await get(`/v1/phone/rooms/${ROOM}/history`, BOB);
    expect(other.status).toBe(200);
    expect(((await other.json()) as { messages: unknown[] }).messages).toHaveLength(2);
    // The outline keeps its own budget.
    expect((await outline()).status).toBe(200);

    now += 60_000;
    expect((await get(`/v1/phone/rooms/${ROOM}/history`)).status).toBe(200);
  });

  it('answers 429 over the outline limit for that identity only', async () => {
    for (let request = 0; request < 3; request += 1) expect((await outline()).status).toBe(200);
    const limited = await outline();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'too_many_requests' });
    expect(log.mock.calls).toEqual([['[phone-outline] rate-limited', `identity=${ALICE}`]]);
    expect((await outline(BOB)).status).toBe(200);
  });

  it('answers the message search, refuses a bad query or cursor, and limits each identity', async () => {
    const found = await get(`/v1/phone/workspaces/${WORKSPACE}/search?q=hi`);
    expect(found.status).toBe(200);
    expect(
      ((await found.json()) as { results: { messageId: string }[] }).results.map(
        (result) => result.messageId,
      ),
    ).toEqual(['2'.repeat(64), '1'.repeat(64)]);
    const blank = await get(`/v1/phone/workspaces/${WORKSPACE}/search?q=%20`);
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: 'invalid_query' });
    const cursor = await get(`/v1/phone/workspaces/${WORKSPACE}/search?q=hi&before=nope`);
    expect(cursor.status).toBe(400);
    expect(await cursor.json()).toEqual({ error: 'invalid_cursor' });
    const limited = await get(`/v1/phone/workspaces/${WORKSPACE}/search?q=hi`);
    expect(limited.status).toBe(429);
    expect(log.mock.calls).toEqual([['[phone-search] rate-limited', `identity=${ALICE}`]]);
    expect(
      (await get(`/v1/phone/workspaces/${WORKSPACE}/search?q=${'x'.repeat(201)}`, BOB)).status,
    ).toBe(400);
    expect((await get(`/v1/phone/workspaces/${WORKSPACE}/search?q=hi`, BOB)).status).toBe(200);
    // Mallory is not in the Workspace.
    expect((await get(`/v1/phone/workspaces/${WORKSPACE}/search?q=hi`, MALLORY)).status).toBe(404);
  });

  it('counts a quiet Room once per time zone and recounts after any message change', async () => {
    const first = await outline();
    expect(first.body.total).toBe(2);
    expect((await outline(BOB)).body).toEqual(first.body);
    expect(outlineCounts).toBe(1);
    expect((await outline(ALICE, 'Asia%2FKolkata')).body.timeZone).toBe('Asia/Kolkata');
    expect(outlineCounts).toBe(2);
    now += 60_000;

    await message('3', '2026-09-03T10:00:00Z');
    await notified(1);
    const added = await outline();
    expect(outlineCounts).toBe(3);
    expect(added.body.total).toBe(3);
    expect(added.body.newest?.id).toBe('3'.repeat(64));
    await outline(BOB);
    expect(outlineCounts).toBe(3);

    // An older message leaves the newest one unchanged; the notification drops the entry.
    await message('0', '2026-08-31T10:00:00Z');
    await notified(2);
    expect((await outline()).body.total).toBe(4);
    expect(outlineCounts).toBe(4);
    now += 60_000;

    // An edit that hides a message from the outline.
    await database.query(`UPDATE messages SET card_type='grant-decision' WHERE id=$1`, [
      '1'.repeat(64),
    ]);
    await notified(3);
    expect((await outline()).body.total).toBe(3);
    expect(outlineCounts).toBe(5);

    await database.query(`DELETE FROM messages WHERE id=$1`, ['2'.repeat(64)]);
    await notified(4);
    const deleted = await outline();
    expect(deleted.body.total).toBe(2);
    expect(deleted.body.days.map((day) => day.day)).toEqual(['2026-08-31', '2026-09-03']);
    expect(outlineCounts).toBe(6);

    // A listener resync drops every entry.
    live.resync();
    await outline();
    expect(outlineCounts).toBe(7);
  });

  it('checks Room access before returning a cached outline', async () => {
    expect((await outline()).status).toBe(200);
    expect(outlineCounts).toBe(1);
    const refused = await outline(MALLORY);
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: 'not_found' });

    await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [BOB]);
    expect((await outline(BOB)).status).toBe(404);
    expect(outlineCounts).toBe(1);
  });
});
