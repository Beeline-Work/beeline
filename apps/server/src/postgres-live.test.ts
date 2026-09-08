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
    expect(JSON.parse(clientsB[0]!.payloads[0]!)).toEqual({
      table: 'messages',
      operation: 'INSERT',
      roomId: ROOM,
      messageId: '1'.repeat(64),
      agentId: AUTHOR,
    });
    expect(clientsB[0]!.payloads[0]).not.toContain('hello');
  });

  it('fans the durable presence fact to every Room on another server without refresh notifications', async () => {
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
    await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'online');
    await database.query(
      `UPDATE live_outputs SET body=body || jsonb_build_object(
      'status','offline','observedAt',(body->>'observedAt')::bigint+1) WHERE agent_id=$1`,
      [agent],
    );
    await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'offline');
    expect(liveB.latestAgentPresence(agent, ROOM)?.status).toBe('offline');
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
