import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';

describe('server readiness', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function get(path: string, database: SqlDatabase): Promise<Response> {
    const server = createBeelineServer({
      database,
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return fetch(`http://127.0.0.1:${port}${path}`);
  }

  it('returns 200 after a successful database query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const response = await get('/readyz', { query, transaction: vi.fn() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns 503 when the database query fails', async () => {
    const response = await get('/readyz', {
      query: vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')),
      transaction: vi.fn(),
    });

    expect(response.status).toBe(503);
  });

  it('reports the release identity baked into the deployed image', async () => {
    vi.stubEnv('BEELINE_RELEASE_VERSION', 'v1.2.3');
    vi.stubEnv('BEELINE_RELEASE_SHA', '0123456789abcdef0123456789abcdef01234567');

    const response = await get('/version', {
      query: vi.fn(),
      transaction: vi.fn(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 'v1.2.3',
      sourceSha: '0123456789abcdef0123456789abcdef01234567',
    });
  });

  it('serves daemon release readiness without a phone bearer', async () => {
    const releaseReadiness = vi.fn().mockResolvedValue({
      daemons: [{ agentPubkey: 'a'.repeat(64), state: 'ready' }],
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: { releaseReadiness } as unknown as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/releases/daemon-readiness`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      daemons: [{ agentPubkey: 'a'.repeat(64), state: 'ready' }],
    });
    expect(releaseReadiness).toHaveBeenCalledOnce();
  });

  it('refuses a release notify call with no or the wrong bearer secret', async () => {
    const notifyReleaseDelivered = vi.fn();
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
      releaseNotify: { secret: 'correct-horse', notifyReleaseDelivered } as never,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://x.test',
    });

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/releases/notify`, {
      method: 'POST',
      body,
    });
    expect(noAuth.status).toBe(403);

    const wrongSecret = await fetch(`http://127.0.0.1:${port}/v1/releases/notify`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body,
    });
    expect(wrongSecret.status).toBe(403);
    expect(notifyReleaseDelivered).not.toHaveBeenCalled();
  });

  it('notifies with the right secret, and refuses when no secret is configured at all', async () => {
    const notifyReleaseDelivered = vi.fn().mockResolvedValue({ notified: 3, skipped: 1 });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
      releaseNotify: { secret: 'correct-horse', notifyReleaseDelivered } as never,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/releases/notify`, {
      method: 'POST',
      headers: { authorization: 'Bearer correct-horse', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 'v0.0.42',
        sha: 'a'.repeat(40),
        changelogUrl: 'https://x.test',
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ notified: 3, skipped: 1 });
    expect(notifyReleaseDelivered).toHaveBeenCalledWith({
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://x.test',
    });

    // No secret configured at all (releaseNotify absent) refuses like any wrong secret.
    const unconfigured = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
    });
    servers.push(unconfigured);
    await new Promise<void>((resolve) => unconfigured.listen(0, '127.0.0.1', resolve));
    const unconfiguredPort = (unconfigured.address() as AddressInfo).port;
    const refused = await fetch(`http://127.0.0.1:${unconfiguredPort}/v1/releases/notify`, {
      method: 'POST',
      headers: { authorization: 'Bearer correct-horse', 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 'v0.0.42',
        sha: 'a'.repeat(40),
        changelogUrl: 'https://x.test',
      }),
    });
    expect(refused.status).toBe(403);
  });
});

describe('daemon live command push', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('refreshes commands only for a command invalidation addressed to this agent', async () => {
    const roomId = 'room-live';
    const agentId = 'agent-live';
    const live = new LiveHub();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomInbox') return { items: [], cursor: undefined };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      throw new Error(`unexpected operation ${name}`);
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticateDaemon: vi.fn().mockResolvedValue(agentId),
      } as unknown as TokenAuth,
      phone: { canReadRoom: vi.fn().mockResolvedValue(true) } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const subscribed = nextSocketMessage(socket, 'subscribed');
    const initialCommands = nextSocketMessage(socket, 'commands');
    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await Promise.all([subscribed, initialCommands]);

    const commandCalls = () =>
      execute.mock.calls.filter(([name]) => name === 'getAgentCommands').length;
    expect(commandCalls()).toBe(1);

    live.publish({ type: 'presence', roomId, agentId, status: 'online', observedAt: 1 });
    live.publish({ type: 'draft', roomId, agentId, turnId: 'turn', text: 'draft' });
    live.publish({ type: 'thought', roomId, agentId, turnId: 'turn', text: 'thought' });
    const messageTrace = { id: 'trace-message', databaseAt: 50, emittedAt: 75 };
    const replayed = nextSocketMessage(socket, 'inbox');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:messages',
      trace: messageTrace,
    });
    await expect(replayed).resolves.toEqual(
      expect.objectContaining({
        type: 'inbox',
        trigger: { reason: 'postgres:messages', trace: messageTrace },
      }),
    );
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_commands',
      targetAgentId: 'another-agent',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(commandCalls()).toBe(1);

    const pushed = nextSocketMessage(socket, 'commands');
    const trace = { id: 'trace-command', databaseAt: 100, emittedAt: 125 };
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_commands',
      targetAgentId: agentId,
      trace,
    });
    await expect(pushed).resolves.toEqual(
      expect.objectContaining({
        type: 'commands',
        trigger: { reason: 'postgres:agent_commands', trace },
      }),
    );
    expect(commandCalls()).toBe(2);
  });
});

describe('daemon operation presence evidence', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('does not hold a command read behind a blocked durable evidence refresh', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const evidence = vi.fn(() => blocked);
    const execute = vi.fn().mockResolvedValue({ commandProtocol: 1, commands: [] });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticatePhone: vi.fn().mockResolvedValue(null),
        authenticateDaemon: vi.fn().mockResolvedValue('agent'),
      } as unknown as TokenAuth,
      phone: {} as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live: {} as LiveHub,
      connectionPresence: { evidence } as never,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/daemon/operations/getAgentCommands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer bdt_${'t'.repeat(43)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ roomId: 'room' }),
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ commandProtocol: 1, commands: [] });
    expect(evidence).toHaveBeenCalledWith('room', 'agent');
    release();
  });
});

describe('phone committed-row live delivery', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function connect(
    readLiveDelta: PhoneService['readLiveDelta'],
    projectCommittedLiveDelta: PhoneService['projectCommittedLiveDelta'] = vi
      .fn()
      .mockReturnValue(null),
    canReadRoom = vi.fn().mockResolvedValue(true),
    livePaintDiagnostics = false,
    databaseQuery = vi.fn(),
  ) {
    const roomId = 'room-live';
    const live = new LiveHub();
    const server = createBeelineServer({
      database: { query: databaseQuery, transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: {
        canReadRoom,
        liveDraftSnapshot: vi.fn().mockResolvedValue([]),
        readLiveDelta,
        projectCommittedLiveDelta,
      } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live,
      livePaintDiagnostics,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const subscribed = nextSocketMessage(socket, 'subscribed');
    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await subscribed;
    return { live, roomId, socket, port };
  }

  it.each([
    ['missing', vi.fn().mockResolvedValue(null)],
    ['failed', vi.fn().mockRejectedValue(new Error('row read failed'))],
  ])(
    'falls back to an authoritative invalidation when the delta read is %s',
    async (_case, read) => {
      const { live, roomId, socket } = await connect(read as PhoneService['readLiveDelta']);
      const fallback = nextSocketMessage(socket, 'invalidate');

      live.publish({
        type: 'invalidate',
        roomId,
        reason: 'postgres:messages',
        messageId: 'message-fallback',
      });

      await expect(fallback).resolves.toMatchObject({
        type: 'invalidate',
        roomId,
        messageId: 'message-fallback',
        reason: 'delta-fallback:postgres:messages',
      });
    },
  );

  it('falls back to an authoritative invalidation when committed-row projection fails', async () => {
    const read = vi.fn();
    const project = vi.fn(() => {
      throw new Error('projection failed');
    });
    const { live, roomId, socket } = await connect(
      read as PhoneService['readLiveDelta'],
      project as PhoneService['projectCommittedLiveDelta'],
    );
    const fallback = nextSocketMessage(socket, 'invalidate');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      messageId: 'message-fallback',
      committedRow: {
        type: 'message',
        row: { room_id: roomId } as never,
      },
    });

    await expect(fallback).resolves.toMatchObject({
      type: 'invalidate',
      roomId,
      messageId: 'message-fallback',
      reason: 'delta-fallback:message',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('bounds a stalled lookup while preserving burst delivery order', async () => {
    const read = vi.fn(
      async (_roomId: string, _viewerId: string, target: { messageId: string }) => {
        if (target.messageId === 'message-1') return new Promise<never>(() => undefined);
        return {
          type: 'message-delta' as const,
          roomId: 'room-live',
          message: {
            id: target.messageId,
            text: target.messageId,
            createdAt: Number(target.messageId.at(-1)),
            author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
            presentation: 'message' as const,
          },
        };
      },
    );
    const { live, roomId, socket } = await connect(read as PhoneService['readLiveDelta']);
    const received = nextSocketMessages(socket, 3);
    const startedAt = Date.now();

    for (const messageId of ['message-1', 'message-2', 'message-3']) {
      live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId });
    }

    const messages = await received;
    expect(Date.now() - startedAt).toBeLessThan(800);
    expect(
      messages.map((message) =>
        message.type === 'message-delta'
          ? (message.message as { id: string }).id
          : message.messageId,
      ),
    ).toEqual(['message-1', 'message-2', 'message-3']);
    expect(messages[0]).toMatchObject({
      type: 'invalidate',
      reason: 'delta-fallback:postgres:messages',
    });
    expect(messages.slice(1).map((message) => message.type)).toEqual([
      'message-delta',
      'message-delta',
    ]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('diagnoses the same-process committed-row delivery boundary', async () => {
    const delta = {
      type: 'message-delta' as const,
      roomId: 'room-live',
      message: {
        id: 'message-diagnostic',
        text: 'diagnostic',
        createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
        presentation: 'message' as const,
      },
    };
    const read = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 170));
      return delta;
    });
    const project = vi.fn().mockReturnValue(delta);
    const { live, roomId, socket } = await connect(
      read as PhoneService['readLiveDelta'],
      project as PhoneService['projectCommittedLiveDelta'],
    );
    const committedRow = {
      type: 'message' as const,
      row: { room_id: roomId, id: delta.message.id },
    } as never;

    const queriedDurations: number[] = [];
    const directDurations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const queriedMessage = nextSocketMessage(socket, 'message-delta');
      const queriedStartedAt = performance.now();
      live.publish({
        type: 'invalidate',
        roomId,
        reason: 'postgres:messages',
        messageId: delta.message.id,
      });
      await queriedMessage;
      queriedDurations.push(performance.now() - queriedStartedAt);

      const directMessage = nextSocketMessage(socket, 'message-delta');
      const directStartedAt = performance.now();
      live.publish({
        type: 'invalidate',
        roomId,
        reason: 'message',
        messageId: delta.message.id,
        committedRow,
      });
      await directMessage;
      directDurations.push(performance.now() - directStartedAt);
    }
    const percentile = (values: readonly number[], fraction: number) =>
      values.toSorted((left, right) => left - right)[Math.ceil(values.length * fraction) - 1]!;

    console.info(
      JSON.stringify({
        operation: 'same-process committed-row diagnostic',
        trials: queriedDurations.length,
        queriedP50Ms: Math.round(percentile(queriedDurations, 0.5)),
        queriedP95Ms: Math.round(percentile(queriedDurations, 0.95)),
        queriedMaxMs: Math.round(Math.max(...queriedDurations)),
        directP50Ms: Math.round(percentile(directDurations, 0.5)),
        directP95Ms: Math.round(percentile(directDurations, 0.95)),
        directMaxMs: Math.round(Math.max(...directDurations)),
        queryCount: read.mock.calls.length,
      }),
    );
    expect(Math.min(...queriedDurations)).toBeGreaterThanOrEqual(160);
    expect(Math.max(...directDurations)).toBeLessThan(25);
    expect(read).toHaveBeenCalledTimes(20);
    expect(project).toHaveBeenCalledTimes(20);
  });

  it('serializes only a public delta and drops a cross-Room committed row', async () => {
    const delta = {
      type: 'message-delta' as const,
      roomId: 'room-live',
      message: {
        id: 'message-public',
        text: 'public text',
        createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
        presentation: 'message' as const,
      },
    };
    const read = vi.fn().mockResolvedValue(null);
    const project = vi.fn((eventRoom: string, committed: { row: { room_id: string } }) =>
      committed.row.room_id === eventRoom ? delta : null,
    );
    const { live, roomId, socket, port } = await connect(
      read as PhoneService['readLiveDelta'],
      project as PhoneService['projectCommittedLiveDelta'],
    );
    const rawMarker = 'raw-committed-row-must-not-cross-wire';
    const startedAt = Date.now();
    const trace = {
      id: 'same-clock-paint-proof',
      startedAt,
      databaseAt: startedAt,
      emittedAt: Date.now(),
    };
    socket.send(JSON.stringify({ type: 'trace-paint', id: 'never-emitted-on-this-socket' }));
    await expectNoSocketMessage(socket);
    const publicMessage = nextSocketMessage(socket, 'message-delta');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      messageId: delta.message.id,
      trace,
      committedRow: {
        type: 'message',
        row: { room_id: roomId, text: rawMarker } as never,
      },
    });
    const delivered = await publicMessage;
    expect(delivered).toEqual({ ...delta, trace });
    expect(JSON.stringify(delivered)).not.toContain(rawMarker);
    expect(delivered).not.toHaveProperty('committedRow');
    const otherSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    sockets.push(otherSocket);
    await new Promise<void>((resolve, reject) => {
      otherSocket.once('open', resolve);
      otherSocket.once('error', reject);
    });
    otherSocket.send(JSON.stringify({ type: 'trace-paint', id: trace.id }));
    await expectNoSocketMessage(otherSocket);
    const paintAck = nextSocketMessage(socket, 'trace-painted');
    socket.send(JSON.stringify({ type: 'trace-paint', id: trace.id }));
    await expect(paintAck).resolves.toMatchObject({
      type: 'trace-painted',
      id: trace.id,
      startedAt,
      databaseAt: startedAt,
      serverReceivedAt: expect.any(Number),
      upperBoundMs: expect.any(Number),
    });
    const acknowledged = await paintAck;
    expect(acknowledged.serverReceivedAt as number).toBeGreaterThanOrEqual(startedAt);
    expect((acknowledged.serverReceivedAt as number) - startedAt).toBeLessThan(100);
    socket.send(JSON.stringify({ type: 'trace-paint', id: trace.id }));
    await expectNoSocketMessage(socket);

    let unexpected = false;
    const onMessage = () => {
      unexpected = true;
    };
    socket.on('message', onMessage);
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      messageId: 'message-cross-room',
      committedRow: {
        type: 'message',
        row: { room_id: 'another-room', text: rawMarker } as never,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.off('message', onMessage);
    expect(unexpected).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('takes one diagnostics-gated DB-clock sample after a cross-process paint', async () => {
    const databaseAt = 1_000;
    const databaseQuery = vi.fn().mockResolvedValue({
      rows: [{ clock_at: new Date(databaseAt + 240) }],
      rowCount: 1,
    });
    const delta = {
      type: 'turn-delta' as const,
      roomId: 'room-live',
      turn: {
        requestId: 'request',
        agentId: 'agent',
        status: 'working' as const,
        createdAt: 1,
      },
    };
    const { live, roomId, socket } = await connect(
      vi.fn().mockResolvedValue(delta),
      undefined,
      undefined,
      true,
      databaseQuery,
    );
    const delivered = nextSocketMessage(socket, 'turn-delta');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_turns',
      agentId: 'agent',
      requestId: 'request',
      trace: { id: 'database-clock-trace', databaseAt, emittedAt: databaseAt + 10 },
    });
    await expect(delivered).resolves.toMatchObject({
      trace: { id: 'database-clock-trace', paintAck: 'database-clock' },
    });

    const painted = nextSocketMessage(socket, 'trace-painted');
    socket.send(JSON.stringify({ type: 'trace-paint', id: 'database-clock-trace' }));
    await expect(painted).resolves.toMatchObject({
      type: 'trace-painted',
      id: 'database-clock-trace',
      databaseAt,
      databaseClockAt: databaseAt + 240,
      upperBoundMs: 240,
    });
    expect(databaseQuery).toHaveBeenCalledOnce();
    socket.send(JSON.stringify({ type: 'trace-paint', id: 'database-clock-trace' }));
    await expectNoSocketMessage(socket);
    expect(databaseQuery).toHaveBeenCalledOnce();
  });

  it('never subscribes or projects a committed row for an unauthorized viewer', async () => {
    const read = vi.fn();
    const project = vi.fn();
    const roomId = 'room-live';
    const live = new LiveHub();
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: {
        canReadRoom: vi.fn().mockResolvedValue(false),
        liveDraftSnapshot: vi.fn().mockResolvedValue([]),
        readLiveDelta: read,
        projectCommittedLiveDelta: project,
      } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    let received = false;
    socket.on('message', () => {
      received = true;
    });
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      messageId: 'secret-message',
      committedRow: {
        type: 'message',
        row: { room_id: roomId, text: 'raw-secret' } as never,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(received).toBe(false);
    expect(project).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('strips a raw committed row even when an invalidation has no delta target', async () => {
    const read = vi.fn();
    const project = vi.fn();
    const { live, roomId, socket } = await connect(
      read as PhoneService['readLiveDelta'],
      project as PhoneService['projectCommittedLiveDelta'],
    );
    const invalidation = nextSocketMessage(socket, 'invalidate');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      committedRow: {
        type: 'message',
        row: { room_id: roomId, text: 'raw-secret' } as never,
      },
    });

    const delivered = await invalidation;
    expect(delivered).toEqual({ type: 'invalidate', roomId, reason: 'message' });
    expect(JSON.stringify(delivered)).not.toContain('raw-secret');
    expect(project).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

function nextSocketMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`websocket ${type} timeout`));
    }, 3_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}

function nextSocketMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      if (messages.length !== count) return;
      cleanup();
      resolve(messages);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`websocket ${count}-message timeout`));
    }, 3_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}

function expectNoSocketMessage(socket: WebSocket, durationMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      cleanup();
      reject(new Error(`unexpected websocket message: ${raw.toString()}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}
