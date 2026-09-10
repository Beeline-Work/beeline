import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { LiveHub, type LiveEvent } from './live.js';
import { announceAgentLifecycle, ConnectionPresence } from './connection-presence.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { PgliteDatabase } from './test-support.js';

const AUTHOR = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private release?: () => Promise<void>;
  readonly payloads: string[] = [];

  constructor(private readonly database: PgliteDatabase) {
    super();
  }

  async connect(): Promise<void> {}

  async query(sql: string): Promise<void> {
    if (sql !== `LISTEN ${POSTGRES_LIVE_CHANNEL}`) throw new Error(`unexpected query: ${sql}`);
    this.release = await this.database.client.listen(POSTGRES_LIVE_CHANNEL, (payload) => {
      this.payloads.push(payload);
      this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload });
    });
  }

  async end(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    await release?.();
  }

  async drop(): Promise<void> {
    await this.end();
    this.emit('end');
  }
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await predicate()).toBe(true);
}

describe('Postgres live fanout', () => {
  let database: PgliteDatabase;
  const listeners: PostgresLiveListener[] = [];

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [
      AUTHOR,
    ]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,
      [ROOM, WORKSPACE, AUTHOR],
    );
  });

  afterEach(async () => {
    await Promise.all(listeners.map((listener) => listener.stop()));
    await database.close();
    vi.restoreAllMocks();
  });

  it('fans a committed write from server A to a subscriber on server B', async () => {
    const liveA = new LiveHub();
    const liveB = new LiveHub();
    const clientsA: PgliteListenClient[] = [];
    const clientsB: PgliteListenClient[] = [];
    const listenerA = new PostgresLiveListener(
      database,
      liveA,
      () => {
        const client = new PgliteListenClient(database);
        clientsA.push(client);
        return client;
      },
      1,
    );
    const listenerB = new PostgresLiveListener(
      database,
      liveB,
      () => {
        const client = new PgliteListenClient(database);
        clientsB.push(client);
        return client;
      },
      1,
    );
    listeners.push(listenerA, listenerB);
    void listenerA.run();
    void listenerB.run();
    await eventually(() => clientsA.length === 1 && clientsB.length === 1);

    const received: LiveEvent[] = [];
    liveB.subscribe(ROOM, (event) => received.push(event));
    // Every successful LISTEN (including its first) now resyncs to recover a
    // delivery written before the listener was ready. Let that connection
    // establishment event settle before verifying the next committed write.
    await eventually(() =>
      received.some((event) => event.type === 'invalidate' && event.reason === 'resync'),
    );
    received.length = 0;
    await database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'hello')`,
        ['1'.repeat(64), ROOM, AUTHOR],
      );
      expect(received).toEqual([]);
    });

    await eventually(() => received.length === 1);
    expect(received).toEqual([
      expect.objectContaining({ type: 'invalidate', roomId: ROOM, agentId: AUTHOR }),
    ]);
    expect(clientsB[0]!.payloads).toHaveLength(1);
    expect(JSON.parse(clientsB[0]!.payloads[0]!)).toEqual(
      expect.objectContaining({
        table: 'messages',
        operation: 'INSERT',
        roomId: ROOM,
        messageId: '1'.repeat(64),
        agentId: AUTHOR,
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        databaseAt: expect.any(Number),
      }),
    );
    expect(received[0]).toEqual(
      expect.objectContaining({
        trace: expect.objectContaining({
          id: expect.stringMatching(/^[0-9a-f]{32}$/),
          databaseAt: expect.any(Number),
          emittedAt: expect.any(Number),
        }),
      }),
    );
    expect(clientsB[0]!.payloads[0]).not.toContain('hello');
  });

  it('publishes room-scoped message and turn notifications without a database lookup', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const query = vi.fn(database.query.bind(database));
    const listener = new PostgresLiveListener(
      { query, transaction: database.transaction.bind(database) },
      live,
      () => client,
      1,
    );
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribe(ROOM, (event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    received.length = 0;
    query.mockClear();

    for (const table of ['messages', 'agent_turns']) {
      client.emit('notification', {
        channel: POSTGRES_LIVE_CHANNEL,
        payload: JSON.stringify({
          table,
          operation: table === 'messages' ? 'INSERT' : 'UPDATE',
          roomId: ROOM,
          agentId: AUTHOR,
        }),
      });
    }

    await eventually(() => received.length === 2);
    expect(query).not.toHaveBeenCalled();
    expect(received.map((event) => event.type === 'invalidate' && event.reason)).toEqual([
      'postgres:messages',
      'postgres:agent_turns',
    ]);
  });

  it('fans an agent presence fact to every joined Room on another server', async () => {
    const otherRoom = '33333333-3333-4333-8333-333333333333';
    const agent = 'b'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other')`, [
      otherRoom,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$4,'member'),($1,$3,$4,'member')`,
      [WORKSPACE, ROOM, otherRoom, agent],
    );
    const liveB = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, liveB, () => client, 1);
    listeners.push(listener);
    void listener.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await announceAgentLifecycle(database, new LiveHub(), ROOM, agent, { lifecycleId: 'boot' });
    await eventually(() => liveB.latestAgentPresence(agent, ROOM)?.status === 'online');
    expect(liveB.latestAgentPresence(agent, otherRoom)?.status).toBe('online');
    await announceAgentLifecycle(database, new LiveHub(), otherRoom, agent, {
      lifecycleId: 'boot',
    });
    await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'online');
    const presenceRows = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM live_outputs
       WHERE agent_id=$1 AND kind='presence'`,
      [agent],
    );
    expect(presenceRows.rows[0]?.count).toBe('1');
    await database.query(
      `UPDATE live_outputs SET body=body || jsonb_build_object(
      'status','offline','observedAt',(body->>'observedAt')::bigint+1) WHERE agent_id=$1`,
      [agent],
    );
    await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'offline');
    expect(liveB.latestAgentPresence(agent, ROOM)?.status).toBe('offline');
  });

  it('fans one canonical presence notification across thirty Rooms on each listener', async () => {
    const agent = 'b'.repeat(64);
    const roomIds = Array.from(
      { length: 30 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    for (const roomId of roomIds) {
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Load')`, [
        roomId,
        WORKSPACE,
      ]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'member')`,
        [WORKSPACE, roomId, agent],
      );
    }
    for (const roomId of roomIds)
      await database.query(
        `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
         VALUES($1,$2,'presence','presence',$3::jsonb)`,
        [
          roomId,
          agent,
          JSON.stringify({
            status: 'online',
            observedAt: 1,
            evidenceNonce: 'before',
            lifecycleId: 'boot',
          }),
        ],
      );
    const queryA = vi.fn(database.query.bind(database));
    const queryB = vi.fn(database.query.bind(database));
    const liveA = new LiveHub();
    const liveB = new LiveHub();
    const clientA = new PgliteListenClient(database);
    const clientB = new PgliteListenClient(database);
    const listenerA = new PostgresLiveListener(
      { query: queryA, transaction: database.transaction.bind(database) },
      liveA,
      () => clientA,
      1,
    );
    const listenerB = new PostgresLiveListener(
      { query: queryB, transaction: database.transaction.bind(database) },
      liveB,
      () => clientB,
      1,
    );
    listeners.push(listenerA, listenerB);
    void listenerA.run();
    void listenerB.run();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const publishA = vi.spyOn(liveA, 'publish');
    const publishB = vi.spyOn(liveB, 'publish');
    const evidence = new ConnectionPresence(database, new LiveHub());
    await evidence.evidence(roomIds[0], agent);

    await eventually(
      () =>
        liveA.latestAgentPresence(agent, roomIds[0])?.status === 'online' &&
        liveB.latestAgentPresence(agent, roomIds[0])?.status === 'online',
    );
    await evidence.stop();
    const stored = await database.query<{ body: { evidenceNonce?: string } }>(
      `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
      [agent],
    );
    expect(stored.rows.filter((row) => row.body.evidenceNonce !== 'before')).toHaveLength(1);
    expect(clientA.payloads).toHaveLength(1);
    expect(clientB.payloads).toHaveLength(1);
    expect(queryA).toHaveBeenCalledTimes(1);
    expect(queryB).toHaveBeenCalledTimes(1);
    for (const query of [queryA.mock.calls[0]?.[0], queryB.mock.calls[0]?.[0]]) {
      expect(query).toContain('SELECT membership.room_id,presence.body');
      expect(query?.match(/SELECT body FROM live_outputs/g)).toHaveLength(1);
    }
    expect(publishA).toHaveBeenCalledTimes(roomIds.length);
    expect(publishB).toHaveBeenCalledTimes(roomIds.length);
    expect([...queryA.mock.calls, ...queryB.mock.calls].map(([sql]) => sql)).toContainEqual(
      expect.stringContaining('memberships'),
    );
    for (const roomId of roomIds) {
      expect(liveA.latestAgentPresence(agent, roomId)?.status).toBe('online');
      expect(liveB.latestAgentPresence(agent, roomId)?.status).toBe('online');
    }
  });

  it('rehydrates a missed delivery deadline when its first LISTEN connection opens', async () => {
    const agent = 'b'.repeat(64);
    const live = new LiveHub();
    const presence = new ConnectionPresence(database, live, 50);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, AUTHOR]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
      [WORKSPACE, ROOM, AUTHOR, agent],
    );
    try {
      await presence.start();
      await presence.announce(ROOM, agent, { lifecycleId: 'boot' });
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,mention_ids)
         VALUES($1,$2,$3,'Are you there?',$4::jsonb)`,
        ['2'.repeat(64), ROOM, AUTHOR, JSON.stringify([agent])],
      );
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client, 1);
      listeners.push(listener);
      void listener.run();
      await eventually(async () => {
        const row = await database.query<{ body: { status: string } }>(
          `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
          [agent],
        );
        return row.rows[0]?.body.status === 'offline';
      });
    } finally {
      await presence.stop();
    }
  });

  it('broadcasts resync after its listener connection is restored', async () => {
    const live = new LiveHub();
    const clients: PgliteListenClient[] = [];
    const listener = new PostgresLiveListener(
      database,
      live,
      () => {
        const client = new PgliteListenClient(database);
        clients.push(client);
        return client;
      },
      50,
    );
    listeners.push(listener);
    void listener.run();
    await eventually(() => clients.length === 1);

    const received: LiveEvent[] = [];
    const recovered: string[] = [];
    live.subscribe(ROOM, (event) => {
      received.push(event);
      if (event.type === 'invalidate' && event.reason === 'resync') {
        void database
          .query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 ORDER BY id`, [ROOM])
          .then((rows) => recovered.push(...rows.rows.map((row) => row.id)));
      }
    });
    await clients[0]!.drop();
    const missedId = '2'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'while down')`,
      [missedId, ROOM, AUTHOR],
    );
    await eventually(() => clients.length === 2);
    await eventually(() => received.some((event) => event.type === 'invalidate'));
    await eventually(() => recovered.includes(missedId));

    expect(received).toContainEqual({ type: 'invalidate', roomId: ROOM, reason: 'resync' });
    expect(recovered).toContain(missedId);
  });
});
