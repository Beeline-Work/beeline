import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { isAgentReachable } from '@beeline/api-contract/agent-access';
import type { TokenAuth } from './auth.js';
import { ConnectionPresence } from './connection-presence.js';
import { MACHINE_SOCKET_PROTOCOL } from './daemon-live.js';
import { DaemonService } from './daemon-service.js';
import { migrate, type SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { createBeelineServer, type ServerOptions } from './server.js';
import { PgliteDatabase } from './test-support.js';

const AGENT_A = 'a'.repeat(64);
const AGENT_B = 'b'.repeat(64);
const AGENT_RETIRED = 'c'.repeat(64);
const AGENT_UNKNOWN = 'd'.repeat(64);
const TOKENS: Record<string, string> = { bdt_a: AGENT_A, bdt_b: AGENT_B };

type Frame = Record<string, unknown>;
type Server = ReturnType<typeof createBeelineServer>;

const servers: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function auth(): TokenAuth {
  return {
    authenticateDaemon: vi.fn(async (token: string) => TOKENS[token] ?? null),
    retiredDaemonAgent: vi.fn(async (token: string) => (token === 'bdt_retired' ? AGENT_RETIRED : null)),
    authenticatePhone: vi.fn(async () => null),
  } as unknown as TokenAuth;
}

function daemonStub(): DaemonService {
  return {
    execute: vi.fn(async (name: string, input: { roomId: string }, agentId: string) =>
      name === 'getAgentCommands'
        ? { commandProtocol: 1, commands: [] }
        : { items: [{ id: `${agentId.slice(0, 1)}-${input.roomId}-${Date.now()}` }] }),
  } as unknown as DaemonService;
}

async function start(overrides: Partial<ServerOptions> = {}): Promise<{ server: Server; port: number }> {
  const server = createBeelineServer({
    database: { query: vi.fn(), transaction: vi.fn() } as unknown as SqlDatabase,
    auth: auth(),
    phone: { canReadRooms: vi.fn(async (ids: readonly string[]) => new Set(ids)) } as unknown as PhoneService,
    daemon: daemonStub(),
    live: new LiveHub(),
    mediaMaximumBytes: 1,
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A socket that records every frame, so a test can wait for one it has not seen yet. */
async function connect(port: number, protocol: string, options: WebSocket.ClientOptions = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, [protocol], options);
  sockets.push(socket);
  const frames: Frame[] = [];
  socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const next = async (match: (frame: Frame) => boolean, timeout = 3_000): Promise<Frame> => {
    let found: Frame | undefined;
    await vi.waitFor(() => {
      found = frames.find(match);
      expect(found).toBeDefined();
    }, { timeout });
    return found!;
  };
  const send = (frame: Frame) => socket.send(JSON.stringify(frame));
  return { socket, frames, next, send };
}

const machine = (port: number, options?: WebSocket.ClientOptions) =>
  connect(port, MACHINE_SOCKET_PROTOCOL, options);

async function register(
  client: Awaited<ReturnType<typeof machine>>,
  agentId: string,
  token: string,
): Promise<Frame> {
  const after = client.frames.length;
  client.send({ type: 'register', agentId, token, lifecycleId: `life-${agentId.slice(0, 1)}` });
  return client.next((frame) =>
    client.frames.indexOf(frame) >= after && frame.agentId === agentId &&
    (frame.type === 'registered' || frame.type === 'register-refused'));
}

describe('one machine socket for every agent on a helper machine', () => {
  it('authorizes each agent separately; a retired, invalid or mismatched token rejects only that agent', async () => {
    const live = new LiveHub();
    const { port } = await start({ live });
    const client = await machine(port);
    expect(await client.next((frame) => frame.type === 'hello')).toMatchObject({
      protocol: 'machine',
      heartbeatMs: 30_000,
    });

    expect(await register(client, AGENT_RETIRED, 'bdt_retired')).toMatchObject({
      type: 'register-refused', code: 'agent_removed',
    });
    expect(await register(client, AGENT_UNKNOWN, 'bdt_unknown')).toMatchObject({
      type: 'register-refused', code: 'daemon_token_required',
    });
    // A token is only ever good for the agent it was issued to.
    client.send({ type: 'register', agentId: AGENT_B, token: 'bdt_a' });
    expect(await client.next((frame) => frame.type === 'register-refused' && frame.agentId === AGENT_B))
      .toMatchObject({ code: 'daemon_token_required' });
    expect(await register(client, AGENT_B, 'bdt_b')).toMatchObject({ type: 'registered' });
    expect(await register(client, AGENT_A, 'bdt_a')).toMatchObject({ type: 'registered' });

    // Frames naming an agent that never registered reach nobody.
    client.send({ type: 'subscribe', agentId: AGENT_RETIRED, roomId: 'room-c' });
    client.send({ type: 'subscribe', agentId: AGENT_B, roomId: 'room-b' });
    client.send({ type: 'subscribe', agentId: AGENT_A, roomId: 'room-a' });
    await client.next((frame) => frame.type === 'subscribed' && frame.agentId === AGENT_B);
    await client.next((frame) => frame.type === 'subscribed' && frame.agentId === AGENT_A);

    const before = client.frames.length;
    live.publish({ type: 'invalidate', roomId: 'room-b', reason: 'postgres:messages' });
    const inbox = await client.next((frame, ) =>
      client.frames.indexOf(frame) >= before && frame.type === 'inbox');
    expect(inbox).toMatchObject({ agentId: AGENT_B, roomId: 'room-b' });
    expect(client.frames.some((frame) => frame.agentId === AGENT_RETIRED && frame.type !== 'register-refused'))
      .toBe(false);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('drops only the agent that floods the socket; its sibling keeps its slot and its work', async () => {
    const stalled: Array<() => void> = [];
    const canReadRooms = vi.fn((ids: readonly string[], agentId: string) =>
      agentId === AGENT_A
        ? new Promise<Set<string>>((resolve) => stalled.push(() => resolve(new Set(ids))))
        : Promise.resolve(new Set(ids)));
    const live = new LiveHub();
    const { port } = await start({ live, phone: { canReadRooms } as unknown as PhoneService });
    const client = await machine(port);
    await register(client, AGENT_A, 'bdt_a');
    await register(client, AGENT_B, 'bdt_b');

    // Agent A's first read never finishes, then A sends far more than its queue holds.
    client.send({ type: 'subscribe', agentId: AGENT_A, roomId: 'room-a' });
    await vi.waitFor(() => expect(stalled).toHaveLength(1));
    const padding = 'x'.repeat(60 * 1024);
    for (let index = 0; index < 40; index++)
      client.send({ type: 'subscribe', agentId: AGENT_A, roomId: `room-a-${index}`, padding });
    expect(await client.next((frame) => frame.type === 'unregistered' && frame.agentId === AGENT_A))
      .toMatchObject({ code: 1013, reason: 'live admission overloaded' });

    // Agent B is neither delayed behind A's queue nor disconnected with it.
    const subscribedAt = Date.now();
    client.send({ type: 'subscribe', agentId: AGENT_B, roomId: 'room-b' });
    await client.next((frame) => frame.type === 'subscribed' && frame.agentId === AGENT_B);
    await client.next((frame) => frame.type === 'inbox' && frame.agentId === AGENT_B);
    expect(Date.now() - subscribedAt).toBeLessThan(1_000);
    const before = client.frames.length;
    live.publish({ type: 'invalidate', roomId: 'room-b', reason: 'postgres:messages' });
    await client.next((frame) =>
      client.frames.indexOf(frame) >= before && frame.type === 'inbox' && frame.agentId === AGENT_B);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    for (const finish of stalled.splice(0)) finish();
  });

  it('keeps one winner per agent across old per-agent sockets and machine registrations', async () => {
    const { port } = await start();
    const old = await connect(port, 'bearer.bdt_a');
    await old.next((frame) => frame.type === 'hello');
    const oldClosed = new Promise<void>((resolve) => old.socket.once('close', () => resolve()));
    const client = await machine(port);
    await register(client, AGENT_A, 'bdt_a');
    await register(client, AGENT_B, 'bdt_b');
    await oldClosed;

    // An old helper process that comes back takes the agent; its sibling stays.
    const returning = await connect(port, 'bearer.bdt_a');
    await returning.next((frame) => frame.type === 'hello');
    expect(await client.next((frame) => frame.type === 'unregistered' && frame.agentId === AGENT_A))
      .toMatchObject({ reason: 'replaced' });
    client.send({ type: 'subscribe', agentId: AGENT_B, roomId: 'room-b' });
    await client.next((frame) => frame.type === 'subscribed' && frame.agentId === AGENT_B);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('protocol heartbeat on helper sockets', () => {
  it('terminates a machine socket that stops answering pings while idle, and keeps one that answers', async () => {
    const { port } = await start({ liveHeartbeatMs: 100 });
    const silent = await machine(port, { autoPong: false });
    const answering = await machine(port);
    let pings = 0;
    answering.socket.on('ping', () => pings++);
    const closedAt = new Promise<number>((resolve) => silent.socket.once('close', () => resolve(Date.now())));
    const openedAt = Date.now();
    // Neither socket sends a frame: both are idle the whole time.
    expect((await closedAt) - openedAt).toBeLessThan(1_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(answering.socket.readyState).toBe(WebSocket.OPEN);
    expect(pings).toBeGreaterThanOrEqual(4);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.live.heartbeatTerminations).toBeGreaterThanOrEqual(1);
  });

  it('pings old per-agent sockets too and drops one whose peer went silent', async () => {
    const { port } = await start({ liveHeartbeatMs: 100 });
    const silent = await connect(port, 'bearer.bdt_a', { autoPong: false });
    const closed = new Promise<void>((resolve) => silent.socket.once('close', () => resolve()));
    await closed;
  });

  it('pings without touching the database', async () => {
    const query = vi.fn();
    const { port } = await start({
      liveHeartbeatMs: 50,
      database: { query, transaction: vi.fn() } as unknown as SqlDatabase,
    });
    const client = await machine(port);
    let pings = 0;
    client.socket.on('ping', () => pings++);
    await vi.waitFor(() => expect(pings).toBeGreaterThanOrEqual(5), { timeout: 2_000 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('held presence for a live connection', () => {
  const ROOM = '22222222-2222-4222-8222-222222222222';
  const WORKSPACE = '11111111-1111-4111-8111-111111111111';
  const HUMAN = 'e'.repeat(64);

  async function seeded() {
    const database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner',NULL),($2,'agent','Bee','bee')`,
      [HUMAN, AGENT_A],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT_A, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'member'),($1,NULL,$3,'member'),($1,$2,$4,'owner')`,
      [WORKSPACE, ROOM, AGENT_A, HUMAN],
    );
    return database;
  }

  async function presenceBody(database: SqlDatabase) {
    return (
      await database.query<{ body: Record<string, unknown> }>(
        `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [AGENT_A],
      )
    ).rows[0]?.body;
  }

  it('stays online past the 90-second horizon while held, and goes offline when the socket dies', async () => {
    const database = await seeded();
    const live = new LiveHub();
    const presence = new ConnectionPresence(database, live);
    try {
      const { port } = await start({ database, live, connectionPresence: presence });
      const client = await machine(port);
      await register(client, AGENT_A, 'bdt_a');
      expect(await presenceBody(database)).toMatchObject({ status: 'online', held: true });

      // Ten idle minutes: no HTTP evidence, no Room event, no database write.
      await database.query(
        `UPDATE live_outputs SET updated_at=now()-interval '10 minutes',
           body=body || jsonb_build_object('observedAt',(extract(epoch FROM now())::bigint-600))
         WHERE agent_id=$1 AND kind='presence'`,
        [AGENT_A],
      );
      const daemon = new DaemonService(database, live);
      expect((await daemon.releaseReadiness()).daemons).toEqual([
        expect.objectContaining({ agentPubkey: AGENT_A, state: 'ready' }),
      ]);
      const body = await presenceBody(database);
      expect(isAgentReachable('online', Number(body?.observedAt) * 1000, Date.now(), body?.held === true))
        .toBe(true);

      client.socket.terminate();
      await vi.waitFor(async () =>
        expect(await presenceBody(database)).toMatchObject({ status: 'offline', held: false }));
      expect((await daemon.releaseReadiness()).daemons).toEqual([
        expect.objectContaining({ agentPubkey: AGENT_A, state: 'offline' }),
      ]);
    } finally {
      await presence.stop();
      await database.close();
    }
  });

  it('lets the newest connection win across two server instances; a late close of the old one changes nothing', async () => {
    const database = await seeded();
    // One hub stands in for the PostgreSQL listener both instances share.
    const live = new LiveHub();
    const first = new ConnectionPresence(database, live, undefined, undefined, { instanceId: 'server-1' });
    const second = new ConnectionPresence(database, live, undefined, undefined, { instanceId: 'server-2' });
    try {
      const one = await start({ database, live, connectionPresence: first });
      const two = await start({ database, live, connectionPresence: second });
      const older = await machine(one.port);
      await register(older, AGENT_A, 'bdt_a');
      const newer = await machine(two.port);
      await register(newer, AGENT_A, 'bdt_a');
      expect(await older.next((frame) => frame.type === 'unregistered' && frame.agentId === AGENT_A))
        .toMatchObject({ reason: 'replaced' });
      const held = await presenceBody(database);
      expect(held).toMatchObject({ status: 'online', held: true });

      // The old machine's socket closes late: the newer connection keeps the agent online.
      older.socket.terminate();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await presenceBody(database)).toMatchObject({
        status: 'online', held: true, connectionId: held?.connectionId,
      });
      const connection = (await database.query<{ epoch: string; instance_id: string }>(
        `SELECT epoch,instance_id FROM agent_connections WHERE agent_id=$1`, [AGENT_A],
      )).rows[0];
      expect(connection).toMatchObject({ instance_id: 'server-2' });
      expect(Number(connection?.epoch)).toBe(2);
    } finally {
      await first.stop();
      await second.stop();
      await database.close();
    }
  });

  it('survives a server restart: the connection stays held until the helper reconnects', async () => {
    const database = await seeded();
    const live = new LiveHub();
    const restarting = new ConnectionPresence(database, live, undefined, undefined, { instanceId: 'server-old' });
    const successor = new ConnectionPresence(database, live, undefined, undefined, { instanceId: 'server-new' });
    try {
      const old = await start({ database, live, connectionPresence: restarting });
      const client = await machine(old.port);
      await register(client, AGENT_A, 'bdt_a');
      // A deploy closes the server; its sockets end but nothing goes offline.
      await new Promise<void>((resolve) => old.server.close(() => resolve()));
      servers.splice(servers.indexOf(old.server), 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await presenceBody(database)).toMatchObject({ status: 'online', held: true });

      const next = await start({ database, live, connectionPresence: successor });
      const back = await machine(next.port);
      await register(back, AGENT_A, 'bdt_a');
      expect(await presenceBody(database)).toMatchObject({ status: 'online', held: true });
      const rows = (await database.query<{ instance_id: string; epoch: string | number }>(
        `SELECT instance_id,epoch FROM agent_connections`,
      )).rows;
      expect(rows.map((row) => [row.instance_id, Number(row.epoch)])).toEqual([['server-new', 2]]);
    } finally {
      await restarting.stop();
      await successor.stop();
      await database.close();
    }
  });

  it('releases the connections of a server that stopped renewing its lease', async () => {
    const database = await seeded();
    const live = new LiveHub();
    const crashed = new ConnectionPresence(database, live, undefined, undefined, {
      instanceId: 'server-gone', expiryMs: 200,
    });
    const survivor = new ConnectionPresence(database, live, undefined, undefined, {
      instanceId: 'server-up', expiryMs: 200,
    });
    try {
      await crashed.renewLease();
      const gone = await start({ database, live, connectionPresence: crashed });
      const client = await machine(gone.port);
      await register(client, AGENT_A, 'bdt_a');
      await new Promise<void>((resolve) => gone.server.close(() => resolve()));
      servers.splice(servers.indexOf(gone.server), 1);
      await crashed.stop();

      // Inside the lease the agent is still held online.
      await survivor.renewLease();
      expect(await presenceBody(database)).toMatchObject({ status: 'online', held: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await survivor.renewLease();
      expect(await presenceBody(database)).toMatchObject({ status: 'offline', held: false });
    } finally {
      await crashed.stop();
      await survivor.stop();
      await database.close();
    }
  });
});
