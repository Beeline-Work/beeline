import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { McpRegistryClient } from './mcp-registry.js';
import { applyVaultList } from './workbench.js';
import { readOwnerApps, resolveAppRoute, type AppRouteProbes } from './app-connections.js';

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
    const registry = vi.fn(async () => ({ status: 'none' }) as const);
    return { workbench, registry, ...overrides } as AppRouteProbes & {
      workbench: ReturnType<typeof vi.fn>;
      registry: ReturnType<typeof vi.fn>;
    };
  };

  it('reuses a connected Workbench connection before asking the Registry', async () => {
    const p = probes({
      workbench: vi.fn(async () => ({ transport: 'squire-api', reference: 'vault:resend' }) as const),
    });
    const decision = await resolveAppRoute({ reconnect: false, noApi: false }, p);
    expect(decision).toMatchObject({ kind: 'route', route: 'workbench', transport: 'squire-api' });
    expect(p.registry).not.toHaveBeenCalled();
  });

  it('takes the official hosted server before Trusty Squire', async () => {
    const p = probes({
      registry: vi.fn(async () => ({ status: 'official', manifest: linearServer }) as never),
    });
    await expect(resolveAppRoute({ reconnect: false, noApi: false }, p)).resolves.toMatchObject({
      kind: 'route',
      route: 'registry-mcp',
    });
  });

  it('falls to the Squire API route only when no official server exists', async () => {
    await expect(
      resolveAppRoute({ reconnect: false, noApi: false }, probes()),
    ).resolves.toMatchObject({ kind: 'route', route: 'squire-api', transport: 'squire-api' });
  });

  it('never skips past a Registry it could not read', async () => {
    const p = probes({ registry: vi.fn(async () => ({ status: 'unavailable' }) as const) });
    await expect(resolveAppRoute({ reconnect: false, noApi: false }, p)).resolves.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('keeps an existing route — even in error — until an explicit reconnect', async () => {
    const existing = { transport: 'registry-mcp', state: 'active', hasCredential: false } as const;
    const p = probes();
    await expect(
      resolveAppRoute({ existing, reconnect: false, noApi: false }, p),
    ).resolves.toEqual({ kind: 'keep', transport: 'registry-mcp' });
    expect(p.workbench).not.toHaveBeenCalled();
    expect(p.registry).not.toHaveBeenCalled();
    // noApi cannot move a Registry route to the browser.
    await expect(
      resolveAppRoute({ existing, reconnect: false, noApi: true }, p),
    ).resolves.toMatchObject({ kind: 'keep', transport: 'registry-mcp' });
    // A reconnect starts from the top again.
    await expect(resolveAppRoute({ existing, reconnect: true, noApi: false }, p)).resolves.toMatchObject({
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
      resolveAppRoute({ existing: { ...api, hasCredential: true }, reconnect: false, noApi: true }, probes()),
    ).resolves.toMatchObject({ kind: 'keep', transport: 'squire-api' });
  });
});

describe('connect_app', () => {
  let database: PgliteDatabase;

  const daemonWith = (registry: McpRegistryClient) =>
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
    );

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

  it('connects an official hosted server, records the route once, and reuses it', async () => {
    const registry = fakeRegistry([
      { ...linearServer, name: 'io.github.someone/linear' },
      linearServer,
    ]);
    const daemon = daemonWith(registry.client);
    const first = await daemon.execute(
      'connectApp',
      { ...turn, app: 'Linear', reason: 'file the bug' },
      HELPER,
    );
    expect(first).toMatchObject({
      status: 'connecting',
      app: 'Linear',
      appKey: 'linear',
      route: 'registry-mcp',
      transport: 'registry-mcp',
    });
    const connector = await database.query<{
      registry_server_name: string;
      install_command_id: string;
    }>(`SELECT registry_server_name,install_command_id FROM workspace_connectors WHERE id=$1`, [
      (first as { connectorId: string }).connectorId,
    ]);
    // The community server of the same name never wins.
    expect(connector.rows[0]).toEqual({
      registry_server_name: 'app.linear/linear',
      install_command_id: COMMAND,
    });
    const again = await daemon.execute(
      'connectApp',
      { ...turn, app: 'linear.app', reason: 'file the bug' },
      HELPER,
    );
    expect(again).toMatchObject({ status: 'connecting', appId: (first as { appId: string }).appId });
    expect(again).not.toHaveProperty('route');
    expect(await routes()).toEqual([{ route: 'registry-mcp', transport: 'registry-mcp' }]);
    expect((await database.query(`SELECT 1 FROM workspace_apps`)).rowCount).toBe(1);
  });

  it('asks for Trusty Squire before an API route can start, then connects on the vaulted key', async () => {
    const daemon = daemonWith(fakeRegistry([]).client);
    const blocked = await daemon.execute('connectApp', { ...turn, app: 'Resend', reason: 'send' }, HELPER);
    expect(blocked).toMatchObject({ status: 'needs_squire', route: 'squire-api' });
    expect((blocked as { next: string }).next).toContain('offer_connector');
    const squireId = await connectSquire();
    const connecting = await daemon.execute('connectApp', { ...turn, app: 'Resend', reason: 'send' }, HELPER);
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

  it('does not choose any route while the Registry is unreadable', async () => {
    await connectSquire();
    const result = await daemonWith(fakeRegistry([], true).client).execute(
      'connectApp',
      { ...turn, app: 'Linear', reason: 'file the bug' },
      HELPER,
    );
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(await routes()).toEqual([]);
  });

  it('authorizes every route of one app against one decision and one usage ledger', async () => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([linearServer]).client);
    const connected = (await daemon.execute(
      'connectApp',
      { ...turn, app: 'Linear', reason: 'file the bug' },
      HELPER,
    )) as { connectorId: string; appId: string };
    await database.query(
      `UPDATE workspace_connectors SET status='connected',connected_at=now() WHERE id=$1`,
      [connected.connectorId],
    );
    const viaRegistry = await daemon.execute(
      'authorizeResourceCall',
      { ...turn, target: 'registry-mcp:app.linear/linear', operation: 'create_issue' },
      HELPER,
    );
    expect(viaRegistry).toMatchObject({ allowed: false, status: 'pending' });
    // The same app reached through Squire is the same pending decision, not a
    // second route that could be tried instead.
    const viaSquire = await daemon.execute(
      'authorizeResourceCall',
      { ...turn, target: 'squire', appKeys: ['linear'], operation: 'use_credential' },
      HELPER,
    );
    expect(viaSquire).toMatchObject({ allowed: false, grantId: (viaRegistry as { grantId: string }).grantId });
    const grants = await database.query<{ target: string; status: string }>(
      `SELECT target,status FROM agent_grants`,
    );
    expect(grants.rows).toEqual([{ target: 'app:linear', status: 'pending' }]);
    // The route is untouched by the refusal.
    expect(await routes()).toEqual([{ route: 'registry-mcp', transport: 'registry-mcp' }]);

    await database.query(`UPDATE agent_grants SET status='approved',decided_by=$1,decided_at=now()`, [
      OWNER,
    ]);
    await expect(
      daemon.execute(
        'authorizeResourceCall',
        { ...turn, target: 'registry-mcp:app.linear/linear', operation: 'create_issue' },
        HELPER,
      ),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      daemon.execute(
        'authorizeResourceCall',
        { ...turn, target: 'squire', appKeys: ['linear'], operation: 'use_credential' },
        HELPER,
      ),
    ).resolves.toMatchObject({ allowed: true });
    // Discovery does not count as use.
    await daemon.execute(
      'authorizeResourceCall',
      { ...turn, target: 'registry-mcp:app.linear/linear', consume: false, operation: 'tools/list' },
      HELPER,
    );
    const usage = await database.query<{ operation: string; app_id: string }>(
      `SELECT operation,app_id FROM workspace_app_usage ORDER BY created_at, operation`,
    );
    expect(usage.rows.map((row) => row.operation).sort()).toEqual(['create_issue', 'use_credential']);
    expect(new Set(usage.rows.map((row) => row.app_id))).toEqual(new Set([connected.appId]));
    const [app] = await readOwnerApps(database, OWNER);
    expect(app).toMatchObject({ status: 'connected', useCount: 2 });
    // A Squire call for an app nobody connected keeps Squire's own gate.
    await daemon.execute(
      'authorizeResourceCall',
      { ...turn, target: 'squire', appKeys: ['unrelated'] },
      HELPER,
    );
    expect(
      (await database.query(`SELECT 1 FROM agent_grants WHERE target='squire'`)).rowCount,
    ).toBe(1);
  });

  it('disconnect revokes the app’s approvals and refuses its Squire calls; reconnect decides again', async () => {
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([linearServer]).client);
    const phone = new PhoneService(database, 'http://placeholder');
    const connected = (await daemon.execute(
      'connectApp',
      { ...turn, app: 'Linear', reason: 'file the bug' },
      HELPER,
    )) as { connectorId: string; appId: string };
    await daemon.execute(
      'authorizeResourceCall',
      { ...turn, target: 'registry-mcp:app.linear/linear' },
      HELPER,
    );
    await database.query(`UPDATE agent_grants SET status='approved',decided_by=$1,decided_at=now()`, [
      OWNER,
    ]);
    await phone.execute('disconnectWorkbenchApp', { workspaceId: WORKSPACE, appId: connected.appId }, OWNER);
    expect(
      (await database.query<{ status: string }>(`SELECT status FROM agent_grants`)).rows,
    ).toEqual([{ status: 'revoked' }]);
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM workspace_connectors WHERE id=$1`,
          [connected.connectorId],
        )
      ).rows,
    ).toEqual([{ status: 'disconnected' }]);
    await expect(
      daemon.execute(
        'authorizeResourceCall',
        { ...turn, target: 'squire', appKeys: ['linear'] },
        HELPER,
      ),
    ).resolves.toEqual({ allowed: false });
    expect(await readOwnerApps(database, OWNER)).toEqual([]);
    const reconnected = await daemon.execute(
      'connectApp',
      { ...turn, app: 'Linear', reason: 'file the bug' },
      HELPER,
    );
    expect(reconnected).toMatchObject({
      appId: connected.appId,
      route: 'registry-mcp',
      status: 'connecting',
    });
    expect(await routes()).toHaveLength(2);
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
    await phone.execute('disconnectWorkbenchApp', { workspaceId: WORKSPACE, appId: linear.appId }, OWNER);
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

  it('keeps one app, one decision and one ledger across the person’s Workspaces', async () => {
    const OTHER_WORKSPACE = '44444444-4444-4444-8444-444444444444';
    const OTHER_ROOM = '55555555-5555-4555-8555-555555555555';
    const OTHER_HELPER = 'c'.repeat(64);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Garden')`, [OTHER_WORKSPACE]);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Wasp','wasp')`, [
      OTHER_HELPER,
    ]);
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,machine_id,machine_name,yolo_mode)
       VALUES($1,$2,'machine-one','Owner laptop',false)`,
      [OTHER_HELPER, OWNER],
    );
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Garden tools')`,
      [OTHER_ROOM, OTHER_WORKSPACE, OWNER],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [OTHER_WORKSPACE, OWNER, OTHER_HELPER, OTHER_ROOM],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('garden-source',$1,$2,'Connect Linear')`,
      [OTHER_ROOM, OWNER],
    );
    await database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at
       ) VALUES('garden-command',$1,$2,'garden-source','garden-request','input','human_tag',
         'garden-command','garden-source',0,'claimed','garden-generation',now()+interval '10 minutes')`,
      [OTHER_ROOM, OTHER_HELPER],
    );
    const gardenTurn = {
      roomId: OTHER_ROOM,
      requestId: 'garden-request',
      generationId: 'garden-generation',
    };
    await connectSquire();
    const daemon = daemonWith(fakeRegistry([linearServer]).client);
    const first = (await daemon.execute(
      'connectApp',
      { ...turn, app: 'Linear', reason: 'file the bug' },
      HELPER,
    )) as { appId: string; connectorId: string };
    await database.query(
      `UPDATE workspace_connectors SET status='connected',connected_at=now() WHERE id=$1`,
      [first.connectorId],
    );
    const second = await daemon.execute(
      'connectApp',
      { ...gardenTurn, app: 'linear.app', reason: 'triage' },
      OTHER_HELPER,
    );
    expect(second).toMatchObject({ appId: first.appId, status: 'connected' });
    expect(second).not.toHaveProperty('route');
    expect(await routes()).toHaveLength(1);
    expect(
      (await database.query(`SELECT 1 FROM workspace_connectors WHERE connector_type='registry-mcp'`))
        .rowCount,
    ).toBe(1);
    expect(await readOwnerApps(database, OWNER)).toHaveLength(1);
    const phone = new PhoneService(database, 'http://placeholder');
    expect((await phone.execute('readWorkbench', { workspaceId: '' }, OWNER)).apps).toHaveLength(1);
    // The person's server mounts in the other Workspace's Room too, and a call
    // there is the same app: the same app:<key> decision and the same ledger.
    const configuration = await daemon.execute(
      'getAgentConfiguration',
      { agentId: OTHER_HELPER, roomId: OTHER_ROOM },
      OTHER_HELPER,
    );
    expect(configuration.registryMcpRoutes).toEqual([
      expect.objectContaining({ connectorId: first.connectorId, target: 'registry-mcp:app.linear/linear' }),
    ]);
    await daemon.execute(
      'authorizeResourceCall',
      { ...gardenTurn, target: 'registry-mcp:app.linear/linear', operation: 'list_issues' },
      OTHER_HELPER,
    );
    const grants = await database.query<{ target: string }>(`SELECT target FROM agent_grants`);
    expect(grants.rows).toEqual([{ target: 'app:linear' }]);
    await database.query(`UPDATE agent_grants SET status='approved',decided_by=$1,decided_at=now()`, [
      OWNER,
    ]);
    await expect(
      daemon.execute(
        'authorizeResourceCall',
        { ...gardenTurn, target: 'registry-mcp:app.linear/linear', operation: 'list_issues' },
        OTHER_HELPER,
      ),
    ).resolves.toMatchObject({ allowed: true });
    const [app] = await readOwnerApps(database, OWNER);
    expect(app).toMatchObject({ appId: first.appId, useCount: 1 });
    // Disconnecting it once revokes the approval every Workspace was using.
    await phone.execute('disconnectWorkbenchApp', { workspaceId: '', appId: first.appId }, OWNER);
    expect((await database.query<{ status: string }>(`SELECT status FROM agent_grants`)).rows).toEqual([
      { status: 'revoked' },
    ]);
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
    );
    const result = await phone.execute(
      'connectWorkbenchApp',
      { workspaceId: WORKSPACE, app: 'Resend', helperAgentId: 'machine-one' },
      OWNER,
    );
    expect(result).toMatchObject({ status: 'connecting', transport: 'squire-api', route: 'squire-api' });
    const asked = await database.query<{ text: string; author_id: string }>(
      `SELECT m.text,m.author_id FROM messages m JOIN rooms r ON r.id=m.room_id
       WHERE r.direct_participants IS NOT NULL AND m.author_id=$1`,
      [OWNER],
    );
    expect(asked.rows).toEqual([{ text: '@bee Connect Resend to my Workbench.', author_id: OWNER }]);
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
