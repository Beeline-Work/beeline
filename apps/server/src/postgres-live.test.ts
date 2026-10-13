import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResultRow } from 'pg';
import { migrate, type SqlDatabase } from './database.js';
import { DeadlineExpiry } from './deadline-expiry.js';
import { LiveHub, type LiveEvent } from './live.js';
import {
  announceAgentLifecycle,
  claimAgentConnection,
  ConnectionPresence,
} from './connection-presence.js';
import {
  notifyAgentConfigChange,
  notifyConnectorAssignment,
  POSTGRES_LIVE_CHANNEL,
  PostgresLiveListener,
  type LivePgClient,
} from './postgres-live.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

const AUTHOR = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

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

/** Wait until every earlier notification has reached the parent, then forget them. */
async function settle(parent: LiveEvent[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  parent.length = 0;
}

/** Reads the database clock shifted by `offsetMs`, as a skewed server would. */
class SkewedClockDatabase implements SqlDatabase {
  offsetMs = 0;

  constructor(private readonly database: SqlDatabase) {}

  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) {
    return this.database.query<Row>(
      sql.replaceAll('now()', `(now()+interval '${this.offsetMs} milliseconds')`), values);
  }

  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return work(this);
  }
}

describe('Postgres live fanout', () => {
  let database: PgliteDatabase;
  const listeners: PostgresLiveListener[] = [];

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    database = PgliteDatabase.fromSnapshot(DATABASE_SNAPSHOT);
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

  /** Open a corner under ROOM with one owed item that expires at `expiresAt`. */
  async function insertExpiringOwed(expiresAt: Date): Promise<void> {
    const corner = 'cccccccc-cccc-4ccc-8ccc-ccccccccccce';
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('owed-x',$1,$2,'question')`,
      [corner, AUTHOR]);
    await database.query(
      `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,expires_at,answerable)
       VALUES($1,$2,'owed-x',now(),$3,true)
       ON CONFLICT (message_id,person_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
      [corner, AUTHOR, expiresAt]);
  }

  it('publishes owner-scoped install, vault and agent commits without an idle read', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);

    const agent = 'b'.repeat(64);
    const connector = '33333333-3333-4333-8333-333333333333';
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')`, [agent]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, AUTHOR]);
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,owner_identity_id,connector_type,helper_agent_id)
      VALUES($1,$2,$3,'tailscale',$4)`, [connector, WORKSPACE, AUTHOR, agent]);
    await database.query(`INSERT INTO workspace_connections
      (id,connector_id,owner_identity_id,reference) VALUES($1,$2,$3,'vault-ref')`,
      ['44444444-4444-4444-8444-444444444444', connector, AUTHOR]);
    await eventually(() => ['agent', 'install', 'workbench'].every((resource) =>
      received.some((event) => event.type === 'resource-change' &&
        event.resource === resource)));
    expect(received).toContainEqual({ type: 'resource-change', roomId: '',
      ownerId: AUTHOR, resource: 'install', resourceId: connector });
    expect(received).toContainEqual({ type: 'resource-change', roomId: '',
      ownerId: AUTHOR, resource: 'workbench' });
  });

  it('publishes machine broker reports and sign-in progress to the owner surfaces', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    const agent = 'b'.repeat(64);
    await database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')", [agent]);
    await database.query("INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'machine')",
      [agent, AUTHOR]);
    await settle(received);
    await database.query("UPDATE agents SET squire_report=$2::jsonb,squire_work=$3::jsonb WHERE agent_id=$1",
      [agent, JSON.stringify({ status: 'error', errorMessage: 'Squire broker unavailable', reportedAt: 1 }),
        JSON.stringify({ generation: 1, install: true, steps: [] })]);
    await eventually(() => received.some((event) => event.type === 'resource-change' && event.resource === 'workbench')
      && received.some((event) => event.type === 'resource-change' && event.resource === 'install'));
    expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR, resource: 'workbench' });
    expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR,
      resource: 'install', resourceId: 'squire:machine' });
  });

  it('names a Workspace header or identity change by id, and only to who shares it', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const events: LiveEvent[] = [];
    live.subscribeAll((event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);

    const workspaceMate = 'c'.repeat(64);
    const roomMate = 'd'.repeat(64);
    const outsider = 'e'.repeat(64);
    const otherWorkspace = '55555555-5555-4555-8555-555555555555';
    const otherRoom = '66666666-6666-4666-8666-666666666666';
    for (const [id, name] of [[workspaceMate, 'Mate'], [roomMate, 'Guest'], [outsider, 'Outsider']])
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$2)`, [id, name]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Elsewhere')`, [otherWorkspace]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Shared')`,
      [otherRoom, otherWorkspace, roomMate],
    );
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),
      ($2,NULL,$5,'owner'),($2,NULL,$6,'member'),($2,$7,$5,'owner'),($2,$7,$3,'member')`,
      [WORKSPACE, otherWorkspace, AUTHOR, workspaceMate, roomMate, outsider, otherRoom]);

    await database.query(`UPDATE workspaces SET about='no header change' WHERE id=$1`, [WORKSPACE]);
    await database.query(`UPDATE identities SET welcome_cards_due=false WHERE id=$1`, [AUTHOR]);
    await database.query(`UPDATE workspaces SET name='Renamed' WHERE id=$1`, [WORKSPACE]);
    await database.query(`UPDATE identities SET name='Author Two' WHERE id=$1`, [AUTHOR]);
    await eventually(() => events.some((event) =>
      event.type === 'invalidate' && event.reason === 'postgres:identities'));
    const changes = events.filter((event) => event.type === 'invalidate' &&
      (event.reason === 'postgres:workspaces' || event.reason === 'postgres:identities'));
    expect(changes).toEqual([
      { type: 'invalidate', roomId: '', reason: 'postgres:workspaces', workspaceId: WORKSPACE },
      { type: 'invalidate', roomId: '', reason: 'postgres:identities', personId: AUTHOR },
    ]);

    const phone = new PhoneService(database, 'http://local.test');
    const workspace = await phone.liveWorkspaceChange(WORKSPACE);
    expect(workspace?.workspace).toEqual({ id: WORKSPACE, name: 'Renamed' });
    expect([...workspace!.viewers].sort()).toEqual([AUTHOR, workspaceMate].sort());

    const person = await phone.livePersonChange(AUTHOR);
    expect(person?.person).toEqual({ pubkey: AUTHOR, kind: 'human', name: 'Author Two' });
    expect(person?.pushLevel).toBe('default');
    expect([...person!.viewers].sort()).toEqual([AUTHOR, workspaceMate, roomMate].sort());
    // A viewer who shares no Workspace or Room with the person never hears it.
    expect(person!.viewers.has(outsider)).toBe(false);

    await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [workspaceMate]);
    expect((await phone.livePersonChange(AUTHOR))!.viewers.has(workspaceMate)).toBe(false);
    expect((await phone.liveWorkspaceChange(WORKSPACE))!.viewers.has(workspaceMate)).toBe(false);
  });

  it('wakes push only after message and device writes commit', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const wake = vi.fn();
    listener.setPushWake(wake);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await eventually(() => wake.mock.calls.length === 1);
    wake.mockClear();
    await database.transaction(async (db) => {
      await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment)
        VALUES('push-wake-device',$1,'ios','physical')`, [AUTHOR]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text)
        VALUES('push-wake-message',$1,$2,'hello')`, [ROOM, AUTHOR]);
      expect(wake).not.toHaveBeenCalled();
    });
    await eventually(() => wake.mock.calls.length === 2);
    await database.query(`INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
      VALUES($1,$2,now(),'push-wake-message')`, [ROOM, AUTHOR]);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('fans out one committed helper release without a follow-up read', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const events: LiveEvent[] = [];
    live.subscribeAll((event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    const query = vi.spyOn(database, 'query');
    await database.query(`INSERT INTO helper_release_notifications(singleton,version,sha)
      VALUES(true,'v0.0.128',$1)`, ['a'.repeat(40)]);
    await eventually(() => events.some((event) => event.type === 'helper-release'));
    expect(events.filter((event) => event.type === 'helper-release')).toEqual([{
      type: 'helper-release',
      version: 'v0.0.128', sha: 'a'.repeat(40),
    }]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('delivers read-mark changes to the listener with the reader identity', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const events: LiveEvent[] = [];
    const release = live.subscribe(ROOM, (event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await database.query(
      `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
       VALUES($1,$2,now(),$3)`,
      [ROOM, AUTHOR, 'a'.repeat(64)],
    );
    await eventually(() => events.some((event) =>
      event.type === 'invalidate' && event.reason === 'postgres:room_read_marks'));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'invalidate', roomId: ROOM, readerId: AUTHOR,
    }));
    release();
    await listener.stop();
  });

  it('routes a bookmark change to its owner without broadcasting its content', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const events: LiveEvent[] = [];
    live.subscribeAll((event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('saved-message',$1,$2,'private content')`, [ROOM, AUTHOR]);
    await database.query(`INSERT INTO message_bookmarks(
      identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,
      message_created_at
    ) SELECT $1,$2,$3,id,'Room','room',created_at FROM messages WHERE id='saved-message'`,
    [AUTHOR, WORKSPACE, ROOM]);
    await eventually(() => events.some((event) => event.type === 'invalidate' &&
      event.reason === 'postgres:message_bookmarks'));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'invalidate', roomId: '', reason: 'postgres:message_bookmarks',
      readerId: AUTHOR, workspaceId: WORKSPACE, messageId: 'saved-message',
    }));
    expect(client.payloads.find((payload) => payload.includes('message_bookmarks')))
      .not.toContain('private content');
  });

  it('coalesces a section clear into one Needs-you wake per Room', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const events: LiveEvent[] = [];
    live.subscribeAll((event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('ask-one',$1,$2,'@author please review?'),
        ('ask-two',$1,$2,'@author please approve?')`, [ROOM, AUTHOR]);
    await database.transaction(async (db) => {
      await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at)
        VALUES($1,'ask-one',$2,now()),($1,'ask-two',$2,now())`, [AUTHOR, WORKSPACE]);
    });
    await eventually(() => events.some((event) => event.type === 'invalidate' &&
      event.reason === 'postgres:needs_you_marks'));
    expect(events.filter((event) => event.type === 'invalidate' &&
      event.reason === 'postgres:needs_you_marks')).toEqual([
      expect.objectContaining({ roomId: '', readerId: AUTHOR, sourceRoomId: ROOM }),
    ]);
    expect(client.payloads.filter((payload) => payload.includes('needs_you_marks')))
      .toHaveLength(1);
  });

  it('bounds notification DB projections and coalesces a repeated repository wake', async () => {
    let releaseReads!: () => void;
    const readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
    let active = 0;
    let peak = 0;
    let repositoryReads = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM rooms WHERE repository_key')) {
        active++;
        peak = Math.max(peak, active);
        await readBarrier;
        active--;
        repositoryReads++;
      }
      return { rows: [], rowCount: 0 };
    });
    const client = new EventEmitter() as EventEmitter & LivePgClient;
    let listening = false;
    client.connect = async () => undefined;
    client.query = async () => { listening = true; };
    client.end = async () => { client.emit('end'); };
    const live = new LiveHub();
    const listener = new PostgresLiveListener(
      { query, transaction: vi.fn() }, live, () => client, 1,
    );
    listeners.push(listener);
    const running = listener.run();
    await eventually(() => listening);
    for (let index = 0; index < 15; index++)
      client.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({
        table: 'github_repositories', operation: 'UPDATE', roomId: ROOM,
        repositoryId: String(index),
      }) });
    expect(listener.projectionHealth()).toMatchObject({
      connected: true, active: 2, queued: 13, delivered: 0, failed: 0,
    });
    expect(listener.projectionHealth().oldestActiveAgeMs).not.toBeNull();
    expect(listener.projectionHealth().oldestQueuedAgeMs).not.toBeNull();
    client.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({
      table: 'github_repositories', operation: 'UPDATE', roomId: ROOM, repositoryId: '5',
    }) });
    expect(listener.projectionHealth().queued).toBe(13);
    releaseReads();
    await eventually(() => repositoryReads === 15);
    expect(peak).toBe(2);
    expect(listener.projectionHealth()).toMatchObject({
      active: 0, queued: 0, dropped: 0, delivered: 15, failed: 0,
      oldestActiveAgeMs: null, oldestQueuedAgeMs: null,
    });
    const health = listener.projectionHealth();
    expect(health.lastNotificationAt).not.toBeNull();
    expect(health.lastDeliveredAt).toBeGreaterThanOrEqual(health.lastNotificationAt!);
    expect(health.lastDeliveryAgeMs).not.toBeNull();
    expect(listener.projectionHealth().deliveryAgeBuckets.reduce((sum, count) => sum + count, 0))
      .toBe(15);
    await listener.stop();
    await running;
    expect(listener.projectionHealth().connected).toBe(false);
  });

  it('sends one recovery resync after a saturated notification backlog drains', async () => {
    let releaseReads!: () => void;
    const readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM rooms WHERE repository_key')) await readBarrier;
      return { rows: [], rowCount: 0 };
    });
    const client = new EventEmitter() as EventEmitter & LivePgClient;
    let listening = false;
    client.connect = async () => undefined;
    client.query = async () => { listening = true; };
    client.end = async () => { client.emit('end'); };
    const live = new LiveHub();
    const resync = vi.fn();
    live.subscribeResync(resync);
    const listener = new PostgresLiveListener(
      { query, transaction: vi.fn() }, live, () => client, 1,
    );
    listeners.push(listener);
    const running = listener.run();
    await eventually(() => listening && resync.mock.calls.length === 1);
    resync.mockClear();
    for (let index = 0; index < 520; index++)
      client.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({
        table: 'github_repositories', operation: 'UPDATE', roomId: ROOM,
        repositoryId: String(index),
      }) });
    expect(listener.projectionHealth()).toMatchObject({
      active: 2, queued: 512, dropped: 6, resyncPending: true,
    });
    releaseReads();
    await eventually(() => listener.projectionHealth().active === 0 &&
      listener.projectionHealth().queued === 0);
    expect(resync).toHaveBeenCalledOnce();
    await listener.stop();
    await running;
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
      expect.objectContaining({
        type: 'invalidate',
        roomId: ROOM,
        agentId: AUTHOR,
        messageId: '1'.repeat(64),
      }),
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
          ...(table === 'messages' ? { messageId: 'message-id' } : { requestId: 'request-id' }),
        }),
      });
    }

    await eventually(() => received.length === 2);
    expect(query).not.toHaveBeenCalled();
    expect(received.map((event) => event.type === 'invalidate' && event.reason)).toEqual([
      'postgres:messages',
      'postgres:agent_turns',
    ]);
    expect(received).toEqual([
      expect.objectContaining({ messageId: 'message-id' }),
      expect.objectContaining({ requestId: 'request-id' }),
    ]);
  });

  it('relays a newer helper connection epoch to every other server instance', async () => {
    const agent = 'f'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    received.length = 0;

    // Server A accepts the connection against its own hub; B learns through PostgreSQL.
    const epoch = await claimAgentConnection(database, new LiveHub(), agent, { lifecycleId: 'life' }, {
      connectionId: 'connection-a', instanceId: 'server-a',
    });
    await eventually(() => received.some((event) => event.type === 'agent-connection'));
    expect(received.filter((event) => event.type === 'agent-connection')).toEqual([
      { type: 'agent-connection', roomId: '', agentId: agent, epoch },
    ]);
  });

  it('delivers a membership change as an agent-directed invalidation', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    received.length = 0;

    const freshRoom = '99999999-9999-4999-8999-999999999999';
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'milo')`,
      [freshRoom, WORKSPACE, AUTHOR],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, freshRoom, AUTHOR],
    );

    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:memberships' &&
          event.targetAgentId === AUTHOR &&
          event.roomId === freshRoom,
      ),
    );
  });

  it('pushes an expired Registry OAuth attempt when its server clock ends', async () => {
    const helper = 'b'.repeat(64);
    const connector = '55555555-5555-4555-8555-555555555555';
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')`, [helper]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [helper, AUTHOR]);
    await database.query(
      `INSERT INTO workspace_connectors(
        id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,status,
        registry_server_name,registry_version,registry_manifest,display_name)
       VALUES($1,$2,$3,'registry-mcp',$4,$4,'installing','app.linear/linear','1.0.1',
         $5::jsonb,'Linear')`,
      [connector, WORKSPACE, AUTHOR, helper,
        JSON.stringify({ name: 'app.linear/linear', version: '1.0.1' })],
    );
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    await database.query(
      `INSERT INTO registry_mcp_oauth_attempts(state,connector_id,expires_at)
       VALUES('registry-expiry-test',$1,now()+interval '100 milliseconds')`,
      [connector],
    );
    await eventually(() => received.some((event) => event.type === 'invalidate' &&
      event.reason === 'connector-assignment' && event.targetAgentId === helper));
  });

  it('names the parent Room and the corner opener on a corner membership invalidate', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    received.length = 0;

    const corner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, corner, AUTHOR],
    );

    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:memberships' &&
          event.targetAgentId === AUTHOR &&
          event.roomId === corner &&
          event.parentRoomId === ROOM &&
          event.openedBy === AUTHOR &&
          event.removed !== true,
      ),
    );

    // `openCorner` writes the corner's memberships before `corner_facts`, so
    // the opener is read the way the corner list reads it: the recorded owner
    // once it exists, and the room's creator until then.
    const opener = 'b'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [opener]);
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective) VALUES($1,$2,'fix it')`,
      [corner, opener],
    );
    received.length = 0;
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
      [WORKSPACE, corner, opener],
    );

    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:memberships' &&
          event.targetAgentId === opener &&
          event.openedBy === opener &&
          event.archived !== true,
      ),
    );

    // Inheriting a Room membership writes one row per corner under it, archived
    // ones included; the helper must be able to drop those without a read.
    await database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]);
    const latecomer = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Cee')`, [
      latecomer,
    ]);
    received.length = 0;
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, corner, latecomer],
    );

    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:memberships' &&
          event.targetAgentId === latecomer &&
          event.archived === true,
      ),
    );
  });

  it('names the parent Room and opener on a queued command for a corner this helper never watched', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);

    const corner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const target = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Cee')`, [
      target,
    ]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('tag-source',$1,$2,'@cee fix this')`,
      [corner, AUTHOR],
    );
    received.length = 0;

    await database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth
       ) VALUES($1,$2,$3,'tag-source',$4,'input','human_tag',$1,'tag-source',0)`,
      ['command-1', corner, target, 'f'.repeat(64)],
    );

    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:agent_commands' &&
          event.targetAgentId === target &&
          event.roomId === corner &&
          event.parentRoomId === ROOM &&
          event.openedBy === AUTHOR,
      ),
    );
  });

  it('marks a command released only when it leaves claimed', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);

    const worker = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Cee')`, [
      worker,
    ]);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('work-source',$1,$2,'@cee work')`,
      [ROOM, AUTHOR],
    );
    const commandEvents = () =>
      received.filter(
        (event) => event.type === 'invalidate' && event.reason === 'postgres:agent_commands',
      );
    await database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth
       ) VALUES($1,$2,$3,'work-source',$4,'input','human_tag',$1,'work-source',0)`,
      ['work-1', ROOM, worker, 'f'.repeat(64)],
    );
    await database.query(
      `UPDATE agent_commands SET state='claimed',lease_expires_at=now()+interval '90 seconds' WHERE id='work-1'`,
    );
    await database.query(
      `UPDATE agent_commands SET lease_expires_at=now()+interval '120 seconds' WHERE id='work-1'`,
    );
    await eventually(() => commandEvents().length === 3);
    expect(commandEvents().some((event) => event.type === 'invalidate' && event.commandReleased))
      .toBe(false);

    await database.query(`UPDATE agent_commands SET state='complete' WHERE id='work-1'`);
    await eventually(() => commandEvents().length === 4);
    expect(commandEvents()[3]).toMatchObject({ targetAgentId: worker, commandReleased: true });
  });

  it('nudges the parent Room only when a corner status input changes', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const parent: LiveEvent[] = [];
    live.subscribe(ROOM, (event) => parent.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);

    const corner = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const agent = 'e'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective) VALUES($1,$2,'fix it')`,
      [corner, agent],
    );
    const nudges = () =>
      parent.filter((event) => event.type === 'invalidate' && event.reason === 'corner-status');
    await settle(parent);

    await database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'r1',$2,'working')`,
      [corner, agent],
    );
    await eventually(() => nudges().length === 1);
    // A heartbeat that only restamps the running turn changes no status.
    await database.query(
      `UPDATE agent_turns SET created_at=now() WHERE room_id=$1 AND request_id='r1'`,
      [corner],
    );
    await database.query(
      `UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND request_id='r1'`,
      [corner],
    );
    await eventually(() => nudges().length === 2);
    await database.query(
      `UPDATE corner_facts SET lifecycle='{"lifecycle":"pr-open","checks":"pending"}'::jsonb
       WHERE corner_id=$1`,
      [corner],
    );
    await eventually(() => nudges().length === 3);
    // An approval waiting inside the corner is the parent Room's needs-you dot.
    await database.query(
      `INSERT INTO permission_authority(room_id,permission_id,principal_id,request_id,scope,status)
       VALUES($1,'perm-1',$2,'r1','{}'::jsonb,'pending')`,
      [corner, agent],
    );
    await eventually(() => nudges().length === 4);
    await database.query(
      `UPDATE permission_authority SET status='authorized' WHERE room_id=$1`,
      [corner],
    );
    await eventually(() => nudges().length === 5);
    // A top-level Room's own turn has no parent to nudge.
    await database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'r2',$2,'working')`,
      [ROOM, agent],
    );
    await eventually(() =>
      parent.some(
        (event) => event.type === 'invalidate' && event.reason === 'postgres:agent_turns',
      ),
    );
    expect(nudges()).toHaveLength(5);
    expect(nudges()).toEqual(
      Array(5).fill({ type: 'invalidate', roomId: ROOM, reason: 'corner-status' }),
    );
  });

  it('nudges the parent Room for every projected corner-row change', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const parent: LiveEvent[] = [];
    live.subscribe(ROOM, (event) => parent.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    const nudges = () =>
      parent.filter((event) => event.type === 'invalidate' && event.reason === 'corner-status');

    const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const agent = 'e'.repeat(64);
    const reader = 'f'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader')`, [reader]);
    // A new corner is a new row in its parent's list.
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await eventually(() => nudges().length >= 1);
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective) VALUES($1,$2,'fix it')`,
      [corner, agent],
    );
    await settle(parent);

    const expectNudge = async (write: () => Promise<unknown>) => {
      await settle(parent);
      await write();
      await eventually(() => nudges().length >= 1);
    };
    // A review verdict or ask_human moves only the workflow columns.
    await expectNudge(() => database.query(
      `UPDATE corner_facts SET workflow_state='review' WHERE corner_id=$1`, [corner]));
    await expectNudge(() => database.query(
      `UPDATE corner_facts SET workflow_outcome='ask_human' WHERE corner_id=$1`, [corner]));
    await expectNudge(() => database.query(
      `INSERT INTO corner_follows(corner_id,identity_id) VALUES($1,$2)`, [corner, reader]));
    await expectNudge(() => database.query(
      `DELETE FROM corner_follows WHERE corner_id=$1 AND identity_id=$2`, [corner, reader]));
    await expectNudge(() => database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, corner, reader]));
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('owed-1',$1,$2,'question')`,
      [corner, agent]);
    await expectNudge(() => database.query(
      `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,expires_at,answerable)
       VALUES($1,$2,'owed-1',now(),now()+interval '1 hour',true)
       ON CONFLICT (message_id,person_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
      [corner, reader]));
    await expectNudge(() => database.query(`UPDATE rooms SET name='renamed' WHERE id=$1`, [corner]));
    await expectNudge(() => database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [corner, reader]));
    await expectNudge(() => database.query(
      `UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]));

    // Every other projected column: objective, initiator, owner, row stamp,
    // brief revision, app binding and the newest chat message.
    await expectNudge(() => database.query(
      `UPDATE corner_facts SET objective='still fix it' WHERE corner_id=$1`, [corner]));
    await expectNudge(() => database.query(
      `UPDATE corner_facts SET commissioned_by=$2 WHERE corner_id=$1`, [corner, reader]));
    await expectNudge(() => database.query(
      `UPDATE corner_facts SET commissioned_by=NULL WHERE corner_id=$1`, [corner]));
    await expectNudge(() => database.query(
      `UPDATE corner_facts SET owner_agent_id=NULL WHERE corner_id=$1`, [corner]));
    await expectNudge(() => database.query(`UPDATE rooms SET updated_at=now() WHERE id=$1`, [corner]));
    await expectNudge(() => database.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
       VALUES($1,1,'brief',$2,$3)`, [corner, agent, ROOM]));
    const installation = '99999999-9999-4999-8999-999999999999';
    await database.query(
      `INSERT INTO corner_app_installations(id,workspace_id,installed_by,manifest)
       VALUES($1,$2,$3,'{}'::jsonb)`, [installation, WORKSPACE, AUTHOR]);
    await expectNudge(() => database.query(
      `INSERT INTO corner_app_bindings(corner_id,installation_id,instance_id,bound_by)
       VALUES($1,$2,gen_random_uuid(),$3)`, [corner, installation, AUTHOR]));
    await expectNudge(() => database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('latest-1',$1,$2,'done')`,
      [corner, agent]));
    await expectNudge(() => database.query(
      `UPDATE messages SET text='done, edited' WHERE id='latest-1'`));
    await expectNudge(() => database.query(
      `UPDATE messages SET presentation='activity' WHERE id='latest-1'`));

    // A write that changes no corner-row column stays off the parent.
    await settle(parent);
    await database.query(`UPDATE corner_facts SET close_requested=true WHERE corner_id=$1`, [corner]);
    await database.query(
      `UPDATE rooms SET github_events_enabled=NOT github_events_enabled WHERE id=$1`, [corner]);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES('step-1',$1,$2,'step','activity')`,
      [corner, agent]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(nudges()).toEqual([]);
  });

  it('nudges the parent Room on every server machine, whichever one wrote', async () => {
    const machines = [new LiveHub(), new LiveHub()];
    const parents: LiveEvent[][] = [[], []];
    for (const [index, live] of machines.entries()) {
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client, 1);
      listeners.push(listener);
      live.subscribe(ROOM, (event) => parents[index]!.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
    }
    const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccf';
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await settle(parents[0]!);
    await settle(parents[1]!);
    // Neither machine publishes in-process: only the committed rename runs.
    await database.query(`UPDATE rooms SET name='renamed' WHERE id=$1`, [corner]);
    for (const parent of parents)
      await eventually(() => parent.some((event) =>
        event.type === 'invalidate' && event.reason === 'corner-status'));
  });

  it('delivers one parent nudge for an owed refresh that rewrites many rows', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
    const agent = 'e'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    for (const id of ['owed-a', 'owed-b', 'owed-c'])
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'question')`,
        [id, corner, agent]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.payloads.length = 0;
    await database.transaction(async (db) => {
      await db.query(`DELETE FROM corner_owed WHERE corner_id=$1`, [corner]);
      for (const id of ['owed-a', 'owed-b', 'owed-c'])
        await db.query(
          `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,answerable)
           VALUES($1,$2,$3,now(),true)`,
          [corner, AUTHOR, id]);
    });
    await eventually(() => client.payloads.some((raw) => raw.includes('"corner_owed"')));
    expect(client.payloads.filter((raw) => raw.includes('"corner_owed"'))).toHaveLength(1);
  });

  it('nudges the parent Room on every machine when the leader sees an owed item expire', async () => {
    const machines = [new LiveHub(), new LiveHub()];
    const parents: LiveEvent[][] = [[], []];
    const wakes = [0, 0];
    for (const [index, live] of machines.entries()) {
      const client = new PgliteListenClient(database);
      const listener = new PostgresLiveListener(database, live, () => client, 1);
      listener.setOwedWake(() => { wakes[index]! += 1; });
      listeners.push(listener);
      live.subscribe(ROOM, (event) => parents[index]!.push(event));
      void listener.run();
      await eventually(() => client.listenerCount('notification') === 1);
    }
    const expiresAt = new Date(Date.now() + 60_000);
    await insertExpiringOwed(expiresAt);
    // A new owed row wakes the leader so it can re-arm for the new deadline.
    await eventually(() => wakes.every((count) => count >= 1));
    const clock = new SkewedClockDatabase(database);
    const expiry = new DeadlineExpiry(clock);
    expect(await expiry.runOnce(true)).toBeGreaterThan(50_000);
    await settle(parents[0]!);
    await settle(parents[1]!);

    // No write happens at expiry: only the leader's job announces it.
    clock.offsetMs = 60_000;
    await expiry.runOnce();
    for (const parent of parents)
      await eventually(() => parent.some((event) =>
        event.type === 'invalidate' && event.reason === 'corner-status'));
    // The same expiry is announced once per leader.
    clock.offsetMs = 61_000;
    await settle(parents[0]!);
    await expiry.runOnce();
    expect(parents[0]).toEqual([]);
  });

  it('decides an owed expiry by the database clock when the app clock runs ahead', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const parent: LiveEvent[] = [];
    live.subscribe(ROOM, (event) => parent.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    const expiresAt = new Date(Date.now() + 60_000);
    await insertExpiringOwed(expiresAt);
    // PGlite reads the JS clock, so the database is held back to stay put
    // while the app clock jumps ten minutes past the expiry.
    const skewMs = 10 * 60_000;
    const clock = new SkewedClockDatabase(database);
    clock.offsetMs = -skewMs;
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + skewMs);
      expect(Date.now()).toBeGreaterThan(expiresAt.getTime());
      const expiry = new DeadlineExpiry(clock);
      expect(await expiry.runOnce(true)).toBeGreaterThan(50_000);
      await settle(parent);
      await expiry.runOnce();
      expect(parent).toEqual([]);

      // The database reaches the expiry: announced once, then never again.
      clock.offsetMs = -skewMs + 60_000;
      await expiry.runOnce();
      await eventually(() => parent.some((event) =>
        event.type === 'invalidate' && event.reason === 'corner-status'));
      clock.offsetMs = -skewMs + 61_000;
      await settle(parent);
      await expiry.runOnce();
      expect(parent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a top-level Room membership without a corner opener', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    received.length = 0;

    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, ROOM, AUTHOR],
    );

    await eventually(() =>
      received.some(
        (event) => event.type === 'invalidate' && event.reason === 'postgres:memberships',
      ),
    );
    expect(
      received.filter((event) => event.type === 'invalidate' && event.openedBy !== undefined),
    ).toEqual([]);
  });

  it('delivers a connector-assignment wake without a catalog', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    received.length = 0;

    await notifyConnectorAssignment(database, AUTHOR);

    await eventually(
      () =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'connector-assignment' &&
            event.targetAgentId === AUTHOR,
        ),
    );
  });

  it('delivers a Squire machine-grant wake as an agent-config invalidation', async () => {
    const agent = 'b'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'member')`,
      [WORKSPACE, ROOM, agent],
    );
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    received.length = 0;

    await notifyAgentConfigChange(database, agent, WORKSPACE);

    await eventually(
      () =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'agent-config' &&
            event.targetAgentId === agent &&
            event.roomId === ROOM,
        ),
    );
  });

  it('delivers a phone-side model/effort change as an agent-config invalidation', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(database);
    const listener = new PostgresLiveListener(database, live, () => client, 1);
    listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => client.listenerCount('notification') === 1);
    received.length = 0;

    // PhoneService.updateAgentModel writes this synthetic payload directly
    // inside the selection transaction — the agents table has no Room for a
    // row trigger, so the wake rides the same pg_notify channel.
    await database.query(`SELECT pg_notify($1, $2)`, [
      POSTGRES_LIVE_CHANNEL,
      JSON.stringify({ table: 'agent_config', operation: 'UPDATE', roomId: ROOM, agentId: AUTHOR }),
    ]);

    await eventually(
      () =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'agent-config' &&
            event.targetAgentId === AUTHOR &&
            event.roomId === ROOM,
        ),
    );
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
    await eventually(() => queryA.mock.calls.length > 0 && queryB.mock.calls.length > 0);
    queryA.mockClear();
    queryB.mockClear();

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
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Bee','bee')`,
      [agent],
    );
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
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee Are you there?')`,
        ['2'.repeat(64), ROOM, AUTHOR],
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
