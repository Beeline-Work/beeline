import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { McpRegistryClient } from './mcp-registry.js';
import { applyVaultList } from './workbench.js';
import { readOwnerApps, resolveAppRoute, type AppRouteProbes } from './app-connections.js';
import { APP_FILE_MAXIMUM_BYTES, ComposioApps } from './composio-apps.js';
import { ObjectService } from './object-service.js';
import type { ObjectStorage } from './object-storage.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
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
  return { client: new McpRegistryClient(transport as unknown as typeof fetch), transport };
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

  it('uses Squire only when managed OAuth is unsupported', async () => {
    await expect(
      resolveAppRoute({ reconnect: false, noApi: false }, probes()),
    ).resolves.toMatchObject({ kind: 'route', route: 'squire-api', transport: 'squire-api' });
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
    // A reconnect starts from the top again.
    await expect(
      resolveAppRoute({ existing, reconnect: true, noApi: false }, p),
    ).resolves.toMatchObject({
      kind: 'route',
      route: 'squire-api',
    });
    expect(p.workbench).toHaveBeenCalledTimes(1);
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
  } as ComposioApps, objects?: ObjectService) =>
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
    );

  function fakeComposio() {
    let active = false;
    const provider = {
      supportsOAuth: vi.fn(async (toolkit: string) => ['slack', 'gmail'].includes(toolkit)),
      link: vi.fn(async (_person: string, _toolkit: string) => ({
        url: 'https://app.composio.dev/connect/fixture', accountId: 'ca_fixture',
        expiresAt: new Date(Date.now() + 600_000),
      })),
      account: vi.fn(async (_account: string, person: string) => active && person === OWNER),
      completeAuth: vi.fn(async (_session: string, person: string) => {
        if (person !== OWNER) throw new Error('App provider request failed (400)');
        active = true;
        return { accountId: 'ca_fixture', toolkit: 'slack' };
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
    const id = '33333333-3333-4333-8333-333333333333';
    await database.query(
      `INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,connector_type,
         helper_agent_id,machine_id,status,connected_at)
       VALUES($1,$2,$3,'trusty-squire',$4,'machine-one','connected',now())`,
      [id, WORKSPACE, OWNER, HELPER],
    );
    return id;
  }

  const routes = async () =>
    (
      await database.query<{ route: string; transport: string }>(
        `SELECT route,transport FROM workspace_app_routes ORDER BY created_at, id`,
      )
    ).rows;

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
    expect(JSON.stringify(card)).not.toContain('composio');
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined,
      undefined, false, database, undefined, undefined, fakeRegistry([]).client, provider);
    const pendingRoom = await phone.readRoom(ROOM, OWNER);
    expect(pendingRoom?.messages.find((message) => message.appSignIn?.appId === first.appId)
      ?.appSignIn).toMatchObject({ status: 'pending', continuation });
    const opened = await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    expect(opened.authorizationUrl).toBe('https://app.composio.dev/connect/fixture');
    expect(provider.link).toHaveBeenCalledWith(OWNER, 'slack');
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture' }, OWNER);
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
      .rejects.toThrow(/unavailable for this person/);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    await expect(phone.execute('completeAppSignIn', { sessionUri: 'session-fixture' }, OTHER))
      .rejects.toThrow(/request failed/);
    expect((await database.query(`SELECT 1 FROM workspace_apps WHERE id=$1 AND
      composio_link_expires_at IS NOT NULL`, [connected.appId])).rowCount).toBe(1);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture' }, OWNER);

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
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture' }, OWNER);
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
    await expect(daemon.execute('authorizeResourceCall', { ...turn,
      target: 'squire', appKeys: ['slack'] }, HELPER))
      .resolves.toEqual({ allowed: false });
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
    expect((blocked as { next: string }).next).toContain('offer_connector');
    const squireId = await connectSquire();
    const connecting = await daemon.execute(
      'connectApp',
      { ...turn, app: 'Resend', reason: 'send' },
      HELPER,
    );
    expect(connecting).toMatchObject({ status: 'connecting', transport: 'squire-api' });
    expect((connecting as { next: string }).next).toContain('store_credential (service "resend")');
    await applyVaultList(database, { id: squireId, owner_identity_id: OWNER }, [
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

  it('reuses an existing Workbench key without searching the Registry', async () => {
    const registry = fakeRegistry([]);
    const squireId = await connectSquire();
    await applyVaultList(database, { id: squireId, owner_identity_id: OWNER }, [
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







  it('refuses a Squire call that names a disconnected app or two apps, whatever else it names', async () => {
    const squireId = await connectSquire();
    const daemon = daemonWith(fakeRegistry([linearServer]).client);
    const linear = (await daemon.execute(
      'connectApp',
      { ...turn, app: 'Linear', reason: 'file the bug' },
      HELPER,
    )) as { appId: string };
    await applyVaultList(database, { id: squireId, owner_identity_id: OWNER }, [
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
    await daemon.execute('connectApp', { ...turn, app: 'Stripe', reason: 'refund' }, HELPER);
    // Every decision is approved, so only the gate's own rule can refuse.
    await database.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [HELPER]);
    const mixed = { ...turn, target: 'squire', operation: 'use_credential' };
    // Two connected apps in one call: no single decision or ledger to charge.
    await expect(
      daemon.execute('authorizeResourceCall', { ...mixed, appKeys: ['linear', 'stripe'] }, HELPER),
    ).resolves.toEqual({ allowed: false });
    // Stripe active, Linear disconnected: Stripe's approval never covers Linear.
    const phone = new PhoneService(database, 'http://placeholder');
    await phone.execute(
      'disconnectWorkbenchApp',
      { workspaceId: WORKSPACE, appId: linear.appId },
      OWNER,
    );
    for (const appKeys of [['linear', 'stripe'], ['stripe', 'linear'], ['linear']])
      await expect(
        daemon.execute('authorizeResourceCall', { ...mixed, appKeys }, HELPER),
      ).resolves.toEqual({ allowed: false });
    expect((await database.query(`SELECT 1 FROM workspace_app_usage`)).rowCount).toBe(0);
    // The one-app call still answers to its own app.
    await expect(
      daemon.execute('authorizeResourceCall', { ...mixed, appKeys: ['stripe'] }, HELPER),
    ).resolves.toMatchObject({ allowed: true });
    const usage = await database.query<{ app_key: string }>(
      `SELECT a.app_key FROM workspace_app_usage u JOIN workspace_apps a ON a.id=u.app_id`,
    );
    expect(usage.rows).toEqual([{ app_key: 'stripe' }]);
  });

  it('does not treat another owner’s connected app as this helper’s resource', async () => {
    const other = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other','other')`, [other]);
    await database.query(
      `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
       VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,$2,'linear','Linear','squire-api','squire-api')`,
      [WORKSPACE, other],
    );
    const daemon = daemonWith(fakeRegistry([]).client);
    await expect(
      daemon.execute('authorizeResourceCall', { ...turn, target: 'squire', appKeys: ['linear'] }, HELPER),
    ).resolves.toEqual({ allowed: false });
    expect((await database.query(`SELECT id FROM agent_grants`)).rows).toEqual([]);
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
        if (path.endsWith('/tools/YOUTUBE_UPLOAD_VIDEO')) return Response.json({
          slug: 'YOUTUBE_UPLOAD_VIDEO', version: '20260930_00', toolkit: { slug: 'youtube' },
          input_parameters: { type: 'object', properties: { title: { type: 'string' },
            videoFile: { type: 'object', file_uploadable: true } } } });
        if (path.endsWith('/tools/YOUTUBE_LIST_CHANNEL_VIDEOS')) return Response.json({
          slug: 'YOUTUBE_LIST_CHANNEL_VIDEOS', version: '20260930_00', toolkit: { slug: 'youtube' } });
        if (path === '/api/v3.1/files/upload/request') return Response.json({
          id: 'file-1', key: S3KEY, new_presigned_url: PRESIGNED, type: 'new' });
        if (path.endsWith('/tools/execute/YOUTUBE_UPLOAD_VIDEO')) return Response.json({
          data: { id: 'yt-1', privacyStatus: 'private', source: S3KEY } });
        if (path.endsWith('/tools/execute/YOUTUBE_LIST_CHANNEL_VIDEOS'))
          return Response.json({ data: { items: [] } });
        throw new Error(`unexpected request ${href}`);
      });
      const daemon = daemonWith(fakeRegistry([]).client,
        new ComposioApps('composio-project-key', transport as typeof fetch), objects);
      const upload = (objectId: string) => daemon.execute('executeAppTool', { ...turn,
        appId: YOUTUBE_APP, tool: 'YOUTUBE_UPLOAD_VIDEO',
        arguments: { title: 'Song', videoFile: { beelineObjectId: objectId } } }, HELPER);
      return { daemon, upload, calls, transport, getObject };
    }

    it('uploads a Room video: the server stages it and the agent sees no key, URL or s3key', async () => {
      const { upload, calls } = await youtubeRoom();
      const result = await upload(IN_ROOM);
      expect(result).toEqual({ status: 'executed',
        data: { id: 'yt-1', privacyStatus: 'private', source: '[staged file]' } });
      expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        'GET /api/v3/connected_accounts/ca_youtube',
        'GET /api/v3/connected_accounts/ca_youtube',
        'GET /api/v3/tools/YOUTUBE_UPLOAD_VIDEO',
        'POST /api/v3.1/files/upload/request',
        'PUT /uploads/youtube/staged-fixture.mp4',
        'POST /api/v3/tools/execute/YOUTUBE_UPLOAD_VIDEO',
      ]);
      expect(calls[3]!.body).toMatchObject({ toolkit_slug: 'youtube',
        tool_slug: 'YOUTUBE_UPLOAD_VIDEO', filename: 'song-take-2.mp4', mimetype: 'video/mp4' });
      expect(calls[4]!.body).toEqual(VIDEO);
      expect((calls[5]!.body as { arguments: unknown }).arguments).toEqual({ title: 'Song',
        videoFile: { name: 'song-take-2.mp4', mimetype: 'video/mp4', s3key: S3KEY } });
      const returned = JSON.stringify(result);
      for (const hidden of ['composio-project-key', S3KEY, PRESIGNED, 'composio-files'])
        expect(returned).not.toContain(hidden);
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
      { supportsOAuth: async () => false } as ComposioApps,
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
      { text: '@bee Connect Resend to my Workbench.', author_id: OWNER },
    ]);
    const command = await database.query<{ agent_id: string; state: string }>(
      `SELECT agent_id,state FROM agent_commands WHERE source_message_id<>'app-source'`,
    );
    expect(command.rows).toEqual([{ agent_id: HELPER, state: 'pending' }]);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.apps).toEqual([
      expect.objectContaining({ appKey: 'resend', name: 'Resend', status: 'connecting' }),
    ]);
  });
});
