import { seedSquireMachine } from './test-fixtures/squire-machines.js';
import { phoneFetch, describe, expect, it, vi, randomBytes, LinkAgentWallet, migrate, DaemonService, PhoneService, LiveHub, ConnectionPresence, applyVaultList, recordSquireSignIn, readOwnerApps, resolveAppRoute, createBeelineServer, captureServerError, WORKSPACE, ROOM, OWNER, HELPER, COMMAND, GENERATION, turn, linearServer, fakeRegistry, fixtureScope1, fixtureScope2, type AddressInfo, type TokenAuth } from './test-support-app-connections.integration.test-support.js';

describe('the app route order', () => {
const scope1 = fixtureScope1();


  it('reuses a connected API credential when OAuth is unsupported', async () => {
    const p = scope1.probes({
      workbench: vi.fn(
        async () => ({ transport: 'squire-api', reference: 'vault:resend' }) as const,
      ),
    });
    const decision = await resolveAppRoute({ reconnect: false, noApi: false }, p);
    expect(decision).toMatchObject({ kind: 'route', route: 'workbench', transport: 'squire-api' });
    expect(p.composio).toHaveBeenCalledTimes(1);
  });



  it.each([false, true])('TIKTOK-ROUTE-1: OAuth supersedes a stored API route on reconnect=%s', async reconnect => {
    const p = scope1.probes({ composio: vi.fn(async () => 'supported' as const) });
    await expect(resolveAppRoute({ existing: { transport: 'squire-api', state: 'active', hasCredential: true },
      reconnect, noApi: false }, p)).resolves.toMatchObject({ kind: 'route', transport: 'composio' });
  });

  it('TIKTOK-ROUTE-1: OAuth wins over a discovered vault credential', async () => {
    const p = scope1.probes({ workbench: vi.fn(async () => ({ transport: 'squire-api', reference: 'vault:developer' }) as const),
      composio: vi.fn(async () => 'supported' as const) });
    await expect(resolveAppRoute({ reconnect: false, noApi: false }, p))
      .resolves.toMatchObject({ kind: 'route', transport: 'composio' });
  });


  it('uses managed OAuth when supported and never probes another path', async () => {
    const p = scope1.probes({ composio: vi.fn(async () => 'supported' as const) });
    await expect(resolveAppRoute({ reconnect: false, noApi: false }, p))
      .resolves.toMatchObject({ kind: 'route', route: 'composio', transport: 'composio' });
  });


  it('fails closed when OAuth support cannot be checked', async () => {
    const p = scope1.probes({ composio: vi.fn(async () => 'unavailable' as const) });
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
      scope1.probes({ composio: vi.fn(async () => 'withheld' as const) }))).resolves.toEqual({
      kind: 'unavailable', reason: 'This app is not available to connect yet.' });
  });


  it('uses Squire only when managed OAuth is unsupported', async () => {
    await expect(
      resolveAppRoute({ reconnect: false, noApi: false }, scope1.probes()),
    ).resolves.toMatchObject({ kind: 'route', route: 'squire-api', transport: 'squire-api' });
  });


  it('uses supported OAuth for both new and existing API selections', async () => {
    const p = scope1.probes({ composio: vi.fn(async () => 'supported' as const) });
    await expect(resolveAppRoute({ reconnect: false, noApi: false,
      preferredRoute: 'squire-api' }, p)).resolves.toMatchObject({ transport: 'composio' });
    expect(p.composio).toHaveBeenCalledTimes(2);
    await expect(resolveAppRoute({ existing: { transport: 'squire-api', state: 'active',
      hasCredential: true }, reconnect: false, noApi: false, preferredRoute: 'composio' }, p))
      .resolves.toMatchObject({ kind: 'route', transport: 'composio' });
    expect(p.composio).toHaveBeenCalledTimes(4);
  });





  it('keeps an existing route — even in error — until an explicit reconnect', async () => {
    const existing = { transport: 'registry-mcp', state: 'active', hasCredential: false } as const;
    const p = scope1.probes();
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
      resolveAppRoute({ existing: api, reconnect: false, noApi: true }, scope1.probes()),
    ).resolves.toMatchObject({ kind: 'route', route: 'squire-browser' });
    await expect(
      resolveAppRoute(
        { existing: { ...api, hasCredential: true }, reconnect: false, noApi: true },
        scope1.probes(),
      ),
    ).resolves.toMatchObject({ kind: 'keep', transport: 'squire-api' });
  });
});
describe('connect_app', () => {
const scope2 = fixtureScope2();


  it.each(['registry-mcp', 'trusty-squire'])(
    'R-STALE-SIGN-IN: %s stale card returns reconnect guidance through HTTP', async connectKind => {
      const appId = '33333333-3333-4333-8333-333333333333';
      await scope2.database.query(
        `INSERT INTO messages(id,room_id,author_id,text,card_type,card)
         VALUES('stale-sign-in',$1,$2,'','app-sign-in',$3::jsonb)`,
        [ROOM, HELPER, JSON.stringify({ appId, ownerId: OWNER, agentId: HELPER,
          connectorId: '55555555-5555-4555-8555-555555555555', connectKind, status: 'pending' })],
      );
      const provider = scope2.fakeComposio();
      const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
        undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
      const server = createBeelineServer({ database: scope2.database, phone, daemon: {} as DaemonService,
        live: new LiveHub(), mediaMaximumBytes: 1,
        auth: { authenticatePhone: async () => OWNER } as unknown as TokenAuth });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      vi.mocked(captureServerError).mockClear();
      try {
        const response = await phoneFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/operations/beginAppSignIn`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-phone-token-0001' },
          body: JSON.stringify({ appId }),
        });
        const result = await response.json();
        console.log(`Reproduction R-STALE-SIGN-IN: ${connectKind} stale card → HTTP ${response.status} ${JSON.stringify(result)}`);
        expect(response.status).toBe(409);
        expect(result).toEqual({ error: 'This sign-in is no longer pending. Reconnect to retry.' });
        expect(captureServerError).not.toHaveBeenCalled();
        expect(provider.link).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  );


  it('Reproduction onboarding-connect-1: returns Rooms steps without app rows or cards', async () => {
    const registry = fakeRegistry([]);
    const daemon = scope2.daemonWith(registry.client);
    for (const service of ['grok', 'xai', 'grok bot', 'muse', 'meta muse', 'meta ai',
      'chatgpt', 'openai chatgpt', 'claude', 'cursor', 'mcp', 'beeline connector']) {
      const result = await daemon.execute('connect', { ...turn, service, reason: 'Join my Room' }, HELPER);
      expect(result).toMatchObject({ status: 'ready', app: 'Beeline Rooms' });
      expect(result.next).toContain('https://join.usebeeline.app');
      expect(result.next).toContain('Members sheet > +');
      expect(result.next).toContain('Muse directory listing is still pending');
    }
    expect((await scope2.database.query('SELECT id FROM workspace_apps')).rowCount).toBe(0);
    expect((await scope2.database.query("SELECT id FROM messages WHERE card_type IS NOT NULL")).rowCount).toBe(0);
    expect(registry.transport).not.toHaveBeenCalled();
  });


  it('Reproduction onboarding-connect-1: blocks TikTok before discovery or sign-in', async () => {
    const registry = fakeRegistry([]);
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(registry.client, provider);
    for (const service of ['TikTok', 'tiktok.com', 'https://www.tiktok.com']) {
      const result = await daemon.execute('connect', { ...turn, service, reason: 'Post a clip' }, HELPER);
      expect(result.status).toBe('unavailable');
      expect(result.next).toContain('approval of Beeline');
    }
    expect(provider.link).not.toHaveBeenCalled();
    expect(registry.transport).not.toHaveBeenCalled();
    expect((await scope2.database.query('SELECT id FROM workspace_apps')).rowCount).toBe(0);
    expect((await scope2.database.query("SELECT id FROM messages WHERE card_type='app-sign-in'")).rowCount).toBe(0);
  });


  it('Reproduction onboarding-connect-1: offers Squire once and continues Shopify after install', async () => {
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'shopify', reason: 'Connect my store', squireAvailable: true };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await daemon.execute('connect', input, HELPER);
      expect(result.status).toBe('needs_approval');
      expect(result.next).toContain('hosted machine');
      expect(result.next).not.toContain('Settings');
    }
    expect((await scope2.database.query("SELECT id FROM messages WHERE card_type='connector-offer'")).rowCount).toBe(1);
    await scope2.connectSquire();
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    await applyVaultList(scope2.database,
      { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
        reference: 'vault:shopify', service: 'shopify', label: 'Store', fieldNames: ['api_key'],
        allowedHosts: ['shopify.com'], createdAt: 1, stale: false, state: 'active',
      }]);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'ready' });
  });


  it('Reproduction onboarding-connect-1: direct Squire requests offer one card before install, including retry', async () => {
    const daemon = daemonWith(fakeRegistry([]).client);
    await seedSquireMachine(database, HELPER, { squire_report: { status: 'not-added', reportedAt: Date.now() / 1000 } });
    for (const input of [{ service: 'trusty-squire' }, { service: 'squire', reconnect: true },
      { service: 'Trusty Squire' }]) {
      expect(await daemon.execute('connect', { ...turn, ...input, reason: 'Use the hosted browser' }, HELPER))
        .toMatchObject({ status: 'needs_approval', app: 'Trusty Squire' });
    }
    expect((await database.query("SELECT id FROM messages WHERE card_type='connector-offer'")).rowCount).toBe(1);
    expect((await database.query('SELECT id FROM workspace_apps')).rowCount).toBe(0);
    expect((await database.query('SELECT squire_work FROM squire_machines WHERE (owner_id,machine_id)=(SELECT owner_id,COALESCE(machine_id,agent_id) FROM agents WHERE agent_id=$1)', [HELPER]))
      .rows[0]!.squire_work.install).not.toBe(true);
    await connectSquire();
    expect(await daemon.execute('connect', { ...turn, service: 'trusty-squire', reason: 'Use the browser' }, HELPER))
      .toMatchObject({ status: 'ready', app: 'Trusty Squire' });
  });


  it('keeps real app names out of the AI-assistant route', async () => {
    await scope2.connectSquire();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, scope2.fakeComposio());
    for (const service of ['openai', 'meta ads', 'instagram', 'facebook', 'youtube', 'gmail', 'stripe']) {
      const result = await daemon.execute('connect', { ...turn, service,
        reason: 'Connect the app', squireAvailable: true }, HELPER);
      expect(result.app).not.toBe('Beeline Rooms');
      expect(result.next).not.toContain('custom connector');
    }
  });


  it.each(['TikTok', 'Gmail'])('TIKTOK-ROUTE-1: %s vault setup keys do not hide OAuth or require manual completion', async name => {
    await scope2.connectSquire();
    const key = name.toLowerCase();
    await applyVaultList(scope2.database, { owner_identity_id: OWNER, machine_id: 'machine-one', workspace_id: WORKSPACE }, [{
      reference: `vault:${key}-developer`, service: key, label: 'App setup',
      fieldNames: ['client_key', 'client_secret'], allowedHosts: [`api.${key}.com`], state: 'active', createdAt: 1,
    }]);
    const provider = scope2.fakeComposio(key);
    provider.supportsOAuth.mockResolvedValue(true);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    const started = await phone.execute('connectWorkbenchApp', { app: name, helperAgentId: HELPER }, OWNER);
    expect(started.authorizationUrl).toBe('https://app.composio.dev/connect/fixture');
    expect(provider.link).toHaveBeenCalledWith(OWNER, key);
    await phone.execute('completeAppSignIn', { appId: started.appId, sessionUri: 'session-fixture' }, OWNER);
    expect(provider.completeAuth).toHaveBeenCalledWith('session-fixture', OWNER);
    expect(await readOwnerApps(scope2.database, OWNER, provider)).toContainEqual(expect.objectContaining({
      appId: started.appId, transport: 'composio', status: 'connected',
    }));
    expect((await scope2.database.query('SELECT reference FROM workspace_connections WHERE owner_identity_id=$1', [OWNER])).rows)
      .toContainEqual({ reference: `vault:${key}-developer` });
    console.info(`Reproduction TIKTOK-ROUTE-1: ${name} setup keys → phone Connect → OAuth → authenticated completion → connected; key retained`);
  });


  it('TIKTOK-ROUTE-1: Connectors search offers OAuth with an account access token', async () => {
    await scope2.connectSquire();
    await applyVaultList(scope2.database, { owner_identity_id: OWNER, machine_id: 'machine-one', workspace_id: WORKSPACE }, [{
      reference: 'vault:tiktok-account', service: 'tiktok', label: 'Account', fieldNames: ['access_token'],
      allowedHosts: ['open.tiktokapis.com'], state: 'active', createdAt: 1,
    }]);
    const provider = scope2.fakeComposio('tiktok');
    provider.supportsOAuth.mockResolvedValue(true);
    provider.searchToolkits = vi.fn(async () => []);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.companies?.rows.find(row => row.id === 'tiktok')?.alsoAvailable)
      .toContainEqual(expect.objectContaining({ appKey: 'tiktok', flow: 'app' }));
    const results = await phone.execute('searchWorkbenchApps', { query: 'TikTok' }, OWNER);
    expect(results).toHaveLength(1);
    expect(results[0]?.company).toMatchObject({ appKey: 'tiktok', flow: 'app' });
    expect(results[0]?.companyId).toBeUndefined();
  });


  it('distinguishes automatic GitHub discovery from the owner selecting that same connection', async () => {
    await scope2.connectSquire();
    await applyVaultList(scope2.database,
      { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
        reference: 'vault:github', service: 'github', label: 'Existing key',
        fieldNames: ['access_token'], allowedHosts: ['api.github.com'],
        createdAt: 1, stale: false, state: 'active',
      }]);
    const registry = fakeRegistry([]);
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(registry.client, provider);
    const discovered = await daemon.execute('connectApp', { ...turn, app: 'GitHub', reason: 'read an issue' }, HELPER);
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: discovered.appId,
        selectedByOwner: false, connectionReference: 'vault:github' }));
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client, provider);
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
    await scope2.connectSquire();
    const transport = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/auth/token')
      ? Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh',
        expires_in: 3600, scope: 'payment_methods.agentic userinfo:read' })
      : Response.json({ address: { country: 'US' } })) as unknown as typeof fetch;
    const wallet = new LinkAgentWallet(scope2.database, 'fixture-client', 'fixture-secret', 'pk_test_fixture',
      'https://server.usebeeline.app', randomBytes(32).toString('base64'), transport);
    const registry = fakeRegistry([]);
    registry.client.catalog = vi.fn(async () => []);
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(registry.client, provider, undefined, wallet);
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
    const cards = await scope2.database.query<{ card: { appId: string; appKey: string; commandId: string } }>(
      `SELECT card FROM messages WHERE card_type='app-sign-in'`);
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]!.card).toMatchObject({ appKey: 'link', commandId: COMMAND });
    expect(registry.transport).not.toHaveBeenCalled();
    expect(provider.supportsOAuth).not.toHaveBeenCalled();
    const phone = new PhoneService(scope2.database, 'https://server.usebeeline.app', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client, provider, wallet);
    const signIn = await phone.execute('beginAppSignIn', { appId: cards.rows[0]!.card.appId }, OWNER);
    const authorization = new URL(signIn.authorizationUrl);
    expect(authorization.origin).toBe('https://login.link.com');
    await wallet.complete(authorization.searchParams.get('state')!, 'fixture-code');
    const settled = (await phone.readRoom(ROOM, OWNER))!.messages;
    expect(settled.filter(message => message.text.includes('connected Link'))).toHaveLength(1);
    expect(settled.some(message => message.appSignIn?.appKey === 'link')).toBe(false);
    const resumed = await scope2.database.query(`SELECT id FROM agent_commands WHERE reason='app_connected'`);
    expect(resumed.rows).toHaveLength(1);
    expect(await daemon.execute('connect', { ...turn, service: 'Link', reason: 'Add a payment card' }, HELPER))
      .toMatchObject({ status: 'ready', appKey: 'link' });
    expect(await daemon.execute('connectApp', { ...turn, app: 'Link', reason: 'Add a payment card' }, HELPER))
      .toMatchObject({ status: 'connected', appKey: 'link' });
    expect((await scope2.database.query(`SELECT id FROM messages WHERE card_type='app-sign-in'`)).rows).toHaveLength(0);
    expect(await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER))
      .toMatchObject({ firstPartyIntegrations: [{ key: 'link', status: 'connected' }] });
    console.info('Reproduction link-route-1: Stripe Link -> one Link sign-in card -> login.link.com -> verified callback -> request resumed -> Link ready with no new card');
  });


  it('Reproduction first-party-connect-card: built-in apps are ready without grants or cards', async () => {
    await scope2.connectSquire();
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
    for (const service of ['beeline:workflow', 'beeline:browser_share',
      'beeline workflow', 'beelineworkflow']) {
      expect(await daemon.execute('connect', { ...turn, service, reason: 'Use built-in app',
        squireAvailable: true }, HELPER)).toMatchObject({ status: 'ready', next: expect.stringContaining('app_tool') });
    }
    expect((await scope2.database.query('SELECT id FROM agent_grants')).rows).toHaveLength(0);
    expect((await scope2.database.query(`SELECT id FROM messages WHERE card_type IN
      ('grant-request','app-sign-in','connector-offer')`)).rows).toHaveLength(0);
  });


  it('connect posts a Composio sign-in card without issuing an agent sign-in URL', async () => {
    const provider = scope2.fakeComposio();
    const result = await scope2.daemonWith(fakeRegistry([]).client, provider).execute('connect',
      { ...turn, service: 'Slack', reason: 'Send the message' }, HELPER);
    expect(result).toMatchObject({ status: 'needs_sign_in', transport: 'composio' });
    expect(result).not.toHaveProperty('authorizationUrl');
    expect((await scope2.database.query(`SELECT id FROM messages WHERE card_type='app-sign-in'`)).rows).toHaveLength(1);
    expect(provider.link).not.toHaveBeenCalled();
  });


  it('Reproduction registry-down-1: a Registry outage still routes GitHub to its managed sign-in', async () => {
    const registry = fakeRegistry([], true);
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'github');
    const result = await scope2.daemonWith(registry.client, provider).execute('connect',
      { ...turn, service: 'GitHub', reason: 'Read issues' }, HELPER);
    expect(registry.transport).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'needs_sign_in', transport: 'composio' });
    expect(result.next).not.toContain('Registry could not be checked');
  });


  it.each(['link my repository', 'GitHub'])('R-REPO-CARD: %s bypasses a Registry outage for repository linking', async service => {
    const registry = fakeRegistry([], true);
    const result = await scope2.daemonWith(registry.client, scope2.fakeComposio()).execute('connect',
      { ...turn, service, reason: `Connect ${service}`, continuation: `Connect my ${service} account.` }, HELPER);
    expect(result).toMatchObject({ status: 'ready', app: 'beeline:onboarding' });
    expect(registry.transport).not.toHaveBeenCalled();
  });


  it('connect installs a no-sign-in Registry remote to ready with no owner card', async () => {
    const registry = fakeRegistry([{ ...linearServer, name: 'org.example/echo', title: 'Echo', websiteUrl: 'https://example.org' }]);
    vi.spyOn(registry.client, 'search').mockResolvedValue([(await registry.client.exact('org.example/echo', linearServer.version))!]);
    const daemon = scope2.daemonWith(registry.client);
    const connection = daemon.execute('connect', { ...turn, service: 'https://example.org', reason: 'Use Echo' }, HELPER);
    let connectorId = '';
    await vi.waitFor(async () => {
      const row = (await scope2.database.query<{ id: string }>(`SELECT id FROM workspace_connectors WHERE connector_type='registry-mcp'`)).rows[0];
      expect(row).toBeDefined(); connectorId = row!.id;
    });
    await daemon.execute('installConnector', { agentId: HELPER, connectorId }, HELPER);
    expect(await connection).toMatchObject({ status: 'ready', transport: 'registry-mcp' });
    expect((await scope2.database.query(`SELECT id FROM messages WHERE card_type IN ('app-sign-in','connector-offer','agent-grant')`)).rows).toHaveLength(0);
  });


  it('Reproduction R1: the owner’s agent connects GitHub without a permission card', async () => {
    await scope2.connectSquire();
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
    const server = createBeelineServer({ database: scope2.database, phone: new PhoneService(scope2.database, 'http://placeholder'),
      daemon, live: new LiveHub(), mediaMaximumBytes: 1,
      auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await phoneFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/daemon/operations/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bdt_fixture-token-0001' },
        body: JSON.stringify({ ...turn, service: 'GitHub', reason: 'Read repository issues', squireAvailable: true }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'needs_squire', appKey: 'github' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    expect((await scope2.database.query(`SELECT status,auto FROM agent_grants WHERE target='connection-install:github'`)).rows)
      .toEqual([{ status: 'approved', auto: true }]);
    expect((await scope2.database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows).toHaveLength(0);
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
      'SELECT squire_work FROM squire_machines WHERE (owner_id,machine_id)=(SELECT owner_id,COALESCE(machine_id,agent_id) FROM agents WHERE agent_id=$1)', [HELPER])).rows[0]!.squire_work;
    expect(work.appConnections).toBeUndefined();
    await applyVaultList(database,
      { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
        reference: 'vault:resend', service: 'resend', label: 'Resend',
        fieldNames: noApi ? ['login', 'password'] : ['api_key'],
        allowedHosts: ['resend.com'], createdAt: 1, stale: false, state: 'active' }]);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'ready' });
    // Readiness is the vault credential, even when no Squire tools are mounted.
    await seedSquireMachine(database, HELPER, { squire_report: { status: 'error', reportedAt: Date.now() / 1000 } });
    expect(await daemon.execute('connect', { ...input, squireAvailable: false }, HELPER))
      .toMatchObject({ status: 'ready' });
    console.info(`Reproduction squire-connect-1: connect -> quiet approved consent -> agent URL/goal (${noApi ? 'browser' : 'API'}) -> no helper job -> vault credential -> ready`);
  });


  it('R1: own-account installation stays approved after boot when someone else requested the work', async () => {
    const requester = 'e'.repeat(64);
    await scope2.connectSquire();
    await scope2.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Requester')`, [requester]);
    await scope2.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WORKSPACE, requester, ROOM]);
    await scope2.database.query(`UPDATE messages SET author_id=$1 WHERE id='app-source'`, [requester]);
    const result = await scope2.daemonWith(fakeRegistry([]).client).execute('connect', {
      ...turn, service: 'GitHub', reason: 'Read repository issues', squireAvailable: true,
    }, HELPER);
    expect(result.status).toBe('needs_squire');
    await migrate(scope2.database);
    expect((await scope2.database.query(`SELECT status,auto,requested_by FROM agent_grants WHERE target='connection-install:github'`)).rows)
      .toEqual([{ status: 'approved', auto: true, requested_by: requester }]);
    expect((await scope2.database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows).toHaveLength(0);
  });


  it('Reproduction SENTRY-ACCESS: reconnect requests owner repair instead of returning the existing key', async () => {
    await scope2.connectSquire();
    await applyVaultList(scope2.database,
      { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
        reference: 'vault:sentry-old', service: 'sentry', label: 'default',
        fieldNames: ['api_key'], allowedHosts: ['sentry.io'],
        createdAt: 1, stale: true, state: 'active',
      }]);
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
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
    await scope2.connectSquire();
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
    for (const squireAvailable of [false, undefined]) {
      const result = await daemon.execute('connect', { ...turn, service: 'resend.com',
        reason: 'Send email', noApi: true, squireAvailable }, HELPER);
      expect(result).toMatchObject({ status: 'unavailable' });
      expect(result.next).toContain('unavailable in this agent session');
      expect(result).not.toHaveProperty('squire');
    }
    expect((await scope2.database.query(`SELECT id FROM agent_grants WHERE target='connection-install:resend'`)).rows).toHaveLength(0);
  });


  it('R1: a foreign app account still asks its owner and stores the app display name', async () => {
    const foreign = 'd'.repeat(64);
    const appId = '88888888-8888-4888-8888-888888888888';
    await scope2.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Alex')`, [foreign]);
    await scope2.database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [WORKSPACE, foreign]);
    await scope2.database.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
      VALUES($1,$2,$3,'github','GitHub','squire-api','squire-api')`, [appId, WORKSPACE, foreign]);
    const result = await scope2.daemonWith(fakeRegistry([]).client).execute('requestAgentGrant', {
      ...turn, kind: 'mcp', target: 'connection-install:github', appId, purpose: 'Connect GitHub to complete the requested task', reason: 'Connect GitHub',
    }, HELPER);
    expect(result).toMatchObject({ status: 'pending', auto: false });
    await scope2.database.query('UPDATE agent_grants SET command_id=$2 WHERE id=$1', [result.grantId, COMMAND]);
    const messages = (await scope2.database.query<{ text: string; card: { owner: { pubkey: string }; grants: { appName: string }[] } }>(
      `SELECT text,card FROM messages WHERE card_type='grant-request'`)).rows;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('@bee wants to connect GitHub');
    expect(messages[0]!.text).not.toContain('connection-install:');
    expect(messages[0]!.card.owner.pubkey).toBe(foreign);
    expect(messages[0]!.card.grants[0]!.appName).toBe('GitHub');
    const phone = new PhoneService(scope2.database, 'http://placeholder');
    await expect(phone.execute('decideAgentGrant', {
      grantId: result.grantId, decision: 'always',
    }, OWNER)).rejects.toThrow('requires the connected person');
    await phone.execute('decideAgentGrant', { grantId: result.grantId, decision: 'always' }, foreign);
    await migrate(scope2.database);
    expect((await scope2.database.query('SELECT status,decided_by FROM agent_grants WHERE id=$1', [result.grantId])).rows)
      .toEqual([{ status: 'approved', decided_by: foreign }]);
  });


  it.each(['denied', 'once'])('R1: owner setup replaces legacy %s consent with quiet standing consent', async status => {
    await scope2.connectSquire();
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'resend.com', reason: 'Send email', noApi: true, squireAvailable: true };
    await daemon.execute('connect', input, HELPER);
    const grant = (await scope2.database.query<{ id: string }>(`SELECT id FROM agent_grants WHERE target='connection-install:resend'`)).rows[0]!;
    await scope2.database.query(`UPDATE agent_grants SET status=$3,auto=false,decided_by=$2 WHERE id=$1`, [grant.id, OWNER, status]);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    expect((await scope2.database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows).toHaveLength(0);
  });


  it('Reproduction squire-session-1: a signed-in Squire session makes a browser app ready without a vault login', async () => {
    await scope2.connectSquire();
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
    const input = { ...turn, service: 'resend.com', reason: 'Send email', noApi: true, squireAvailable: true };
    await daemon.execute('connect', input, HELPER);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    // The agent's own Squire session showed the app signed in; no vault login exists.
    const signedIn = await daemon.execute('connect', { ...input,
      signedInUrl: 'https://app.resend.com/emails', squireSignedIn: true }, HELPER);
    expect(signedIn).toMatchObject({ status: 'ready', transport: 'squire-browser' });
    expect(signedIn).not.toHaveProperty('squire');
    expect((await scope2.database.query(`SELECT 1 FROM workspace_connections`)).rows).toHaveLength(0);
    // The signed-in session remains ready after the old consent is revoked.
    await scope2.database.query(`UPDATE agent_grants SET status='revoked' WHERE target='connection-install:resend'`);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'ready' });
    const work = (await scope2.database.query<{ squire_work: { signedInApps?: Record<string, unknown> } }>(
      'SELECT squire_work FROM agents WHERE agent_id=$1', [HELPER])).rows[0]!.squire_work;
    expect(Object.keys(work.signedInApps ?? {})).toEqual(['resend']);
    expect(JSON.stringify(work.signedInApps)).not.toMatch(/cookie|token/i);
    // An OAuth redirect from the app to Google's sign-in page clears the app, not unrelated apps.
    await recordSquireSignIn(scope2.database, HELPER, 'linear', 'linear.app');
    await daemon.execute('forgetSquireSignIn', { url: 'https://accounts.google.com/signin',
      siteUrl: 'https://app.resend.com/emails' }, HELPER);
    expect(await daemon.execute('connect', input, HELPER)).toMatchObject({ status: 'needs_squire' });
    const after = (await scope2.database.query<{ squire_work: { signedInApps?: Record<string, unknown> } }>(
      'SELECT squire_work FROM agents WHERE agent_id=$1', [HELPER])).rows[0]!.squire_work;
    expect(Object.keys(after.signedInApps ?? {})).toEqual(['linear']);
    console.info('Reproduction squire-session-1: signed-in session -> ready; reused; signed-out page -> re-check');
  });


  it('a signed-in session cannot make an API app ready, another site proves nothing, and reconnect re-checks', async () => {
    await scope2.connectSquire();
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
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
    const provider = scope2.fakeComposio();
    const result = await scope2.daemonWith(registry.client, provider).execute('connectApp',
      { ...turn, app: 'Linear', reason: 'manage issues' }, HELPER);
    expect(result).toMatchObject({ transport: 'registry-mcp', appKey: 'linear' });
    expect(provider.supportsOAuth).not.toHaveBeenCalled();
    const row = (await scope2.database.query<{ registry_server_name: string; status: string }>(
      `SELECT registry_server_name,status FROM workspace_connectors
       WHERE owner_identity_id=$1 AND connector_type='registry-mcp'`, [OWNER],
    )).rows[0];
    expect(row).toEqual({ registry_server_name: 'app.linear/linear', status: 'installing' });
  });


  it('R-YOUTUBE-CONNECTED: one sign-in becomes one catalog notice and one resume', async () => {
    const provider = scope2.fakeComposio('youtube');
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp',
      { ...turn, app: 'YouTube', reason: 'Make a welcome video' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    const pending = (await phone.readRoom(ROOM, OWNER))!.messages.find(
      message => message.appSignIn?.appId === first.appId)!;
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: first.appId! }, OWNER);
    // A rejected callback replay must not add a notice or resume twice.
    await expect(phone.execute('completeAppSignIn',
      { sessionUri: 'session-fixture', appId: first.appId! }, OWNER)).rejects.toThrow('no longer pending');
    const messages = (await phone.readRoom(ROOM, OWNER))!.messages;
    const notices = messages.filter(message => message.appSignIn?.appId === first.appId
      || message.text.includes('connected YouTube'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ id: pending.id, presentation: 'system',
      text: '@owner connected YouTube · The request can continue.' });
    expect(notices[0]!.appSignIn).toBeUndefined();
    const commands = (await scope2.database.query<{ source_message_id: string }>(
      `SELECT source_message_id FROM agent_commands WHERE reason='app_connected'`)).rows;
    expect(commands).toEqual([{ source_message_id: pending.id }]);
  });


  it.each([false, true])('posts one route-neutral Room card and resumes the original request after sign-in (owned=%s)', async owned => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const presence = owned ? new ConnectionPresence(scope2.database, new LiveHub()) : undefined;
    const generationId = owned ? 'owned-provider-parity' : GENERATION;
    if (presence) {
      const epoch = await presence.claimConnection(HELPER, {connectionId:'owned-provider-parity'});
      await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: COMMAND, generationId },
        HELPER, { connectionId: 'owned-provider-parity', epoch });
    }
    const callTurn = {...turn,generationId};
    try {

    const continuation = 'I will post the launch notes after sign-in.';
    const first = await daemon.execute('connectApp',
      { ...callTurn, app: 'Slack', reason: 'post the launch notes', continuation }, HELPER);
    expect(first).toMatchObject({ status: 'needs_sign_in', route: 'composio',
      transport: 'composio' });
    expect(first).not.toHaveProperty('authorizationUrl');
    expect(await scope2.routes()).toEqual([{ route: 'composio', transport: 'composio' }]);
    const card = (await scope2.database.query<{ card: { appId: string; status: string;
      continuation?: string } }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM],
    )).rows[0];
    expect(card?.card).toMatchObject({ appId: first.appId, status: 'pending', continuation });
    // The app's https logo is the only provider-hosted value the card may carry.
    const { logo, ...neutral } = card!.card as typeof card.card & { logo?: string };
    expect(logo === undefined || /^https:\/\//.test(logo)).toBe(true);
    expect(JSON.stringify(neutral)).not.toContain('composio');
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    const pendingRoom = await phone.readRoom(ROOM, OWNER);
    expect(pendingRoom?.messages.find((message) => message.appSignIn?.appId === first.appId)
      ?.appSignIn).toMatchObject({ status: 'pending', continuation });
    const opened = await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    expect(opened.authorizationUrl).toBe('https://app.composio.dev/connect/fixture');
    expect(provider.link).toHaveBeenCalledWith(OWNER, 'slack');
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: first.appId! }, OWNER);
    expect(provider.completeAuth).toHaveBeenCalledWith('session-fixture', OWNER);
    expect((await scope2.database.query(
      `SELECT id FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM],
    )).rows).toHaveLength(0);
    const connectedRoom = await phone.readRoom(ROOM, OWNER);
    expect(connectedRoom?.messages.filter(message => message.text.includes('connected Slack')))
      .toHaveLength(1);
    expect((await scope2.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND agent_id=$2 AND reason='app_connected'`, [ROOM, HELPER])).rowCount).toBe(1);
    const neverUsed = (await readOwnerApps(scope2.database, OWNER, provider))[0]!;
    expect(neverUsed).toMatchObject({
      appId: first.appId, status: 'connected', accountLabel: 'owner',
      workspaceName: 'Hive', useCount: 0,
    });
    expect(neverUsed).not.toHaveProperty('lastUse');
    expect(neverUsed).not.toHaveProperty('lastUsedAt');
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: first.appId, appKey: 'slack' }));
    expect((await daemon.execute('listAppTools', { ...callTurn, appId: first.appId! }, HELPER)).tools)
      .toHaveLength(1);
    const used = await daemon.execute('executeAppTool', { ...callTurn, appId: first.appId!,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER);
    expect(used).toEqual({ status: 'executed', data: { ok: true } });
    expect(provider.execute).toHaveBeenCalledWith(expect.objectContaining({
      userId: OWNER, accountId: 'ca_fixture', toolkit: 'slack',
    }));
    expect((await scope2.database.query(`SELECT 1 FROM workspace_app_usage WHERE app_id=$1`,
      [first.appId])).rowCount).toBe(1);
    const afterUse = (await readOwnerApps(scope2.database, OWNER, provider))[0]!;
    expect(afterUse).toMatchObject({ useCount: 1,
      lastUse: { agentId: HELPER, agentName: 'Bee', roomId: ROOM,
        roomName: 'Tools', usedAt: afterUse.lastUsedAt } });
    if (presence) {
      await presence.releaseConnection(HELPER, 'owned-provider-parity');
      await expect(daemon.execute('executeAppTool', { ...callTurn, appId: first.appId!,
        tool: 'SLACK_POST_MESSAGE', arguments: { text: 'must not dispatch after owner loss' } }, HELPER)).rejects.toThrow();
      expect(provider.execute).toHaveBeenCalledTimes(1);
    }
    } finally { await presence?.stop(); }
  });
});
