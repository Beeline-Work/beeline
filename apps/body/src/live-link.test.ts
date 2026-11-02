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
  heartbeatTimeoutMs: 600,
};

/** The fake server pings like the real one, scaled to the timings above. */
const SERVER_PING_MS = 150;

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
  readonly #heartbeat = setInterval(() => {
    for (const client of this.openClients()) client.ping();
  }, SERVER_PING_MS);

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
        client.on('message', (raw) => {
          const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
          this.frames.push(frame);
          // Every agent that registers is taken, as the real server takes a valid token.
          if (frame.type === 'register')
            client.send(JSON.stringify({ type: 'registered', agentId: frame.agentId }));
          if(frame.type==='subscribe')client.send(JSON.stringify({type:'subscribed',agentId:frame.agentId,roomId:frame.roomId,capabilities:{pushIntake:true}}));
        });
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

  /** Send one frame on every open socket. */
  push(frame: Record<string, unknown>): void {
    for (const client of this.openClients()) client.send(JSON.stringify(frame));
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeat);
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
      heartbeatTimeoutMs: 75_000,
    });
  });

  it.each([408, 429, 503])('parks a retryable %s upgrade; Retry-After admits only a later real boundary', async status => {
    const {server,client}=await harness();
    server.answer=attempt=>attempt===1?{kind:'refuse',status,headers:{'Retry-After':'0.1'}}:{kind:'accept'};
    client.setRoomsChangedListener(()=>undefined);
    await vi.waitFor(()=>expect(server.upgrades).toHaveLength(1));
    await vi.waitFor(()=>expect(client.link.state).toBe('disconnected'));
    client.link.reconnectNow();expect(server.upgrades).toHaveLength(1);
    await new Promise(resolve=>setTimeout(resolve,300));
    expect(server.upgrades).toHaveLength(1);
    client.link.reconnectNow();await vi.waitFor(()=>expect(client.channel.isOpen()).toBe(true));
    expect(server.upgrades).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 410])('does not reconnect after a permanent %s upgrade refusal', async (status) => {
    const { server, client } = await harness();
    server.answer = () => ({ kind: 'refuse', status });
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(server.upgrades).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, TIMING.backoffMaxMs * 3));
    client.link.start();
    expect(server.upgrades).toHaveLength(1);
    expect(client.link.state).toBe('refused');
  });

  it('parks an unanswered initial handshake until an actual path recovery', async()=>{
    const {server,proxy,client,sockets}=await harness();proxy.blackhole=true;
    client.setRoomsChangedListener(()=>undefined);
    await vi.waitFor(()=>expect(client.link.state).toBe('disconnected'),{timeout:2000});
    await new Promise(resolve=>setTimeout(resolve,TIMING.handshakeTimeoutMs*2));
    expect(sockets).toHaveLength(1);expect(server.upgrades).toHaveLength(0);
    proxy.blackhole=false;client.link.reconnectNow();
    await vi.waitFor(()=>expect(client.channel.isOpen()).toBe(true));expect(sockets).toHaveLength(2);
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
    if(client.link.state==='disconnected')client.link.reconnectNow();
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

  it('does not reset an incident after a brief unauthenticated replacement open',async()=>{
    const {server,client}=await harness();let accepts=true;
    server.answer=()=>accepts?{kind:'accept'}:{kind:'refuse',status:502};
    client.setRoomsChangedListener(()=>undefined);
    await vi.waitFor(()=>expect(client.channel.isOpen()).toBe(true));
    accepts=false;server.openClients()[0]!.terminate();
    await vi.waitFor(()=>expect(server.upgrades).toHaveLength(2));
    await new Promise(resolve=>setTimeout(resolve,600));expect(server.upgrades).toHaveLength(2);
    accepts=true;client.link.reconnectNow();
    await vi.waitFor(()=>expect(client.channel.isOpen()).toBe(true));expect(server.upgrades).toHaveLength(3);
  });

  it('resubscribes, fires every open wake and the update check on every open', async () => {
    const { server, client } = await harness();
    const rooms = vi.fn();
    const connectors = vi.fn();
    const updateCheck = vi.fn();
    client.setRoomsChangedListener(rooms);
    client.setConnectorAssignmentListener(connectors);
    client.onLiveOpen(updateCheck);
    client.liveSubscribe('room-1', `1000,${'a'.repeat(64)}`);
    for (let open = 1; open <= 2; open++) {
      await vi.waitFor(() =>
        expect(server.frames.filter((frame) => frame.type === 'subscribe')).toHaveLength(open),
      { timeout: 5_000 });
      expect(rooms).toHaveBeenCalledTimes(open);
      expect(rooms).toHaveBeenLastCalledWith();
      expect(connectors).toHaveBeenCalledTimes(open);
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

  it('drops an idle socket that stops hearing server pings and resumes Room work and release notices', async () => {
    // The incident: an idle helper performs no operation, so nothing it does
    // can notice that its socket died. Only the server's heartbeat can.
    const fetchImpl = vi.fn<typeof fetch>();
    const { server, proxy, client, sockets } = await harness({ fetchImpl });
    const delivered: string[] = [];
    const releases: Array<{ version: string; sha: string }> = [];
    client.setRoomsChangedListener(() => undefined);
    client.setHelperReleaseListener((release) => releases.push(release));
    client.liveSubscribe('room-1', undefined, (items) => delivered.push(...items.map((item) => item.id)));
    await vi.waitFor(() => expect(server.frames.filter((frame) => frame.type === 'subscribe')).toHaveLength(1));
    const first = sockets[0]!;
    const deadAt = Date.now();
    proxy.blackhole = true; // No error and no close on either side: the path just stops.
    const closedAt = await new Promise<number>((resolve) => first.once('close', () => resolve(Date.now())));
    expect(closedAt - deadAt).toBeGreaterThanOrEqual(TIMING.heartbeatTimeoutMs - SERVER_PING_MS - 20);
    expect(closedAt - deadAt).toBeLessThan(TIMING.heartbeatTimeoutMs + 300);
    proxy.blackhole = false;
    if(client.link.state==='disconnected')client.link.reconnectNow();
    await vi.waitFor(() =>
      expect(server.frames.filter((frame) => frame.type === 'subscribe')).toHaveLength(2), { timeout: 5_000 });
    server.push({ type: 'inbox', agentId: 'agent', roomId: 'room-1', items: [{ id: 'after-outage' }] });
    server.push({ type: 'helper-release', version: 'v0.0.99', sha: 'abc1234' });
    await vi.waitFor(() => {
      expect(delivered).toEqual(['after-outage']);
      expect(releases).toEqual([{ version: 'v0.0.99', sha: 'abc1234' }]);
    });
    // Nothing the helper did found the dead socket: it made no request at all.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps an idle socket that keeps hearing server pings', async () => {
    const { server, client, sockets } = await harness();
    client.setRoomsChangedListener(() => undefined);
    await vi.waitFor(() => expect(client.channel.isOpen()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, TIMING.heartbeatTimeoutMs * 3));
    expect(sockets).toHaveLength(1);
    expect(server.upgrades).toHaveLength(1);
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
