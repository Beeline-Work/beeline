import { phoneFetch, AddressInfo, WebSocket, describe, expect, it, vi, PostgresDatabase, LiveHub, createBeelineServer, databaseConnectionBudget, canReadRoomsFrom, nextSocketMessage, fixtureScope1, fixtureScope2, type Pool, type SqlDatabase, type TokenAuth, type PhoneService, type DaemonService } from './test-support-server.test-support.js';

describe('server readiness', () => {
const scope1 = fixtureScope1();


  it('requires explicit authenticated operator scope for vendor refresh', async () => {
    const query = vi.fn(), transaction = vi.fn();
    const options = { dashboardSecret: 'fixture-dashboard-secret' };
    const denied = await scope1.get('/v1/admin/dashboard/refresh', { query, transaction }, options,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'finances' }) });
    expect(denied.status).toBe(403);
    for (const input of [{ scope: 'all' }, { scope: 'finances', force: true }]) {
      const invalid = await scope1.get('/v1/admin/dashboard/refresh', { query, transaction }, options,
        { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-dashboard-secret' }, body: JSON.stringify(input) });
      expect(invalid.status).toBe(400);
    }
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });


  it('Reproduction RETURN-1: retains a visible verifier return when the app handoff is blocked', async () => {
    const query = vi.fn(), transaction = vi.fn();
    const response = await scope1.get('/v1/apps/oauth/verify?session_uri=session-fixture',
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
    const start = await scope1.get(`/v1/apps/oauth/start?${new URLSearchParams({ authorization, return: webAppOrigins[0] })}`,
      { query: vi.fn(), transaction: vi.fn() }, { webAppOrigins }, { redirect: 'manual' });
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toBe(authorization);
    const cookie = start.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const session = 'https://backend.composio.dev/session/one?a=1&b=2';
    const verify = await scope1.get(`/v1/apps/oauth/verify?${new URLSearchParams({ session_uri: session })}`,
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
    const response = await scope1.get('/v1/apps/oauth/verify?session_uri=session-fixture',
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
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const response = await scope1.get(`/v1/apps/oauth/start?${new URLSearchParams({ authorization, return: returnOrigin })}`,
      { query, transaction: vi.fn() }, { webAppOrigins: ['https://web.beeline.test'] }, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    if (_label !== 'a non-provider sign-in link') expect(query).not.toHaveBeenCalled();
  });


  it.each([
    ['https://signin.example.test/start', 302, true],
    ['http://signin.example.test/start', 400, false],
    ['https://user:password@signin.example.test/start', 400, false],
  ])('validates a stored machine sign-in URL before redirecting: %s', async (authorization, status, reads) => {
    const query = vi.fn(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
    const response = await scope1.get(`/v1/apps/oauth/start?${new URLSearchParams({ authorization, return: 'https://web.beeline.test' })}`,
      { query, transaction: vi.fn() }, { webAppOrigins: ['https://web.beeline.test'] }, { redirect: 'manual' });
    expect(response.status).toBe(status);
    expect(response.headers.get('location')).toBe(status === 302 ? authorization : null);
    expect(query.mock.calls.length > 0).toBe(reads);
  });


  it('keeps an untrusted verifier session encoded in the return link', async () => {
    const session = 'https://provider.test/session?a=1&b="</script><script>alert(1)</script>\'';
    const response = await scope1.get(`/v1/apps/oauth/verify?${new URLSearchParams({ session_uri: session })}`,
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
    const response = await scope1.get(`/v1/apps/oauth/verify?${new URLSearchParams({ session_uri: session })}`,
      { query: vi.fn(), transaction: vi.fn() });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid app sign-in session' });
  });


  it('retires the first-party Google callback route', async () => {
    const response = await scope1.get('/v1/google/oauth/callback?state=attempt&code=grant',
      { query: vi.fn(), transaction: vi.fn() }, {}, { redirect: 'manual' });
    expect(response.status).toBe(404);
  });


  it('returns the known readiness verdict without observing the database', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const response = await scope1.get('/readyz', { query, transaction: vi.fn() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(query).not.toHaveBeenCalled();
  });


  it('reports app pool pressure and the oldest active app query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const oldestActiveQueryAgeMs = vi.fn().mockResolvedValue(12_345);
    const response = await scope1.get('/health', {
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
    const response = await scope1.get('/health', {
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
    const response = await scope1.get('/health', pool(5, 1, 2), {
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
    const response = await scope1.get('/health', app, { databasePools: { app, jobs } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.database.pool).toEqual({ size: 2, inUse: 1, waiting: 0 });
    expect(body.database.pools).toEqual({
      app: { size: 2, inUse: 1, waiting: 0, telemetry: app.poolTelemetry() },
      jobs: { size: 1, inUse: 1, waiting: 2, telemetry: null },
    });
  });


  it('reports the age of an app transaction holding a connection', async () => {
    const response = await scope1.get('/health', {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), transaction: vi.fn(),
      oldestActiveTransactionAgeMs: () => 42,
    });
    expect((await response.json()).database).toMatchObject({
      oldestActiveTransactionAgeMs: 42,
    });
  });


  it('returns 503 for a known unavailable dependency without a database probe', async () => {
    const query=vi.fn().mockRejectedValue(new Error('must not probe'));
    const response=await scope1.get('/readyz',{query,transaction:vi.fn()},{readiness:()=>false});
    expect(response.status).toBe(503);expect(await response.json()).toEqual({ok:false});
    expect(query).not.toHaveBeenCalled();
  });


  it('survives an injected pool checkout timeout and serves the next request', async () => {
    const timeout = new Error('timeout exceeded when trying to connect');
    const connect = vi.fn()
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
    const database = new PostgresDatabase('', 5, { pool });
    const server = createBeelineServer({
      database,
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    scope1.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;

    const failed = await phoneFetch(url);
    expect(failed.status).toBe(503);
    expect(connect).toHaveBeenCalledOnce();
    const recovered = await phoneFetch(url);
    expect(recovered.status).toBe(200);
  });


  it('reports the release identity baked into the deployed image', async () => {
    vi.stubEnv('BEELINE_RELEASE_VERSION', 'v1.2.3');
    vi.stubEnv('BEELINE_RELEASE_SHA', '0123456789abcdef0123456789abcdef01234567');

    const response = await scope1.get('/version', {
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
      live: Object.assign(new LiveHub(), { publish }),
      mediaMaximumBytes: 1,
    });
    scope1.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await phoneFetch(`http://127.0.0.1:${port}/v1/phone/operations/sendRoomMessage`, {
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


  it.each(['readRoomTools', 'readMediaMetadata', 'readMediaLink', 'readMediaPlayback'])(
    'keeps selected read operation %s on the socket', async operation => {
      const query = vi.fn(), transaction = vi.fn(), execute = vi.fn();
      const response = await scope1.get(`/v1/phone/operations/${operation}`, { query, transaction }, {
        auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
        phone: { execute } as unknown as PhoneService,
      }, { method: 'POST', headers: { authorization: `Bearer ${'p'.repeat(20)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ objectId: '11111111-1111-4111-8111-111111111111' }) });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'phone_socket_required' });
      expect(execute).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    });


  it('publishes no Room invalidation when opening a Room clears its dismissal', async () => {
    const publish = vi.fn();
    const execute = vi.fn().mockResolvedValue(undefined);
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: { execute } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: Object.assign(new LiveHub(), { publish }),
      mediaMaximumBytes: 1,
    });
    scope1.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await phoneFetch(`http://127.0.0.1:${port}/v1/phone/operations/reopenChat`, {
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
        live: Object.assign(new LiveHub(), { publish }),
        mediaMaximumBytes: 1,
      });
      scope1.servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;

      // An open corner rereads its workflow runs on every Room invalidation;
      // a read that published one made that reread loop without end.
      const response = await phoneFetch(`http://127.0.0.1:${port}/v1/phone/operations/${operation}`, {
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
      live: new LiveHub(),
      mediaMaximumBytes: 1,
      webAppOrigins: ['https://web.beeline.test'],
    });
    scope1.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const path = `http://127.0.0.1:${port}/v1/phone/rooms/22222222-2222-4222-8222-222222222222`;

    const preflight = await phoneFetch(path, {
      method: 'OPTIONS',
      headers: { origin: 'https://web.beeline.test', 'access-control-request-headers': 'x-beeline-view' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-beeline-view');

    const read = await phoneFetch(path, {
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
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    scope1.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await phoneFetch(`http://127.0.0.1:${port}/v1/releases/daemon-readiness`);

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
      live: new LiveHub(),
      mediaMaximumBytes: 1,
      releaseNotify: { secret: 'correct-horse', notifyReleaseDelivered } as never,
    });
    scope1.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({
      version: 'v0.0.42',
      sha: 'a'.repeat(40),
      changelogUrl: 'https://x.test',
    });

    const noAuth = await phoneFetch(`http://127.0.0.1:${port}/v1/releases/notify`, {
      method: 'POST',
      body,
    });
    expect(noAuth.status).toBe(403);

    const wrongSecret = await phoneFetch(`http://127.0.0.1:${port}/v1/releases/notify`, {
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
      live: new LiveHub(),
      mediaMaximumBytes: 1,
      releaseNotify: { secret: 'correct-horse', notifyReleaseDelivered } as never,
    });
    scope1.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await phoneFetch(`http://127.0.0.1:${port}/v1/releases/notify`, {
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
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    scope1.servers.push(unconfigured);
    await new Promise<void>((resolve) => unconfigured.listen(0, '127.0.0.1', resolve));
    const unconfiguredPort = (unconfigured.address() as AddressInfo).port;
    const refused = await phoneFetch(`http://127.0.0.1:${unconfiguredPort}/v1/releases/notify`, {
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
const scope2 = fixtureScope2();


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
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    scope2.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', roomId: 'room-live' }));
    await vi.waitFor(async () => {
      const health = await phoneFetch(`http://127.0.0.1:${port}/health`);
      expect((await health.json()).live.errors.database).toBe(1);
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const response = await phoneFetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
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
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    scope2.sockets.push(socket);
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
      connectionPresence: { announce, renewLease: async () => {} } as never,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    scope2.sockets.push(socket);
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
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    scope2.sockets.push(socket);
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
    // A broad table hint carries no message-owned context and cannot admit a read.
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);
    const messageTrace = { id: 'trace-message', databaseAt: 50, emittedAt: 75 };
    const replayed = nextSocketMessage(socket, 'inbox');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:messages',
      messageId: 'actual-committed-message',
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
});
