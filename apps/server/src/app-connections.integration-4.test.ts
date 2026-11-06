import { describe, expect, it, vi, SYSTEM_IDENTITY_ID, SCHEDULE_SCHEDULER_ID, PhoneService, beginComposioAppSignIn, connectApp, readOwnerApps, ComposioApps, WORKSPACE, ROOM, OWNER, HELPER, COMMAND, turn, fakeRegistry, fixtureScope2 } from './test-support-app-connections.integration.test-support.js';

describe('connect_app', () => {
const scope2 = fixtureScope2();


  it('keeps a niche Registry publisher in its own company', async () => {
    const registry = fakeRegistry([{ name: 'com.pulsemcp/catalog', version: '1', title: 'Catalog',
      websiteUrl: 'https://pulsemcp.com', remotes: [{ type: 'streamable-http', url: 'https://third-party.example/mcp' }] }]);
    const daemon = scope2.daemonWith(registry.client);
    await daemon.execute('connectMcpServer', { ...turn, serverName: 'com.pulsemcp/catalog', version: '1', reason: 'Use the third-party server' }, HELPER);
    await scope2.database.query("UPDATE workspace_connectors SET status='connected',connected_at=now() WHERE registry_server_name='com.pulsemcp/catalog'");
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.companies?.rows.some(company => company.id === 'fly')).toBe(false);
    expect(view.companies?.rows.find(company => company.id === 'pulsemcp.com')?.items).toHaveLength(1);
  });


  it('keeps an existing Composio route when a person selects an MCP', async () => {
    const registry = fakeRegistry([]); const provider = scope2.fakeComposio();
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client, provider);
    const first = await phone.execute('connectWorkbenchApp', { app: 'Slack', helperAgentId: HELPER }, OWNER);
    expect(first).toMatchObject({ transport: 'composio' });
    await expect(phone.execute('connectWorkbenchApp', { app: 'Slack', helperAgentId: HELPER,
      registryServerName: 'com.slack/mcp', registryVersion: '1' }, OWNER)).resolves.toMatchObject({ appId: first.appId, transport: 'composio' });
    expect((await scope2.database.query(`SELECT id FROM workspace_connectors WHERE connector_type='registry-mcp'`)).rows).toHaveLength(0);
  });


  it('searches real Workbench services and refuses arbitrary app text before a connection exists', async () => {
    const provider = scope2.fakeComposio();
    provider.searchToolkits = vi.fn(async (query: string) => query === 'resend'
      ? [{ slug: 'resend', name: 'Resend', appUrl: 'https://resend.com' }] : []);
    provider.toolkit.mockImplementation(async (slug: string) => {
      if (slug === 'resend') return { slug };
      throw Object.assign(new Error('missing'), { status: 404 });
    });
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await expect(phone.execute('searchWorkbenchApps', { query: 'fuckface' }, OWNER))
      .resolves.toEqual([]);
    await expect(phone.execute('searchWorkbenchApps', { query: 'resend' }, OWNER))
      .resolves.toMatchObject([{ appKey: 'resend', name: 'Resend', domain: 'resend.com', company: { providerId: 'resend', appName: 'Resend' } }]);
    await expect(phone.execute('connectWorkbenchApp', {
      app: 'fuckface', helperAgentId: 'machine-one' }, OWNER))
      .rejects.toThrow('Select an app from search results');
    expect((await scope2.database.query('SELECT id FROM workspace_apps')).rows).toEqual([]);
  });


  it('puts official Stripe sign-in first and keeps its other sign-in available', async () => {
    const provider = scope2.fakeComposio();
    provider.searchToolkits = vi.fn(async () => [{ slug: 'stripe', name: 'Stripe',
      appUrl: 'https://stripe.com' }]);
    const registry = fakeRegistry([{ name: 'com.stripe/mcp', version: '0.2.4',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.stripe.com' }] }]);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client, provider);
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
    const provider = scope2.fakeComposio();
    provider.searchToolkits = vi.fn(async () => [{ slug: 'tiktok', name: 'TikTok',
      appUrl: 'https://tiktok.com' }]);
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'tiktok');
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await expect(phone.execute('searchWorkbenchApps', { query: 'tiktok' }, OWNER))
      .resolves.toContainEqual(expect.objectContaining({ appKey: 'tiktok', name: 'TikTok' }));
    await expect(phone.execute('connectWorkbenchApp', {
      app: 'TikTok', helperAgentId: 'machine-one', preferredRoute: 'composio',
    }, OWNER)).resolves.toMatchObject({ transport: 'composio' });
    expect(provider.supportsOAuth).toHaveBeenCalledWith('tiktok');
  });


  it('Reproduction R1: retries an existing Squire app absent from the Composio catalog', async () => {
    await scope2.connectSquire();
    const provider = scope2.fakeComposio();
    provider.toolkit.mockImplementation(async (slug: string) => {
      if (slug === 'hetzner' || slug === 'fuckface')
        throw Object.assign(new Error('missing'), { status: 404 });
      return { slug };
    });
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const started = await daemon.execute('connectApp',
      { ...turn, app: 'Hetzner', reason: 'manage my server' }, HELPER);
    expect(started.transport).toBe('squire-api');
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);

    await expect(phone.execute('connectWorkbenchApp', {
      app: 'Hetzner', helperAgentId: 'machine-one', reconnect: true,
    }, OWNER)).resolves.toMatchObject({ appId: started.appId, transport: 'squire-api' });
    expect((await scope2.database.query('SELECT id FROM workspace_apps')).rows)
      .toEqual([{ id: started.appId }]);
    const requests = await scope2.database.query<{ text: string }>(
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
    await scope2.connectSquire();
    const provider = scope2.fakeComposio();
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
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
    const requests = await scope2.database.query<{ text: string }>(
      `SELECT text FROM messages WHERE author_id=$1 AND text LIKE '%Runway in my Connectors.' ORDER BY created_at`, [OWNER],
    );
    expect(requests.rows.map(row => row.text)).toEqual([
      '@bee Connect Runway in my Connectors.', '@bee Reconnect Runway in my Connectors.',
    ]);
    console.log('RUNWAY-1 demonstrated: retry sent Reconnect Runway to the helper; no browser sign-in link requested');
  });


  it('lets a person connect from Workbench by handing the sign-in to their agent', async () => {
    await scope2.connectSquire();
    const phone = new PhoneService(
      scope2.database,
      'http://placeholder',
      undefined,
      undefined,
      undefined,
      false,
      scope2.database,
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
    const asked = await scope2.database.query<{ text: string; author_id: string }>(
      `SELECT m.text,m.author_id FROM messages m JOIN rooms r ON r.id=m.room_id
       WHERE r.direct_participants IS NOT NULL AND m.author_id=$1`,
      [OWNER],
    );
    expect(asked.rows).toEqual([
      { text: '@bee Connect Resend in my Connectors.', author_id: OWNER },
    ]);
    const command = await scope2.database.query<{ agent_id: string; state: string }>(
      `SELECT agent_id,state FROM agent_commands WHERE source_message_id<>'app-source'`,
    );
    expect(command.rows).toEqual([{ agent_id: HELPER, state: 'pending' }]);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.apps).toEqual([]);
    expect((await scope2.database.query(`SELECT app_key FROM workspace_apps WHERE owner_identity_id=$1`, [OWNER])).rows)
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
    const daemon = scope2.daemonWith(registry, provider);
    const seed = async (appId: string, appKey: string, routeId: string, name: string) => {
      await scope2.database.query(
        `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,
           transport,route,state,composio_account_id)
         VALUES($1,$2,$3,$4,$5,'composio','composio','active','ca_gone')`,
        [appId, WORKSPACE, OWNER, appKey, name],
      );
      await scope2.database.query(
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
    const appBefore = (await readOwnerApps(scope2.database, OWNER, provider))[0]!;
    expect(appBefore).toMatchObject({ status: 'error',
      errorMessage: 'App connection was not found. Sign in again.' });
    expect(appBefore.errorMessage).not.toBe('App connection could not be checked');

    // AC-3: the agent-side connect_app(reconnect:true) settles on
    // needs_sign_in against the STILL-stale row (the link arrives only when
    // the person taps the connection card) instead of the error loop.
    const daemonOutcome = await daemon.execute('connectApp', { ...turn, app: 'YouTube',
      reason: 'post the launch notes', reconnect: true }, HELPER);
    expect(daemonOutcome.status).toBe('needs_sign_in');
    expect((await scope2.database.query<{ composio_account_id: string | null }>(
      `SELECT composio_account_id FROM workspace_apps WHERE id=$1`, [youtubeId],
    )).rows[0]?.composio_account_id).toBe('ca_gone'); // still stale: the card path issues no link

    // The phone path: beginComposioAppSignIn returns a fresh authorizationUrl
    // and replaces the stale id in the same transaction (the Workbench
    // "Connect youtube" tap that failed with the 404 before the fix).
    const opened = await beginComposioAppSignIn(scope2.database, provider, OWNER, youtubeId);
    expect(opened.authorizationUrl).toBe('https://app.composio.dev/connect/fixture');
    const after = (await scope2.database.query<{ composio_account_id: string | null;
      composio_link_expires_at: string | null }>(
      `SELECT composio_account_id,composio_link_expires_at FROM workspace_apps WHERE id=$1`,
      [youtubeId],
    )).rows[0]!;
    expect(after.composio_account_id).toBe('ca_fixture'); // the stale id was replaced
    expect(after.composio_link_expires_at).not.toBeNull();

    // The front door's phone reconnect issues the fresh link as well.
    const slackId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await seed(slackId, 'slack', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Slack');
    const resumed = await connectApp(scope2.database, registry, {
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
    const slackRow = (await scope2.database.query<{ composio_account_id: string | null }>(
      `SELECT composio_account_id FROM workspace_apps WHERE id=$1`, [slackId],
    )).rows[0]!;
    expect(slackRow.composio_account_id).toBe('ca_fixture'); // the stale id was replaced
  });


  it('runs an app tool on a handoff wake of a person-started run', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const appId = await scope2.connectedSlack(daemon, provider);
    await scope2.seedWorkflowWake({ runId: 'wf-person', startRequester: OWNER });
    const used = await daemon.execute('executeAppTool', { ...turn, appId,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER);
    expect(used).toMatchObject({ status: 'executed' });
    expect((await scope2.database.query<{ requester_id: string }>(
      `SELECT requester_id FROM workspace_app_usage`)).rows[0]?.requester_id).toBe(OWNER);
  });


  it('runs an app tool when a person answered the run\u2019s latest gate', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const appId = await scope2.connectedSlack(daemon, provider);
    await scope2.seedWorkflowWake({ runId: 'wf-gate', startRequester: HELPER, gateAnswerer: OWNER });
    await expect(daemon.execute('executeAppTool', { ...turn, appId,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER))
      .resolves.toMatchObject({ status: 'executed' });
  });


  it('Reproduction wake-app: runs its owner’s app on an agent-only wake', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const appId = await scope2.connectedSlack(daemon, provider);
    await scope2.seedWorkflowWake({ runId: 'wf-agent', startRequester: HELPER });
    await expect(daemon.execute('executeAppTool', { ...turn, appId,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER))
      .resolves.toMatchObject({ status: 'executed' });
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect((await scope2.database.query(`SELECT requester_id FROM workspace_app_usage`)).rows[0]?.requester_id).toBe(OWNER);
  });


  it.each([['schedule', SCHEDULE_SCHEDULER_ID], ['subscribed_event', SYSTEM_IDENTITY_ID], ['subscribed_event', HELPER]])(
    'Reproduction wake-app: %s uses the owner app and records the owner as requester (%s)', async (reason, author) => {
      const provider = scope2.fakeComposio();
      const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
      const appId = await scope2.connectedSlack(daemon, provider);
      await scope2.database.query(`INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES($1,'human','Wake',true) ON CONFLICT DO NOTHING`, [author]);
      await scope2.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('app-wake',$1,$2,'Wake')`, [ROOM, author]);
      await scope2.database.query(`UPDATE agent_commands SET root_source_message_id='app-wake',reason=$1 WHERE id=$2`, [reason, COMMAND]);
      await expect(daemon.execute('executeAppTool', { ...turn, appId,
        tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER))
        .resolves.toMatchObject({ status: 'executed' });
      expect(provider.execute).toHaveBeenCalledTimes(1);
      expect((await scope2.database.query(`SELECT requester_id FROM workspace_app_usage`)).rows[0]?.requester_id).toBe(OWNER);
    });


  it('Reproduction wake-app: an agent-only wake cannot borrow another person’s app', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const appId = await scope2.connectedSlack(daemon, provider);
    const other = 'c'.repeat(64);
    await scope2.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [other]);
    await scope2.database.query(`UPDATE agents SET owner_id=$1 WHERE agent_id=$2`, [other, HELPER]);
    await scope2.seedWorkflowWake({ runId: 'wf-foreign-app', startRequester: HELPER });
    await expect(daemon.execute('executeAppTool', { ...turn, appId,
      tool: 'SLACK_POST_MESSAGE', arguments: { text: 'Launch notes' } }, HELPER))
      .rejects.toThrow('App use requires a person’s request');
    expect(provider.execute).not.toHaveBeenCalled();
  });
});
