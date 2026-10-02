import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { DaemonApiClient, type DaemonWebSocketFactory } from './daemon-api-client.js';
import { ReadBudgetFullError, type HostReadBudget } from './host-read-budget.js';
import { isNetworkFailure, LIVE_LINK_TIMING, type LiveLinkTiming } from './live-link.js';

/**
 * These run against a real `ws` server reached through a real TCP proxy that
 * can black-hole traffic in both directions while keeping both connections
 * open: the half-open path a sleeping laptop, a NAT timeout or a dead Wi-Fi
 * hop leaves behind. Timings are scaled down; the production values are
 * asserted separately.
 */
const TIMING: LiveLinkTiming = {
  handshakeTimeoutMs: 300,
  pongTimeoutMs: 250,
  backoffBaseMs: 40,
  backoffMaxMs: 320,
  stableSocketMs: 400,
  stableCloseJitterMs: 30,
  keepAliveDelayMs: 5 * 60_000,
};

type UpgradeAnswer =
  | { kind: 'accept' }
  | { kind: 'refuse'; status: number; headers?: Record<string, string>; body?: string };

class LiveServer {
  readonly http: Server;
  readonly wss = new WebSocketServer({ noServer: true });
  readonly upgrades: number[] = [];
  readonly frames: Array<Record<string, unknown>> = [];
  readonly clients: WebSocket[] = [];
  answer: (attempt: number) => UpgradeAnswer = () => ({ kind: 'accept' });

  constructor() {
    this.http = createServer();
    this.http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.upgrades.push(Date.now());
      const answer = this.answer(this.upgrades.length);
      if (answer.kind === 'refuse') {
        const body = answer.body ?? '';
        const headers = Object.entries({
          ...answer.headers,
          'Content-Length': String(Buffer.byteLength(body)),
          Connection: 'close',
        })
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join('');
        socket.write(`HTTP/1.1 ${answer.status} Refused\r\n${headers}\r\n${body}`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (client) => {
        this.clients.push(client);
        client.on('message', (raw) => this.frames.push(JSON.parse(raw.toString())));
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    return (this.http.address() as AddressInfo).port;
  }

  openClients(): WebSocket[] {
    return this.clients.filter((client) => client.readyState === WebSocket.OPEN);
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

/** A TCP relay whose `blackhole` drops every byte without closing anything. */
class BlackholeProxy {
  blackhole = false;
  private readonly server = createTcpServer((client) => this.relay(client));
  private readonly sockets = new Set<Socket>();

  constructor(private readonly targetPort: number) {}

  private relay(client: Socket): void {
    const upstream = connect(this.targetPort, '127.0.0.1');
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => this.sockets.delete(socket));
    }
    client.on('data', (chunk) => {
      if (!this.blackhole) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!this.blackhole) client.write(chunk);
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function harness(options: {
  fetchImpl?: typeof fetch;
  readBudget?: HostReadBudget;
  random?: () => number;
} = {}) {
  const server = new LiveServer();
  const serverPort = await server.listen();
  const proxy = new BlackholeProxy(serverPort);
  const proxyPort = await proxy.listen();
  const sockets: WebSocket[] = [];
  const pings: WebSocket[] = [];
  const factory: DaemonWebSocketFactory = (url, protocols, socketOptions) => {
    const socket = new WebSocket(url, protocols, socketOptions);
    const ping = socket.ping.bind(socket);
    socket.ping = (...args: Parameters<WebSocket['ping']>) => {
      pings.push(socket);
      ping(...args);
    };
    sockets.push(socket);
    return socket;
  };
  if (options.random) vi.spyOn(Math, 'random').mockImplementation(options.random);
  const client = new DaemonApiClient(
    `http://127.0.0.1:${proxyPort}`,
    'bdt_token',
    'agent',
    options.fetchImpl ?? (async () => Response.json({ workspaceIds: [], rooms: [] })),
    factory,
    options.readBudget,
    TIMING,
  );
  cleanups.push(() => server.close(), () => proxy.close(), () => client.closeLive());
  return { server, proxy, client, sockets, pings };
}

const networkFailure = (code: string) =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('LiveLink against a real server and a black-holing proxy', () => {
  it('keeps the production timings the spec names', () => {
    expect(LIVE_LINK_TIMING).toEqual({
      handshakeTimeoutMs: 30_000,
      pongTimeoutMs: 15_000,
      backoffBaseMs: 1_000,
      backoffMaxMs: 30_000,
      stableSocketMs: 30_000,
      stableCloseJitterMs: 10_000,
      keepAliveDelayMs: 300_000,
    });
  });

  it('reconnects after a 503 at upgrade, honouring Retry-After', async () => {
    const { server, client } = await harness();
    server.answer = (attempt) =>
      attempt === 1
        ? { kind: 'refuse', status: 503, headers: { 'Retry-After': '1' } }
        : { kind: 'accept' };
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(client.link.state).toBe('open'), { timeout: 5_000 });
    expect(server.upgrades).toHaveLength(2);
    expect(server.upgrades[1]! - server.upgrades[0]!).toBeGreaterThanOrEqual(950);
  });

  it('abandons a handshake that gets no answer and reconnects after the handshake timeout', async () => {
    const { server, proxy, client, sockets } = await harness();
    proxy.blackhole = true;
    const started = Date.now();
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMING.handshakeTimeoutMs - 20);
    expect(server.upgrades).toHaveLength(0);
    proxy.blackhole = false;
    await vi.waitFor(() => expect(client.link.state).toBe('open'), { timeout: 5_000 });
    expect(server.openClients()).toHaveLength(1);
  });

  it('pings a half-open socket once after a failed fetch, drops it at the pong deadline, and reconnects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(networkFailure('ECONNRESET'));
    const { server, proxy, client, sockets, pings } = await harness({ fetchImpl });
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(client.link.state).toBe('open'));
    const first = sockets[0]!;
    proxy.blackhole = true;
    const suspectedAt = Date.now();
    await expect(client.execute('getDaemonBootstrap', { agentId: 'agent' })).rejects.toThrow();
    await expect(client.execute('getDaemonBootstrap', { agentId: 'agent' })).rejects.toThrow();
    expect(client.link.state).toBe('suspect');
    expect(pings).toEqual([first]);
    const closed = new Promise<number>((resolve) => first.once('close', () => resolve(Date.now())));
    expect((await closed) - suspectedAt).toBeGreaterThanOrEqual(TIMING.pongTimeoutMs - 20);
    proxy.blackhole = false;
    await vi.waitFor(() => expect(client.link.state).toBe('open'), { timeout: 5_000 });
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets.at(-1)).not.toBe(first);
    expect(server.upgrades.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps a healthy socket that answers the ping, even while HTTP calls time out', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(networkFailure('UND_ERR_HEADERS_TIMEOUT'));
    const { server, client, sockets, pings } = await harness({ fetchImpl });
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(client.link.state).toBe('open'));
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(client.execute('getDaemonBootstrap', { agentId: 'agent' })).rejects.toThrow();
      await vi.waitFor(() => expect(client.link.state).toBe('open'));
    }
    await new Promise((resolve) => setTimeout(resolve, TIMING.pongTimeoutMs + 100));
    expect(pings).toHaveLength(3);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(WebSocket.OPEN);
    expect(server.upgrades).toHaveLength(1);
  });

  it('never pings for a full read budget or an error response the server sent', async () => {
    const budget = {
      acquire: async () => {
        throw new ReadBudgetFullError();
      },
      metrics: () => ({ waiting: 0, active: 0, totalWaitMs: 0 }),
    } as unknown as HostReadBudget;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 503 }));
    const { client, pings } = await harness({ fetchImpl, readBudget: budget });
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(client.link.state).toBe('open'));
    await expect(client.execute('getDaemonBootstrap', { agentId: 'agent' })).rejects.toMatchObject({
      code: 'read_budget_full',
    });
    await expect(client.execute('postAgentMachineReport', { machineId: 'm', machineName: 'n' }))
      .rejects.toMatchObject({ status: 503 });
    expect(pings).toHaveLength(0);
    expect(client.link.state).toBe('open');
  });

  it('backs off failed connects to the cap and resets only after a socket lived long enough', async () => {
    const { server, client } = await harness({ random: () => 1 });
    let accept = false;
    server.answer = () => (accept ? { kind: 'accept' } : { kind: 'refuse', status: 502 });
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(server.upgrades.length).toBeGreaterThanOrEqual(7), {
      timeout: 10_000,
    });
    const gaps = server.upgrades.slice(1).map((at, index) => at - server.upgrades[index]!);
    // 40, 80, 160, 320, 320, 320: doubling from the base, capped.
    expect(gaps[0]).toBeGreaterThanOrEqual(35);
    expect(gaps[1]).toBeGreaterThanOrEqual(75);
    expect(gaps[2]).toBeGreaterThanOrEqual(155);
    expect(gaps[3]).toBeGreaterThanOrEqual(315);
    expect(gaps[4]).toBeGreaterThanOrEqual(315);
    expect(Math.max(...gaps.slice(0, 6))).toBeLessThan(TIMING.backoffMaxMs + 250);

    // A socket that opens but dies young is still a failed connect.
    accept = true;
    await vi.waitFor(() => expect(server.openClients()).toHaveLength(1), { timeout: 5_000 });
    const young = server.upgrades.length;
    server.openClients()[0]!.terminate();
    await vi.waitFor(() => expect(server.upgrades.length).toBe(young + 1), { timeout: 5_000 });
    expect(server.upgrades.at(-1)! - server.upgrades.at(-2)!).toBeGreaterThanOrEqual(315);

    // One that lived past the stable window resets the backoff.
    await vi.waitFor(() => expect(server.openClients()).toHaveLength(1), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, TIMING.stableSocketMs + 50));
    const stable = server.upgrades.length;
    const closedAt = Date.now();
    server.openClients()[0]!.terminate();
    await vi.waitFor(() => expect(server.upgrades.length).toBe(stable + 1), { timeout: 5_000 });
    expect(server.upgrades.at(-1)! - closedAt).toBeLessThan(TIMING.backoffMaxMs);
  });

  it('resubscribes, fires every open wake and the update check on every open', async () => {
    const { server, client } = await harness();
    const rooms = vi.fn();
    const connectors = vi.fn();
    const memory = vi.fn();
    const updateCheck = vi.fn();
    client.setRoomsChangedListener(rooms);
    client.setConnectorAssignmentListener(connectors);
    client.setMemoryJobListener(memory);
    client.onLiveOpen(updateCheck);
    client.liveSubscribe('room-1', `1000,${'a'.repeat(64)}`);
    for (let open = 1; open <= 2; open++) {
      await vi.waitFor(() =>
        expect(server.frames.filter((frame) => frame.type === 'subscribe')).toHaveLength(open),
      { timeout: 5_000 });
      expect(rooms).toHaveBeenCalledTimes(open);
      expect(rooms).toHaveBeenLastCalledWith();
      expect(connectors).toHaveBeenCalledTimes(open);
      expect(memory).toHaveBeenCalledTimes(open);
      expect(updateCheck).toHaveBeenCalledTimes(open);
      server.openClients()[0]?.terminate();
    }
    expect(server.frames.filter((frame) => frame.type === 'subscribe').at(-1)).toMatchObject({
      roomId: 'room-1',
      cursor: `1000,${'a'.repeat(64)}`,
    });
  });

  it('never reconnects after a 426 and announces the update once', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: 'update_required', minVersion: 'v0.0.90' }, { status: 426 }),
    );
    const { server, client } = await harness({ fetchImpl });
    server.answer = () => ({
      kind: 'refuse',
      status: 426,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'update_required', minVersion: 'v0.0.90' }),
    });
    const update = vi.fn();
    client.setForceUpdateListener(update);
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(update).toHaveBeenCalledWith('v0.0.90');
    await expect(client.execute('getDaemonBootstrap', { agentId: 'agent' })).rejects.toMatchObject({
      status: 426,
    });
    await new Promise((resolve) => setTimeout(resolve, TIMING.backoffMaxMs * 3));
    expect(client.link.state).toBe('update-required');
    expect(server.upgrades).toHaveLength(1);
    expect(update).toHaveBeenCalledOnce();
  });

  it('enables TCP keepalive at five minutes on the socket under the WebSocket', async () => {
    const { client, sockets } = await harness();
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(client.link.state).toBe('open'));
    const tcp = (sockets[0] as unknown as { _socket: Socket })._socket;
    const state = Object.fromEntries(
      Object.getOwnPropertySymbols(tcp).map((key) => [key.description, (tcp as never)[key]]),
    );
    expect(state.kSetKeepAlive).toBe(true);
    expect(state.kSetKeepAliveInitialDelay).toBe(300); // seconds
  });
});

describe('network failure classification', () => {
  it('recognises network codes anywhere in the cause chain and nothing the server sent', () => {
    expect(isNetworkFailure(networkFailure('ECONNREFUSED'))).toBe(true);
    expect(isNetworkFailure(networkFailure('UND_ERR_SOCKET'))).toBe(true);
    expect(
      isNetworkFailure(new TypeError('fetch failed', {
        cause: new AggregateError([networkFailure('ENETUNREACH'), networkFailure('EHOSTUNREACH')]),
      })),
    ).toBe(true);
    expect(isNetworkFailure(new AggregateError([networkFailure('ETIMEDOUT'), new Error('other')])))
      .toBe(false);
    expect(isNetworkFailure(new Error('invalid runtime identity'))).toBe(false);
    expect(isNetworkFailure(Object.assign(new Error('denied'), { status: 401 }))).toBe(false);
  });
});
