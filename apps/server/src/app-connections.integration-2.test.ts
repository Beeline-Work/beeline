import { phoneFetch, describe, expect, it, vi, randomUUID, DaemonService, PhoneService, LiveHub, applyVaultList, ComposioApps, readRoomViewMessage, createBeelineServer, captureServerError, WORKSPACE, ROOM, CORNER, OWNER, HELPER, turn, linearServer, fakeRegistry, fixtureScope2, type AddressInfo, type TokenAuth } from './app-connections.integration.test-support.js';

describe('connect_app', () => {
const scope2 = fixtureScope2();


  it('RS-1: an unlisted app sign-in card stores its web domain so the card shows its mark', async () => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'whatsapp');
    provider.toolkit.mockImplementation(async (toolkit: string) => ({ slug: toolkit,
      logo: `https://logos.composio.dev/api/${toolkit}`, appUrl: 'https://web.whatsapp.com' }));
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const result = await daemon.execute('connect',
      { ...turn, service: 'WhatsApp', reason: 'message customers' }, HELPER);
    expect(result).toMatchObject({ status: 'needs_sign_in', appKey: 'whatsapp' });
    const stored = (await scope2.database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.card).toMatchObject({ appKey: 'whatsapp', domain: 'whatsapp.com',
      logo: 'https://logos.composio.dev/api/whatsapp' });
    // The logo URL is the only provider-hosted value the card may carry.
    const { logo: _logo, ...rest } = stored[0]!.card;
    expect(JSON.stringify(rest)).not.toContain('composio');
    // The Room view keeps the stored domain even when the read-time logo lookup fails.
    provider.toolkit.mockRejectedValue(new Error('App provider is unavailable'));
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    const view = await phone.readRoom(ROOM, OWNER);
    expect(view?.messages.find((message) => message.appSignIn)?.appSignIn)
      .toMatchObject({ appKey: 'whatsapp', domain: 'whatsapp.com', logo: 'https://logos.composio.dev/api/whatsapp' });
    console.info('Reproduction RS-1: connect WhatsApp -> card stores logo and domain whatsapp.com -> Room view returns them');
  });


  it('RS-1: an unlisted app with a logo but no web address stores the logo on its sign-in card', async () => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'whatsapp');
    provider.toolkit.mockImplementation(async (toolkit: string) => ({ slug: toolkit,
      logo: `https://logos.composio.dev/api/${toolkit}` }));
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const result = await daemon.execute('connect',
      { ...turn, service: 'WhatsApp', reason: 'message customers' }, HELPER);
    expect(result).toMatchObject({ status: 'needs_sign_in', appKey: 'whatsapp' });
    const stored = (await scope2.database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.card).toMatchObject({ appKey: 'whatsapp', logo: 'https://logos.composio.dev/api/whatsapp' });
    expect(stored[0]!.card).not.toHaveProperty('domain');
    // The Room view keeps the stored logo even when the read-time lookup fails.
    provider.toolkit.mockRejectedValue(new Error('App provider is unavailable'));
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    const view = await phone.readRoom(ROOM, OWNER);
    expect(view?.messages.find((message) => message.appSignIn)?.appSignIn)
      .toMatchObject({ appKey: 'whatsapp', logo: 'https://logos.composio.dev/api/whatsapp' });
    console.info('Reproduction RS-1: connect WhatsApp (logo only) -> card stores logo -> Room view returns it');
  });


  it('RS-1: an app sign-in card drops a logo that is not https', async () => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'whatsapp');
    provider.toolkit.mockImplementation(async (toolkit: string) => ({ slug: toolkit,
      logo: `http://logos.example/${toolkit}` }));
    await scope2.daemonWith(fakeRegistry([]).client, provider).execute('connect',
      { ...turn, service: 'WhatsApp', reason: 'message customers' }, HELPER);
    const stored = (await scope2.database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.card).not.toHaveProperty('logo');
  });


  it('RS-1: an app sign-in card still posts when the app metadata lookup fails', async () => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'whatsapp');
    provider.toolkit.mockRejectedValue(new Error('App provider is unavailable'));
    const result = await scope2.daemonWith(fakeRegistry([]).client, provider).execute('connect',
      { ...turn, service: 'WhatsApp', reason: 'message customers' }, HELPER);
    expect(result).toMatchObject({ status: 'needs_sign_in' });
    const stored = (await scope2.database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM])).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.card).not.toHaveProperty('domain');
    expect(stored[0]!.card).not.toHaveProperty('logo');
  });


  it('WB-1: corner turn discovers X app ID and status, posts sign-in card, and wakes after connection', async () => {
    await scope2.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       VALUES($1,$2,$3,$4,'MM desk corner')`, [CORNER, WORKSPACE, ROOM, OWNER],
    );

    await scope2.database.query(
      `INSERT INTO messages(id,room_id,author_id,text)
       VALUES('corner-service-source',$1,$2,'Check access to X posts')`, [CORNER, OWNER],
    );
    await scope2.database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at
       ) VALUES('corner-service-command',$1,$2,'corner-service-source','corner-service-request',
         'input','human_tag','corner-service-command','corner-service-source',0,
         'claimed','corner-service-generation',now()+interval '10 minutes')`,
      [CORNER, HELPER],
    );
    const provider = scope2.fakeComposio('x');
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const cornerTurn = { roomId: CORNER, requestId: 'corner-service-request',
      generationId: 'corner-service-generation' };
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
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
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
    expect((await scope2.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND agent_id=$2 AND reason='app_connected'`, [CORNER, HELPER])).rowCount).toBe(1);
  });


  it('R-YOUTUBE-PUBLISHER: refuses a third-party YouTube install before creating a connector', async () => {
    const server = { ...linearServer, name: 'click.myagents/youtube', title: 'YouTube',
      websiteUrl: 'https://youtube.com', version: '1.0.2' };
    const registry = fakeRegistry([server]);
    const result = await scope2.daemonWith(registry.client).execute('connectMcpServer', { ...turn,
      serverName: server.name, version: server.version, reason: 'Upload a YouTube video' }, HELPER);
    expect(result).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('connect') });
    expect((await scope2.database.query(`SELECT id FROM workspace_connectors WHERE connector_type='registry-mcp'`)).rows).toHaveLength(0);
  });


  it('R-YOUTUBE-PUBLISHER: connect YouTube rejects the Registry impostor and posts the managed sign-in card', async () => {
    const registry = fakeRegistry([{ ...linearServer, name: 'click.myagents/youtube', title: 'YouTube',
      websiteUrl: 'https://youtube.com', version: '1.0.2' }]);
    const search = vi.spyOn(registry.client, 'search');
    const provider = scope2.fakeComposio('youtube');
    provider.supportsOAuth.mockImplementation(async (toolkit: string) => toolkit === 'youtube');
    const result = await scope2.daemonWith(registry.client, provider).execute('connect', { ...turn,
      service: 'youtube', reason: 'Upload a YouTube video' }, HELPER);
    expect(result).toMatchObject({ status: 'needs_sign_in', transport: 'composio', appKey: 'youtube' });
    expect(search).toHaveBeenCalled();
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client, provider);
    expect((await phone.readRoom(ROOM, OWNER))?.messages.find(message => message.appSignIn)?.appSignIn)
      .toMatchObject({ appKey: 'youtube', status: 'pending', ownerId: OWNER });
    expect((await scope2.database.query(`SELECT id FROM workspace_connectors WHERE connector_type='registry-mcp'`)).rows).toHaveLength(0);
  });


  it.each([['com.stripe/mcp', 'Stripe', 'https://stripe.com'], ['app.linear/linear', 'Linear', 'https://linear.app']])('R-YOUTUBE-PUBLISHER: official %s still installs directly', async (name, title, websiteUrl) => {
    const server = { ...linearServer, name, title, websiteUrl };
    const registry = fakeRegistry([server]);
    const result = await scope2.daemonWith(registry.client).execute('connectMcpServer', { ...turn,
      serverName: server.name, version: server.version, reason: 'Use Stripe' }, HELPER);
    expect(result).toMatchObject({ status: 'connecting', connectorId: expect.any(String) });
    expect((await scope2.database.query(`SELECT registry_server_name FROM workspace_connectors WHERE connector_type='registry-mcp'`)).rows)
      .toEqual([{ registry_server_name: server.name }]);
  });


  it.each([['com.stripe/mcp', 'Stripe', 'https://stripe.com'], ['app.linear/linear', 'Linear', 'https://linear.app']])('R-YOUTUBE-PUBLISHER: connect uses official %s', async (name, title, websiteUrl) => {
    const registry = fakeRegistry([{ ...linearServer, name, title, websiteUrl }]);
    const manifest = await registry.client.exact(name, linearServer.version);
    vi.spyOn(registry.client, 'search').mockResolvedValue([manifest!]);
    const daemon = scope2.daemonWith(registry.client);
    const connection = daemon.execute('connect', { ...turn, service: title, reason: 'Use the official app' }, HELPER);
    let connectorId = '';
    await vi.waitFor(async () => {
      const row = (await scope2.database.query<{ id: string }>(`SELECT id FROM workspace_connectors WHERE registry_server_name=$1`, [name])).rows[0];
      expect(row).toBeDefined(); connectorId = row!.id;
    });
    await daemon.execute('installConnector', { agentId: HELPER, connectorId }, HELPER);
    expect(await connection).toMatchObject({ status: 'ready', transport: 'registry-mcp' });
  });


  it('owner opens agent-started Registry GitHub sign-in and selects personal authentication', async () => {
    const githubServer = { ...linearServer, name: 'com.github/github', title: 'GitHub',
      websiteUrl: 'https://github.com',
      remotes: [{ type: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' }] };
    const registry = fakeRegistry([githubServer]);
    const daemon = scope2.daemonWith(registry.client);
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
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client);
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
    const provider = scope2.fakeComposio('github');
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = scope2.daemonWith(registry.client, provider);
    let started = await daemon.execute('connectApp', { ...turn, app: 'GitHub', reason: 'connect personal GitHub' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client, provider);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    provider.accountStatus.mockResolvedValueOnce({ status: 'pending' });
    await expect(phone.execute('completeAppSignIn', {
      sessionUri: 'session-fixture', appId: started.appId!,
    }, OWNER)).rejects.toThrow('App sign-in could not be verified');
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .not.toContainEqual(expect.objectContaining({ appId: started.appId }));
    started = await daemon.execute('connectApp', { ...turn, app: 'GitHub', reason: 'retry personal GitHub' }, HELPER);
    provider.account.mockResolvedValueOnce(false);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: started.appId! }, OWNER);
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).apps)
      .toContainEqual(expect.objectContaining({ appId: started.appId,
        status: 'connected', selectedByOwner: true }));
  });


  it('refuses YouTube without its custom sign-in instead of issuing a link or a Squire route', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    await expect(daemon.execute('connectApp',
      { ...turn, app: 'YouTube', reason: 'upload the launch video' }, HELPER)).resolves.toMatchObject({
      status: 'unavailable', appKey: 'youtube', next: 'This app is not available to connect yet.' });
    expect(provider.supportsOAuth).toHaveBeenCalledWith('youtube');
    expect(provider.link).not.toHaveBeenCalled();
    expect(await scope2.routes()).toEqual([]);
  });


  it('Reproduction CRED-1: connect and status agree on the selected reference among two GitHub keys', async () => {
    await scope2.connectSquire();
    await applyVaultList(scope2.database,
      { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [
        { reference: 'vault:github-work', service: 'github', label: 'Work projects',
          fieldNames: ['token'], allowedHosts: ['api.github.com'], createdAt: 1, stale: false, state: 'active' },
        { reference: 'vault:github-public', service: 'github', label: 'Public projects',
          fieldNames: ['token'], allowedHosts: ['api.github.com'], createdAt: 2, stale: false, state: 'error' },
      ]);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, scope2.fakeComposio());
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


  it('Reproduction APP-CATALOG-CONTINUATION: reaches every tool in a 1,895-Room Workspace', async () => {
    await scope2.database.query(`INSERT INTO rooms(id,workspace_id,created_by,name,parent_id,archived_at)
      SELECT md5('catalog-room-'||n)::uuid,$1,$2,'Archived corner '||n,$3,now()
      FROM generate_series(1,1894) n`, [WORKSPACE, OWNER, ROOM]);
    const appId = randomUUID();
    await scope2.database.query(`INSERT INTO workspace_apps
      (id,workspace_id,owner_identity_id,app_key,display_name,transport,route,composio_account_id)
      VALUES($1,$2,$3,'slack','Slack','composio','composio','ca_fixture')`, [appId, WORKSPACE, OWNER]);
    const items = Array.from({ length: 1000 }, (_, i) => ({ slug: `SLACK_TOOL_${i}`,
      name: `Tool ${i}`, toolkit: { slug: 'slack' }, description: 'Useful description '.repeat(30),
      input_parameters: { type: 'object' } }));
    const transport = vi.fn(async (url: URL | string) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/connected_accounts/ca_fixture')) return Response.json({
        id: 'ca_fixture', user_id: OWNER, toolkit: { slug: 'slack' }, status: 'ACTIVE',
      });
      if (!parsed.searchParams.has('cursor') && !parsed.searchParams.has('query'))
        return Response.json({ items: [], next_cursor: 'catalog' });
      return Response.json({ items });
    });
    const daemon = scope2.daemonWith(fakeRegistry([]).client, new ComposioApps('fixture-only', transport as typeof fetch));
    const slugs: string[] = [];
    let query: string | undefined;
    let pages = 0;
    do {
      const page = await daemon.execute('listAppTools', { ...turn, appId, query }, HELPER);
      slugs.push(...page.tools.map(tool => tool.slug));
      query = /query="(beeline-page:[^"]+)"/.exec(page.next ?? '')?.[1];
      pages++;
    } while (query);
    expect(pages).toBeGreaterThan(1);
    expect(slugs).toEqual(items.map(tool => tool.slug));
    expect((await scope2.database.query(`SELECT count(*)::int count FROM rooms WHERE workspace_id=$1`, [WORKSPACE])).rows[0]).toEqual({ count: 1895 });
    const schema = await daemon.execute('listAppTools', { ...turn, appId, query: 'SLACK_TOOL_999' }, HELPER);
    expect(schema.tools).toEqual([expect.objectContaining({ slug: 'SLACK_TOOL_999', inputParameters: { type: 'object' } })]);
    await scope2.database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [HELPER]);
    await expect(daemon.execute('listAppTools', { ...turn, appId }, HELPER)).rejects.toThrow();
  }, 120_000);


  it('uses a connected owner app from a Room and corner where only the agent is a member', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const started = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: started.appId! }, OWNER);

    const otherWorkspace = '55555555-5555-4555-8555-555555555555';
    const otherRoom = '66666666-6666-4666-8666-666666666666';
    const otherCorner = '77777777-7777-4777-8777-777777777777';
    const host = 'c'.repeat(64);
    await scope2.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Host')`, [host]);
    await scope2.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`, [otherWorkspace]);
    await scope2.database.query(`INSERT INTO rooms(id,workspace_id,created_by,name)
      VALUES($1,$3,$4,'Other room'),($2,$3,$4,'Other corner')`,
      [otherRoom, otherCorner, otherWorkspace, host]);
    await scope2.database.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [otherRoom, otherCorner]);
    await scope2.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$3,'member') `,
      [otherWorkspace, host, HELPER, otherRoom]);
    for (const [roomId, requestId, generationId] of [
      [otherRoom, 'other-room-request', 'other-room-generation'],
      [otherCorner, 'other-corner-request', 'other-corner-generation'],
    ]) {
      const sourceId = `${requestId}-source`;
      const commandId = `${requestId}-command`;
      await scope2.database.query(`INSERT INTO messages(id,room_id,author_id,text)
        VALUES($1,$2,$3,'Use my connected app')`, [sourceId, roomId, host]);
      await scope2.database.query(`INSERT INTO agent_commands(
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
    await scope2.database.query(
      `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
       VALUES($1,$2,$3,'neon','Neon','squire-api','squire-api')`,
      [neon, WORKSPACE, OWNER],
    );
    const daemon = scope2.daemonWith(fakeRegistry([]).client, scope2.fakeComposio());
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
    await scope2.database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other','other')`, [other]);
    await scope2.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, other]);
    await scope2.database.query(`UPDATE workspace_apps SET owner_identity_id=$1 WHERE id=$2`, [other, neon]);
    await expect(daemon.execute('listAppTools', { ...turn, appId: neon }, HELPER))
      .rejects.toThrow("Neon is another person's squire-api app; only their own agents can use it.");
  });


  it('Reproduction APP-ROUTE-1: daemon HTTP discovers Squire routes and refuses tool execution', async () => {
    const appId = 'edd5e6c5-fc4c-4170-93c0-8efef63010c9';
    await scope2.database.query(
      `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
       VALUES($1,$2,$3,'github','GitHub','squire-api','squire-api')`,
      [appId, WORKSPACE, OWNER],
    );
    await scope2.connectSquire();
    await applyVaultList(scope2.database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
      reference: 'vault:github', service: 'github', label: 'default',
      fieldNames: ['token'], allowedHosts: ['api.github.com'], createdAt: 1,
      stale: false, state: 'active',
    }]);
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const phone = new PhoneService(scope2.database, 'http://placeholder');
    const server = createBeelineServer({ database: scope2.database, phone, daemon, live: new LiveHub(),
      mediaMaximumBytes: 1,
      auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.mocked(captureServerError).mockClear();
    try {
      for (const otherOwner of [false, true]) {
        if (otherOwner) {
          const other = 'c'.repeat(64);
          await scope2.database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other','other')`, [other]);
          await scope2.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
            VALUES($1,NULL,$2,'member')`, [WORKSPACE, other]);
          await scope2.database.query(`UPDATE workspace_apps SET owner_identity_id=$1 WHERE id=$2`, [other, appId]);
        }
        const message = otherOwner
          ? "GitHub is another person's squire-api app; only their own agents can use it."
          : 'GitHub is connected through squire-api, not app tools. ' +
            'Call GitHub\'s API with Trusty Squire use_credential (reference "vault:github").';
        for (const operation of ['listAppTools', 'executeAppTool']) {
          const response = await phoneFetch(`${origin}/v1/daemon/operations/${operation}`, {
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
      await scope2.database.query(`INSERT INTO workspace_apps
        (id,workspace_id,owner_identity_id,app_key,display_name,transport,route,composio_account_id)
        VALUES($1,$2,$3,$4,$4,'composio','composio','account-fixture')`,
        [ids[index], WORKSPACE, OWNER, key]);
    }
    const provider = scope2.fakeComposio();
    await provider.completeAuth('session-fixture', OWNER);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const server = createBeelineServer({ database: scope2.database, phone: new PhoneService(scope2.database, 'http://placeholder'),
      daemon, live: new LiveHub(), mediaMaximumBytes: 1,
      auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (operation: string, args: Record<string, unknown>) => {
      const response = await phoneFetch(`${origin}/v1/daemon/operations/${operation}`, {
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
      await scope2.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [other]);
      await scope2.database.query(`INSERT INTO workspace_apps
        (id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
        VALUES($1,$2,$3,'github','GitHub','composio','composio')`, [duplicate, WORKSPACE, other]);
      // An inaccessible matching key must not make the owner's connection ambiguous.
      expect((await call('listAppTools', { appId: 'github' })).status).toBe(200);
      await scope2.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
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
      await scope2.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Third')`, [third]);
      await scope2.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'member')`, [WORKSPACE, third]);
      await scope2.database.query(`UPDATE workspace_apps SET owner_identity_id=$1 WHERE id=$2`, [third, ids[0]]);
      for (const operation of ['listAppTools', 'executeAppTool']) {
        const ambiguous = await call(operation, { appId: 'github', tool: 'SLACK_POST_MESSAGE', arguments: {} });
        expect(ambiguous.status).toBe(400);
        expect(ambiguous.body).toEqual({ error:
          `Connected app key is ambiguous; use an exact app id: ${duplicate}, ${ids[0]}` });
      }
      await scope2.database.query(`UPDATE workspace_apps SET owner_identity_id=$1 WHERE id=$2`, [OWNER, ids[0]]);
      expect((await call('listAppTools', { appId: ids[0] })).status).toBe(200);
      console.log('Reproduction R-APPKEY: workbench keys github/web discover and execute over HTTP; unknown and ambiguous keys refused');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });


  it('returns an empty tool list over the daemon API when a query matches nothing', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const started = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'find a tool' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: started.appId! }, OWNER);
    provider.listTools.mockResolvedValueOnce({ tools: [] });
    const server = createBeelineServer({ database: scope2.database, phone, daemon, live: new LiveHub(),
      mediaMaximumBytes: 1,
      auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await phoneFetch(`${origin}/v1/daemon/operations/listAppTools`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bdt_fixture-token-0001' },
        body: JSON.stringify({ ...turn, appId: started.appId!, query: 'nonexistent-tool' }),
      });
      const result = await response.json();
      console.log(`Reproduction tool-input-limits: no-match query → HTTP ${response.status} ${JSON.stringify(result)}`);
      expect(response.status).toBe(200);
      expect(result).toEqual({
        tools: [],
        next: expect.stringContaining('query set to a tool slug or search phrase for matching input schemas'),
      });
      expect(provider.listTools).toHaveBeenCalledWith('slack', 'nonexistent-tool');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });


  it('names the cause when a connected app has no discoverable tools', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const started = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: started.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: started.appId! }, OWNER);
    provider.listTools.mockResolvedValueOnce({ tools: [] });
    await expect(daemon.execute('listAppTools', { ...turn, appId: started.appId! }, HELPER))
      .rejects.toThrow(/no tools/i);
  });


  it.each(['Linear', 'Example App'])('shows a failed provider link for %s on Workbench and clears it on retry', async (app) => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    let first = await daemon.execute('connectApp',
      { ...turn, app, reason: `connect ${app}` }, HELPER);
    expect(first).toMatchObject({ status: 'needs_sign_in', transport: 'composio' });
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    provider.link.mockRejectedValueOnce(new Error('App provider request failed (403)'));
    await expect(phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER))
      .rejects.toThrow('App provider request failed (403)');
    expect((await phone.readRoom(ROOM, OWNER))?.messages.find((message) =>
      message.appSignIn?.appId === first.appId)?.appSignIn).toMatchObject({
        status: 'failed', errorMessage: 'App provider request failed (403)',
      });
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps)
      .not.toContainEqual(expect.objectContaining({ appId: first.appId }));
    first = await daemon.execute('connectApp', { ...turn, app, reason: 'retry sign-in' }, HELPER);
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps)
      .not.toContainEqual(expect.objectContaining({ appId: first.appId }));
  });


  it('projects provider descriptions and logos to app rows and the connect catalog', async () => {
    const provider = scope2.fakeComposio('gmail');
    provider.toolkit.mockImplementation(async (toolkit: string) => ({ slug: toolkit,
      description: `Use ${toolkit} tools.`, logo: `https://cdn.composio.dev/${toolkit}.png`,
      ...(toolkit === 'gmail' ? { appUrl: 'https://mail.google.com' } : {}) }));
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp',
      { ...turn, app: 'Gmail', reason: 'connect Gmail' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: first.appId! }, OWNER);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.apps).toContainEqual(expect.objectContaining({ appId: first.appId,
      description: 'Use gmail tools.', logo: 'https://cdn.composio.dev/gmail.png',
      domain: 'mail.google.com' }));
    expect(view.appCatalog).toContainEqual({ appKey: 'gmail',
      description: 'Use gmail tools.', logo: 'https://cdn.composio.dev/gmail.png',
      domain: 'mail.google.com' });
  });


  it.each(['Instagram', 'Figma'])('Reproduction CARD-1: %s Room cards retain the same logo as Workbench', async (app) => {
    const provider = scope2.fakeComposio(app.toLowerCase());
    provider.supportsOAuth.mockResolvedValue(true);
    provider.toolkit.mockImplementation(async (slug: string) => ({ slug,
      logo: `https://cdn.composio.dev/${slug}.png`, appUrl: `https://${slug}.com` }));
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp', { ...turn, app,
      reason: `connect ${app}` }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    const expected = { logo: `https://cdn.composio.dev/${app.toLowerCase()}.png`,
      domain: `${app.toLowerCase()}.com` };
    const cardMessage = (await phone.readRoom(ROOM, OWNER))?.messages.find(message =>
      message.appSignIn?.appId === first.appId);
    const card = readRoomViewMessage(cardMessage)?.appSignIn;
    expect(card).toMatchObject(expected);
    const historyCard = (await phone.readHistory(ROOM, OWNER))?.messages.find(message =>
      message.appSignIn?.appId === first.appId)?.appSignIn;
    expect(historyCard).toMatchObject(expected);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: first.appId! }, OWNER);
    const workbench = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(workbench.apps).toContainEqual(expect.objectContaining({ appId: first.appId, ...expected }));
    for (const view of [await phone.readRoom(ROOM, OWNER), await phone.readHistory(ROOM, OWNER)]) {
      expect(view?.messages.some(message => message.appSignIn?.appId === first.appId)).toBe(false);
      expect(view?.messages.filter(message => message.text.includes(`connected ${app}`))).toHaveLength(1);
    }
    if (process.env.BEELINE_SIGN_IN_PROOF === '1')
      console.log(`CARD-1 ${app}: Room and history cards show ${expected.logo}, matching Workbench`);
  });


  it('keeps existing Room cards usable when provider metadata fails or stalls', async () => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp', { ...turn, app: 'Instagram',
      reason: 'connect Instagram' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
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
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    provider.completeAuth.mockResolvedValue({ accountId: 'ca_fixture', toolkit: 'instagram' });
    provider.account.mockResolvedValue(true);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    let appId: string;
    let authorizationUrl: string;
    if (route === 'card') {
      const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
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
    const server = createBeelineServer({ database: scope2.database, phone, daemon: {} as DaemonService,
      live: new LiveHub(), mediaMaximumBytes: 1,
      auth: { authenticatePhone: async (token: string) => token === 'fixture-phone-token-0001' ? OWNER : null } as TokenAuth });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const callback = await phoneFetch(`${origin}/v1/apps/oauth/verify?session_uri=session-fixture`);
      expect(callback.status).toBe(200);
      const html = await callback.text();
      const returnLink = new URL(html.match(/id="open-beeline" href="([^"]+)"/)![1]);
      expect(html).toContain('Open Beeline</a>');
      expect(provider.completeAuth).not.toHaveBeenCalled();
      const input = { sessionUri: returnLink.searchParams.get('appSignInSession'), appId };
      const unauthorized = await phoneFetch(`${origin}/v1/phone/operations/completeAppSignIn`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      expect(unauthorized.status).toBe(401);
      expect(provider.completeAuth).not.toHaveBeenCalled();
      provider.accountStatus.mockResolvedValue({ status: 'active' });
      const completion = await phoneFetch(`${origin}/v1/phone/operations/completeAppSignIn`, {
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
      const messages = (await phone.readRoom(ROOM, OWNER))!.messages;
      expect(messages.some(message => message.appSignIn?.appId === appId)).toBe(false);
      expect(messages.filter(message => message.text.includes('connected Instagram'))).toHaveLength(1);
      expect((await scope2.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
        AND agent_id=$2 AND reason='app_connected'`, [ROOM, HELPER])).rowCount).toBe(1);
    }
    if (process.env.BEELINE_SIGN_IN_PROOF === '1')
      console.log(`RETURN-1 / SIGNIN-1 ${route}: visible fallback retains the first session; anonymous completion refused; authenticated phone connects Workbench${route === 'card' ? ', settles card and resumes request' : ''}; no second sign-in link`);
  });


  it('shows a failed callback on Workbench and clears it on retry', async () => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    let first = await daemon.execute('connectApp',
      { ...turn, app: 'Linear', reason: 'connect Linear' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    provider.completeAuth.mockRejectedValueOnce(new Error('App provider request failed (403)'));
    await expect(phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: first.appId! }, OWNER))
      .rejects.toThrow('App provider request failed (403)');
    expect((await phone.readRoom(ROOM, OWNER))?.messages.find((message) =>
      message.appSignIn?.appId === first.appId)?.appSignIn).toMatchObject({
        status: 'failed', errorMessage: 'App provider request failed (403)',
      });
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps)
      .not.toContainEqual(expect.objectContaining({ appId: first.appId }));
    first = await daemon.execute('connectApp', { ...turn, app: 'Linear', reason: 'retry sign-in' }, HELPER);
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps)
      .not.toContainEqual(expect.objectContaining({ appId: first.appId }));
  });
});
