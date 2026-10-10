import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer, maxLiveDbTasks, type ServerOptions } from './server.js';
import { databaseConnectionBudget } from './database-budget.js';


function canReadRoomsFrom(canReadRoom: (roomId: string, identityId: string) => Promise<boolean>) {
  return async (roomIds: readonly string[], identityId: string) => {
    const allowed = new Set<string>();
    for (const roomId of roomIds) {
      if (await canReadRoom(roomId, identityId)) allowed.add(roomId);
    }
    return allowed;
  };
}

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

  async function get(path: string, database: SqlDatabase, extra: Partial<ServerOptions> = {},
    requestInit: RequestInit = {}): Promise<Response> {
    const server = createBeelineServer({
      database,
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
      ...extra,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return fetch(`http://127.0.0.1:${port}${path}`, requestInit);
  }

  it('Reproduction RETURN-1: retains a visible verifier return when the app handoff is blocked', async () => {
    const query = vi.fn(), transaction = vi.fn();
    const response = await get('/v1/apps/oauth/verify?session_uri=session-fixture',
      { query, transaction }, {}, { redirect: 'manual' });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await response.text();
    expect(html).toContain('href="beeline://beeline/settings/workbench/connect-signin?appSignInSession=session-fixture">Open Beeline</a>');
    expect(html).toContain("window.location.href = document.getElementById('open-beeline').href;");
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('Reproduction web-app-signin: returns a web-started sign-in to the web app, not the app scheme', async () => {
    const webAppOrigins = ['https://web.beeline.test'];
    const authorization = 'https://backend.composio.dev/link/lk_fixture';
    const start = await get(`/v1/apps/oauth/start?${new URLSearchParams({ authorization, return: webAppOrigins[0] })}`,
      { query: vi.fn(), transaction: vi.fn() }, { webAppOrigins }, { redirect: 'manual' });
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toBe(authorization);
    const cookie = start.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const session = 'https://backend.composio.dev/session/one?a=1&b=2';
    const verify = await get(`/v1/apps/oauth/verify?${new URLSearchParams({ session_uri: session })}`,
      { query: vi.fn(), transaction: vi.fn() }, { webAppOrigins },
      { redirect: 'manual', headers: { cookie: cookie.split(';')[0] } });
    expect(verify.status).toBe(302);
    const location = new URL(verify.headers.get('location')!);
    expect(location.origin).toBe(webAppOrigins[0]);
    expect(location.pathname).toBe('/beeline/settings/workbench/connect-signin');
    expect(location.searchParams.get('appSignInSession')).toBe(session);
    expect(verify.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('keeps the native return when the return cookie names an origin that is not configured', async () => {
    const response = await get('/v1/apps/oauth/verify?session_uri=session-fixture',
      { query: vi.fn(), transaction: vi.fn() }, { webAppOrigins: ['https://web.beeline.test'] },
      { redirect: 'manual', headers: { cookie: `beeline_app_sign_in_return=${encodeURIComponent('https://evil.test')}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toContain('href="beeline://beeline/settings/workbench/connect-signin?appSignInSession=session-fixture"');
  });

  it.each([
    ['an unconfigured return origin', 'https://backend.composio.dev/link/x', 'https://evil.test'],
    ['a non-provider sign-in link', 'https://evil.test/link/x', 'https://web.beeline.test'],
    ['a plain-http sign-in link', 'http://backend.composio.dev/link/x', 'https://web.beeline.test'],
  ])('refuses to start web sign-in with %s', async (_label, authorization, returnOrigin) => {
    const response = await get(`/v1/apps/oauth/start?${new URLSearchParams({ authorization, return: returnOrigin })}`,
      { query: vi.fn(), transaction: vi.fn() }, { webAppOrigins: ['https://web.beeline.test'] }, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('keeps an untrusted verifier session encoded in the return link', async () => {
    const session = 'https://provider.test/session?a=1&b="</script><script>alert(1)</script>\'';
    const response = await get(`/v1/apps/oauth/verify?${new URLSearchParams({ session_uri: session })}`,
      { query: vi.fn(), transaction: vi.fn() });
    const html = await response.text();
    expect(html).not.toContain(session);
    expect(html.match(/<script\b/g)).toHaveLength(1);
    const link = new URL(html.match(/id="open-beeline" href="([^"]+)"/)![1]);
    expect(link.searchParams.get('appSignInSession')).toBe(session);
    const nonce = html.match(/<script nonce="([^"]+)"/)![1];
    expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it.each(['', 'x'.repeat(4097)])('rejects an absent or oversized verifier session', async session => {
    const response = await get(`/v1/apps/oauth/verify?${new URLSearchParams({ session_uri: session })}`,
      { query: vi.fn(), transaction: vi.fn() });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid app sign-in session' });
  });

  it('retires the first-party Google callback route', async () => {
    const response = await get('/v1/google/oauth/callback?state=attempt&code=grant',
      { query: vi.fn(), transaction: vi.fn() }, {}, { redirect: 'manual' });
    expect(response.status).toBe(404);
  });

  it('returns 200 after a successful database query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const response = await get('/readyz', { query, transaction: vi.fn() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('reports app pool pressure and the oldest active app query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const oldestActiveQueryAgeMs = vi.fn().mockResolvedValue(12_345);
    const response = await get('/health', {
      query,
      transaction: vi.fn(),
      poolCounts: () => ({ total: 5, idle: 2, waiting: 3 }),
      oldestActiveQueryAgeMs,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      database: {
        pool: { size: 5, inUse: 3, waiting: 3 },
        oldestActiveQueryAgeMs: 12_345,
      },
      live: {
        sockets: 0,
        subscriptions: 0,
        activeDbTasks: 0,
        waitingDbTasks: 0,
        errors: { database: 0, invalid: 0, internal: 0, overload: 0 },
        heartbeatTerminations: 0,
      },
    });
  });

  it('reports bounded query fingerprints without SQL or parameter values', async () => {
    const response = await get('/health', {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      transaction: vi.fn(),
      queryProfiles: () => ({ top: [{ fingerprint: 'abc123', calls: 2, totalMs: 8,
        maxMs: 6, errors: 0, timeouts: 0, deadlocks: 0 }], overflow: 0 }),
    });
    expect((await response.json()).database.queryProfiles).toMatchObject({
      top: [{ fingerprint: 'abc123', totalMs: 8 }], overflow: 0,
    });
  });

  it('reports measured deployment headroom and all pool pressure from the diagnostics lane', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const pool = (total: number, idle: number, waiting: number): SqlDatabase => ({
      query, transaction: vi.fn(), poolCounts: () => ({ total, idle, waiting }),
    });
    const response = await get('/health', pool(5, 1, 2), {
      databaseBudget: databaseConnectionBudget(100),
      enrichmentDatabase: pool(2, 0, 1),
      healthDatabase: pool(1, 0, 0),
      jobsDatabase: pool(2, 1, 1),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).database).toMatchObject({
      budget: { maxConnections: 100, reservedConnections: 20, app: 5 },
      pools: {
        enrichment: { size: 2, inUse: 2, waiting: 1 },
        diagnostics: { size: 1, inUse: 1, waiting: 0 },
        jobs: { size: 2, inUse: 1, waiting: 1 },
      },
    });
  });

  it('reports each pool separately while retaining the older app-pool health shape', async () => {
    const app = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      transaction: vi.fn(),
      poolCounts: () => ({ total: 2, idle: 1, waiting: 0 }),
      poolTelemetry: () => ({
        checkouts: 4, checkoutFailures: 1, statementTimeouts: 0, deadlocks: 0,
        waitMs: 17, maxWaitMs: 10,
        activeMs: 25, maxActiveMs: 12, waitBuckets: [1, 2, 1, 0, 0, 0],
      }),
    };
    const jobs = {
      query: vi.fn(), transaction: vi.fn(),
      poolCounts: () => ({ total: 1, idle: 0, waiting: 2 }),
    };
    const response = await get('/health', app, { databasePools: { app, jobs } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.database.pool).toEqual({ size: 2, inUse: 1, waiting: 0 });
    expect(body.database.pools).toEqual({
      app: { size: 2, inUse: 1, waiting: 0, telemetry: app.poolTelemetry() },
      jobs: { size: 1, inUse: 1, waiting: 2, telemetry: null },
    });
  });

  it('reports an app transaction that is holding a connection and deadline count', async () => {
    const response = await get('/health', {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), transaction: vi.fn(),
      oldestActiveTransactionAgeMs: () => 42,
      transactionDeadlineCount: () => 3,
    });
    expect((await response.json()).database).toMatchObject({
      oldestActiveTransactionAgeMs: 42, transactionDeadlines: 3,
    });
  });

  it('returns 503 when the database query fails', async () => {
    const response = await get('/readyz', {
      query: vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')),
      transaction: vi.fn(),
    });

    expect(response.status).toBe(503);
  });

  it('survives an injected pool checkout timeout and serves the next request', async () => {
    const timeout = new Error('timeout exceeded when trying to connect');
    const connect = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
        release: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
      });
    const pool = {
      connect,
      query: vi.fn(),
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as Pool;
    const database = new PostgresDatabase('', 5, { pool, pause: async () => {} });
    const server = createBeelineServer({
      database,
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/readyz`;

    const failed = await fetch(url);
    expect(failed.status).toBe(503);
    expect(connect).toHaveBeenCalledTimes(4);
    const recovered = await fetch(url);
    expect(recovered.status).toBe(200);
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

  it('names the committed message on a phone-write so an open Room can paint it', async () => {
    const publish = vi.fn();
    const execute = vi.fn().mockResolvedValue({ messageId: 'posted-message' });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: { execute } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: { publish } as unknown as LiveHub,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/phone/operations/sendRoomMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'p'.repeat(20)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-open', text: 'hello' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ messageId: 'posted-message' });
    expect(publish).toHaveBeenCalledWith({
      type: 'invalidate',
      roomId: 'room-open',
      reason: 'phone-write',
      messageId: 'posted-message',
      trace: {
        id: expect.any(String),
        startedAt: expect.any(Number),
        databaseAt: expect.any(Number),
        emittedAt: expect.any(Number),
      },
    });
  });

  it('publishes no Room invalidation when opening a Room clears its dismissal', async () => {
    const publish = vi.fn();
    const execute = vi.fn().mockResolvedValue(undefined);
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: { execute } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: { publish } as unknown as LiveHub,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/phone/operations/reopenChat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'p'.repeat(20)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-open' }),
    });

    expect(response.status).toBe(204);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ['listRoomWorkflowRuns', { workflows: [] }],
    ['readWorkflowRun', { runId: 'run' }],
    ['listRoomSchedules', { schedules: [] }],
    ['updateRoomPushState', { muted: false }],
  ])(
    'publishes no Room invalidation after %s, which no other Room read sees',
    async (operation, result) => {
      const publish = vi.fn();
      const execute = vi.fn().mockResolvedValue(result);
      const server = createBeelineServer({
        database: { query: vi.fn(), transaction: vi.fn() },
        auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
        phone: { execute } as unknown as PhoneService,
        daemon: {} as DaemonService,
        live: { publish } as unknown as LiveHub,
        mediaMaximumBytes: 1,
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;

      // An open corner rereads its workflow runs on every Room invalidation;
      // a read that published one made that reread loop without end.
      const response = await fetch(`http://127.0.0.1:${port}/v1/phone/operations/${operation}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${'p'.repeat(20)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'room-open' }),
      });

      expect(response.status).toBe(200);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('lets the web app ask for a compact Room read and keeps CORS varying by origin when it compresses', async () => {
    const readRoom = vi.fn().mockResolvedValue({
      room: { id: '22222222-2222-4222-8222-222222222222' },
      messages: Array.from({ length: 20 }, (_, index) => ({ id: String(index), text: 'x'.repeat(80) })),
      watchFilters: [],
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: { readRoom } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
      webAppOrigins: ['https://web.beeline.test'],
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const path = `http://127.0.0.1:${port}/v1/phone/rooms/22222222-2222-4222-8222-222222222222`;

    const preflight = await fetch(path, {
      method: 'OPTIONS',
      headers: { origin: 'https://web.beeline.test', 'access-control-request-headers': 'x-beeline-view' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-beeline-view');

    const read = await fetch(path, {
      headers: {
        origin: 'https://web.beeline.test',
        authorization: `Bearer ${'p'.repeat(20)}`,
        'accept-encoding': 'gzip',
        'x-beeline-view': 'compact',
      },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get('content-encoding')).toBe('gzip');
    expect(read.headers.get('vary')).toBe('Origin, accept-encoding');
    expect(await read.json()).not.toHaveProperty('watchFilters');
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

  it('contains a pool timeout during a live subscription and keeps serving HTTP', async () => {
    const timeout = new Error('timeout exceeded when trying to connect');
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticateDaemon: vi.fn().mockResolvedValue('agent-live') } as unknown as TokenAuth,
      phone: { canReadRooms: vi.fn().mockRejectedValue(timeout) } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
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
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'subscribe', roomId: 'room-live' }));

    await expect(closed).resolves.toBe(1013);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect((await health.json()).live.errors.database).toBe(1);
  });

  it('advertises discovery wake and pushes listener and app-pool recovery', async () => {
    const live = new LiveHub();
    let recover: (() => void) | undefined;
    const onRecovery = vi.fn((listener: () => void) => {
      recover = listener;
      return () => { recover = undefined; };
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn(), onRecovery },
      auth: { authenticateDaemon: vi.fn().mockResolvedValue('agent-live') } as unknown as TokenAuth,
      phone: { canReadRooms: vi.fn().mockResolvedValue(new Set(['room-live'])) } as unknown as PhoneService,
      daemon: { execute: vi.fn(async (name: string) => name === 'getAgentCommands'
        ? { commandProtocol: 1, commands: [] } : { items: [] }) } as unknown as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    sockets.push(socket);
    const hello = nextSocketMessage(socket, 'hello');
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await expect(hello).resolves.toMatchObject({
      protocolMin: 1, protocolMax: 1,
      capabilities: { discoveryWake: true },
    });
    const subscribed = nextSocketMessage(socket, 'subscribed');
    socket.send(JSON.stringify({ type: 'subscribe', roomId: 'room-live' }));
    await expect(subscribed).resolves.toMatchObject({
      capabilities: { discoveryWake: true, pushIntake: true },
    });
    const listenerWake = nextSocketMessage(socket, 'discovery-wake');
    live.resync();
    await expect(listenerWake).resolves.toMatchObject({ reason: 'listener-resync' });
    const poolWake = nextSocketMessage(socket, 'discovery-wake');
    recover?.();
    await expect(poolWake).resolves.toMatchObject({ reason: 'database-recovered' });
  });

  it('acknowledges push intake when the separate presence announcement fails', async () => {
    const roomId = 'room-live';
    const agentId = 'agent-live';
    const announce = vi.fn().mockRejectedValue(new Error('pool exhausted'));
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomInbox') return { items: [], cursor: undefined };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      throw new Error(`unexpected operation ${name}`);
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticateDaemon: vi.fn().mockResolvedValue(agentId) } as unknown as TokenAuth,
      phone: { canReadRooms: canReadRoomsFrom(async () => true) } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      connectionPresence: { announce } as never,
      live: new LiveHub(),
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
    const commands = nextSocketMessage(socket, 'commands');
    socket.send(JSON.stringify({ type: 'subscribe', roomId, lifecycleId: 'lifecycle-1' }));
    await expect(subscribed).resolves.toMatchObject({
      roomId,
      capabilities: { pushIntake: true, connectionPresence: true },
    });
    await expect(commands).resolves.toMatchObject({ roomId, commandProtocol: 1 });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(announce).toHaveBeenCalledOnce();
  });

  it('refreshes commands for a command addressed to this agent or one another agent released', async () => {
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
      phone: { canReadRoom: vi.fn().mockResolvedValue(true), canReadRooms: canReadRoomsFrom(async () => true) } as unknown as PhoneService,
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
    const inboxCalls = () => execute.mock.calls.filter(([name]) => name === 'getRoomInbox').length;
    expect(commandCalls()).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);

    live.publish({ type: 'presence', roomId, agentId, status: 'online', observedAt: 1 });
    live.publish({ type: 'draft', roomId, agentId, turnId: 'turn', text: 'draft' });
    live.publish({ type: 'thought', roomId, agentId, turnId: 'turn', text: 'thought' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);
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

    // The worker's command ending releases a review wake held for this agent.
    const released = nextSocketMessage(socket, 'commands');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_commands',
      targetAgentId: 'another-agent',
      commandReleased: true,
    });
    await expect(released).resolves.toMatchObject({ type: 'commands', roomId });
    expect(commandCalls()).toBe(2);

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
    expect(commandCalls()).toBe(3);
  });

  it('answers a phone ping with a pong without touching the database', async () => {
    const query = vi.fn();
    const server = createBeelineServer({
      database: { query, transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('reader') } as unknown as TokenAuth,
      phone: { canReadRooms: canReadRoomsFrom(async () => true) } as unknown as PhoneService,
      daemon: { execute: vi.fn() } as unknown as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone-token']);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    query.mockClear();
    const pong = nextSocketMessage(socket, 'pong');
    socket.send(JSON.stringify({ type: 'ping' }));
    await expect(pong).resolves.toEqual({ type: 'pong' });
    const synced = nextSocketMessage(socket, 'sync-ok');
    socket.send(JSON.stringify({ type: 'sync' }));
    await expect(synced).resolves.toEqual({ type: 'sync-ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('sends read-mark reconciliation to reader devices without replaying a daemon inbox', async () => {
    const roomId = 'room-live';
    const live = new LiveHub();
    const liveDraftSnapshot = vi.fn().mockResolvedValue([]);
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomInbox') return { items: [], cursor: undefined };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      throw new Error(`unexpected operation ${name}`);
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticateDaemon: vi.fn().mockResolvedValue('agent-live'),
        authenticatePhone: vi.fn().mockResolvedValue('reader'),
      } as unknown as TokenAuth,
      phone: {
        canReadRooms: canReadRoomsFrom(async () => true),
        liveDraftSnapshot,
      } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const connect = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, [`bearer.${token}`]);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const subscribed = nextSocketMessage(socket, 'subscribed');
      const initialInbox = token.startsWith('bdt_') ? nextSocketMessage(socket, 'inbox') : null;
      socket.send(JSON.stringify({ type: 'subscribe', roomId }));
      await subscribed;
      if (initialInbox) await initialInbox;
      return socket;
    };
    const daemonSocket = await connect('bdt_test');
    const phoneA = await connect('phone-a');
    const phoneB = await connect('phone-b');
    const inboxCalls = () => execute.mock.calls.filter(([name]) => name === 'getRoomInbox').length;
    expect(inboxCalls()).toBe(1);

    const first = nextSocketMessage(phoneA, 'invalidate');
    const second = nextSocketMessage(phoneB, 'invalidate');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:room_read_marks', readerId: 'reader' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ reason: 'postgres:room_read_marks' }),
      expect.objectContaining({ reason: 'postgres:room_read_marks' }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);

    const replayed = nextSocketMessage(daemonSocket, 'inbox');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages' });
    await replayed;
    expect(inboxCalls()).toBe(2);
  });

  it('pushes config-changed only to the changed agent, without an inbox replay', async () => {
    const roomId = 'room-config';
    const agentId = 'agent-config';
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
      phone: { canReadRoom: vi.fn().mockResolvedValue(true), canReadRooms: canReadRoomsFrom(async () => true) } as unknown as PhoneService,
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

    const inboxCalls = () => execute.mock.calls.filter(([name]) => name === 'getRoomInbox').length;
    expect(inboxCalls()).toBe(1);

    // Another agent's selection change must not wake this daemon.
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'agent-config',
      targetAgentId: 'another-agent',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);

    const changed = nextSocketMessage(socket, 'config-changed');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'agent-config',
      targetAgentId: agentId,
    });
    await expect(changed).resolves.toEqual({ type: 'config-changed', roomId });
    // The wake carries no transcript: the durable fact is the agent-model
    // system line, and the daemon needs no inbox replay to retire sessions.
    expect(inboxCalls()).toBe(1);
  });

  it('pushes scoped rooms-changed, connector-assignment, and corner lifecycle events', async () => {
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
      phone: {
        canReadRoom: vi.fn().mockResolvedValue(true),
        canReadRooms: canReadRoomsFrom(async () => true),
      } as unknown as PhoneService,
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

    const roomsChanged = nextSocketMessage(socket, 'rooms-changed');
    live.publish({
      type: 'invalidate',
      roomId: 'corner-1',
      reason: 'postgres:memberships',
      targetAgentId: agentId,
      operation: 'INSERT',
      parentRoomId: roomId,
      openedBy: 'opener-agent',
    });
    await expect(roomsChanged).resolves.toEqual({
      type: 'rooms-changed',
      roomId: 'corner-1',
      parentRoomId: roomId,
      openedBy: 'opener-agent',
    });

    // A command queued for a corner this helper has never watched carries
    // its own parent/opener, so the agent-wide wake can start it directly
    // instead of waiting for the next discovery reconciliation.
    const commandPushedCorner = nextSocketMessage(socket, 'rooms-changed');
    live.publish({
      type: 'invalidate',
      roomId: 'corner-2',
      reason: 'postgres:agent_commands',
      targetAgentId: agentId,
      parentRoomId: roomId,
      openedBy: 'opener-agent',
    });
    await expect(commandPushedCorner).resolves.toEqual({
      type: 'rooms-changed',
      roomId: 'corner-2',
      parentRoomId: roomId,
      openedBy: 'opener-agent',
    });

    // A command queued for a top-level Room needs no push: every desired
    // Room already starts eagerly on membership alone. (Its own existing
    // per-room subscription still answers with a `commands` refresh.)
    const noPushForRoom = expectNoSocketMessageOfType(socket, 'rooms-changed');
    const roomCommandsEcho = nextSocketMessage(socket, 'commands');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_commands',
      targetAgentId: agentId,
    });
    await Promise.all([noPushForRoom, roomCommandsEcho]);

    const repositoryChanged = nextSocketMessage(socket, 'rooms-changed');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:rooms',
      repositoryChanged: true });
    await expect(repositoryChanged).resolves.toEqual({ type: 'rooms-changed', roomId,
      repositoryChanged: true });

    const connector = nextSocketMessage(socket, 'connector-assignment');
    live.publish({
      type: 'invalidate',
      roomId: '',
      reason: 'connector-assignment',
      targetAgentId: agentId,
    });
    await expect(connector).resolves.toEqual({ type: 'connector-assignment' });

    // A child corner's status hint is for corner lists, never an inbox replay.
    live.publish({ type: 'invalidate', roomId, reason: 'corner-status' });

    const closed = nextSocketMessage(socket, 'corner-complete');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:corner_facts',
      closeRequested: true,
    });
    await expect(closed).resolves.toEqual({ type: 'corner-complete', roomId });
    expect(execute.mock.calls.filter(([name]) => name === 'getRoomInbox')).toHaveLength(1);
  });

  it("forwards only this agent's @agent login start and code steps to its helper", async () => {
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
      auth: { authenticateDaemon: vi.fn().mockResolvedValue(agentId) } as unknown as TokenAuth,
      phone: {
        canReadRoom: vi.fn().mockResolvedValue(true),
        canReadRooms: canReadRoomsFrom(async () => true),
      } as unknown as PhoneService,
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
    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await subscribed;

    const frames: Record<string, unknown>[] = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === 'agent-sign-in') frames.push(message);
    });
    const attemptId = '00000000-0000-4000-8000-000000000001';
    const base = { type: 'agent-sign-in', roomId: '', attemptId } as const;
    live.publish({ ...base, agentId: 'another-agent', step: 'start', cardId: 'c'.repeat(64) });
    live.publish({
      ...base,
      agentId,
      step: 'link',
      link: { kind: 'paste-code', authorizeUrl: 'https://claude.com/x' },
    });
    live.publish({ ...base, agentId, step: 'result', outcome: 'signed-in' });
    live.publish({ ...base, agentId, step: 'start', cardId: 'c'.repeat(64) });
    live.publish({ ...base, agentId, step: 'code', code: 'abc#state' });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames).toEqual([
      { type: 'agent-sign-in', step: 'start', attemptId, cardId: 'c'.repeat(64) },
      { type: 'agent-sign-in', step: 'code', attemptId, code: 'abc#state' },
    ]);
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
    liveChatCornerStatus?: PhoneService['liveChatCornerStatus'],
    readLiveDeltas?: PhoneService['readLiveDeltas'],
    readLiveBookmark?: PhoneService['readLiveBookmark'],
    liveNeedsYou?: PhoneService['liveNeedsYou'],
  ) {
    const roomId = 'room-live';
    const live = new LiveHub();
    const liveDraftSnapshot = vi.fn().mockResolvedValue([]);
    const server = createBeelineServer({
      database: { query: databaseQuery, transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: {
        canReadRoom,
        canReadRooms: canReadRoomsFrom(canReadRoom),
        liveDraftSnapshot,
        readLiveDelta,
        readLiveDeltas,
        readLiveBookmark,
        liveNeedsYou,
        projectCommittedLiveDelta,
        liveChatCornerStatus,
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
    return { live, roomId, socket, port, liveDraftSnapshot };
  }

  it('projects a parent corner status into one compact frame', async () => {
    const status = { cornerCount: 1, waitingCornerCount: 1,
      openCorners: [{ id: 'corner', name: 'Fix', state: 'waiting' as const }],
      agentState: 'needs-you' as const };
    const project = vi.fn().mockResolvedValue(status);
    const { live, roomId, socket } = await connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false, undefined,
      project as PhoneService['liveChatCornerStatus']);
    const frame = nextSocketMessage(socket, 'corner-status');
    live.publish({ type: 'invalidate', roomId, reason: 'corner-status' });
    await expect(frame).resolves.toEqual({ type: 'corner-status', roomId, ...status, sequence: 1 });
    expect(project).toHaveBeenCalledWith(roomId, 'viewer');
    const noDuplicate = expectNoSocketMessage(socket);
    live.publish({ type: 'invalidate', roomId, reason: 'corner-status' });
    await noDuplicate;
    expect(project).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2, 8])('reads a cross-process row once for %i sockets', async (count) => {
    const roomId = 'room-live';
    const delta = { type: 'message-delta' as const, roomId,
      message: { id: 'one-row', text: 'hello', createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } };
    const batch = vi.fn().mockImplementation(async (_roomId, viewers: string[]) =>
      new Map(viewers.map((viewer) => [viewer, delta])));
    const read = vi.fn().mockRejectedValue(new Error('per-socket read'));
    const { live, socket, port } = await connect(
      read as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const viewers = [socket];
    for (let index = 1; index < count; index++) {
      const next = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
      sockets.push(next);
      await new Promise<void>((resolve, reject) => {
        next.once('open', resolve);
        next.once('error', reject);
      });
      const subscribed = nextSocketMessage(next, 'subscribed');
      next.send(JSON.stringify({ type: 'subscribe', roomId }));
      await subscribed;
      viewers.push(next);
    }
    const frames = viewers.map((viewer) => nextSocketMessage(viewer, 'message-delta'));
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
      operation: 'INSERT', messageId: 'one-row' });
    for (const frame of frames) await expect(frame).resolves.toMatchObject(delta);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    await Promise.all(viewers.map((viewer) => expectNoSocketMessage(viewer, 50)));
  });

  it('sends owner-scoped resource changes on the shared phone socket', async () => {
    const { live, socket } = await connect(vi.fn() as PhoneService['readLiveDelta']);
    const frame = nextSocketMessage(socket, 'resource-change');
    live.publish({ type: 'resource-change', roomId: '', ownerId: 'viewer',
      resource: 'workbench', resourceId: 'connection' });
    await expect(frame).resolves.toEqual({ type: 'resource-change', roomId: '',
      resource: 'workbench', resourceId: 'connection' });
    const noLeak = expectNoSocketMessage(socket, 100);
    live.publish({ type: 'resource-change', roomId: '', ownerId: 'other',
      resource: 'agent', resourceId: 'other-agent' });
    await noLeak;
  });

  it('reads a bookmark once and sends the typed change to both devices', async () => {
    const bookmark = { messageId: 'saved', workspaceId: 'workspace', roomId: 'room-live',
      roomName: 'Room', roomKind: 'room' as const, messageCreatedAt: 1,
      bookmarkedAt: 2, available: true };
    const read = vi.fn().mockResolvedValue(bookmark);
    const { live, socket, port } = await connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, undefined, read as PhoneService['readLiveBookmark']);
    const second = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    sockets.push(second);
    await new Promise<void>((resolve, reject) => {
      second.once('open', resolve);
      second.once('error', reject);
    });
    const firstFrame = nextSocketMessage(socket, 'bookmark-delta');
    const secondFrame = nextSocketMessage(second, 'bookmark-delta');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:message_bookmarks',
      readerId: 'viewer', workspaceId: 'workspace', messageId: 'saved' });
    await expect(firstFrame).resolves.toMatchObject({ bookmark, messageId: 'saved' });
    await expect(secondFrame).resolves.toMatchObject({ bookmark, messageId: 'saved' });
    expect(read).toHaveBeenCalledTimes(1);
    const removed = nextSocketMessage(socket, 'bookmark-delta');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:message_bookmarks',
      readerId: 'viewer', workspaceId: 'workspace', messageId: 'saved', operation: 'DELETE' });
    await expect(removed).resolves.toMatchObject({ messageId: 'saved', bookmark: null });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('sends one server-derived Needs-you room slice to each device', async () => {
    const roomId = 'room-live';
    const message = { id: 'ask', text: '@viewer please review', createdAt: 1,
      author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
      presentation: 'message' as const, mentionPubkeys: ['viewer'] };
    const batch = vi.fn().mockImplementation(async (_roomId, viewers: string[]) =>
      new Map(viewers.map((viewer) => [viewer,
        { type: 'message-delta', roomId, message }])));
    const needs = { workspaceId: 'workspace', count: 1,
      items: [{ messageId: 'ask', workspaceId: 'workspace', roomId,
        roomName: 'Room', roomKind: 'room', text: 'please review', createdAt: 1 }] };
    const readNeeds = vi.fn().mockResolvedValue(needs);
    const { live, socket, port } = await connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas'],
      undefined, readNeeds as PhoneService['liveNeedsYou']);
    const second = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    sockets.push(second);
    await new Promise<void>((resolve, reject) => {
      second.once('open', resolve);
      second.once('error', reject);
    });
    const subscribed = nextSocketMessage(second, 'subscribed');
    second.send(JSON.stringify({ type: 'subscribe', roomId }));
    await subscribed;
    const first = nextSocketMessage(socket, 'needs-you-delta');
    const next = nextSocketMessage(second, 'needs-you-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
      operation: 'INSERT', messageId: 'ask', needsYouCandidate: true,
      agentId: 'agent' });
    await expect(first).resolves.toMatchObject({ type: 'needs-you-delta', count: 1,
      sourceRoomId: roomId, items: needs.items });
    await expect(next).resolves.toMatchObject({ type: 'needs-you-delta', count: 1 });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(readNeeds).toHaveBeenCalledTimes(1);
  });

  it('sends append frames and suppresses a duplicate Postgres draft', async () => {
    const { live, roomId, socket } = await connect(vi.fn() as PhoneService['readLiveDelta']);
    const frames = nextSocketMessages(socket, 3);
    for (const text of ['a'.repeat(1_000), 'a'.repeat(2_000), 'a'.repeat(3_000)]) {
      live.publish({ type: 'draft', roomId, agentId: 'agent', turnId: 'turn',
        text, latestChunk: 'a'.repeat(1_000), localOrigin: true });
      live.publish({ type: 'draft', roomId, agentId: 'agent', turnId: 'turn', text,
        latestChunk: 'a'.repeat(1_000) });
    }
    const [snapshot, first, second] = await frames;
    expect(snapshot).toMatchObject({ type: 'draft', revision: 0, text: 'a'.repeat(1_000), sequence: 1 });
    expect(first).toMatchObject({ type: 'draft-append', revision: 1, offset: 1_000,
      chunk: 'a'.repeat(1_000), sequence: 2 });
    expect(second).toMatchObject({ type: 'draft-append', revision: 2, offset: 2_000,
      chunk: 'a'.repeat(1_000), sequence: 3 });
    expect(first).not.toHaveProperty('latestChunk');
    expect(second).not.toHaveProperty('latestChunk');
    const actual = [snapshot, first, second].reduce((sum, frame) =>
      sum + Buffer.byteLength(JSON.stringify(frame)), 0);
    const old = [1_000, 2_000, 3_000].reduce((sum, size) => sum +
      Buffer.byteLength(JSON.stringify({ type: 'draft', roomId, agentId: 'agent',
        turnId: 'turn', text: 'a'.repeat(size) })), 0);
    expect(actual).toBeLessThan(old);
    await expectNoSocketMessage(socket, 100);
  });

  it('resumes one Room with only missed deltas and no repeated snapshots', async () => {
    const delta = { type: 'message-delta' as const, roomId: 'room-live',
      message: { id: 'missed', text: 'after disconnect', createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } };
    const read = vi.fn().mockResolvedValue(delta);
    const { live, roomId, socket, port, liveDraftSnapshot } = await connect(read as PhoneService['readLiveDelta']);
    const first = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    sockets.push(first);
    await new Promise<void>((resolve, reject) => { first.once('open', resolve); first.once('error', reject); });
    const initial = nextSocketMessage(first, 'subscribed');
    first.send(JSON.stringify({ type: 'subscribe', roomId }));
    const acknowledged = await initial;
    expect(acknowledged).toMatchObject({ resumed: false, cursor: 0, epoch: expect.any(String) });
    expect(liveDraftSnapshot).toHaveBeenCalledTimes(2);
    const originalClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const firstClosed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    socket.terminate();
    first.terminate();
    await Promise.all([originalClosed, firstClosed]);
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'missed' });
    const resumed = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    sockets.push(resumed);
    await new Promise<void>((resolve, reject) => { resumed.once('open', resolve); resumed.once('error', reject); });
    const frames = nextSocketMessages(resumed, 2);
    resumed.send(JSON.stringify({ type: 'subscribe', roomId,
      cursors: { [roomId]: { epoch: acknowledged.epoch, base: 0, seen: [] } } }));
    const [ack, replayed] = await frames;
    expect(ack).toMatchObject({ type: 'subscribed', resumed: true, cursor: 0 });
    expect(replayed).toMatchObject({ ...delta, sequence: 1 });
    expect(liveDraftSnapshot).toHaveBeenCalledTimes(2);
    await expectNoSocketMessage(resumed, 100);
  });

  it('sends one fallback for a row that projects no delta', async () => {
    const { live, roomId, socket } = await connect(
      vi.fn().mockResolvedValue(null) as PhoneService['readLiveDelta'],
    );
    const invalidated = nextSocketMessage(socket, 'invalidate');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:messages',
      operation: 'UPDATE',
      messageId: 'message-hidden',
    });

    await expect(invalidated).resolves.toMatchObject({
      reason: 'delta-fallback:postgres:messages',
    });
    await expectNoSocketMessage(socket, 100);
  });

  it.each([
    ['deleted', vi.fn().mockResolvedValue(null)],
    ['failed', vi.fn().mockRejectedValue(new Error('row read failed'))],
  ])(
    'sends one fallback when the delta read is %s',
    async (_case, read) => {
      const { live, roomId, socket } = await connect(read as PhoneService['readLiveDelta']);
      const fallbackFrame = nextSocketMessage(socket, 'invalidate');

      live.publish({
        type: 'invalidate',
        roomId,
        reason: 'postgres:messages',
        operation: 'DELETE',
        messageId: 'message-fallback',
      });

      const fallback = await fallbackFrame;
      // A deleted row or failed read still reaches a list waiting on the row.
      expect(fallback).toMatchObject({
        type: 'invalidate',
        roomId,
        reason: 'delta-fallback:postgres:messages',
      });
      expect(fallback).not.toHaveProperty('messageId');
      await expectNoSocketMessage(socket, 100);
    },
  );

  it('scales live admission with the app pool and leaves ordinary requests four', () => {
    expect(maxLiveDbTasks(undefined)).toBe(2);
    expect(maxLiveDbTasks(5)).toBe(2);
    expect(maxLiveDbTasks(10)).toBe(6);
  });

  it('turns a named phone-write into a message-delta for an already-open Room', async () => {
    const delta = {
      type: 'message-delta' as const,
      roomId: 'room-live',
      message: {
        id: 'posted-message',
        text: 'hello',
        createdAt: 1,
        author: { pubkey: 'human', kind: 'human' as const, name: 'Captain' },
        presentation: 'message' as const,
      },
    };
    const read = vi.fn().mockResolvedValue(delta);
    const { live, roomId, socket } = await connect(read as PhoneService['readLiveDelta']);
    const painted = nextSocketMessage(socket, 'message-delta');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'phone-write',
      messageId: 'posted-message',
    });

    await expect(painted).resolves.toEqual({ ...delta, sequence: 1 });
    await expectNoSocketMessage(socket, 100);
    expect(read).toHaveBeenCalledWith(roomId, 'viewer', {
      type: 'message',
      messageId: 'posted-message',
    });
  });

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
      reason: 'delta-fallback:message',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps later committed deltas direct when an earlier lookup stalls', async () => {
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
    const received = nextSocketMessages(socket, 2);
    const startedAt = Date.now();

    for (const messageId of ['message-1', 'message-2', 'message-3']) {
      live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId });
    }

    const messages = await received;
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(messages.map((message) => message.type)).toEqual(['message-delta', 'message-delta']);
    expect(
      messages.map((message) => (message.message as { id: string }).id),
    ).toEqual(['message-2', 'message-3']);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      'SYNC-01',
      {
        reason: 'postgres:messages',
        messageId: 'message-stalled',
      },
    ],
    [
      'STOP-01',
      {
        reason: 'postgres:agent_turns',
        agentId: 'agent-stopped',
        requestId: 'request-stopped',
      },
    ],
  ])('keeps %s to one frame while its delta projection remains stalled', async (_id, row) => {
    let resolveRead!: (value: unknown) => void;
    const read = vi.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { live, roomId, socket } = await connect(read as PhoneService['readLiveDelta']);

    live.publish({ type: 'invalidate', roomId, ...row });
    await expectNoSocketMessage(socket, 100);
    const delivered = nextSocketMessage(socket, 'invalidate');
    resolveRead(null);
    await expect(delivered).resolves.toMatchObject({ type: 'invalidate', roomId,
      reason: `delta-fallback:${row.reason}` });
  });

  it('preserves the direct delta after the immediate invalidation for a slow projection', async () => {
    const delta = {
      type: 'message-delta' as const,
      roomId: 'room-live',
      message: {
        id: 'message-slow',
        text: 'slow but direct',
        createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
        presentation: 'message' as const,
      },
    };
    const read = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
      return delta;
    });
    const { live, roomId, socket } = await connect(read as PhoneService['readLiveDelta']);
    const received = nextSocketMessage(socket, 'message-delta');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:messages',
      messageId: 'message-slow',
    });

    await expect(received).resolves.toMatchObject({
      ...delta,
    });
  });

  it('suppresses the duplicate direct/PG projection of one committed row', async () => {
    const delta = {
      type: 'message-delta' as const,
      roomId: 'room-live',
      message: { id: 'message-duplicate', text: 'once', createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
        presentation: 'message' as const },
    };
    const read = vi.fn().mockResolvedValue(delta);
    const project = vi.fn().mockReturnValue(delta);
    const { live, roomId, socket } = await connect(
      read as PhoneService['readLiveDelta'], project as PhoneService['projectCommittedLiveDelta']);
    const first = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: delta.message.id,
      committedRow: { type: 'message', row: { room_id: roomId, id: delta.message.id } as never } });
    await expect(first).resolves.toEqual({ ...delta, sequence: 1 });
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
      operation: 'INSERT', messageId: delta.message.id });
    await expectNoSocketMessage(socket, 100);
    expect(read).not.toHaveBeenCalled();
    expect(project).toHaveBeenCalledTimes(1);
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
    const recordedEvents = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const { live, roomId, socket, port } = await connect(
      read as PhoneService['readLiveDelta'],
      project as PhoneService['projectCommittedLiveDelta'],
      vi.fn().mockResolvedValue(true),
      true,
      recordedEvents,
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
    expect(delivered).toEqual({ ...delta, trace, sequence: 1 });
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
    expect(recordedEvents).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operator_function_events'),
      ['message_delivery', expect.any(Number), false],
    );
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

  it('contains a failed paint-clock read and keeps serving HTTP', async () => {
    const query = vi.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const { live, roomId, socket, port } = await connect(
      vi.fn().mockResolvedValue({
        type: 'turn-delta',
        roomId: 'room-live',
        turn: { requestId: 'request', agentId: 'agent', status: 'working', createdAt: 1 },
      }),
      undefined,
      undefined,
      true,
      query,
    );
    const delivered = nextSocketMessage(socket, 'turn-delta');
    live.publish({
      type: 'invalidate', roomId, reason: 'postgres:agent_turns',
      agentId: 'agent', requestId: 'request',
      trace: { id: 'failed-clock', databaseAt: 1, emittedAt: 2 },
    });
    await delivered;
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(JSON.stringify({ type: 'trace-paint', id: 'failed-clock' }));
    await expect(closed).resolves.toBe(1013);
    expect(query).toHaveBeenCalledOnce();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
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
        canReadRooms: canReadRoomsFrom(async () => false),
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
    expect(delivered).toEqual({ type: 'invalidate', roomId, reason: 'message', sequence: 1 });
    expect(JSON.stringify(delivered)).not.toContain('raw-secret');
    expect(project).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('authorizes a multi-Room subscribe batch with one canReadRooms call', async () => {
    const allowedRoom = 'room-allowed';
    const deniedRoom = 'room-denied';
    const canReadRooms = vi.fn(async (roomIds: readonly string[]) => {
      expect(roomIds).toEqual([allowedRoom, deniedRoom]);
      return new Set([allowedRoom]);
    });
    const read = vi.fn();
    const project = vi.fn().mockImplementation((_roomId: string, committed: { row: { id: string } }) => ({
      type: 'message-delta' as const,
      roomId: allowedRoom,
      message: {
        id: committed.row.id,
        text: 'ok',
        createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
        presentation: 'message' as const,
      },
    }));
    const live = new LiveHub();
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: {
        canReadRoom: vi.fn(),
        canReadRooms,
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

    const subscribed = nextSocketMessage(socket, 'subscribed');
    socket.send(JSON.stringify({ type: 'subscribe', roomIds: [allowedRoom, deniedRoom] }));
    await expect(subscribed).resolves.toMatchObject({ type: 'subscribed', roomId: allowedRoom });
    expect(canReadRooms).toHaveBeenCalledTimes(1);
    expect(canReadRooms).toHaveBeenCalledWith([allowedRoom, deniedRoom], 'viewer');
    await expectNoSocketMessage(socket);

    const allowedDelta = nextSocketMessage(socket, 'message-delta');
    live.publish({
      type: 'invalidate',
      roomId: allowedRoom,
      reason: 'message',
      messageId: 'allowed-message',
      committedRow: {
        type: 'message',
        row: { room_id: allowedRoom, id: 'allowed-message' },
      },
    });
    await expect(allowedDelta).resolves.toMatchObject({
      type: 'message-delta',
      roomId: allowedRoom,
    });

    live.publish({
      type: 'invalidate',
      roomId: deniedRoom,
      reason: 'message',
      messageId: 'secret-message',
      committedRow: {
        type: 'message',
        row: { room_id: deniedRoom, id: 'secret-message', text: 'raw-secret' },
      },
    });
    await expectNoSocketMessage(socket);
    expect(project).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('live reconnect admission', () => {
  it('rejects an oversized subscribe frame before asking the database', async () => {
    const canReadRooms = vi.fn();
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: { canReadRooms } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    let socket: WebSocket | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
      await new Promise<void>((resolve, reject) => {
        socket!.once('open', () => resolve());
        socket!.once('error', reject);
      });
      const closed = new Promise<number>((resolve) => socket!.once('close', resolve));
      socket.send(JSON.stringify({
        type: 'subscribe', roomIds: Array.from({ length: 33 }, (_, index) => `room-${index}`),
      }));
      await expect(closed).resolves.toBe(1008);
      expect(canReadRooms).not.toHaveBeenCalled();
    } finally {
      socket?.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('admits a restarted helper over its zombie sockets and pongs while the database gate is full', async () => {
    const stalledReads: Array<() => void> = [];
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticateDaemon: vi.fn(async () => 'agent-restarted'),
        authenticatePhone: vi.fn(async (token: string) => token),
      } as unknown as TokenAuth,
      phone: {
        canReadRooms: vi.fn(() => new Promise<Set<string>>((resolve) => {
          stalledReads.push(() => resolve(new Set()));
        })),
      } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    const sockets: WebSocket[] = [];
    const open = (protocol: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, [protocol]);
      sockets.push(socket);
      return new Promise<WebSocket>((resolve, reject) => {
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
      });
    };
    let port = 0;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
      // Five helper processes died without their TCP connections closing.
      const zombies: WebSocket[] = [];
      const zombieClosed: Promise<void>[] = [];
      for (let restart = 0; restart < 5; restart++) {
        const zombie = await open('bearer.bdt_restarted');
        zombies.push(zombie);
        zombieClosed.push(new Promise((resolve) => zombie.once('close', () => resolve())));
      }
      const current = await open('bearer.bdt_restarted');
      expect(current.readyState).toBe(WebSocket.OPEN);
      await zombieClosed[0];
      await Promise.all(zombieClosed);
      expect(zombies.every((zombie) => zombie.readyState === WebSocket.CLOSED)).toBe(true);
      expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).live.sockets).toBe(1);

      // Saturate the live database gate with reads that never finish.
      for (const reader of ['phone-a', 'phone-b', 'phone-c']) {
        const phone = await open(`bearer.${reader}`);
        phone.send(JSON.stringify({ type: 'subscribe', roomId: `room-${reader}` }));
      }
      await vi.waitFor(() => expect(stalledReads).toHaveLength(2));
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(health.live).toMatchObject({ activeDbTasks: 2, waitingDbTasks: 1 });
      const pong = new Promise<string>((resolve) => current.once('pong', (data) => resolve(data.toString())));
      current.ping('still-there');
      await expect(pong).resolves.toBe('still-there');
      for (const finish of stalledReads.splice(0)) finish();
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('recovers 15 agents twice through a two-connection pool without waiters', async () => {
    let inUse = 0;
    let waiting = 0;
    let peakInUse = 0;
    let peakWaiting = 0;
    const poolWaiters: Array<() => void> = [];
    const query = vi.fn(async () => {
      if (inUse >= 2) {
        waiting++;
        peakWaiting = Math.max(peakWaiting, waiting);
        await new Promise<void>((resolve) => poolWaiters.push(resolve));
        waiting--;
      }
      inUse++;
      peakInUse = Math.max(peakInUse, inUse);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inUse--;
      poolWaiters.shift()?.();
      return { rows: [], rowCount: 0 };
    });
    const database = {
      query,
      transaction: vi.fn(),
      poolCounts: () => ({ total: 2, idle: 2 - inUse, waiting }),
    } as unknown as SqlDatabase;
    const server = createBeelineServer({
      database,
      auth: { authenticateDaemon: vi.fn(async (token: string) => token) } as unknown as TokenAuth,
      phone: {
        canReadRooms: vi.fn(async (roomIds: readonly string[]) => {
          await database.query('SELECT 1');
          return new Set(roomIds);
        }),
      } as unknown as PhoneService,
      daemon: {
        execute: vi.fn(async (name: string) => {
          await database.query('SELECT 1');
          return name === 'getAgentCommands'
            ? { commandProtocol: 1, commands: [] }
            : { items: [] };
        }),
      } as unknown as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    const sockets: WebSocket[] = [];
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      for (let wave = 0; wave < 2; wave++) {
        const waveSockets = Array.from({ length: 15 }, (_, index) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, [
            `bearer.bdt_agent_${index}`,
          ]);
          sockets.push(socket);
          return socket;
        });
        await Promise.all(waveSockets.map(async (socket, index) => {
          await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('error', reject);
          });
          const commands = nextSocketMessage(socket, 'commands');
          socket.send(JSON.stringify({ type: 'subscribe', roomId: `room-${index}` }));
          await commands;
        }));
        await Promise.all(waveSockets.map((socket) => new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.close();
        })));
      }
      expect(peakInUse).toBeLessThanOrEqual(2);
      expect(peakWaiting).toBe(0);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect((await health.json()).database.pool.waiting).toBe(0);
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

function expectNoSocketMessageOfType(
  socket: WebSocket,
  type: string,
  durationMs = 25,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== type) return;
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
