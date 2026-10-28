import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
import { LinkAgentWallet } from './link-agent-wallet.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { McpRegistryClient } from './mcp-registry.js';
import { CompanyMcpDiscovery } from './company-mcp-discovery.js';
import { applyVaultList } from './workbench.js';
import { recordSquireSignIn } from './squire-machine.js';
import { beginComposioAppSignIn, connectApp, readOwnerApps, resolveAppRoute, type AppRouteProbes } from './app-connections.js';
import { APP_FILE_MAXIMUM_BYTES, ComposioApps } from './composio-apps.js';
import { ObjectService } from './object-service.js';
import type { ObjectStorage } from './object-storage.js';
import { readRoomViewMessage } from '@beeline/api-contract/phone';
import type { AddressInfo } from 'node:net';
import type { TokenAuth } from './auth.js';
import { createBeelineServer } from './server.js';
import { captureServerError } from './sentry.js';

vi.mock('./sentry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sentry.js')>(),
  captureServerError: vi.fn(),
}));

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '44444444-4444-4444-8444-444444444444';
const OWNER = 'a'.repeat(64);
const HELPER = 'b'.repeat(64);
const COMMAND = 'app-connect-command';
const REQUEST = 'app-connect-request';
const GENERATION = 'app-connect-generation';

const turn = { roomId: ROOM, requestId: REQUEST, generationId: GENERATION };

const linearServer = {
  name: 'app.linear/linear',
  version: '1.0.1',
  title: 'Linear',
  websiteUrl: 'https://linear.app',
  remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
  packages: [],
};

/** A Registry that answers from a fixed table, and counts what it was asked. */
function fakeRegistry(servers: Record<string, unknown>[], fail = false) {
  const transport = vi.fn(async (url: URL | string) => {
    if (fail) return new Response('down', { status: 503 });
    const parsed = new URL(String(url));
    if (parsed.pathname === '/v0.1/servers') {
      const term = parsed.searchParams.get('search') ?? '';
      return Response.json({
        servers: servers
          .filter((server) => String(server.name).includes(term))
          .map((server) => ({ server })),
      });
    }
    const match = /^\/v0\.1\/servers\/(.+)\/versions\/(.+)$/.exec(parsed.pathname);
    const server = servers.find(
      (entry) =>
        match &&
        entry.name === decodeURIComponent(match[1]!) &&
        entry.version === decodeURIComponent(match[2]!),
    );
    return server ? Response.json({ server }) : new Response('missing', { status: 404 });
  });
  return { client: new McpRegistryClient(transport as unknown as typeof fetch, undefined, new CompanyMcpDiscovery(async () => ({ status: 404, body: '' }))), transport };
}

describe('the app route order', () => {
  const probes = (overrides: Partial<AppRouteProbes> = {}) => {
    const workbench = vi.fn(async () => undefined);
    const composio = vi.fn(async () => 'none' as const);
    return { workbench, composio, ...overrides } as AppRouteProbes & {
      workbench: ReturnType<typeof vi.fn>;
      composio: ReturnType<typeof vi.fn>;
    };
  };

  it('reuses a connected Workbench connection before probing OAuth', async () => {
    const p = probes({
      workbench: vi.fn(
        async () => ({ transport: 'squire-api', reference: 'vault:resend' }) as const,
      ),
    });
    const decision = await resolveAppRoute({ reconnect: false, noApi: false }, p);
    expect(decision).toMatchObject({ kind: 'route', route: 'workbench', transport: 'squire-api' });
    expect(p.composio).not.toHaveBeenCalled();
  });

  it('uses managed OAuth when supported and never probes another path', async () => {
    const p = probes({ composio: vi.fn(async () => 'supported' as const) });
    await expect(resolveAppRoute({ reconnect: false, noApi: false }, p))
      .resolves.toMatchObject({ kind: 'route', route: 'composio', transport: 'composio' });
  });

  it('fails closed when OAuth support cannot be checked', async () => {
    const p = probes({ composio: vi.fn(async () => 'unavailable' as const) });
    await expect(resolveAppRoute({ reconnect: false, noApi: false }, p))
      .resolves.toMatchObject({ kind: 'unavailable' });
  });

  it('fails closed when the server has no OAuth provider configured', async () => {
    await expect(resolveAppRoute({ reconnect: false, noApi: false }, {
      workbench: async () => undefined,
    })).resolves.toMatchObject({ kind: 'unavailable' });
  });

  it('reports an app withheld from managed OAuth as not available, not as a Squire route', async () => {
    await expect(resolveAppRoute({ reconnect: false, noApi: false },
      probes({ composio: vi.fn(async () => 'withheld' as const) }))).resolves.toEqual({
      kind: 'unavailable', reason: 'This app is not available to connect yet.' });
  });

  it('uses Squire only when managed OAuth is unsupported', async () => {
    await expect(
      resolveAppRoute({ reconnect: false, noApi: false }, probes()),
    ).resolves.toMatchObject({ kind: 'route', route: 'squire-api', transport: 'squire-api' });
  });

  it('lets a person explicitly select an alternative only for a new connection', async () => {
    const p = probes({ composio: vi.fn(async () => 'supported' as const) });
    await expect(resolveAppRoute({ reconnect: false, noApi: false,
      preferredRoute: 'squire-api' }, p)).resolves.toMatchObject({ transport: 'squire-api' });
    expect(p.composio).not.toHaveBeenCalled();
    await expect(resolveAppRoute({ existing: { transport: 'squire-api', state: 'active',
      hasCredential: true }, reconnect: false, noApi: false, preferredRoute: 'composio' }, p))
      .resolves.toEqual({ kind: 'keep', transport: 'squire-api' });
    expect(p.composio).not.toHaveBeenCalled();
  });




  it('keeps an existing route — even in error — until an explicit reconnect', async () => {
    const existing = { transport: 'registry-mcp', state: 'active', hasCredential: false } as const;
    const p = probes();
    await expect(resolveAppRoute({ existing, reconnect: false, noApi: false }, p)).resolves.toEqual(
      { kind: 'keep', transport: 'registry-mcp' },
    );
    expect(p.workbench).not.toHaveBeenCalled();
    expect(p.composio).not.toHaveBeenCalled();
    // noApi cannot move a retained legacy route to the browser.
    await expect(
      resolveAppRoute({ existing, reconnect: false, noApi: true }, p),
    ).resolves.toMatchObject({ kind: 'keep', transport: 'registry-mcp' });
    // A retry keeps the person's existing route too. Priority applies only
    // to a new connection, even if another route is now available.
    await expect(
      resolveAppRoute({ existing, reconnect: true, noApi: false }, p),
    ).resolves.toEqual({ kind: 'keep', transport: 'registry-mcp' });
    expect(p.workbench).not.toHaveBeenCalled();
  });

  it('reaches the browser only from the API route, on the fact of no API', async () => {
    const api = { transport: 'squire-api', state: 'active', hasCredential: false } as const;
    await expect(
      resolveAppRoute({ existing: api, reconnect: false, noApi: true }, probes()),
    ).resolves.toMatchObject({ kind: 'route', route: 'squire-browser' });
    await expect(
      resolveAppRoute(
        { existing: { ...api, hasCredential: true }, reconnect: false, noApi: true },
        probes(),
      ),
    ).resolves.toMatchObject({ kind: 'keep', transport: 'squire-api' });
  });
});

describe('connect_app', () => {
  let database: PgliteDatabase;

  const daemonWith = (registry: McpRegistryClient, composio: ComposioApps = {
    supportsOAuth: async () => false,
  } as ComposioApps, objects?: ObjectService, linkWallet?: LinkAgentWallet) =>
    new DaemonService(
      database,
      new LiveHub(),
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { enabled: false },
      registry,
      undefined,
      composio,
      undefined,
      objects,
      linkWallet,
    );

  function fakeComposio(completedToolkit = 'slack') {
    let active = false;
    const provider = {
      supportsOAuth: vi.fn(async (toolkit: string) => ['slack', 'gmail'].includes(toolkit)),
      toolkit: vi.fn(async (toolkit: string) => ({ slug: toolkit,
        description: `Use ${toolkit} tools.`, logo: `https://cdn.composio.dev/${toolkit}.png` })),
      link: vi.fn(async (_person: string, _toolkit: string) => ({
        url: 'https://app.composio.dev/connect/fixture', accountId: 'ca_fixture',
        expiresAt: new Date(Date.now() + 600_000),
      })),
      account: vi.fn(async (_account: string, person: string) => active && person === OWNER),
      accountStatus: vi.fn(async (_account: string, person: string) => ({
        status: active && person === OWNER ? 'active' as const : 'pending' as const,
      })),
      completeAuth: vi.fn(async (_session: string, person: string) => {
        if (person !== OWNER) throw new Error('App provider request failed (400)');
        active = true;
        return { accountId: 'ca_fixture', toolkit: completedToolkit };
      }),
      listTools: vi.fn(async () => [{ slug: 'SLACK_POST_MESSAGE', name: 'Post message',
        description: 'Post to a channel', inputParameters: {} }]),
      execute: vi.fn(async () => ({ ok: true })),
      deleteAccount: vi.fn(async () => { active = false; }),
    };
    return provider as typeof provider & ComposioApps;
  }

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle)
       VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
      [OWNER, HELPER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,machine_id,machine_name,yolo_mode)
       VALUES($1,$2,'machine-one','Owner laptop',false)`,
      [HELPER, OWNER],
    );
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Tools')`,
      [ROOM, WORKSPACE, OWNER],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
             ($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, OWNER, HELPER, ROOM],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('app-source',$1,$2,'Connect Linear')`,
      [ROOM, OWNER],
    );
    await database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at
       ) VALUES($1,$2,$3,'app-source',$4,'input','human_tag',$1,'app-source',0,
         'claimed',$5,now()+interval '10 minutes')`,
      [COMMAND, ROOM, HELPER, REQUEST, GENERATION],
    );
  });

  afterEach(async () => database.close());

  async function connectSquire(): Promise<string> {
    await database.query(`UPDATE agents SET squire_report=$2::jsonb WHERE agent_id=$1`,
      [HELPER, JSON.stringify({ status: 'connected', reportedAt: Date.now() / 1000 })]);
    return 'squire:machine-one';
  }

  const routes = async () =>
    (
      await database.query<{ route: string; transport: string }>(
        `SELECT route,transport FROM workspace_app_routes ORDER BY created_at, id`,
      )
    ).rows;

  it('distinguishes automatic GitHub discovery from the owner selecting that same connection', async () => {
    await connectSquire();
    await applyVaultList(database,
      { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
        reference: 'vault:github', service: 'github', label: 'Existing key',
        fieldNames: ['access_token'], allowedHosts: ['api.github.com'],
        createdAt: 1, stale: false, state: 'active',
      }]);
    const registry = fakeRegistry([]);
    const provider = fakeComposio();
    const daemon = daemonWith(registry.client, provider);
    const discovered = await daemon.execute('connectApp', { ...turn, app: 'GitHub', reason: 'read an issue' }, HELPER);
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: discovered.appId,
        selectedByOwner: false, connectionReference: 'vault:github' }));
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client, provider);
    await phone.execute('connectWorkbenchApp', { app: 'GitHub', helperAgentId: HELPER,
      preferredRoute: 'squire-api' }, OWNER);
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: discovered.appId,
        selectedByOwner: true, connectionReference: 'vault:github' }));
    await phone.execute('disconnectWorkbenchApp', {
      workspaceId: WORKSPACE, appId: discovered.appId!,
    }, OWNER);
    const rediscovered = await daemon.execute('connectApp', {
      ...turn, app: 'GitHub', reason: 'read another issue',
    }, HELPER);
    expect(rediscovered.appId).toBe(discovered.appId);
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: discovered.appId,
        selectedByOwner: false, connectionReference: 'vault:github' }));
    await phone.execute('connectWorkbenchApp', { app: 'GitHub', helperAgentId: HELPER,
      preferredRoute: 'squire-api' }, OWNER);
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: discovered.appId,
        selectedByOwner: true, connectionReference: 'vault:github' }));
  });

  it('Reproduction link-route-1: Link signs in with a card and resumes the original request', async () => {
    await connectSquire();
    const transport = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/auth/token')
      ? Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh',
        expires_in: 3600, scope: 'payment_methods.agentic userinfo:read' })
      : Response.json({ address: { country: 'US' } })) as unknown as typeof fetch;
    const wallet = new LinkAgentWallet(database, 'fixture-client', 'fixture-secret', 'pk_test_fixture',
      'https://server.usebeeline.app', randomBytes(32).toString('base64'), transport);
    const registry = fakeRegistry([]);
    registry.client.catalog = vi.fn(async () => []);
    const provider = fakeComposio();
    const daemon = daemonWith(registry.client, provider, undefined, wallet);
    const discovery = await daemon.execute('findConnectors', { roomId: ROOM, query: 'add a card' }, HELPER);
    expect(discovery.matches[0]).toMatchObject({ key: 'link', status: 'not-connected' });
    const named = await daemon.execute('findConnectors', { roomId: ROOM, query: 'Stripe Link' }, HELPER);
    expect(named.matches[0]).toMatchObject({ key: 'link' });
    expect(registry.client.catalog).toHaveBeenCalledTimes(1);
    for (const app of ['Stripe Link (link.com)', 'Link', 'Stripe Link', 'link.com']) {
      const result = await daemon.execute('connect', { ...turn, service: app, reason: 'Add a payment card' }, HELPER);
      expect(result).toMatchObject({ appKey: 'link', app: 'Link', status: 'needs_sign_in' });
      expect(result.next).not.toMatch(/store_credential|operate_|API key/);
    }
    const cards = await database.query<{ card: { appId: string; appKey: string; commandId: string } }>(
      `SELECT card FROM messages WHERE card_type='app-sign-in'`);
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]!.card).toMatchObject({ appKey: 'link', commandId: COMMAND });
    expect(registry.transport).not.toHaveBeenCalled();
    expect(provider.supportsOAuth).not.toHaveBeenCalled();
    const phone = new PhoneService(database, 'https://server.usebeeline.app', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client, provider, wallet);
    const signIn = await phone.execute('beginAppSignIn', { appId: cards.rows[0]!.card.appId }, OWNER);
    const authorization = new URL(signIn.authorizationUrl);
    expect(authorization.origin).toBe('https://login.link.com');
    await wallet.complete(authorization.searchParams.get('state')!, 'fixture-code');
    const settled = await database.query<{ card: { status: string } }>(
      `SELECT card FROM messages WHERE card_type='app-sign-in'`);
    expect(settled.rows[0]!.card.status).toBe('connected');
    const resumed = await database.query(`SELECT id FROM agent_commands WHERE reason='app_connected'`);
    expect(resumed.rows).toHaveLength(1);
    expect(await daemon.execute('connect', { ...turn, service: 'Link', reason: 'Add a payment card' }, HELPER))
      .toMatchObject({ status: 'ready', appKey: 'link' });
    expect(await daemon.execute('connectApp', { ...turn, app: 'Link', reason: 'Add a payment card' }, HELPER))
      .toMatchObject({ status: 'connected', appKey: 'link' });
    expect((await database.query(`SELECT id FROM messages WHERE card_type='app-sign-in'`)).rows).toHaveLength(1);
    expect(await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER))
      .toMatchObject({ firstPartyIntegrations: [{ key: 'link', status: 'connected' }] });
    console.info('Reproduction link-route-1: Stripe Link -> one Link sign-in card -> login.link.com -> verified callback -> request resumed -> Link ready with no new card');
  });

  it('Reproduction first-party-connect-card: built-in apps are ready without grants or cards', async () => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([]).client);
    for (const service of ['beeline:corner_app', 'beeline:workflow', 'beeline:browser_share',
      'beeline corner app', 'beelinecornerapp', 'corner_app']) {
      expect(await daemon.execute('connect', { ...turn, service, reason: 'Use built-in app',
        squireAvailable: true }, HELPER)).toMatchObject({ status: 'ready', next: expect.stringContaining('app_tool') });
    }
    expect((await database.query('SELECT id FROM agent_grants')).rows).toHaveLength(0);
    expect((await database.query(`SELECT id FROM messages WHERE card_type IN
      ('grant-request','app-sign-in','connector-offer')`)).rows).toHaveLength(0);
  });

  it('connect posts a Composio sign-in card without issuing an agent sign-in URL', async () => {
    const provider = fakeComposio();
    const result = await daemonWith(fakeRegistry([]).client, provider).execute('connect',
      { ...turn, service: 'Slack', reason: 'Send the message' }, HELPER);
    expect(result).toMatchObject({ status: 'needs_sign_in', transport: 'composio' });
    expect(result).not.toHaveProperty('authorizationUrl');
    expect((await database.query(`SELECT id FROM messages WHERE card_type='app-sign-in'`)).rows).toHaveLength(1);
    expect(provider.link).not.toHaveBeenCalled();
  });

  it('Reproduction registry-down-1: a Registry outage still routes GitHub to its managed sign-in', async () => {
    const registry = fakeRegistry([], true);
    const provider = fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'github');
    const result = await daemonWith(registry.client, provider).execute('connect',
      { ...turn, service: 'GitHub', reason: 'Read issues' }, HELPER);
    expect(registry.transport).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'needs_sign_in', transport: 'composio' });
    expect(result.next).not.toContain('Registry could not be checked');
  });

  it.each(['link my repository', 'GitHub'])('R-REPO-CARD: %s bypasses a Registry outage for repository linking', async service => {
    const registry = fakeRegistry([], true);
    const result = await daemonWith(registry.client, fakeComposio()).execute('connect',
      { ...turn, service, reason: `Connect ${service}`, continuation: `Connect my ${service} account.` }, HELPER);
    expect(result).toMatchObject({ status: 'ready', app: 'beeline:onboarding' });
    expect(registry.transport).not.toHaveBeenCalled();
  });

  it('connect installs a no-sign-in Registry remote to ready with no owner card', async () => {
    const registry = fakeRegistry([{ ...linearServer, name: 'org.example/echo', title: 'Echo', websiteUrl: 'https://echo.test' }]);
    const daemon = daemonWith(registry.client);
    const connection = daemon.execute('connect', { ...turn, service: 'org.example/echo', reason: 'Use Echo' }, HELPER);
    let connectorId = '';
    await vi.waitFor(async () => {
      const row = (await database.query<{ id: string }>(`SELECT id FROM workspace_connectors WHERE connector_type='registry-mcp'`)).rows[0];
      expect(row).toBeDefined(); connectorId = row!.id;
    });
    await daemon.execute('installConnector', { agentId: HELPER, connectorId }, HELPER);
    expect(await connection).toMatchObject({ status: 'ready', transport: 'registry-mcp' });
    expect((await database.query(`SELECT id FROM messages WHERE card_type IN ('app-sign-in','connector-offer','agent-grant')`)).rows).toHaveLength(0);
  });

  it('Reproduction R1: the owner’s agent connects GitHub without a permission card', async () => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([]).client);
    const server = createBeelineServer({ database, phone: new PhoneService(database, 'http://placeholder'),
      daemon, live: new LiveHub(), mediaMaximumBytes: 1,
      auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/daemon/operations/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bdt_fixture-token-0001' },
        body: JSON.stringify({ ...turn, service: 'GitHub', reason: 'Read repository issues', squireAvailable: true }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'needs_squire', appKey: 'github' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    expect((await database.query(`SELECT status,auto FROM agent_grants WHERE target='connection-install:github'`)).rows)
      .toEqual([{ status: 'approved', auto: true }]);
    expect((await database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows).toHaveLength(0);
  });

  it.each([true, false])('Reproduction R1 / squire-connect-1: connect hands Squire setup to the agent (browser=%s)', async noApi => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'resend.com', reason: 'Send email', noApi, squireAvailable: true };
    const ask = await daemon.execute('connect', input, HELPER);
    expect(ask.status).toBe('needs_squire');
    expect((await database.query(`SELECT status,auto FROM agent_grants WHERE target='connection-install:resend'`)).rows)
      .toEqual([{ status: 'approved', auto: true }]);
    expect((await database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows).toHaveLength(0);
    const result = await daemon.execute('connect', input, HELPER);
    expect(result).toMatchObject({ status: 'needs_squire',
      transport: noApi ? 'squire-browser' : 'squire-api', squire: { url: 'https://resend.com' } });
    expect(result.squire?.goal).toContain('vault as service resend');
    expect(result.next).toContain('same session');
    expect(result.next).toContain('low_confidence');
    const assigned = await daemon.execute('getConnectorAssignments', { agentId: HELPER }, HELPER);
    expect(assigned.assignments).not.toContainEqual(expect.objectContaining({ kind: 'connect-app' }));
    const work = (await database.query<{ squire_work: Record<string, unknown> }>(
      'SELECT squire_work FROM agents WHERE agent_id=$1', [HELPER])).rows[0]!.squire_work;
    expect(work.appConnections).toBeUndefined();
    await applyVaultList(database,
      { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
        reference: 'vault:resend', service: 'resend', label: 'Resend',
        fieldNames: noApi ? ['login', 'password'] : ['api_key'],
        allowedHosts: ['resend.com'], createdAt: 1, stale: false, state: 'active' }]);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'ready' });
    // Readiness is the vault credential, even when no Squire tools are mounted.
    await database.query(`UPDATE agents SET squire_report=$2::jsonb WHERE agent_id=$1`,
      [HELPER, JSON.stringify({ status: 'error', reportedAt: Date.now() / 1000 })]);
    expect(await daemon.execute('connect', { ...input, squireAvailable: false }, HELPER))
      .toMatchObject({ status: 'ready' });
    console.info(`Reproduction squire-connect-1: connect -> quiet approved consent -> agent URL/goal (${noApi ? 'browser' : 'API'}) -> no helper job -> vault credential -> ready`);
  });

  it('R1: own-account installation stays approved after boot when someone else requested the work', async () => {
    const requester = 'e'.repeat(64);
    await connectSquire();
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Requester')`, [requester]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WORKSPACE, requester, ROOM]);
    await database.query(`UPDATE messages SET author_id=$1 WHERE id='app-source'`, [requester]);
    const result = await daemonWith(fakeRegistry([]).client).execute('connect', {
      ...turn, service: 'GitHub', reason: 'Read repository issues', squireAvailable: true,
    }, HELPER);
    expect(result.status).toBe('needs_squire');
    await migrate(database);
    expect((await database.query(`SELECT status,auto,requested_by FROM agent_grants WHERE target='connection-install:github'`)).rows)
      .toEqual([{ status: 'approved', auto: true, requested_by: requester }]);
    expect((await database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows).toHaveLength(0);
  });

  it('Reproduction SENTRY-ACCESS: reconnect requests owner repair instead of returning the existing key', async () => {
    await connectSquire();
    await applyVaultList(database,
      { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
        reference: 'vault:sentry-old', service: 'sentry', label: 'default',
        fieldNames: ['api_key'], allowedHosts: ['sentry.io'],
        createdAt: 1, stale: true, state: 'active',
      }]);
    const daemon = daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'sentry', reason: 'Read Beeline issues', squireAvailable: true };
    expect(await daemon.execute('connect', input, HELPER))
      .toMatchObject({ status: 'ready', connectionReference: 'vault:sentry-old' });
    const reconnect = { ...input, reconnect: true };
    const ask = await daemon.execute('connect', reconnect, HELPER);
    expect(ask.status).toBe('needs_squire');
    expect(ask).not.toHaveProperty('connectionReference');
    const repair = await daemon.execute('connect', reconnect, HELPER);
    expect(repair).toMatchObject({ status: 'needs_squire', transport: 'squire-api' });
    expect(repair).not.toHaveProperty('connectionReference');
    expect(repair.squire?.goal).toContain('Repair the existing');
    expect(repair.squire?.goal).toContain('do not select an alternative credential');
    expect(await daemon.execute('connect', { ...reconnect, squireAvailable: false }, HELPER))
      .toMatchObject({ status: 'unavailable' });
    console.info('Reproduction SENTRY-ACCESS stand-in: existing key -> reconnect -> quiet consent -> same-route repair goal, with no old credential returned; live organization issue access still requires owner reauthorization.');
  });

  it('connect reports unavailable without mounted Squire tools and queues no hidden job', async () => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([]).client);
    for (const squireAvailable of [false, undefined]) {
      const result = await daemon.execute('connect', { ...turn, service: 'resend.com',
        reason: 'Send email', noApi: true, squireAvailable }, HELPER);
      expect(result).toMatchObject({ status: 'unavailable' });
      expect(result.next).toContain('unavailable in this agent session');
      expect(result).not.toHaveProperty('squire');
    }
    expect((await database.query(`SELECT id FROM agent_grants WHERE target='connection-install:resend'`)).rows).toHaveLength(0);
  });

  it('R1: a foreign app account still asks its owner and stores the app display name', async () => {
    const foreign = 'd'.repeat(64);
    const appId = '88888888-8888-4888-8888-888888888888';
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Alex')`, [foreign]);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [WORKSPACE, foreign]);
    await database.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
      VALUES($1,$2,$3,'github','GitHub','squire-api','squire-api')`, [appId, WORKSPACE, foreign]);
    const result = await daemonWith(fakeRegistry([]).client).execute('requestAgentGrant', {
      ...turn, kind: 'mcp', target: 'connection-install:github', appId, purpose: 'Connect GitHub to complete the requested task', reason: 'Connect GitHub',
    }, HELPER);
    expect(result).toMatchObject({ status: 'pending', auto: false });
    await database.query('UPDATE agent_grants SET command_id=$2 WHERE id=$1', [result.grantId, COMMAND]);
    const messages = (await database.query<{ text: string; card: { owner: { pubkey: string }; grants: { appName: string }[] } }>(
      `SELECT text,card FROM messages WHERE card_type='grant-request'`)).rows;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('@bee wants to connect GitHub');
    expect(messages[0]!.text).not.toContain('connection-install:');
    expect(messages[0]!.card.owner.pubkey).toBe(foreign);
    expect(messages[0]!.card.grants[0]!.appName).toBe('GitHub');
    const phone = new PhoneService(database, 'http://placeholder');
    await expect(phone.execute('decideAgentGrant', {
      grantId: result.grantId, decision: 'always',
    }, OWNER)).rejects.toThrow('requires the connected person');
    await phone.execute('decideAgentGrant', { grantId: result.grantId, decision: 'always' }, foreign);
    await migrate(database);
    expect((await database.query('SELECT status,decided_by FROM agent_grants WHERE id=$1', [result.grantId])).rows)
      .toEqual([{ status: 'approved', decided_by: foreign }]);
  });

  it.each(['denied', 'once'])('R1: owner setup replaces legacy %s consent with quiet standing consent', async status => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'resend.com', reason: 'Send email', noApi: true, squireAvailable: true };
    await daemon.execute('connect', input, HELPER);
    const grant = (await database.query<{ id: string }>(`SELECT id FROM agent_grants WHERE target='connection-install:resend'`)).rows[0]!;
    await database.query(`UPDATE agent_grants SET status=$3,auto=false,decided_by=$2 WHERE id=$1`, [grant.id, OWNER, status]);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    expect((await database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows).toHaveLength(0);
  });

  it('Reproduction squire-session-1: a signed-in Squire session makes a browser app ready without a vault login', async () => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'resend.com', reason: 'Send email', noApi: true, squireAvailable: true };
    await daemon.execute('connect', input, HELPER);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    // The agent's own Squire session showed the app signed in; no vault login exists.
    const signedIn = await daemon.execute('connect', { ...input,
      signedInUrl: 'https://app.resend.com/emails', squireSignedIn: true }, HELPER);
    expect(signedIn).toMatchObject({ status: 'ready', transport: 'squire-browser' });
    expect(signedIn).not.toHaveProperty('squire');
    expect((await database.query(`SELECT 1 FROM workspace_connections`)).rows).toHaveLength(0);
    // The signed-in session remains ready after the old consent is revoked.
    await database.query(`UPDATE agent_grants SET status='revoked' WHERE target='connection-install:resend'`);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'ready' });
    const work = (await database.query<{ squire_work: { signedInApps?: Record<string, unknown> } }>(
      'SELECT squire_work FROM agents WHERE agent_id=$1', [HELPER])).rows[0]!.squire_work;
    expect(Object.keys(work.signedInApps ?? {})).toEqual(['resend']);
    expect(JSON.stringify(work.signedInApps)).not.toMatch(/cookie|token/i);
    // An OAuth redirect from the app to Google's sign-in page clears the app, not unrelated apps.
    await recordSquireSignIn(database, HELPER, 'linear', 'linear.app');
    await daemon.execute('forgetSquireSignIn', { url: 'https://accounts.google.com/signin',
      siteUrl: 'https://app.resend.com/emails' }, HELPER);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    const after = (await database.query<{ squire_work: { signedInApps?: Record<string, unknown> } }>(
      'SELECT squire_work FROM agents WHERE agent_id=$1', [HELPER])).rows[0]!.squire_work;
    expect(Object.keys(after.signedInApps ?? {})).toEqual(['linear']);
    console.info('Reproduction squire-session-1: signed-in session -> ready; reused; signed-out page -> re-check');
  });

  it('a signed-in session cannot make an API app ready, another site proves nothing, and reconnect re-checks', async () => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([]).client);
    const signed = { signedInUrl: 'https://app.resend.com/emails', squireSignedIn: true };
    const apiInput = { ...turn, service: 'resend.com', reason: 'Send email', squireAvailable: true };
    await daemon.execute('connect', apiInput, HELPER);
    expect(await daemon.execute('connect', { ...apiInput, ...signed }, HELPER))
      .toMatchObject({ status: 'needs_squire', transport: 'squire-api' });
    const input = { ...apiInput, noApi: true };
    for (const signedInUrl of ['https://github.com/settings/profile', 'http://app.resend.com/emails', 'not a url'])
      expect(await daemon.execute('connect', { ...input, signedInUrl, squireSignedIn: true }, HELPER))
        .toMatchObject({ status: 'needs_squire' });
    // The agent's own URL is only a claim until the agent MCP checked it.
    expect(await daemon.execute('connect', { ...input, signedInUrl: signed.signedInUrl }, HELPER))
      .toMatchObject({ status: 'needs_squire' });
    const needs = await daemon.execute('connect', input, HELPER);
    expect(needs.next).toContain('signedInUrl');
    expect(await daemon.execute('connect', { ...input, ...signed }, HELPER)).toMatchObject({ status: 'ready' });
    expect(await daemon.execute('connect', { ...input, reconnect: true }, HELPER)).toMatchObject({ status: 'needs_squire' });
    expect(await daemon.execute('connect', { ...input, ...signed }, HELPER)).toMatchObject({ status: 'ready' });
    // Without mounted Squire tools the session cannot be used, so it is not ready.
    expect(await daemon.execute('connect', { ...input, squireAvailable: false }, HELPER))
      .toMatchObject({ status: 'unavailable' });
  });

  it('installs the official Linear Registry MCP for a new agent connection', async () => {
    const registry = fakeRegistry([linearServer]);
    const provider = fakeComposio();
    const result = await daemonWith(registry.client, provider).execute('connectApp',
      { ...turn, app: 'Linear', reason: 'manage issues' }, HELPER);
    expect(result).toMatchObject({ transport: 'registry-mcp', appKey: 'linear' });
    expect(provider.supportsOAuth).not.toHaveBeenCalled();
    const row = (await database.query<{ registry_server_name: string; status: string }>(
      `SELECT registry_server_name,status FROM workspace_connectors
       WHERE owner_identity_id=$1 AND connector_type='registry-mcp'`, [OWNER],
    )).rows[0];
    expect(row).toEqual({ registry_server_name: 'app.linear/linear', status: 'installing' });
  });

  it('posts one route-neutral Room card and resumes the original request after sign-in', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const continuation = 'I will post the launch notes after sign-in.';
    const first = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes', continuation }, HELPER);
    expect(first).toMatchObject({ status: 'needs_sign_in', route: 'composio',
      transport: 'composio' });
    expect(first).not.toHaveProperty('authorizationUrl');
    expect(await routes()).toEqual([{ route: 'composio', transport: 'composio' }]);
    const card = (await database.query<{ card: { appId: string; status: string;
      continuation?: string } }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM],
    )).rows[0];
    expect(card?.card).toMatchObject({ appId: first.appId, status: 'pending', continuation });
    // The app's https logo is the only provider-hosted value the card may carry.
    const { logo, ...neutral } = card!.card as typeof card.card & { logo?: string };
    expect(logo === undefined || /^https:\/\//.test(logo)).toBe(true);
    expect(JSON.stringify(neutral)).not.toContain('composio');
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    const pendingRoom = await phone.readRoom(ROOM, OWNER);
    expect(pendingRoom?.messages.find((message) => message.appSignIn?.appId === first.appId)
      ?.appSignIn).toMatchObject({ status: 'pending', continuation });
    const opened = await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    expect(opened.authorizationUrl).toBe('https://app.composio.dev/connect/fixture');
    expect(provider.link).toHaveBeenCalledWith(OWNER, 'slack');
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: first.appId! }, OWNER);
    expect(provider.completeAuth).toHaveBeenCalledWith('session-fixture', OWNER);
    expect((await database.query<{ card: { status: string; continuation?: string } }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM],
    )).rows[0]?.card).toMatchObject({ status: 'connected', continuation });
    const connectedRoom = await phone.readRoom(ROOM, OWNER);
    expect(connectedRoom?.messages.find((message) => message.appSignIn?.appId === first.appId)
      ?.appSignIn).toMatchObject({ status: 'connected', continuation });
    expect((await database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND agent_id=$2 AND reason='app_connected'`, [ROOM, HELPER])).rowCount).toBe(1);
    const neverUsed = (await readOwnerApps(database, OWNER, provider))[0]!;
    expect(neverUsed).toMatchObject({
      appId: first.appId, status: 'connected', accountLabel: 'owner',
      workspaceName: 'Hive', useCount: 0,
    });
    expect(neverUsed).not.toHaveProperty('lastUse');
    expect(neverUsed).not.toHaveProperty('lastUsedAt');
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: first.appId, appKey: 'slack' }));
    expect((await daemon.execute('listAppTools', { ...turn, appId: first.appId! }, HELPER)).tools)
      .toHaveLength(1);
    const used = await daemon.execute('executeAppTool', { ...turn, appId: first.appId!,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER);
    expect(used).toEqual({ status: 'executed', data: { ok: true } });
    expect(provider.execute).toHaveBeenCalledWith(expect.objectContaining({
      userId: OWNER, accountId: 'ca_fixture', toolkit: 'slack',
    }));
    expect((await database.query(`SELECT 1 FROM workspace_app_usage WHERE app_id=$1`,
      [first.appId])).rowCount).toBe(1);
    const afterUse = (await readOwnerApps(database, OWNER, provider))[0]!;
    expect(afterUse).toMatchObject({ useCount: 1,
      lastUse: { agentId: HELPER, agentName: 'Bee', roomId: ROOM,
        roomName: 'Tools', usedAt: afterUse.lastUsedAt } });
  });

  it('RS-1: an unlisted app sign-in card stores its web domain so the card shows its mark', async () => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'whatsapp');
    provider.toolkit.mockImplementation(async (toolkit: string) => ({ slug: toolkit,
      logo: `https://logos.composio.dev/api/${toolkit}`, appUrl: 'https://web.whatsapp.com' }));
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const result = await daemon.execute('connect',
      { ...turn, service: 'WhatsApp', reason: 'message customers' }, HELPER);
    expect(result).toMatchObject({ status: 'needs_sign_in', appKey: 'whatsapp' });
    const stored = (await database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.card).toMatchObject({ appKey: 'whatsapp', domain: 'whatsapp.com',
      logo: 'https://logos.composio.dev/api/whatsapp' });
    // The logo URL is the only provider-hosted value the card may carry.
    const { logo: _logo, ...rest } = stored[0]!.card;
    expect(JSON.stringify(rest)).not.toContain('composio');
    // The Room view keeps the stored domain even when the read-time logo lookup fails.
    provider.toolkit.mockRejectedValue(new Error('App provider is unavailable'));
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    const view = await phone.readRoom(ROOM, OWNER);
    expect(view?.messages.find((message) => message.appSignIn)?.appSignIn)
      .toMatchObject({ appKey: 'whatsapp', domain: 'whatsapp.com', logo: 'https://logos.composio.dev/api/whatsapp' });
    console.info('Reproduction RS-1: connect WhatsApp -> card stores logo and domain whatsapp.com -> Room view returns them');
  });

  it('RS-1: an unlisted app with a logo but no web address stores the logo on its sign-in card', async () => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'whatsapp');
    provider.toolkit.mockImplementation(async (toolkit: string) => ({ slug: toolkit,
      logo: `https://logos.composio.dev/api/${toolkit}` }));
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const result = await daemon.execute('connect',
      { ...turn, service: 'WhatsApp', reason: 'message customers' }, HELPER);
    expect(result).toMatchObject({ status: 'needs_sign_in', appKey: 'whatsapp' });
    const stored = (await database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.card).toMatchObject({ appKey: 'whatsapp', logo: 'https://logos.composio.dev/api/whatsapp' });
    expect(stored[0]!.card).not.toHaveProperty('domain');
    // The Room view keeps the stored logo even when the read-time lookup fails.
    provider.toolkit.mockRejectedValue(new Error('App provider is unavailable'));
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    const view = await phone.readRoom(ROOM, OWNER);
    expect(view?.messages.find((message) => message.appSignIn)?.appSignIn)
      .toMatchObject({ appKey: 'whatsapp', logo: 'https://logos.composio.dev/api/whatsapp' });
    console.info('Reproduction RS-1: connect WhatsApp (logo only) -> card stores logo -> Room view returns it');
  });

  it('RS-1: an app sign-in card drops a logo that is not https', async () => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'whatsapp');
    provider.toolkit.mockImplementation(async (toolkit: string) => ({ slug: toolkit,
      logo: `http://logos.example/${toolkit}` }));
    await daemonWith(fakeRegistry([]).client, provider).execute('connect',
      { ...turn, service: 'WhatsApp', reason: 'message customers' }, HELPER);
    const stored = (await database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.card).not.toHaveProperty('logo');
  });

  it('RS-1: an app sign-in card still posts when the app metadata lookup fails', async () => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'whatsapp');
    provider.toolkit.mockRejectedValue(new Error('App provider is unavailable'));
    const result = await daemonWith(fakeRegistry([]).client, provider).execute('connect',
      { ...turn, service: 'WhatsApp', reason: 'message customers' }, HELPER);
    expect(result).toMatchObject({ status: 'needs_sign_in' });
    const stored = (await database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.card).not.toHaveProperty('domain');
    expect(stored[0]!.card).not.toHaveProperty('logo');
  });

  it('WB-1: corner turn discovers X app ID and status, posts sign-in card, and wakes after connection', async () => {
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       VALUES($1,$2,$3,$4,'MM desk corner')`, [CORNER, WORKSPACE, ROOM, OWNER],
    );

    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text)
       VALUES('corner-app-source',$1,$2,'Check access to X posts')`, [CORNER, OWNER],
    );
    await database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at
       ) VALUES('corner-app-command',$1,$2,'corner-app-source','corner-app-request',
         'input','human_tag','corner-app-command','corner-app-source',0,
         'claimed','corner-app-generation',now()+interval '10 minutes')`,
      [CORNER, HELPER],
    );
    const provider = fakeComposio('x');
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const cornerTurn = { roomId: CORNER, requestId: 'corner-app-request',
      generationId: 'corner-app-generation' };
    const before = await daemon.execute('readAgentWorkbench', { roomId: CORNER }, HELPER);
    expect(before.apps).toEqual([]);
    const started = await daemon.execute('connectApp', { ...cornerTurn, app: 'X',
      reason: 'Check access to X posts',
      continuation: 'I will check the requested posts after sign-in.' }, HELPER);
    expect(started).toMatchObject({ status: 'needs_sign_in', transport: 'composio',
      appId: expect.any(String) });
    const discovered = await daemon.execute('readAgentWorkbench', { roomId: CORNER }, HELPER);
    expect(discovered.apps).toContainEqual(expect.objectContaining({
      appId: started.appId, appKey: 'x', name: 'X', status: 'connecting',
    }));
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    expect((await phone.readRoom(CORNER, OWNER))?.messages.find((message) =>
      message.appSignIn?.appId === started.appId)?.appSignIn).toMatchObject({
        status: 'pending', ownerId: OWNER, agentId: HELPER,
      });
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture',
      appId: started.appId! }, OWNER);
    expect((await daemon.execute('readAgentWorkbench', { roomId: CORNER }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({
        appId: started.appId, appKey: 'x', status: 'connected',
      }));
    expect((await database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND agent_id=$2 AND reason='app_connected'`, [CORNER, HELPER])).rowCount).toBe(1);
  });

  it('owner opens agent-started Registry GitHub sign-in and selects personal authentication', async () => {
    const githubServer = { ...linearServer, name: 'com.github/github', title: 'GitHub',
      websiteUrl: 'https://github.com',
      remotes: [{ type: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' }] };
    const registry = fakeRegistry([githubServer]);
    const daemon = daemonWith(registry.client);
    const installed = await daemon.execute('connectMcpServer', { ...turn,
      serverName: githubServer.name, version: githubServer.version,
      reason: 'connect personal GitHub' }, HELPER);
    if (installed.status === 'unsupported') throw new Error(installed.reason);
    await daemon.execute('postConnectorStatus', { agentId: HELPER,
      connectorId: installed.connectorId, steps: [],
      signIn: { method: 'oauth', url: 'https://github.com/login/oauth/authorize?state=fixture',
        attemptId: 'github-owner-sign-in' } }, HELPER);
    const started = await daemon.execute('connect', { ...turn, service: 'GitHub',
      reason: 'Read account issues' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client);
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: started.appId, selectedByOwner: false }));
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await daemon.execute('installConnector', { agentId: HELPER,
      connectorId: installed.connectorId }, HELPER);
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: started.appId,
        status: 'connected', selectedByOwner: true }));
  });

  it('owner completion of agent-started GitHub login selects personal authentication', async () => {
    const registry = fakeRegistry([]);
    const provider = fakeComposio('github');
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = daemonWith(registry.client, provider);
    const started = await daemon.execute('connectApp', { ...turn, app: 'GitHub', reason: 'connect personal GitHub' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client, provider);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    provider.accountStatus.mockResolvedValueOnce({ status: 'pending' });
    await expect(phone.execute('completeAppSignIn', {
      sessionUri: 'session-fixture', appId: started.appId!,
    }, OWNER)).rejects.toThrow('App sign-in could not be verified');
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: started.appId, selectedByOwner: false }));
    provider.account.mockResolvedValueOnce(false);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: started.appId! }, OWNER);
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: started.appId,
        status: 'connected', selectedByOwner: true }));
  });

  it('refuses YouTube without its custom sign-in instead of issuing a link or a Squire route', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    await expect(daemon.execute('connectApp',
      { ...turn, app: 'YouTube', reason: 'upload the launch video' }, HELPER)).resolves.toMatchObject({
      status: 'unavailable', appKey: 'youtube', next: 'This app is not available to connect yet.' });
    expect(provider.supportsOAuth).toHaveBeenCalledWith('youtube');
    expect(provider.link).not.toHaveBeenCalled();
    expect(await routes()).toEqual([]);
  });

  it('Reproduction CRED-1: connect and status agree on the selected reference among two GitHub keys', async () => {
    await connectSquire();
    await applyVaultList(database,
      { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [
        { reference: 'vault:github-work', service: 'github', label: 'Work projects',
          fieldNames: ['token'], allowedHosts: ['api.github.com'], createdAt: 1, stale: false, state: 'active' },
        { reference: 'vault:github-public', service: 'github', label: 'Public projects',
          fieldNames: ['token'], allowedHosts: ['api.github.com'], createdAt: 2, stale: false, state: 'error' },
      ]);
    const daemon = daemonWith(fakeRegistry([]).client, fakeComposio());
    const connected = await daemon.execute('connect', { ...turn, service: 'github',
      reason: 'List repositories', squireAvailable: true }, HELPER);
    expect(connected).toMatchObject({ status: 'ready', connectionReference: 'vault:github-work' });
    expect(connected.next).toContain('reference "vault:github-work"');
    const view = await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER);
    expect(view.apps).toContainEqual(expect.objectContaining({ appKey: 'github',
      status: 'connected', connectionReference: 'vault:github-work' }));
    const discovered = await daemon.execute('listAppTools', { ...turn, appId: connected.appId! }, HELPER);
    expect(discovered.next).toContain('use_credential (reference "vault:github-work")');
    await expect(daemon.execute('executeAppTool', { ...turn, appId: connected.appId!,
      tool: 'LIST_REPOS', arguments: {} }, HELPER))
      .rejects.toThrow('use_credential (reference "vault:github-work")');
    console.log('Reproduction CRED-1: connect and status select vault:github-work among two GitHub keys');
  });

  it('uses a connected owner app from a Room and corner where only the agent is a member', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const started = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: started.appId! }, OWNER);

    const otherWorkspace = '55555555-5555-4555-8555-555555555555';
    const otherRoom = '66666666-6666-4666-8666-666666666666';
    const otherCorner = '77777777-7777-4777-8777-777777777777';
    const host = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Host')`, [host]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`, [otherWorkspace]);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name)
      VALUES($1,$3,$4,'Other room'),($2,$3,$4,'Other corner')`,
      [otherRoom, otherCorner, otherWorkspace, host]);
    await database.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [otherRoom, otherCorner]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$3,'member') `,
      [otherWorkspace, host, HELPER, otherRoom]);
    for (const [roomId, requestId, generationId] of [
      [otherRoom, 'other-room-request', 'other-room-generation'],
      [otherCorner, 'other-corner-request', 'other-corner-generation'],
    ]) {
      const sourceId = `${requestId}-source`;
      const commandId = `${requestId}-command`;
      await database.query(`INSERT INTO messages(id,room_id,author_id,text)
        VALUES($1,$2,$3,'Use my connected app')`, [sourceId, roomId, host]);
      await database.query(`INSERT INTO agent_commands(
        id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
        root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at
      ) VALUES($1,$2,$3,$4,$5,'input','human_tag',$1,$4,0,'claimed',$6,
        now()+interval '10 minutes')`, [commandId, roomId, HELPER, sourceId, requestId, generationId]);
      const input = { roomId, requestId, generationId, appId: started.appId! };
      expect((await daemon.execute('readAgentWorkbench', { roomId }, HELPER)).apps)
        .toContainEqual(expect.objectContaining({ appId: started.appId, status: 'connected' }));
      expect((await daemon.execute('listAppTools', input, HELPER)).tools).toHaveLength(1);
      expect(await daemon.execute('executeAppTool', { ...input,
        tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER))
        .toEqual({ status: 'executed', data: { ok: true } });
      console.log(`${roomId === otherCorner ? 'Corner' : 'Room'}: connected app listed and executed`);
    }
  });

  it('Reproduction NEON-1: app tools name the Squire route for a squire-api app instead of "unavailable"', async () => {
    const neon = 'edd5e6c5-fc4c-4170-93c0-8efef63010c9';
    await database.query(
      `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
       VALUES($1,$2,$3,'neon','Neon','squire-api','squire-api')`,
      [neon, WORKSPACE, OWNER],
    );
    const daemon = daemonWith(fakeRegistry([]).client, fakeComposio());
    const cause = 'Neon is connected through squire-api, not app tools. ' +
      'Call Neon\'s API with Trusty Squire use_credential (service "neon").';
    const listed = await daemon.execute('listAppTools', { ...turn, appId: neon }, HELPER)
      .catch((error: Error) => error.message);
    expect(listed).toMatchObject({ tools: [], transport: 'squire-api',
      service: 'neon', credentials: [], next: expect.stringContaining('use_credential') });
    console.log(`list_app_tools(Neon): ${listed}`);
    await expect(daemon.execute('executeAppTool', { ...turn, appId: neon,
      tool: 'NEON_LIST_PROJECTS', arguments: {} }, HELPER)).rejects.toThrow(cause);

    const other = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other','other')`, [other]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, other]);
    await database.query(`UPDATE workspace_apps SET owner_identity_id=$1 WHERE id=$2`, [other, neon]);
    await expect(daemon.execute('listAppTools', { ...turn, appId: neon }, HELPER))
      .rejects.toThrow("Neon is another person's squire-api app; only their own agents can use it.");
  });

  it('Reproduction APP-ROUTE-1: daemon HTTP discovers Squire routes and refuses tool execution', async () => {
    const appId = 'edd5e6c5-fc4c-4170-93c0-8efef63010c9';
    await database.query(
      `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
       VALUES($1,$2,$3,'github','GitHub','squire-api','squire-api')`,
      [appId, WORKSPACE, OWNER],
    );
    await connectSquire();
    await applyVaultList(database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
      reference: 'vault:github', service: 'github', label: 'default',
      fieldNames: ['token'], allowedHosts: ['api.github.com'], createdAt: 1,
      stale: false, state: 'active',
    }]);
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const phone = new PhoneService(database, 'http://placeholder');
    const server = createBeelineServer({ database, phone, daemon, live: new LiveHub(),
      mediaMaximumBytes: 1,
      auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.mocked(captureServerError).mockClear();
    try {
      for (const otherOwner of [false, true]) {
        if (otherOwner) {
          const other = 'c'.repeat(64);
          await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other','other')`, [other]);
          await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
            VALUES($1,NULL,$2,'member')`, [WORKSPACE, other]);
          await database.query(`UPDATE workspace_apps SET owner_identity_id=$1 WHERE id=$2`, [other, appId]);
        }
        const message = otherOwner
          ? "GitHub is another person's squire-api app; only their own agents can use it."
          : 'GitHub is connected through squire-api, not app tools. ' +
            'Call GitHub\'s API with Trusty Squire use_credential (reference "vault:github").';
        for (const operation of ['listAppTools', 'executeAppTool']) {
          const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer bdt_fixture-token-0001' },
            body: JSON.stringify({ ...turn, appId: 'github',
              ...(operation === 'executeAppTool' ? { tool: 'GITHUB_LIST_REPOSITORIES', arguments: {} } : {}) }),
          });
          const result = await response.json();
          console.log(`Reproduction APP-ROUTE-1: ${operation}, other owner=${otherOwner} → HTTP ${response.status} ${JSON.stringify(result)}`);
          if (!otherOwner && operation === 'listAppTools') {
            expect(response.status).toBe(200);
            expect(result).toEqual({ tools: [], transport: 'squire-api', service: 'github',
              next: 'Call GitHub\'s API with Trusty Squire use_credential (reference "vault:github").',
              credentials: [{ reference: 'vault:github', allowedHosts: ['api.github.com'] }] });
          } else {
            expect(response.status).toBe(otherOwner ? 403 : 400);
            expect(result).toEqual({ error: message });
          }
          expect(captureServerError).not.toHaveBeenCalled();
        }
      }
      expect(provider.listTools).not.toHaveBeenCalled();
      expect(provider.execute).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('Reproduction R-APPKEY: connected keys discover and execute over daemon HTTP', async () => {
    const ids = ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff'];
    for (const [index, key] of ['github', 'web'].entries()) {
      await database.query(`INSERT INTO workspace_apps
        (id,workspace_id,owner_identity_id,app_key,display_name,transport,route,composio_account_id)
        VALUES($1,$2,$3,$4,$4,'composio','composio','account-fixture')`,
        [ids[index], WORKSPACE, OWNER, key]);
    }
    const provider = fakeComposio();
    await provider.completeAuth('session-fixture', OWNER);
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const server = createBeelineServer({ database, phone: new PhoneService(database, 'http://placeholder'),
      daemon, live: new LiveHub(), mediaMaximumBytes: 1,
      auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (operation: string, args: Record<string, unknown>) => {
      const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bdt_fixture-token-0001' },
        body: JSON.stringify({ ...turn, ...args }),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      const workbench = await call('readAgentWorkbench', {});
      expect(workbench.status).toBe(200);
      expect(workbench.body.apps).toEqual(expect.arrayContaining(
        ['github', 'web'].map(appKey => expect.objectContaining({ appKey, status: 'connected' }))));
      for (const appId of ['github', 'web', 'app:github', ...ids]) {
        const listed = await call('listAppTools', { appId });
        expect(listed.status).toBe(200);
        expect(listed.body.tools).toHaveLength(1);
        expect(await call('executeAppTool', { appId, tool: 'SLACK_POST_MESSAGE', arguments: { text: 'fixture' } }))
          .toEqual({ status: 200, body: { status: 'executed', data: { ok: true } } });
      }
      for (const operation of ['listAppTools', 'executeAppTool']) {
        const unknown = await call(operation, { appId: 'unknown-key', tool: 'SLACK_POST_MESSAGE', arguments: {} });
        expect(unknown.body).toEqual({ error: 'Connected app is unavailable in this Room' });
      }
      const other = 'c'.repeat(64);
      const duplicate = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [other]);
      await database.query(`INSERT INTO workspace_apps
        (id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
        VALUES($1,$2,$3,'github','GitHub','composio','composio')`, [duplicate, WORKSPACE, other]);
      // An inaccessible matching key must not make the owner's connection ambiguous.
      expect((await call('listAppTools', { appId: 'github' })).status).toBe(200);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'member')`, [WORKSPACE, other]);
      // Status advertises only the agent owner's apps; shared names must not shadow them.
      for (const app of workbench.body.apps) {
        expect((await call('listAppTools', { appId: app.appKey })).status).toBe(200);
        expect(provider.account).toHaveBeenLastCalledWith('account-fixture', OWNER, app.appKey);
        expect((await call('executeAppTool', { appId: `app:${app.appKey}`,
          tool: 'SLACK_POST_MESSAGE', arguments: {} })).status).toBe(200);
      }
      // With no owner mapping, two accessible shared apps are a genuine tie.
      const third = 'd'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Third')`, [third]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'member')`, [WORKSPACE, third]);
      await database.query(`UPDATE workspace_apps SET owner_identity_id=$1 WHERE id=$2`, [third, ids[0]]);
      for (const operation of ['listAppTools', 'executeAppTool']) {
        const ambiguous = await call(operation, { appId: 'github', tool: 'SLACK_POST_MESSAGE', arguments: {} });
        expect(ambiguous.status).toBe(400);
        expect(ambiguous.body).toEqual({ error:
          `Connected app key is ambiguous; use an exact app id: ${duplicate}, ${ids[0]}` });
      }
      await database.query(`UPDATE workspace_apps SET owner_identity_id=$1 WHERE id=$2`, [OWNER, ids[0]]);
      expect((await call('listAppTools', { appId: ids[0] })).status).toBe(200);
      console.log('Reproduction R-APPKEY: workbench keys github/web discover and execute over HTTP; unknown and ambiguous keys refused');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('returns an empty tool list over the daemon API when a query matches nothing', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const started = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'find a tool' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: started.appId! }, OWNER);
    provider.listTools.mockResolvedValueOnce([]);
    const server = createBeelineServer({ database, phone, daemon, live: new LiveHub(),
      mediaMaximumBytes: 1,
      auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${origin}/v1/daemon/operations/listAppTools`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bdt_fixture-token-0001' },
        body: JSON.stringify({ ...turn, appId: started.appId!, query: 'nonexistent-tool' }),
      });
      const result = await response.json();
      console.log(`Reproduction tool-input-limits: no-match query → HTTP ${response.status} ${JSON.stringify(result)}`);
      expect(response.status).toBe(200);
      expect(result).toEqual({ tools: [] });
      expect(provider.listTools).toHaveBeenCalledWith('slack', 'nonexistent-tool');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('names the cause when a connected app has no discoverable tools', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const started = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: started.appId! }, OWNER);
    provider.listTools.mockResolvedValueOnce([]);
    await expect(daemon.execute('listAppTools', { ...turn, appId: started.appId! }, HELPER))
      .rejects.toThrow(/no tools/i);
  });

  it.each(['Linear', 'Example App'])('shows a failed provider link for %s on Workbench and clears it on retry', async (app) => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp',
      { ...turn, app, reason: `connect ${app}` }, HELPER);
    expect(first).toMatchObject({ status: 'needs_sign_in', transport: 'composio' });
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    provider.link.mockRejectedValueOnce(new Error('App provider request failed (403)'));
    await expect(phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER))
      .rejects.toThrow('App provider request failed (403)');
    expect((await phone.readRoom(ROOM, OWNER))?.messages.find((message) =>
      message.appSignIn?.appId === first.appId)?.appSignIn).toMatchObject({
        status: 'failed', errorMessage: 'App provider request failed (403)',
      });
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps)
      .toContainEqual(expect.objectContaining({ appId: first.appId, status: 'error',
        errorMessage: 'App provider request failed (403)' }));
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps)
      .toContainEqual(expect.objectContaining({ appId: first.appId, status: 'connecting' }));
  });

  it('projects provider descriptions and logos to app rows and the connect catalog', async () => {
    const provider = fakeComposio();
    provider.toolkit.mockImplementation(async (toolkit: string) => ({ slug: toolkit,
      description: `Use ${toolkit} tools.`, logo: `https://cdn.composio.dev/${toolkit}.png`,
      ...(toolkit === 'gmail' ? { appUrl: 'https://mail.google.com' } : {}) }));
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp',
      { ...turn, app: 'Gmail', reason: 'connect Gmail' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.apps).toContainEqual(expect.objectContaining({ appId: first.appId,
      description: 'Use gmail tools.', logo: 'https://cdn.composio.dev/gmail.png',
      domain: 'mail.google.com' }));
    expect(view.appCatalog).toContainEqual({ appKey: 'gmail',
      description: 'Use gmail tools.', logo: 'https://cdn.composio.dev/gmail.png',
      domain: 'mail.google.com' });
  });

  it.each(['Instagram', 'Figma'])('Reproduction CARD-1: %s Room cards retain the same logo as Workbench', async (app) => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    provider.toolkit.mockImplementation(async (slug: string) => ({ slug,
      logo: `https://cdn.composio.dev/${slug}.png`, appUrl: `https://${slug}.com` }));
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp', { ...turn, app,
      reason: `connect ${app}` }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    const expected = { logo: `https://cdn.composio.dev/${app.toLowerCase()}.png`,
      domain: `${app.toLowerCase()}.com` };
    const workbench = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(workbench.apps).toContainEqual(expect.objectContaining({ appId: first.appId, ...expected }));
    const cardMessage = (await phone.readRoom(ROOM, OWNER))?.messages.find(message =>
      message.appSignIn?.appId === first.appId);
    const card = readRoomViewMessage(cardMessage)?.appSignIn;
    expect(card).toMatchObject(expected);
    const historyCard = (await phone.readHistory(ROOM, OWNER))?.messages.find(message =>
      message.appSignIn?.appId === first.appId)?.appSignIn;
    expect(historyCard).toMatchObject(expected);
    if (process.env.BEELINE_SIGN_IN_PROOF === '1')
      console.log(`CARD-1 ${app}: Room and history cards show ${expected.logo}, matching Workbench`);
  });

  it('keeps existing Room cards usable when provider metadata fails or stalls', async () => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp', { ...turn, app: 'Instagram',
      reason: 'connect Instagram' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    provider.toolkit.mockRejectedValueOnce(new Error('metadata unavailable'));
    const failed = await phone.readRoom(ROOM, OWNER);
    expect(failed?.messages.find(message => message.appSignIn?.appId === first.appId)
      ?.appSignIn).toMatchObject({ name: 'Instagram', status: 'pending' });
    provider.toolkit.mockImplementationOnce(() => new Promise(() => {}));
    const stalled = await phone.readRoom(ROOM, OWNER);
    expect(stalled?.messages.find(message => message.appSignIn?.appId === first.appId)
      ?.appSignIn).toMatchObject({ name: 'Instagram', status: 'pending' });
    await expect(phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER))
      .resolves.toHaveProperty('authorizationUrl');
  });

  it.each(['card', 'workbench'])('SIGNIN-1: Instagram connects on its first attempt through %s', async (route) => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    provider.completeAuth.mockResolvedValue({ accountId: 'ca_fixture', toolkit: 'instagram' });
    provider.account.mockResolvedValue(true);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    let appId: string;
    let authorizationUrl: string;
    if (route === 'card') {
      const daemon = daemonWith(fakeRegistry([]).client, provider);
      const first = await daemon.execute('connectApp', { ...turn, app: 'Instagram',
        reason: 'connect Instagram' }, HELPER);
      appId = first.appId!;
      expect(provider.link).not.toHaveBeenCalled();
      authorizationUrl = (await phone.execute('beginAppSignIn', { appId }, OWNER)).authorizationUrl;
    } else {
      const started = await phone.execute('connectWorkbenchApp', {
        app: 'Instagram', helperAgentId: HELPER }, OWNER);
      appId = started.appId;
      authorizationUrl = started.authorizationUrl!;
    }
    expect(authorizationUrl).toBe('https://app.composio.dev/connect/fixture');
    expect(provider.link).toHaveBeenCalledTimes(1);
    expect(provider.link).toHaveBeenCalledWith(OWNER, 'instagram');
    // The fallback reuses the verifier session after a missed browser handoff;
    // only the authenticated phone may redeem it.
    const server = createBeelineServer({ database, phone, daemon: {} as DaemonService,
      live: new LiveHub(), mediaMaximumBytes: 1,
      auth: { authenticatePhone: async (token: string) => token === 'fixture-phone-token-0001' ? OWNER : null } as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const callback = await fetch(`${origin}/v1/apps/oauth/verify?session_uri=session-fixture`);
      expect(callback.status).toBe(200);
      const html = await callback.text();
      const returnLink = new URL(html.match(/id="open-beeline" href="([^"]+)"/)![1]);
      expect(html).toContain('Open Beeline</a>');
      expect(provider.completeAuth).not.toHaveBeenCalled();
      const input = { sessionUri: returnLink.searchParams.get('appSignInSession'), appId };
      const unauthorized = await fetch(`${origin}/v1/phone/operations/completeAppSignIn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      expect(unauthorized.status).toBe(401);
      expect(provider.completeAuth).not.toHaveBeenCalled();
      provider.accountStatus.mockResolvedValue({ status: 'active' });
      const completion = await fetch(`${origin}/v1/phone/operations/completeAppSignIn`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-phone-token-0001' },
        body: JSON.stringify(input) });
      expect(completion.status).toBe(200);
      expect(await completion.json()).toEqual({ appId });
      expect(provider.completeAuth).toHaveBeenCalledWith('session-fixture', OWNER);
      expect(provider.link).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps)
      .toContainEqual(expect.objectContaining({ appId, status: 'connected' }));
    if (route === 'card') {
      expect((await phone.readRoom(ROOM, OWNER))?.messages.find(message =>
        message.appSignIn?.appId === appId)?.appSignIn?.status).toBe('connected');
      expect((await database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
        AND agent_id=$2 AND reason='app_connected'`, [ROOM, HELPER])).rowCount).toBe(1);
    }
    if (process.env.BEELINE_SIGN_IN_PROOF === '1')
      console.log(`RETURN-1 / SIGNIN-1 ${route}: visible fallback retains the first session; anonymous completion refused; authenticated phone connects Workbench${route === 'card' ? ', settles card and resumes request' : ''}; no second sign-in link`);
  });

  it('shows a failed callback on Workbench and clears it on retry', async () => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp',
      { ...turn, app: 'Linear', reason: 'connect Linear' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    provider.completeAuth.mockRejectedValueOnce(new Error('App provider request failed (403)'));
    await expect(phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: first.appId! }, OWNER))
      .rejects.toThrow('App provider request failed (403)');
    expect((await phone.readRoom(ROOM, OWNER))?.messages.find((message) =>
      message.appSignIn?.appId === first.appId)?.appSignIn).toMatchObject({
        status: 'failed', errorMessage: 'App provider request failed (403)',
      });
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps)
      .toContainEqual(expect.objectContaining({ appId: first.appId, status: 'error',
        errorMessage: 'App provider request failed (403)' }));
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps)
      .toContainEqual(expect.objectContaining({ appId: first.appId, status: 'connecting' }));
  });

  it.each(['Instagram', 'Runway'])('Reproduction OAuth-1: %s provider failure reaches Workbench and its card', async (app) => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp',
      { ...turn, app, reason: `connect ${app}` }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    provider.accountStatus.mockResolvedValue({ status: 'failed', reason: 'Provider rejected this account type' });
    const checked = await daemon.execute('connectApp',
      { ...turn, app, reason: `finish ${app}` }, HELPER);
    expect(checked).toMatchObject({ status: 'error',
      next: expect.stringContaining('Provider rejected this account type') });
    expect((await phone.readRoom(ROOM, OWNER))?.messages.find((message) =>
      message.appSignIn?.appId === first.appId)?.appSignIn).toMatchObject({
        status: 'failed', errorMessage: 'Provider rejected this account type',
      });
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.apps).toContainEqual(expect.objectContaining({ appId: first.appId,
      status: 'error', errorMessage: 'Provider rejected this account type' }));
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: first.appId,
        status: 'error', errorMessage: 'Provider rejected this account type' }));
    const room = await phone.readRoom(ROOM, OWNER);
    expect(room?.messages.find((message) => message.appSignIn?.appId === first.appId)
      ?.appSignIn).toMatchObject({ status: 'failed',
        errorMessage: 'Provider rejected this account type' });
    if (process.env.BEELINE_SIGN_IN_PROOF === '1')
      console.log(`OAuth-1 ${app}: Workbench=error, agent status=error, card=failed; reason=Provider rejected this account type`);
  });

  it.each(['Instagram', 'Runway'])('Reproduction OAuth-2: %s expires a pending sign-in', async (app) => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    provider.link.mockResolvedValue({ url: 'https://app.composio.dev/connect/fixture',
      accountId: 'ca_fixture', expiresAt: new Date(Date.now() + 60 * 60_000) });
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp',
      { ...turn, app, reason: `connect ${app}` }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    const deadline = (await database.query<{ composio_link_expires_at: Date }>(
      `SELECT composio_link_expires_at FROM workspace_apps WHERE id=$1`, [first.appId],
    )).rows[0]!.composio_link_expires_at;
    expect(deadline.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    await database.query(`UPDATE workspace_apps SET composio_link_expires_at=now()-interval '1 second'
      WHERE id=$1`, [first.appId]);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.apps).toContainEqual(expect.objectContaining({ appId: first.appId,
      status: 'error', errorMessage: expect.stringContaining('timed out') }));
    expect((await phone.readRoom(ROOM, OWNER))?.messages.find((message) =>
      message.appSignIn?.appId === first.appId)?.appSignIn).toMatchObject({ status: 'failed',
        errorMessage: expect.stringContaining('timed out') });
    if (process.env.BEELINE_SIGN_IN_PROOF === '1')
      console.log(`OAuth-2 ${app}: Workbench=error, card=failed; reason=App sign-in timed out`);
  });

  it('WB-CALLBACK-2: fails only the initiating app when two sign-ins are pending', async () => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const linear = await daemon.execute('connectApp',
      { ...turn, app: 'Linear', reason: 'connect Linear' }, HELPER);
    const slack = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'connect Slack' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: linear.appId! }, OWNER);
    await phone.execute('beginAppSignIn', { appId: slack.appId! }, OWNER);
    provider.completeAuth.mockRejectedValueOnce(new Error('App provider request failed (403)'));
    await expect(phone.execute('completeAppSignIn',
      { sessionUri: 'session-fixture', appId: linear.appId! }, OWNER))
      .rejects.toThrow('App provider request failed (403)');
    const apps = (await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps;
    expect(apps).toContainEqual(expect.objectContaining({ appId: linear.appId,
      status: 'error', errorMessage: 'App provider request failed (403)' }));
    expect(apps).toContainEqual(expect.objectContaining({ appId: slack.appId,
      status: 'connecting' }));
  });

  it('rejects invalid card copy before creating a connection or card', async () => {
    const daemon = daemonWith(fakeRegistry([]).client, fakeComposio());
    await expect(daemon.execute('connectApp', { ...turn, app: 'Slack',
      reason: 'post the launch notes', continuation: '<b>Do this now.</b>' }, HELPER))
      .rejects.toThrow(/app continuation/);
    expect((await database.query(`SELECT 1 FROM messages WHERE card_type='app-sign-in'`))
      .rowCount).toBe(0);
    expect((await database.query(`SELECT 1 FROM workspace_apps`)).rowCount).toBe(0);
  });

  it('binds sign-in to the returning person and refuses a foreign agent until the app owner approves', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    expect((await database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM],
    )).rows[0]?.card).not.toHaveProperty('continuation');
    const OTHER = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [OTHER]);
    expect(await readOwnerApps(database, OTHER, provider)).toEqual([]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WORKSPACE, OTHER, ROOM]);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await expect(phone.execute('beginAppSignIn', { appId: connected.appId! }, OTHER))
      .rejects.toThrow(/no longer in your Connectors/);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    await expect(phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OTHER))
      .rejects.toThrow(/no longer pending/);
    expect((await database.query(`SELECT 1 FROM workspace_apps WHERE id=$1 AND
      composio_link_expires_at IS NOT NULL`, [connected.appId])).rowCount).toBe(1);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OWNER);

    await database.query(`UPDATE agents SET owner_id=$1 WHERE agent_id=$2`, [OTHER, HELPER]);
    const call = { ...turn, appId: connected.appId!, tool: 'SLACK_POST_MESSAGE',
      arguments: { text: 'Launch notes' } };
    const first = await daemon.execute('executeAppTool', call, HELPER);
    expect(first).toMatchObject({ status: 'needs_permission' });
    expect(provider.execute).not.toHaveBeenCalled();
    await expect(phone.execute('decideAgentGrant', {
      grantId: (first as { grantId: string }).grantId, decision: 'always',
    }, OTHER)).rejects.toThrow(/connected person/);
    await phone.execute('decideAgentGrant', {
      grantId: (first as { grantId: string }).grantId, decision: 'deny',
    }, OWNER);
    const second = await daemon.execute('executeAppTool', call, HELPER);
    expect(second).toMatchObject({ status: 'needs_permission' });
    expect((second as { grantId: string }).grantId).not.toBe((first as { grantId: string }).grantId);
    expect(provider.execute).not.toHaveBeenCalled();
    await phone.execute('decideAgentGrant', {
      grantId: (second as { grantId: string }).grantId, decision: 'always',
    }, OWNER);
    expect((await daemon.execute('listAgentGrants', { agentId: HELPER, roomId: ROOM },
      HELPER)).grants).toContainEqual(expect.objectContaining({
      grantId: (second as { grantId: string }).grantId, target: 'app:slack',
    }));
    await expect(daemon.execute('executeAppTool', call, HELPER))
      .resolves.toMatchObject({ status: 'executed' });
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a connection visible until provider revocation succeeds', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OWNER);
    provider.deleteAccount.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(phone.execute('disconnectWorkbenchApp', {
      workspaceId: WORKSPACE, appId: connected.appId!,
    }, OWNER)).rejects.toThrow(/provider unavailable/);
    expect((await readOwnerApps(database, OWNER, provider))[0]?.status).toBe('connected');
    await phone.execute('disconnectWorkbenchApp', {
      workspaceId: WORKSPACE, appId: connected.appId!,
    }, OWNER);
    expect((await database.query<{ state: string }>(
      `SELECT state FROM workspace_apps WHERE id=$1`, [connected.appId])).rows[0]?.state)
      .toBe('disconnected');
  });

  it.skipIf(!process.env.CONNECTOR_BROWSER_PROOF)('CONNECTOR-BROWSER: real service bridge', async () => {
    const { createServer } = await import('node:http');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const provider = fakeComposio();
    provider.searchToolkits = vi.fn(async () => []);
    await connectSquire();
    await applyVaultList(database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER },
      Array.from({length:6}, (_,i) => ({reference:'vault:fly-'+i,service:'fly',label:'Fly key '+i,fieldNames:['token'],allowedHosts:['api.fly.io'],createdAt:1,stale:false,state:'active' as const})));
    const registry = fakeRegistry([]);
    const discovery = new CompanyMcpDiscovery(async () => ({status:200,body:JSON.stringify({resource:'https://mcp.fly.io',authorization_servers:['https://fly.io/mcp/oauth']})}));
    registry.client.companies.discover = discovery.discover.bind(discovery);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client, provider);
    const connected = await daemonWith(fakeRegistry([]).client, provider).execute('connectApp',
      { ...turn, app: 'Slack', reason: 'browser removal proof' }, HELPER);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    provider.completeAuth.mockRejectedValueOnce(new Error('authorization timeout'));
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OWNER).catch(() => {});
    const server = createServer(async (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'content-type');
      if (request.method === 'OPTIONS') { response.end(); return; }
      try {
        let body = ''; for await (const chunk of request) body += chunk;
        const { operation, input } = JSON.parse(body);
        if (operation === 'resetProof') {
          await database.query("UPDATE workspace_apps SET state='active' WHERE id=$1", [connected.appId]);
          response.end('{}'); return;
        }
        if (!['readWorkbench', 'disconnectWorkbenchApp', 'searchWorkbenchApps', 'connectWorkbenchApp'].includes(operation)) throw new Error('Proof operation not allowed');
        const pending = phone.execute(operation, input, OWNER);
        if (operation === 'connectWorkbenchApp') await publishFlySignIn();
        const result = await pending;
        // Only helper presence is simulated; all connection operations execute PhoneService.
        if (operation === 'readWorkbench') for (const helper of (result as any).helpers) helper.online = true;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result ?? {}));
      } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const result = await promisify(execFile)('npm', ['test', '--', 'run', 'sources/test/connector-service.browser.test.ts'], {
        cwd: '../mobile', timeout: 240000, maxBuffer: 4000000,
        env: { ...process.env, CONNECTOR_PROOF_ORIGIN: 'http://127.0.0.1:' + port },
      });
      console.log(result.stdout);
      expect(provider.deleteAccount).toHaveBeenCalled();
      expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps.some(app => app.appKey === 'slack')).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 260000);

  it.each(['Slack', 'Supabase', 'WhatsApp'])('Reproduction REMOVE-1: removes failed %s attempts and refuses foreign owners and late callbacks', async (app) => {
    const provider = fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp', { ...turn, app, reason: 'connect app' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    provider.completeAuth.mockRejectedValueOnce(new Error('authorization timeout'));
    await expect(phone.execute('completeAppSignIn', { sessionUri: 'session-fixture',
      appId: connected.appId! }, OWNER)).rejects.toThrow('authorization timeout');
    const read = () => phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect((await read()).apps).toContainEqual(expect.objectContaining({ appId: connected.appId, status: 'error' }));
    await expect(phone.execute('disconnectWorkbenchApp', { workspaceId: WORKSPACE,
      appId: connected.appId! }, 'c'.repeat(64))).rejects.toThrow();
    expect(provider.deleteAccount).not.toHaveBeenCalled();
    await phone.execute('disconnectWorkbenchApp', { workspaceId: WORKSPACE, appId: connected.appId! }, OWNER);
    expect(provider.deleteAccount).toHaveBeenCalledWith('ca_fixture');
    expect((await read()).apps).not.toContainEqual(expect.objectContaining({ appId: connected.appId }));
    await expect(phone.execute('completeAppSignIn', { sessionUri: 'session-fixture',
      appId: connected.appId! }, OWNER)).rejects.toThrow();
    expect((await read()).apps).not.toContainEqual(expect.objectContaining({ appId: connected.appId }));
  });

  it('deletes a pending provider account when its app is disconnected', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    expect((await readOwnerApps(database, OWNER, provider))[0]?.status).toBe('connecting');
    await phone.execute('disconnectWorkbenchApp', { workspaceId: WORKSPACE,
      appId: connected.appId! }, OWNER);
    expect(provider.deleteAccount).toHaveBeenCalledWith('ca_fixture');
    expect(await readOwnerApps(database, OWNER, provider)).toEqual([]);
  });

  it('does not execute from a provider account activated before identity verification', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    // A misconfigured provider project must not make an account usable before
    // the authenticated phone returns and the server redeems its session.
    provider.account.mockResolvedValue(true);
    expect((await readOwnerApps(database, OWNER, provider))[0]?.status).toBe('connecting');
    await expect(daemon.execute('executeAppTool', { ...turn, appId: connected.appId!,
      tool: 'SLACK_POST_MESSAGE', arguments: {} }, HELPER))
      .resolves.toEqual({ status: 'needs_connection' });
    expect(provider.execute).not.toHaveBeenCalled();
  });



  it('asks for Trusty Squire before an API route can start, then connects on the vaulted key', async () => {
    const daemon = daemonWith(fakeRegistry([]).client);
    const blocked = await daemon.execute(
      'connectApp',
      { ...turn, app: 'Resend', reason: 'send' },
      HELPER,
    );
    expect(blocked).toMatchObject({ status: 'needs_squire', route: 'squire-api' });
    expect((blocked as { next: string }).next).not.toMatch(/offer_connector|store_credential|operate_/);
    await connectSquire();
    const connecting = await daemon.execute(
      'connectApp',
      { ...turn, app: 'Resend', reason: 'send' },
      HELPER,
    );
    expect(connecting).toMatchObject({ status: 'connecting', transport: 'squire-api' });
    expect((connecting as { next: string }).next).not.toMatch(/store_credential|operate_/);
    await applyVaultList(database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [
      {
        reference: 'vault:resend',
        service: 'resend',
        label: 'default',
        fieldNames: ['api_key'],
        allowedHosts: ['api.resend.com'],
        createdAt: 1,
        stale: false,
        state: 'active',
      },
    ]);
    await expect(
      daemon.execute('connectApp', { ...turn, app: 'Resend', reason: 'send' }, HELPER),
    ).resolves.toMatchObject({ status: 'connected', transport: 'squire-api' });
    // One decision, however many times it was asked.
    expect(await routes()).toEqual([{ route: 'squire-api', transport: 'squire-api' }]);
    const [app] = await readOwnerApps(database, OWNER);
    expect(app).toMatchObject({
      appKey: 'resend',
      status: 'connected',
      connectionReference: 'vault:resend',
    });
  });

  it('shows one key for repeated vault reports from the same machine', async () => {
    await connectSquire();
    const key = { reference: 'vault://openrouter/default', service: 'openrouter', label: 'default',
      fieldNames: ['api_key'], allowedHosts: ['openrouter.ai'], createdAt: 1, stale: false,
      state: 'active' as const };
    for (let report = 0; report < 3; report++)
      await applyVaultList(database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [key]);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.connections.map((connection) => connection.reference)).toEqual([key.reference]);
  });

  it('reuses an existing Workbench key without searching the Registry', async () => {
    const registry = fakeRegistry([{ name: 'com.stripe/mcp', version: '0.2.4',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.stripe.com' }] }]);
    await connectSquire();
    await applyVaultList(database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [
      {
        reference: 'vault:stripe',
        service: 'stripe',
        label: 'live',
        fieldNames: ['secret_key'],
        allowedHosts: ['api.stripe.com'],
        createdAt: 1,
        stale: false,
        state: 'active',
      },
    ]);
    await expect(
      daemonWith(registry.client).execute(
        'connectApp',
        { ...turn, app: 'stripe.com', reason: 'refund' },
        HELPER,
      ),
    ).resolves.toMatchObject({ status: 'connected', route: 'workbench', transport: 'squire-api' });
    expect(registry.transport).not.toHaveBeenCalled();
  });

  it('moves to the browser only when Squire reports no API', async () => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([]).client);
    await daemon.execute('connectApp', { ...turn, app: 'Hacker News', reason: 'post' }, HELPER);
    const browser = await daemon.execute(
      'connectApp',
      { ...turn, app: 'Hacker News', reason: 'post', noApi: true },
      HELPER,
    );
    expect(browser).toMatchObject({ route: 'squire-browser', transport: 'squire-browser' });
    expect(await routes()).toEqual([
      { route: 'squire-api', transport: 'squire-api' },
      { route: 'squire-browser', transport: 'squire-browser' },
    ]);
  });







  it('lets the owner use Squire for an app another person has connected', async () => {
    const other = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other','other')`, [other]);
    await database.query(
      `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
       VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,$2,'fly','Fly','squire-api','squire-api')`,
      [WORKSPACE, other],
    );
    const daemon = daemonWith(fakeRegistry([]).client);
    // Older helpers still send the app keys a Squire call names; the gate ignores them.
    await expect(
      daemon.execute('authorizeResourceCall', { ...turn, target: 'squire', appKeys: ['fly'] } as never, HELPER),
    ).resolves.toEqual({ allowed: true });
    expect((await database.query(`SELECT 1 FROM workspace_app_usage`)).rowCount).toBe(0);
  });



  describe('Room files for app tools', () => {
    const YOUTUBE_APP = '44444444-4444-4444-8444-444444444444';
    const OTHER_ROOM = '55555555-5555-4555-8555-555555555555';
    const IN_ROOM = '66666666-6666-4666-8666-666666666666';
    const ELSEWHERE = '77777777-7777-4777-8777-777777777777';
    const HUGE = '88888888-8888-4888-8888-888888888888';
    const S3KEY = 'uploads/youtube/staged-fixture.mp4';
    const PRESIGNED = 'https://composio-files.s3.amazonaws.com/uploads/youtube/staged-fixture.mp4?X-Amz-Signature=sig';
    const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);

    async function youtubeRoom() {
      await database.query(
        `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,
           transport,route,composio_account_id)
         VALUES($1,$2,$3,'youtube','YouTube','composio','composio','ca_youtube')`,
        [YOUTUBE_APP, WORKSPACE, OWNER],
      );
      await database.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Elsewhere')`,
        [OTHER_ROOM, WORKSPACE, OWNER],
      );
      const object = (id: string, title: string, size: number) => database.query(
        `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
         VALUES($1,$2,'artifact',$3,'application/octet-stream',$4,$5,$6,'ready',now()+interval '1 day')`,
        [id, HELPER, `artifact/${id}`, title, size, id.replaceAll('-', '').padEnd(64, '0')],
      );
      await object(IN_ROOM, 'song-take-2.mp4', VIDEO.length);
      await object(ELSEWHERE, 'other.mp4', VIDEO.length);
      await object(HUGE, 'long-cut.mp4', APP_FILE_MAXIMUM_BYTES + 1);
      const attach = (id: string, room: string, objectId: string) => database.query(
        `INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'take',$4::jsonb)`,
        [id, room, HELPER, JSON.stringify([{ kind: 'artifact',
          url: `https://beeline.example/v1/media/${objectId}` }])],
      );
      await attach('take-in-room', ROOM, IN_ROOM);
      await attach('take-elsewhere', OTHER_ROOM, ELSEWHERE);
      await attach('take-huge', ROOM, HUGE);
      const getObject = vi.fn(async (key: string) => (key === `artifact/${IN_ROOM}` ? VIDEO : null));
      const objects = new ObjectService(database, { getObject } as unknown as ObjectStorage,
        'https://beeline.example');
      const calls: { method: string; url: string; body?: unknown }[] = [];
      const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
        const href = String(url);
        calls.push({ method: init?.method ?? 'GET', url: href.split('?')[0]!,
          ...(init?.body instanceof Uint8Array ? { body: init.body }
            : init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (href === PRESIGNED) return new Response(null, { status: 200 });
        const path = new URL(href).pathname;
        if (path.endsWith('/connected_accounts/ca_youtube')) return Response.json({
          id: 'ca_youtube', user_id: OWNER, status: 'ACTIVE', toolkit: { slug: 'youtube' } });
        if (path.endsWith('/tools/YOUTUBE_MULTIPART_UPLOAD_VIDEO')) return Response.json({
          slug: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO', version: '20260930_00', toolkit: { slug: 'youtube' },
          input_parameters: { type: 'object', properties: { title: { type: 'string' },
            videoFile: { type: 'object', file_uploadable: true } } } });
        if (path.endsWith('/tools/YOUTUBE_LIST_CHANNEL_VIDEOS')) return Response.json({
          slug: 'YOUTUBE_LIST_CHANNEL_VIDEOS', version: '20260930_00', toolkit: { slug: 'youtube' } });
        if (path === '/api/v3.1/files/upload/request') return Response.json({
          id: 'file-1', key: S3KEY, new_presigned_url: PRESIGNED, type: 'new' });
        if (path.endsWith('/tools/execute/YOUTUBE_MULTIPART_UPLOAD_VIDEO')) return Response.json({
          data: { id: 'yt-1', privacyStatus: 'private', source: S3KEY } });
        if (path.endsWith('/tools/execute/YOUTUBE_LIST_CHANNEL_VIDEOS'))
          return Response.json({ data: { items: [] } });
        if (path === '/api/v3/tools') return Response.json({ items: [{
          slug: 'YOUTUBE_LIST_CHANNEL_VIDEOS', name: 'List channel videos', toolkit: { slug: 'youtube' } }] });
        if (path === '/api/v3.1/tools/execute/proxy') return Response.json({ status: 200, data: {
          kind: 'youtubeAnalytics#resultTable',
          columnHeaders: [{ name: 'views', columnType: 'METRIC', dataType: 'INTEGER' }],
          rows: [[1234]] } });
        throw new Error(`unexpected request ${href}`);
      });
      const daemon = daemonWith(fakeRegistry([]).client,
        new ComposioApps('composio-project-key', transport as typeof fetch), objects);
      const upload = (objectId: string) => daemon.execute('executeAppTool', { ...turn,
        appId: YOUTUBE_APP, tool: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO',
        arguments: { title: 'Song', videoFile: { beelineObjectId: objectId } } }, HELPER);
      return { daemon, upload, calls, transport, getObject };
    }

    it.each(['local path', 'broken tool', 'Room object', 'provider 5xx', 'network', 'upload PUT'])(
      'Reproduction APP-FILE-1: daemon HTTP handles %s with the correct capture count', async (failure) => {
        const { daemon, transport, calls } = await youtubeRoom();
        const original = transport.getMockImplementation()!;
        transport.mockImplementation(async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith('/tools/execute/YOUTUBE_MULTIPART_UPLOAD_VIDEO')) {
            if (failure === 'local path') return Response.json({ error: 'storage returned HTTP 404' });
            if (failure === 'provider 5xx') return Response.json({ message: 'provider unavailable' }, { status: 503 });
            if (failure === 'network') throw new Error('network failed');
          }
          if (failure === 'upload PUT' && init?.method === 'PUT') return new Response(null, { status: 503 });
          return original(url, init);
        });
        const server = createBeelineServer({ database,
          phone: new PhoneService(database, 'http://placeholder'), daemon, live: new LiveHub(),
          mediaMaximumBytes: 1,
          auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        vi.mocked(captureServerError).mockClear();
        try {
          const response = await fetch(`${origin}/v1/daemon/operations/executeAppTool`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer bdt_fixture-token-0001' },
            body: JSON.stringify({ ...turn, appId: YOUTUBE_APP,
              tool: failure === 'broken tool' ? 'YOUTUBE_UPLOAD_VIDEO' : 'YOUTUBE_MULTIPART_UPLOAD_VIDEO',
              arguments: { title: 'Song', videoFile: failure === 'local path'
                ? '/tmp/video.mp4' : { beelineObjectId: IN_ROOM } } }),
          });
          const result = await response.json();
          console.log(`Reproduction APP-FILE-1: ${failure} → HTTP ${response.status}, captures=${vi.mocked(captureServerError).mock.calls.length}, ${JSON.stringify(result)}`);
          const refused = failure === 'local path' || failure === 'broken tool';
          expect(response.status).toBe(refused ? 400 : failure === 'Room object' ? 200 : 503);
          expect(captureServerError).toHaveBeenCalledTimes(refused || failure === 'Room object' ? 0 : 1);
          if (failure === 'Room object') expect(result).toMatchObject({ status: 'executed', data: { id: 'yt-1' } });
          if (failure === 'local path') {
            expect(result.error).toContain('videoFile');
            expect(result.error).toContain('staged Room object');
            expect(transport.mock.calls.some(([url, init]) =>
              init?.method === 'POST' && String(url).includes('/tools/execute/'))).toBe(false);
            expect(calls.some(call => call.method === 'PUT')).toBe(false);
          }
        } finally {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    it('uploads a Room video: the server stages it and the agent sees no key, URL or s3key', async () => {
      const { upload, calls } = await youtubeRoom();
      const result = await upload(IN_ROOM);
      expect(result).toEqual({ status: 'executed',
        data: { id: 'yt-1', privacyStatus: 'private', source: '[staged file]' } });
      expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        'GET /api/v3/connected_accounts/ca_youtube',
        'GET /api/v3/connected_accounts/ca_youtube',
        'GET /api/v3/tools/YOUTUBE_MULTIPART_UPLOAD_VIDEO',
        'POST /api/v3.1/files/upload/request',
        'PUT /uploads/youtube/staged-fixture.mp4',
        'POST /api/v3/tools/execute/YOUTUBE_MULTIPART_UPLOAD_VIDEO',
      ]);
      expect(calls[3]!.body).toMatchObject({ toolkit_slug: 'youtube',
        tool_slug: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO', filename: 'song-take-2.mp4', mimetype: 'video/mp4' });
      expect(calls[4]!.body).toEqual(VIDEO);
      expect((calls[5]!.body as { arguments: unknown }).arguments).toEqual({ title: 'Song',
        videoFile: { name: 'song-take-2.mp4', mimetype: 'video/mp4', s3key: S3KEY } });
      const returned = JSON.stringify(result);
      for (const hidden of ['composio-project-key', S3KEY, PRESIGNED, 'composio-files'])
        expect(returned).not.toContain(hidden);
    });

    it('refuses YOUTUBE_UPLOAD_VIDEO and points the agent to the multipart tool', async () => {
      const { daemon, calls } = await youtubeRoom();
      await expect(daemon.execute('executeAppTool', { ...turn, appId: YOUTUBE_APP,
        tool: 'YOUTUBE_UPLOAD_VIDEO',
        arguments: { title: 'Song', videoFile: { beelineObjectId: IN_ROOM } } }, HELPER))
        .rejects.toThrow('use YOUTUBE_MULTIPART_UPLOAD_VIDEO instead');
      expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        'GET /api/v3/connected_accounts/ca_youtube']);
    });

    it('refuses an oversize Room file with no Composio request', async () => {
      const { upload, transport, getObject } = await youtubeRoom();
      await expect(upload(HUGE)).rejects.toThrow('Room file is larger than the 128 MB app tool limit');
      expect(transport).not.toHaveBeenCalled();
      expect(getObject).not.toHaveBeenCalled();
    });

    it('refuses a file from another Room or a missing object with no Composio request', async () => {
      const { upload, transport } = await youtubeRoom();
      await expect(upload(ELSEWHERE)).rejects.toThrow(`Room file ${ELSEWHERE} is not in this Room`);
      await expect(upload('99999999-9999-4999-8999-999999999999'))
        .rejects.toThrow('is not in this Room');
      await expect(upload('not-a-uuid')).rejects.toThrow('Room file not-a-uuid is not in this Room');
      expect(transport).not.toHaveBeenCalled();
    });

    it('keeps the API key out of a connection check error the provider echoes', async () => {
      const transport = vi.fn(async () =>
        Response.json({ message: 'account rejected key composio-project-key' }, { status: 401 }));
      await youtubeRoom();
      const daemon = daemonWith(fakeRegistry([]).client,
        new ComposioApps('composio-project-key', transport as typeof fetch));
      const error = await daemon.execute('executeAppTool', { ...turn, appId: YOUTUBE_APP,
        tool: 'YOUTUBE_LIST_CHANNEL_VIDEOS', arguments: {} }, HELPER).catch((e: unknown) => e as Error);
      expect(error.message).toBe('App provider request failed (401): account rejected key [redacted]');
      expect(transport).toHaveBeenCalledOnce();
    });

    it('runs a tool without Room files exactly as before', async () => {
      const { daemon, calls, getObject } = await youtubeRoom();
      await expect(daemon.execute('executeAppTool', { ...turn, appId: YOUTUBE_APP,
        tool: 'YOUTUBE_LIST_CHANNEL_VIDEOS', arguments: { maxResults: 5 } }, HELPER))
        .resolves.toEqual({ status: 'executed', data: { items: [] } });
      expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET', 'POST']);
      expect(calls[3]!.body).toEqual({ connected_account_id: 'ca_youtube', user_id: OWNER,
        arguments: { maxResults: 5 }, version: '20260930_00' });
      expect(getObject).not.toHaveBeenCalled();
    });

    it('lists and runs the YouTube Analytics report for the connected channel without a Google token', async () => {
      const { daemon, calls } = await youtubeRoom();
      const listed = await daemon.execute('listAppTools', { ...turn, appId: YOUTUBE_APP }, HELPER);
      expect(listed.tools.map((tool: { slug: string }) => tool.slug))
        .toEqual(['BEELINE_YOUTUBE_ANALYTICS_REPORT', 'YOUTUBE_LIST_CHANNEL_VIDEOS']);
      calls.length = 0;
      const result = await daemon.execute('executeAppTool', { ...turn, appId: YOUTUBE_APP,
        tool: 'BEELINE_YOUTUBE_ANALYTICS_REPORT',
        arguments: { startDate: '2026-09-06', endDate: '2026-10-03', metrics: 'views' } }, HELPER);
      expect(result).toEqual({ status: 'executed', data: {
        columnHeaders: [{ name: 'views', columnType: 'METRIC', dataType: 'INTEGER' }], rows: [[1234]] } });
      expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        'GET /api/v3/connected_accounts/ca_youtube',
        'GET /api/v3/connected_accounts/ca_youtube',
        'POST /api/v3.1/tools/execute/proxy',
      ]);
      expect(calls[2]!.body).toMatchObject({ connected_account_id: 'ca_youtube',
        endpoint: 'https://youtubeanalytics.googleapis.com/v2/reports', method: 'GET' });
      expect(JSON.stringify(calls[2]!.body)).not.toMatch(/authorization|bearer|access_token/i);
    });
  });

  async function publishFlySignIn() {
    let connectorId = '';
    await vi.waitFor(async () => {
      connectorId = (await database.query<{ id: string }>(`SELECT id FROM workspace_connectors WHERE registry_server_name='io.fly/company-mcp'`)).rows[0]?.id ?? '';
      expect(connectorId).not.toBe('');
    });
    await database.query(`UPDATE workspace_connectors SET sign_in=$2::jsonb WHERE id=$1`,
      [connectorId, JSON.stringify({ method: 'oauth', url: 'https://fly.io/mcp/oauth/authorize?fixture=1', attemptId: 'proof' })]);
  }

  it('Reproduction MCP-DISCOVERY-1: offers Fly on its service page and replaces only an explicitly selected Squire route, retaining keys', async () => {
    await connectSquire();
    const keys = Array.from({ length: 6 }, (_, index) => ({ reference: `vault:fly-${index}`,
      service: 'fly', label: `Fly key ${index}`, fieldNames: ['access_token'], allowedHosts: ['api.fly.io'],
      createdAt: 1, stale: false, state: 'active' as const }));
    await applyVaultList(database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, keys);
    const registry = fakeRegistry([]);
    const discovery = new CompanyMcpDiscovery(async () => ({ status: 200,
      body: JSON.stringify({ resource: 'https://mcp.fly.io', authorization_servers: ['https://fly.io/mcp/oauth'] }) }));
    registry.client.companies.discover = discovery.discover.bind(discovery);
    const provider = fakeComposio(); provider.searchToolkits = vi.fn(async () => []);
    const daemon = daemonWith(registry.client, provider);
    const original = await daemon.execute('connectApp', { ...turn, app: 'fly', reason: 'Use Fly' }, HELPER);
    expect(original).toMatchObject({ transport: 'squire-api', connectionReference: 'vault:fly-0' });
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client, provider);
    await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    await vi.waitFor(async () => expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).companies?.rows.find(row => row.id === 'fly')?.mcp).toBeDefined());
    const before = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(before.companies?.rows.find(row => row.id === 'fly')).toMatchObject({ subtitle: '6 keys',
      mcp: { appName: 'Fly.io', registryServerName: 'io.fly/company-mcp' } });
    const results = await phone.execute('searchWorkbenchApps', { query: 'fly' }, OWNER);
    expect(results).toEqual([expect.objectContaining({ name: 'Fly.io', company: expect.objectContaining({ registryServerName: 'io.fly/company-mcp' }) })]);
    const automatic = await daemon.execute('connectApp', { ...turn, app: 'fly', reason: 'Use Fly again' }, HELPER);
    expect(automatic).toMatchObject({ appId: original.appId, transport: 'squire-api', connectionReference: 'vault:fly-0' });
    const manifest = (await discovery.discover('fly'))!;
    const selection = phone.execute('connectWorkbenchApp', { app: 'Fly.io', helperAgentId: HELPER,
      registryServerName: manifest.name, registryVersion: manifest.version }, OWNER);
    await publishFlySignIn();
    const chosen = await selection;
    expect(chosen.authorizationUrl).toBe('https://fly.io/mcp/oauth/authorize?fixture=1');
    expect(chosen).toMatchObject({ appId: original.appId, transport: 'registry-mcp' });
    const after = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    const company = after.companies?.rows.find(row => row.id === 'fly');
    expect(company).toMatchObject({ subtitle: '1 app · 6 keys' });
    expect(company?.mcp).toBeUndefined();
    expect(company?.items.find(item => item.kind === 'connection')).toMatchObject({ title: 'Fly.io', subtitle: 'via Fly MCP' });
    expect(after.connections.map(key => key.reference).sort()).toEqual(keys.map(key => key.reference).sort());
    expect((await database.query(`SELECT reference,state,hosts FROM workspace_connections ORDER BY reference`)).rows)
      .toEqual(keys.map(key => ({ reference: key.reference, state: 'active', hosts: key.allowedHosts })));
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).connections.map(key => key.label).sort())
      .toEqual(keys.map(key => key.label).sort());
    expect((await database.query(`SELECT reason,requested_by FROM workspace_app_routes WHERE transport='registry-mcp'`)).rows)
      .toContainEqual({ reason: 'person selected verified company MCP', requested_by: OWNER });
  });

  it('Reproduction MCP-DISCOVERY-1: offers company discovery to a new person and searches the Registry for non-allowlisted queries', async () => {
    const registry = fakeRegistry([
      { name: 'com.pulsemcp/fly-io', version: '1', title: 'Fly.io', websiteUrl: 'https://fly.io',
        remotes: [{ type: 'streamable-http', url: 'https://evil.test' }] },
      { name: 'io.sentry/mcp', version: '1.2', title: 'Sentry', websiteUrl: 'https://sentry.io',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.sentry.io/mcp' }] },
    ]);
    const discovery = new CompanyMcpDiscovery(async url => url.host === 'mcp.fly.io'
      ? { status: 200, body: JSON.stringify({ resource: 'https://mcp.fly.io', authorization_servers: ['https://fly.io/mcp/oauth'] }) }
      : { status: 404, body: '' });
    registry.client.companies.discover = discovery.discover.bind(discovery);
    const provider = fakeComposio(); provider.searchToolkits = vi.fn(async () => []);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client, provider);
    await phone.execute('searchWorkbenchApps', { query: 'fly' }, OWNER);
    await vi.waitFor(async () => expect((await phone.execute('searchWorkbenchApps', { query: 'fly' }, OWNER)).some(row => row.registryServerName === 'io.fly/company-mcp')).toBe(true));
    const fly = await phone.execute('searchWorkbenchApps', { query: 'fly' }, OWNER);
    expect(fly.filter(row => row.name === 'Fly.io')).toHaveLength(1);
    expect(fly.find(row => row.name === 'Fly.io')).toMatchObject({ company: { registryServerName: 'io.fly/company-mcp' } });
    expect(fly.some(row => row.registryServerName === 'com.pulsemcp/fly-io')).toBe(false);
    await phone.execute('searchWorkbenchApps', { query: 'sentry' }, OWNER);
    await vi.waitFor(async () => expect(await phone.execute('searchWorkbenchApps', { query: 'sentry' }, OWNER))
      .toContainEqual(expect.objectContaining({ name: 'Sentry', registryServerName: 'io.sentry/mcp', registryVersion: '1.2' })));
    expect(registry.transport.mock.calls.some(call => new URL(String(call[0])).searchParams.get('search') === 'sentry')).toBe(true);
    const manifest = (await discovery.discover('fly'))!;
    await expect(phone.execute('connectWorkbenchApp', { app: 'Fly.io', helperAgentId: HELPER,
      registryServerName: 'com.pulsemcp/fly-io', registryVersion: '1' }, OWNER)).rejects.toThrow('official sign-in');
    const selection = phone.execute('connectWorkbenchApp', { app: 'Fly.io', helperAgentId: HELPER,
      registryServerName: manifest.name, registryVersion: manifest.version }, OWNER);
    await publishFlySignIn();
    await expect(selection).resolves.toMatchObject({ transport: 'registry-mcp' });
  });

  it.each(['https://fly.io/mcp/', 'https://mcp.fly.io'])('MCP-URL-1: resolves %s to the provider MCP with saved keys', async query => {
    await connectSquire();
    await applyVaultList(database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
      reference: 'vault:fly', service: 'fly', label: 'Fly key', fieldNames: ['token'], allowedHosts: ['api.fly.io'],
      createdAt: 1, stale: false, state: 'active',
    }]);
    const registry = fakeRegistry([]);
    const discovery = new CompanyMcpDiscovery(async url => url.href === 'https://mcp.fly.io/.well-known/oauth-protected-resource'
      ? { status: 200, body: JSON.stringify({ resource: 'https://mcp.fly.io', authorization_servers: ['https://fly.io/mcp/oauth'] }) }
      : { status: 404, body: '' });
    registry.client.companies.discover = discovery.discover.bind(discovery);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client);
    await phone.execute('searchWorkbenchApps', { query }, OWNER);
    await vi.waitFor(async () => expect(await phone.execute('searchWorkbenchApps', { query }, OWNER))
      .toContainEqual(expect.objectContaining({ registryServerName: 'io.fly/company-mcp' })));
    const results = await phone.execute('searchWorkbenchApps', { query }, OWNER);
    const selected = results.find(row => row.registryServerName === 'io.fly/company-mcp')!;
    const pending = phone.execute('connectWorkbenchApp', { app: selected.name, helperAgentId: HELPER,
      registryServerName: selected.registryServerName, registryVersion: selected.registryVersion }, OWNER);
    await publishFlySignIn();
    await expect(pending).resolves.toMatchObject({ transport: 'registry-mcp', authorizationUrl: expect.stringContaining('https://fly.io/mcp/oauth/') });
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).companies?.rows
      .find(row => row.id === 'fly')?.items.some(item => item.kind === 'key')).toBe(true);
  });

  it('MCP-DISCOVERY-1: cold results never wait for stalled providers; committed discovery is visible from another server', async () => {
    await connectSquire();
    await applyVaultList(database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
      reference: 'vault:fly', service: 'fly', label: 'Fly key', fieldNames: ['token'], allowedHosts: ['api.fly.io'],
      createdAt: 1, stale: false, state: 'active',
    }]);
    let finishProbe!: (value: { status: number; body: string }) => void;
    let finishRegistry!: (value: []) => void;
    const registry = fakeRegistry([]);
    registry.client.search = () => new Promise(resolve => { finishRegistry = resolve; });
    const discovery = new CompanyMcpDiscovery(() => new Promise(resolve => { finishProbe = resolve; }));
    registry.client.companies.discover = discovery.discover.bind(discovery);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client);
    const first = await phone.execute('searchWorkbenchApps', { query: 'fly' }, OWNER);
    expect(first.map(row => row.name)).toEqual(['Fly.io']);
    expect(first[0]?.description).toBe('1 key');
    await vi.waitFor(() => { expect(finishProbe).toBeTypeOf('function'); expect(finishRegistry).toBeTypeOf('function'); });
    const cold = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(cold.companies?.rows.find(row => row.id === 'fly')?.mcp).toBeUndefined();
    finishRegistry([]);
    finishProbe({ status: 200, body: JSON.stringify({ resource: 'https://mcp.fly.io', authorization_servers: ['https://fly.io/mcp/oauth'] }) });
    const other = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client);
    await vi.waitFor(async () => expect((await other.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER))
      .companies?.rows.find(row => row.id === 'fly')?.mcp?.registryServerName).toBe('io.fly/company-mcp'));
    expect(await phone.execute('searchWorkbenchApps', { query: 'fly' }, OWNER)).toEqual([expect.objectContaining({ company: expect.objectContaining({ registryServerName: 'io.fly/company-mcp' }) })]);
  });

  it.each([true, false])('MCP-DISCOVERY-1: hides insightfulpipe Notion when the official Notion server exists (%s)', async official => {
    const thirdParty = { name: 'com.insightfulpipe/notion', version: '1', title: 'Notion',
      description: 'Hosted Notion MCP server', websiteUrl: 'https://insightfulpipe.com',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.insightfulpipe.com/notion' }] };
    const officialServer = { name: 'com.notion/mcp', version: '1.0.1', title: 'Notion', description: 'Official Notion MCP server',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }] };
    const registry = fakeRegistry([thirdParty, ...(official ? [officialServer] : [])]);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client);
    const first = await phone.execute('searchWorkbenchApps', { query: 'notion' }, OWNER);
    expect(first[0]?.name).toBe('Notion');
    await vi.waitFor(async () => expect((await database.query(`SELECT cache_key FROM connector_discovery_cache WHERE cache_key='search:notion'`)).rows).toHaveLength(1));
    const results = await phone.execute('searchWorkbenchApps', { query: 'notion' }, OWNER);
    expect(results[0]?.name).toBe('Notion');
    expect(results.some(row => row.name === 'insightfulpipe.com')).toBe(!official);
    if (official) expect(results).toEqual([expect.objectContaining({ name: 'Notion', registryServerName: 'com.notion/mcp' })]);
    else expect(results.map(row => row.name)).toEqual(['Notion', 'insightfulpipe.com']);
  });

  it('keeps a third-party Registry publisher separate from the company named in its title or website', async () => {
    const registry = fakeRegistry([{ name: 'com.pulsemcp/fly-io', version: '1', title: 'Fly.io',
      websiteUrl: 'https://fly.io', remotes: [{ type: 'streamable-http', url: 'https://third-party.example/mcp' }] }]);
    const daemon = daemonWith(registry.client);
    await daemon.execute('connectMcpServer', { ...turn, serverName: 'com.pulsemcp/fly-io', version: '1', reason: 'Use the third-party server' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.companies?.rows.some(company => company.id === 'fly')).toBe(false);
    expect(view.companies?.rows.find(company => company.id === 'pulsemcp.com')?.items).toHaveLength(1);
  });

  it('keeps an existing Composio route when a person selects an MCP', async () => {
    const registry = fakeRegistry([]); const provider = fakeComposio();
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client, provider);
    const first = await phone.execute('connectWorkbenchApp', { app: 'Slack', helperAgentId: HELPER }, OWNER);
    expect(first).toMatchObject({ transport: 'composio' });
    await expect(phone.execute('connectWorkbenchApp', { app: 'Slack', helperAgentId: HELPER,
      registryServerName: 'com.slack/mcp', registryVersion: '1' }, OWNER)).resolves.toMatchObject({ appId: first.appId, transport: 'composio' });
    expect((await database.query(`SELECT id FROM workspace_connectors WHERE connector_type='registry-mcp'`)).rows).toHaveLength(0);
  });

  it('searches real Workbench services and refuses arbitrary app text before a connection exists', async () => {
    const provider = fakeComposio();
    provider.searchToolkits = vi.fn(async (query: string) => query === 'resend'
      ? [{ slug: 'resend', name: 'Resend', appUrl: 'https://resend.com' }] : []);
    provider.toolkit.mockImplementation(async (slug: string) => {
      if (slug === 'resend') return { slug };
      throw Object.assign(new Error('missing'), { status: 404 });
    });
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await expect(phone.execute('searchWorkbenchApps', { query: 'fuckface' }, OWNER))
      .resolves.toEqual([]);
    await expect(phone.execute('searchWorkbenchApps', { query: 'resend' }, OWNER))
      .resolves.toMatchObject([{ appKey: 'resend', name: 'Resend', domain: 'resend.com', company: { providerId: 'resend', appName: 'Resend' } }]);
    await expect(phone.execute('connectWorkbenchApp', {
      app: 'fuckface', helperAgentId: 'machine-one' }, OWNER))
      .rejects.toThrow('Select an app from search results');
    expect((await database.query('SELECT id FROM workspace_apps')).rows).toEqual([]);
  });

  it('puts official Stripe sign-in first and keeps its other sign-in available', async () => {
    const provider = fakeComposio();
    provider.searchToolkits = vi.fn(async () => [{ slug: 'stripe', name: 'Stripe',
      appUrl: 'https://stripe.com' }]);
    const registry = fakeRegistry([{ name: 'com.stripe/mcp', version: '0.2.4',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.stripe.com' }] }]);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, registry.client, provider);
    await phone.execute('searchWorkbenchApps', { query: 'Stripe' }, OWNER);
    await vi.waitFor(async () => expect((await phone.execute('searchWorkbenchApps', { query: 'Stripe' }, OWNER))[0]?.registryServerName).toBe('com.stripe/mcp'));
    const results = await phone.execute('searchWorkbenchApps', { query: 'Stripe' }, OWNER);
    expect(results).toEqual([
      expect.objectContaining({ appKey: 'stripe', registryServerName: 'com.stripe/mcp', company: expect.objectContaining({
        registryServerName: 'com.stripe/mcp', alternativeRoutes: ['squire-api', 'composio'],
      }) }),
    ]);
  });

  it('offers TikTok through its configured custom Composio sign-in', async () => {
    const provider = fakeComposio();
    provider.searchToolkits = vi.fn(async () => [{ slug: 'tiktok', name: 'TikTok',
      appUrl: 'https://tiktok.com' }]);
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'tiktok');
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await expect(phone.execute('searchWorkbenchApps', { query: 'tiktok' }, OWNER))
      .resolves.toContainEqual(expect.objectContaining({ appKey: 'tiktok', name: 'TikTok' }));
    await expect(phone.execute('connectWorkbenchApp', {
      app: 'TikTok', helperAgentId: 'machine-one', preferredRoute: 'composio',
    }, OWNER)).resolves.toMatchObject({ transport: 'composio' });
    expect(provider.supportsOAuth).toHaveBeenCalledWith('tiktok');
  });

  it('Reproduction R1: retries an existing Squire app absent from the Composio catalog', async () => {
    await connectSquire();
    const provider = fakeComposio();
    provider.toolkit.mockImplementation(async (slug: string) => {
      if (slug === 'hetzner' || slug === 'fuckface')
        throw Object.assign(new Error('missing'), { status: 404 });
      return { slug };
    });
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const started = await daemon.execute('connectApp',
      { ...turn, app: 'Hetzner', reason: 'manage my server' }, HELPER);
    expect(started.transport).toBe('squire-api');
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);

    await expect(phone.execute('connectWorkbenchApp', {
      app: 'Hetzner', helperAgentId: 'machine-one', reconnect: true,
    }, OWNER)).resolves.toMatchObject({ appId: started.appId, transport: 'squire-api' });
    expect((await database.query('SELECT id FROM workspace_apps')).rows)
      .toEqual([{ id: started.appId }]);
    const requests = await database.query<{ text: string }>(
      `SELECT text FROM messages WHERE author_id=$1 AND text LIKE '%Hetzner in my Connectors.'`,
      [OWNER],
    );
    expect(requests.rows.map((row) => row.text))
      .toEqual(['@bee Reconnect Hetzner in my Connectors.']);
    await expect(phone.execute('connectWorkbenchApp', {
      app: 'fuckface', helperAgentId: 'machine-one', reconnect: true,
    }, OWNER)).rejects.toThrow('Select an app from search results');
  });

  it('Reproduction RUNWAY-1: Workbench retries Runway through its helper instead of browser sign-in', async () => {
    await connectSquire();
    const provider = fakeComposio();
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    const first = await phone.execute('connectWorkbenchApp', {
      workspaceId: WORKSPACE, app: 'Runway', helperAgentId: 'machine-one',
    }, OWNER);
    expect(first.transport).toBe('squire-api');
    let wrongResult = '';
    try { await phone.execute('beginAppSignIn', { appId: first.appId }, OWNER); }
    catch (error) { wrongResult = (error as Error).message; }
    console.log(`Reproduction RUNWAY-1: Connect Runway → ${first.transport}; browser retry → ${wrongResult}`);
    expect(wrongResult).toBe('This app connects through Trusty Squire. Reconnect it from Connectors.');
    expect(provider.link).not.toHaveBeenCalled();
    await phone.execute('connectWorkbenchApp', {
      workspaceId: WORKSPACE, app: 'Runway', helperAgentId: 'machine-one', reconnect: true,
    }, OWNER);
    const requests = await database.query<{ text: string }>(
      `SELECT text FROM messages WHERE author_id=$1 AND text LIKE '%Runway in my Connectors.' ORDER BY created_at`, [OWNER],
    );
    expect(requests.rows.map(row => row.text)).toEqual([
      '@bee Connect Runway in my Connectors.', '@bee Reconnect Runway in my Connectors.',
    ]);
    console.log('RUNWAY-1 demonstrated: retry sent Reconnect Runway to the helper; no browser sign-in link requested');
  });

  it('lets a person connect from Workbench by handing the sign-in to their agent', async () => {
    await connectSquire();
    const phone = new PhoneService(
      database,
      'http://placeholder',
      undefined,
      undefined,
      undefined,
      false,
      database,
      undefined,
      undefined,
      fakeRegistry([]).client,
      { supportsOAuth: async () => false,
        toolkit: async () => ({ slug: 'resend' }) } as ComposioApps,
    );
    const result = await phone.execute(
      'connectWorkbenchApp',
      { workspaceId: WORKSPACE, app: 'Resend', helperAgentId: 'machine-one' },
      OWNER,
    );
    expect(result).toMatchObject({
      status: 'connecting',
      transport: 'squire-api',
      route: 'squire-api',
    });
    const asked = await database.query<{ text: string; author_id: string }>(
      `SELECT m.text,m.author_id FROM messages m JOIN rooms r ON r.id=m.room_id
       WHERE r.direct_participants IS NOT NULL AND m.author_id=$1`,
      [OWNER],
    );
    expect(asked.rows).toEqual([
      { text: '@bee Connect Resend in my Connectors.', author_id: OWNER },
    ]);
    const command = await database.query<{ agent_id: string; state: string }>(
      `SELECT agent_id,state FROM agent_commands WHERE source_message_id<>'app-source'`,
    );
    expect(command.rows).toEqual([{ agent_id: HELPER, state: 'pending' }]);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.apps).toEqual([]);
    expect((await database.query(`SELECT app_key FROM workspace_apps WHERE owner_identity_id=$1`, [OWNER])).rows)
      .toEqual([{ app_key: 'resend' }]);
  });

  it('treats a missing upstream account as not connected so reconnect issues a fresh link', async () => {
    // A real provider boundary: the stored account id 404s upstream, exactly
    // like the production account that died after the #1945 config change.
    const transport = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      if (/^\/api\/v3\/connected_accounts\/[^/]+$/.test(parsed.pathname) &&
          (method === 'GET' || method === 'DELETE'))
        return Response.json({ error: 'Connected account "ca_gone" not found' }, { status: 404 });
      const toolkit = /^\/api\/v3\/toolkits\/([^/?]+)/.exec(parsed.pathname)?.[1];
      if (toolkit) return Response.json({ slug: toolkit, enabled: true,
        composio_managed_auth_schemes: ['OAUTH2'] });
      if (parsed.pathname === '/api/v3/auth_configs' && method === 'GET') {
        const slug = parsed.searchParams.get('toolkit_slug') ?? '';
        // YouTube signs in only through the operator's custom OAuth2 config.
        return Response.json({ items: [{ id: `ac_${slug}`, toolkit: { slug },
          auth_scheme: 'OAUTH2', is_composio_managed: slug !== 'youtube', status: 'ENABLED' }] });
      }
      if (parsed.pathname === '/api/v3/connected_accounts/link')
        return Response.json({ redirect_url: 'https://app.composio.dev/connect/fixture',
          connected_account_id: 'ca_fixture',
          expires_at: new Date(Date.now() + 600_000).toISOString() }, { status: 201 });
      throw new Error(`unexpected request ${method} ${parsed.pathname}`);
    });
    const provider = new ComposioApps('fixture-only', transport as typeof fetch);
    const registry = fakeRegistry([]).client;
    const daemon = daemonWith(registry, provider);
    const seed = async (appId: string, appKey: string, routeId: string, name: string) => {
      await database.query(
        `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,
           transport,route,state,composio_account_id)
         VALUES($1,$2,$3,$4,$5,'composio','composio','active','ca_gone')`,
        [appId, WORKSPACE, OWNER, appKey, name],
      );
      await database.query(
        `INSERT INTO workspace_app_routes(id,app_id,route,transport,reason,requested_by)
         VALUES($1,$2,'composio','composio','seeded stale fixture',$3)`,
        [routeId, appId, OWNER],
      );
    };

    // YouTube is the exact live production symptom.
    const youtubeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await seed(youtubeId, 'youtube', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'YouTube');

    // AC-2: the Workbench row names the actual next step, never the generic
    // could-not-be-checked error.
    const appBefore = (await readOwnerApps(database, OWNER, provider))[0]!;
    expect(appBefore).toMatchObject({ status: 'error',
      errorMessage: 'App connection was not found. Sign in again.' });
    expect(appBefore.errorMessage).not.toBe('App connection could not be checked');

    // AC-3: the agent-side connect_app(reconnect:true) settles on
    // needs_sign_in against the STILL-stale row (the link arrives only when
    // the person taps the connection card) instead of the error loop.
    const daemonOutcome = await daemon.execute('connectApp', { ...turn, app: 'YouTube',
      reason: 'post the launch notes', reconnect: true }, HELPER);
    expect(daemonOutcome.status).toBe('needs_sign_in');
    expect((await database.query<{ composio_account_id: string | null }>(
      `SELECT composio_account_id FROM workspace_apps WHERE id=$1`, [youtubeId],
    )).rows[0]?.composio_account_id).toBe('ca_gone'); // still stale: the card path issues no link

    // The phone path: beginComposioAppSignIn returns a fresh authorizationUrl
    // and replaces the stale id in the same transaction (the Workbench
    // "Connect youtube" tap that failed with the 404 before the fix).
    const opened = await beginComposioAppSignIn(database, provider, OWNER, youtubeId);
    expect(opened.authorizationUrl).toBe('https://app.composio.dev/connect/fixture');
    const after = (await database.query<{ composio_account_id: string | null;
      composio_link_expires_at: string | null }>(
      `SELECT composio_account_id,composio_link_expires_at FROM workspace_apps WHERE id=$1`,
      [youtubeId],
    )).rows[0]!;
    expect(after.composio_account_id).toBe('ca_fixture'); // the stale id was replaced
    expect(after.composio_link_expires_at).not.toBeNull();

    // The front door's phone reconnect issues the fresh link as well.
    const slackId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await seed(slackId, 'slack', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Slack');
    const resumed = await connectApp(database, registry, {
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      machineId: 'machine-one',
      helperAgentId: HELPER,
      requestedBy: OWNER,
      app: 'Slack',
      reconnect: true,
      composio: provider,
    });
    expect(resumed).toMatchObject({ status: 'needs_sign_in', transport: 'composio' });
    expect(resumed.authorizationUrl).toBe('https://app.composio.dev/connect/fixture');
    const slackRow = (await database.query<{ composio_account_id: string | null }>(
      `SELECT composio_account_id FROM workspace_apps WHERE id=$1`, [slackId],
    )).rows[0]!;
    expect(slackRow.composio_account_id).toBe('ca_fixture'); // the stale id was replaced
  });

  /**
   * Connects Slack for OWNER and returns its appId, the state the reported
   * feedback-triage run reached before its app step stalled.
   */
  async function connectedSlack(daemon: DaemonService, provider: ComposioApps): Promise<string> {
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OWNER);
    return connected.appId!;
  }

  /**
   * Seeds a saved workflow run and points this turn's command at a handoff
   * wake card for it. `startRequester` is the run's recorded starter (a
   * person for a person-started run, an agent otherwise); `gateAnswerer` adds
   * a newer card answered by that person.
   */
  async function seedWorkflowWake(input: {
    runId: string;
    startRequester: string;
    gateAnswerer?: string;
  }): Promise<void> {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,'started workflow','system','workflow-handoff',$4::jsonb)`,
      [input.runId, ROOM, HELPER, JSON.stringify({ runId: input.runId, seq: 0, runStatus: 'live',
        workflowSlug: 'sweep', workflowVersion: 1, requesterId: input.startRequester, toState: 'work' })],
    );
    const handoffId = `${input.runId}-handoff`;
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,'handed off','system','workflow-handoff',$4::jsonb)`,
      [handoffId, ROOM, HELPER, JSON.stringify({ runId: input.runId, seq: 1,
        workflowSlug: 'sweep', workflowVersion: 1, toState: 'work' })],
    );
    if (input.gateAnswerer) {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
         VALUES($1,$2,$3,'answered gate','system','workflow-handoff',$4::jsonb)`,
        [`${input.runId}-gate`, ROOM, input.gateAnswerer, JSON.stringify({ runId: input.runId, seq: 2,
          workflowSlug: 'sweep', workflowVersion: 1, toState: 'work',
          contents: { decision: 'go', answeredBy: input.gateAnswerer },
          receipt: { exit: { gate: 'go', actorId: input.gateAnswerer } } })],
      );
    }
    await database.query(`UPDATE agent_commands SET root_source_message_id=$1 WHERE id=$2`,
      [handoffId, COMMAND]);
  }

  it('runs an app tool on a handoff wake of a person-started run', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const appId = await connectedSlack(daemon, provider);
    await seedWorkflowWake({ runId: 'wf-person', startRequester: OWNER });
    const used = await daemon.execute('executeAppTool', { ...turn, appId,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER);
    expect(used).toMatchObject({ status: 'executed' });
    expect((await database.query<{ requester_id: string }>(
      `SELECT requester_id FROM workspace_app_usage`)).rows[0]?.requester_id).toBe(OWNER);
  });

  it('runs an app tool when a person answered the run\u2019s latest gate', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const appId = await connectedSlack(daemon, provider);
    await seedWorkflowWake({ runId: 'wf-gate', startRequester: HELPER, gateAnswerer: OWNER });
    await expect(daemon.execute('executeAppTool', { ...turn, appId,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER))
      .resolves.toMatchObject({ status: 'executed' });
  });

  it('Reproduction wake-app: runs its owner’s app on an agent-only wake', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const appId = await connectedSlack(daemon, provider);
    await seedWorkflowWake({ runId: 'wf-agent', startRequester: HELPER });
    await expect(daemon.execute('executeAppTool', { ...turn, appId,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER))
      .resolves.toMatchObject({ status: 'executed' });
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect((await database.query(`SELECT requester_id FROM workspace_app_usage`)).rows[0]?.requester_id).toBe(OWNER);
  });

  it.each([['schedule', SCHEDULE_SCHEDULER_ID], ['subscribed_event', SYSTEM_IDENTITY_ID], ['subscribed_event', HELPER]])(
    'Reproduction wake-app: %s uses the owner app and records the owner as requester (%s)', async (reason, author) => {
      const provider = fakeComposio();
      const daemon = daemonWith(fakeRegistry([]).client, provider);
      const appId = await connectedSlack(daemon, provider);
      await database.query(`INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES($1,'human','Wake',true) ON CONFLICT DO NOTHING`, [author]);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('app-wake',$1,$2,'Wake')`, [ROOM, author]);
      await database.query(`UPDATE agent_commands SET root_source_message_id='app-wake',reason=$1 WHERE id=$2`, [reason, COMMAND]);
      await expect(daemon.execute('executeAppTool', { ...turn, appId,
        tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER))
        .resolves.toMatchObject({ status: 'executed' });
      expect(provider.execute).toHaveBeenCalledTimes(1);
      expect((await database.query(`SELECT requester_id FROM workspace_app_usage`)).rows[0]?.requester_id).toBe(OWNER);
    });

  it('Reproduction wake-app: an agent-only wake cannot borrow another person’s app', async () => {
    const provider = fakeComposio();
    const daemon = daemonWith(fakeRegistry([]).client, provider);
    const appId = await connectedSlack(daemon, provider);
    const other = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [other]);
    await database.query(`UPDATE agents SET owner_id=$1 WHERE agent_id=$2`, [other, HELPER]);
    await seedWorkflowWake({ runId: 'wf-foreign-app', startRequester: HELPER });
    await expect(daemon.execute('executeAppTool', { ...turn, appId,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER))
      .rejects.toThrow('App use requires a person’s request');
    expect(provider.execute).not.toHaveBeenCalled();
  });
});
