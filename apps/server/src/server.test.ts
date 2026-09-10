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
