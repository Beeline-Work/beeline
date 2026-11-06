import { phoneFetch, describe, expect, it, vi, PhoneService, LiveHub, CompanyMcpDiscovery, applyVaultList, readOwnerApps, cleanupUnfinishedAppSignIns, ComposioApps, createBeelineServer, captureServerError, WORKSPACE, ROOM, OWNER, HELPER, turn, fakeRegistry, fixtureScope2, fixtureScope3, type AddressInfo, type TokenAuth } from './test-support-app-connections.integration.test-support.js';

describe('connect_app', () => {
const scope2 = fixtureScope2();


  it.each(['Instagram', 'Runway'])('Reproduction OAuth-1: %s provider failure reaches Workbench and its card', async (app) => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp',
      { ...turn, app, reason: `connect ${app}` }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
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
    expect(view.apps).not.toContainEqual(expect.objectContaining({ appId: first.appId }));
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


  it('Reproduction CONNECTORS-1: removes abandoned owner sign-ins and preserves a broken real connection', async () => {
    for (const [index, name] of ['Slack', 'Supabase', 'WhatsApp', 'Notion'].entries()) {
      await scope2.database.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,
        transport,route,composio_account_id,composio_link_expires_at,authorised_at)
        VALUES($1,$2,$3,$4,$5,'composio','composio',$6,now()-interval '1 day',
          CASE WHEN $7 THEN now()-interval '2 days' ELSE NULL END)`,
      [`99999999-9999-4999-8999-99999999999${index}`, WORKSPACE, OWNER, name.toLowerCase(), name, `account-${index}`, index === 3]);
    }
    expect(await cleanupUnfinishedAppSignIns(scope2.database)).toBe(3);
    expect(await cleanupUnfinishedAppSignIns(scope2.database, true)).toBe(3);
    const provider = scope2.fakeComposio();
    provider.accountStatus.mockResolvedValue({ status: 'failed', reason: 'Token revoked' });
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.apps?.map(app => app.appKey)).toEqual(['notion']);
    expect(view.companies?.rows.filter(row => row.section === 'attention').map(row => row.name)).toEqual(['Notion']);
    expect(view.companies?.rows.find(row => row.name === 'Notion')?.items[0]?.attention).toBe(true);
    expect(await cleanupUnfinishedAppSignIns(scope2.database)).toBe(0);
  });


  it.each(['Instagram', 'Runway'])('Reproduction OAuth-2: %s expires a pending sign-in', async (app) => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    provider.link.mockResolvedValue({ url: 'https://app.composio.dev/connect/fixture',
      accountId: 'ca_fixture', expiresAt: new Date(Date.now() + 60 * 60_000) });
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const first = await daemon.execute('connectApp',
      { ...turn, app, reason: `connect ${app}` }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: first.appId! }, OWNER);
    const deadline = (await scope2.database.query<{ composio_link_expires_at: Date }>(
      `SELECT composio_link_expires_at FROM workspace_apps WHERE id=$1`, [first.appId],
    )).rows[0]!.composio_link_expires_at;
    expect(deadline.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    await scope2.database.query(`UPDATE workspace_apps SET composio_link_expires_at=now()-interval '1 second'
      WHERE id=$1`, [first.appId]);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.apps).not.toContainEqual(expect.objectContaining({ appId: first.appId }));
    expect(view.companies?.rows.some(row => row.section === 'attention')).toBe(false);
    expect((await scope2.database.query('SELECT id FROM workspace_apps WHERE id=$1', [first.appId])).rows).toEqual([]);
    expect((await phone.readRoom(ROOM, OWNER))?.messages.find((message) =>
      message.appSignIn?.appId === first.appId)?.appSignIn).toMatchObject({ status: 'failed',
        errorMessage: expect.stringContaining('timed out') });
    if (process.env.BEELINE_SIGN_IN_PROOF === '1')
      console.log(`OAuth-2 ${app}: Workbench=error, card=failed; reason=App sign-in timed out`);
  });


  it('WB-CALLBACK-2: fails only the initiating app when two sign-ins are pending', async () => {
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const linear = await daemon.execute('connectApp',
      { ...turn, app: 'Linear', reason: 'connect Linear' }, HELPER);
    const slack = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'connect Slack' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: linear.appId! }, OWNER);
    await phone.execute('beginAppSignIn', { appId: slack.appId! }, OWNER);
    provider.completeAuth.mockRejectedValueOnce(new Error('App provider request failed (403)'));
    await expect(phone.execute('completeAppSignIn',
      { sessionUri: 'session-fixture', appId: linear.appId! }, OWNER))
      .rejects.toThrow('App provider request failed (403)');
    const apps = (await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).apps;
    expect(apps).toEqual([]);
    const cards = (await phone.readRoom(ROOM, OWNER))?.messages;
    expect(cards?.find(message => message.appSignIn?.appId === linear.appId)?.appSignIn?.status).toBe('failed');
    expect(cards?.find(message => message.appSignIn?.appId === slack.appId)?.appSignIn?.status).toBe('pending');
  });


  it('rejects invalid card copy before creating a connection or card', async () => {
    const daemon = scope2.daemonWith(fakeRegistry([]).client, scope2.fakeComposio());
    await expect(daemon.execute('connectApp', { ...turn, app: 'Slack',
      reason: 'post the launch notes', continuation: '<b>Do this now.</b>' }, HELPER))
      .rejects.toThrow(/app continuation/);
    expect((await scope2.database.query(`SELECT 1 FROM messages WHERE card_type='app-sign-in'`))
      .rowCount).toBe(0);
    expect((await scope2.database.query(`SELECT 1 FROM workspace_apps`)).rowCount).toBe(0);
  });


  it('binds sign-in to the returning person and refuses a foreign agent until the app owner approves', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    expect((await scope2.database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='app-sign-in'`, [ROOM],
    )).rows[0]?.card).not.toHaveProperty('continuation');
    const OTHER = 'c'.repeat(64);
    await scope2.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [OTHER]);
    expect(await readOwnerApps(scope2.database, OTHER, provider)).toEqual([]);
    await scope2.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WORKSPACE, OTHER, ROOM]);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await expect(phone.execute('beginAppSignIn', { appId: connected.appId! }, OTHER))
      .rejects.toThrow(/no longer in your Connectors/);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    await expect(phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OTHER))
      .rejects.toThrow(/no longer pending/);
    expect((await scope2.database.query(`SELECT 1 FROM workspace_apps WHERE id=$1 AND
      composio_link_expires_at IS NOT NULL`, [connected.appId])).rowCount).toBe(1);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OWNER);

    await scope2.database.query(`UPDATE agents SET owner_id=$1 WHERE agent_id=$2`, [OTHER, HELPER]);
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
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OWNER);
    provider.deleteAccount.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(phone.execute('disconnectWorkbenchApp', {
      workspaceId: WORKSPACE, appId: connected.appId!,
    }, OWNER)).rejects.toThrow(/provider unavailable/);
    expect((await readOwnerApps(scope2.database, OWNER, provider))[0]?.status).toBe('connected');
    await phone.execute('disconnectWorkbenchApp', {
      workspaceId: WORKSPACE, appId: connected.appId!,
    }, OWNER);
    expect((await scope2.database.query<{ state: string }>(
      `SELECT state FROM workspace_apps WHERE id=$1`, [connected.appId])).rows[0]?.state)
      .toBe('disconnected');
  });


  it.skipIf(!process.env.CONNECTOR_BROWSER_PROOF)('CONNECTOR-BROWSER: real service bridge', async () => {
    const { createServer } = await import('node:http');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const provider = scope2.fakeComposio();
    provider.searchToolkits = vi.fn(async () => []);
    await scope2.connectSquire();
    await applyVaultList(scope2.database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER },
      Array.from({length:6}, (_,i) => ({reference:'vault:fly-'+i,service:'fly',label:'Fly key '+i,fieldNames:['token'],allowedHosts:['api.fly.io'],createdAt:1,stale:false,state:'active' as const})));
    const registry = fakeRegistry([]);
    const discovery = new CompanyMcpDiscovery(async () => ({status:200,body:JSON.stringify({resource:'https://mcp.fly.io',authorization_servers:['https://fly.io/mcp/oauth']})}));
    registry.client.companies.discover = discovery.discover.bind(discovery);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client, provider);
    const connected = await scope2.daemonWith(fakeRegistry([]).client, provider).execute('connectApp',
      { ...turn, app: 'Slack', reason: 'browser removal proof' }, HELPER);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    await phone.execute('completeAppSignIn', { sessionUri: 'session-fixture', appId: connected.appId! }, OWNER);
    const server = createServer(async (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'content-type');
      if (request.method === 'OPTIONS') { response.end(); return; }
      try {
        let body = ''; for await (const chunk of request) body += chunk;
        const { operation, input } = JSON.parse(body);
        if (operation === 'resetProof') {
          await scope2.database.query("UPDATE workspace_apps SET state='active' WHERE id=$1", [connected.appId]);
          response.end('{}'); return;
        }
        if (!['readWorkbench', 'disconnectWorkbenchApp', 'searchWorkbenchApps', 'connectWorkbenchApp'].includes(operation)) throw new Error('Proof operation not allowed');
        const pending = phone.execute(operation, input, OWNER);
        if (operation === 'connectWorkbenchApp') await scope2.publishFlySignIn();
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
    const provider = scope2.fakeComposio();
    provider.supportsOAuth.mockResolvedValue(true);
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp', { ...turn, app, reason: 'connect app' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    provider.completeAuth.mockRejectedValueOnce(new Error('authorization timeout'));
    await expect(phone.execute('completeAppSignIn', { sessionUri: 'session-fixture',
      appId: connected.appId! }, OWNER)).rejects.toThrow('authorization timeout');
    const read = () => phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect((await read()).apps).not.toContainEqual(expect.objectContaining({ appId: connected.appId }));
    expect((await scope2.database.query('SELECT id FROM workspace_apps WHERE id=$1', [connected.appId])).rows).toEqual([]);
    await expect(phone.execute('disconnectWorkbenchApp', { workspaceId: WORKSPACE,
      appId: connected.appId! }, 'c'.repeat(64))).rejects.toThrow();
    expect(provider.deleteAccount).not.toHaveBeenCalled();
    await expect(phone.execute('disconnectWorkbenchApp', { workspaceId: WORKSPACE, appId: connected.appId! }, OWNER)).rejects.toThrow('app not found');
    expect((await read()).apps).not.toContainEqual(expect.objectContaining({ appId: connected.appId }));
    await expect(phone.execute('completeAppSignIn', { sessionUri: 'session-fixture',
      appId: connected.appId! }, OWNER)).rejects.toThrow();
    expect((await read()).apps).not.toContainEqual(expect.objectContaining({ appId: connected.appId }));
  });


  it('deletes a pending provider account when its app is disconnected', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    expect((await readOwnerApps(scope2.database, OWNER, provider))[0]?.status).toBe('connecting');
    await phone.execute('disconnectWorkbenchApp', { workspaceId: WORKSPACE,
      appId: connected.appId! }, OWNER);
    expect(provider.deleteAccount).toHaveBeenCalledWith('ca_fixture');
    expect(await readOwnerApps(scope2.database, OWNER, provider)).toEqual([]);
  });


  it('does not execute from a provider account activated before identity verification', async () => {
    const provider = scope2.fakeComposio();
    const daemon = scope2.daemonWith(fakeRegistry([]).client, provider);
    const connected = await daemon.execute('connectApp',
      { ...turn, app: 'Slack', reason: 'post the launch notes' }, HELPER);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client, provider);
    await phone.execute('beginAppSignIn', { appId: connected.appId! }, OWNER);
    // A misconfigured provider project must not make an account usable before
    // the authenticated phone returns and the server redeems its session.
    provider.account.mockResolvedValue(true);
    expect((await readOwnerApps(scope2.database, OWNER, provider))[0]?.status).toBe('connecting');
    await expect(daemon.execute('executeAppTool', { ...turn, appId: connected.appId!,
      tool: 'SLACK_POST_MESSAGE', arguments: {} }, HELPER))
      .resolves.toEqual({ status: 'needs_connection' });
    expect(provider.execute).not.toHaveBeenCalled();
  });




  it('asks for Trusty Squire before an API route can start, then connects on the vaulted key', async () => {
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
    const blocked = await daemon.execute(
      'connectApp',
      { ...turn, app: 'Resend', reason: 'send' },
      HELPER,
    );
    expect(blocked).toMatchObject({ status: 'needs_squire', route: 'squire-api' });
    expect((blocked as { next: string }).next).not.toMatch(/offer_connector|store_credential|operate_/);
    await scope2.connectSquire();
    const connecting = await daemon.execute(
      'connectApp',
      { ...turn, app: 'Resend', reason: 'send' },
      HELPER,
    );
    expect(connecting).toMatchObject({ status: 'connecting', transport: 'squire-api' });
    expect((connecting as { next: string }).next).not.toMatch(/store_credential|operate_/);
    await applyVaultList(scope2.database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [
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
    expect(await scope2.routes()).toEqual([{ route: 'squire-api', transport: 'squire-api' }]);
    const [app] = await readOwnerApps(scope2.database, OWNER);
    expect(app).toMatchObject({
      appKey: 'resend',
      status: 'connected',
      connectionReference: 'vault:resend',
    });
  });


  it('shows one key for repeated vault reports from the same machine', async () => {
    await scope2.connectSquire();
    const key = { reference: 'vault://openrouter/default', service: 'openrouter', label: 'default',
      fieldNames: ['api_key'], allowedHosts: ['openrouter.ai'], createdAt: 1, stale: false,
      state: 'active' as const };
    for (let report = 0; report < 3; report++)
      await applyVaultList(scope2.database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [key]);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client);
    const view = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(view.connections.map((connection) => connection.reference)).toEqual([key.reference]);
  });


  it('reuses an existing Workbench key without searching the Registry', async () => {
    const registry = fakeRegistry([{ name: 'com.stripe/mcp', version: '0.2.4',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.stripe.com' }] }]);
    await scope2.connectSquire();
    await applyVaultList(scope2.database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [
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
      scope2.daemonWith(registry.client).execute(
        'connectApp',
        { ...turn, app: 'stripe.com', reason: 'refund' },
        HELPER,
      ),
    ).resolves.toMatchObject({ status: 'connected', route: 'workbench', transport: 'squire-api' });
    expect(registry.transport).not.toHaveBeenCalled();
  });


  it('moves to the browser only when Squire reports no API', async () => {
    await scope2.connectSquire();
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
    await daemon.execute('connectApp', { ...turn, app: 'Hacker News', reason: 'post' }, HELPER);
    const browser = await daemon.execute(
      'connectApp',
      { ...turn, app: 'Hacker News', reason: 'post', noApi: true },
      HELPER,
    );
    expect(browser).toMatchObject({ route: 'squire-browser', transport: 'squire-browser' });
    expect(await scope2.routes()).toEqual([
      { route: 'squire-api', transport: 'squire-api' },
      { route: 'squire-browser', transport: 'squire-browser' },
    ]);
  });








  it('lets the owner use Squire for an app another person has connected', async () => {
    const other = 'c'.repeat(64);
    await scope2.database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other','other')`, [other]);
    await scope2.database.query(
      `INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
       VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,$2,'fly','Fly','squire-api','squire-api')`,
      [WORKSPACE, other],
    );
    const daemon = scope2.daemonWith(fakeRegistry([]).client);
    // Older helpers still send the app keys a Squire call names; the gate ignores them.
    await expect(
      daemon.execute('authorizeResourceCall', { ...turn, target: 'squire', appKeys: ['fly'] } as never, HELPER),
    ).resolves.toEqual({ allowed: true });
    expect((await scope2.database.query(`SELECT 1 FROM workspace_app_usage`)).rowCount).toBe(0);
  });
describe('Room files for app tools', () => {
const scope3 = fixtureScope3(scope2);


    it.each(['clear refusal', 'ambiguous 503', 'network loss', 'id with error', 'concurrent'])('R1: phone Post approval handles %s', async (failure) => {
      const { daemon, transport, calls } = await scope3.youtubeRoom();
      await scope2.database.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at)
        VALUES('starter-welcome',$1,$2,'Welcome','{"starterOnboarding":"welcome","selectedOptionId":"B"}',now()-interval '1 minute')`, [ROOM, HELPER]);
      const { postRoomChoice } = await import('./room-choice.js');
      const preview = await postRoomChoice(scope2.database, { roomId: ROOM, agentId: HELPER, mode: 'question', prompt: 'Song',
        options: [{ label: 'Post', consequence: 'Post' }, { label: 'Cancel', consequence: 'Cancel' }] });
      await scope2.database.query(`UPDATE messages SET card=card || $2::jsonb WHERE id=$1`, [preview.messageId, JSON.stringify({
        status: 'answered', selectedOptionId: 'A', videoPreview: { videoObjectId: scope3.IN_ROOM, title: 'Song', description: '', visibility: 'private' }
      })]);
      const original = transport.getMockImplementation()!;
      let refused = false;
      let release!: () => void;
      let started!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      transport.mockImplementation(async (url, init) => {
        if (String(url).includes('/tools/execute/YOUTUBE_MULTIPART_UPLOAD_VIDEO') && !refused) {
          refused = true;
          if (failure === 'concurrent') { started(); await pending; return original(url, init); }
          if (failure === 'network loss') throw new Error('connection lost after sending bytes');
          if (failure === 'ambiguous 503') return Response.json({ message: 'upstream unavailable' }, { status: 503 });
          return Response.json({ ...(failure === 'id with error' ? { data: { id: 'yt-already-created' } } : {}), successful: false, error: { code: 503, message: 'The channel is not properly configured.', errors: [{ reason: 'youtubeSignupRequired' }] } });
        }
        return original(url, init);
      });
      const call = () => daemon.execute('executeAppTool', { ...turn, appId: scope3.YOUTUBE_APP,
        tool: 'YOUTUBE_MULTIPART_UPLOAD_VIDEO', arguments: { title: 'Song', description: '', privacyStatus: 'private', videoFile: { beelineObjectId: scope3.IN_ROOM } } }, HELPER);
      if (failure === 'concurrent') {
        const first = call();
        await entered;
        try { await expect(call()).rejects.toThrow('tap Post'); }
        finally { release(); }
        await expect(first).resolves.toMatchObject({ data: { id: 'yt-1' } });
      } else {
        await expect(call()).rejects.toThrow(failure === 'network loss' ? 'connection lost' : failure === 'ambiguous 503' ? '503' : 'channel is not properly configured');
        if (failure === 'clear refusal') await expect(call()).resolves.toMatchObject({ status: 'executed', data: { id: 'yt-1' } });
      }
      await expect(call()).rejects.toThrow('tap Post');
      expect(calls.filter(c => c.url.includes('/tools/execute/YOUTUBE_MULTIPART_UPLOAD_VIDEO'))).toHaveLength(['clear refusal', 'concurrent'].includes(failure) ? 1 : 0);
    });


    it.each(['local path', 'broken tool', 'Room object', 'provider 5xx', 'network', 'upload PUT'])(
      'Reproduction APP-FILE-1: daemon HTTP handles %s with the correct capture count', async (failure) => {
        const { daemon, transport, calls } = await scope3.youtubeRoom();
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
        const server = createBeelineServer({ database: scope2.database,
          phone: new PhoneService(scope2.database, 'http://placeholder'), daemon, live: new LiveHub(),
          mediaMaximumBytes: 1,
          auth: { authenticateDaemon: async () => HELPER, authenticatePhone: async () => null } as unknown as TokenAuth });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        vi.mocked(captureServerError).mockClear();
        try {
          const response = await phoneFetch(`${origin}/v1/daemon/operations/executeAppTool`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer bdt_fixture-token-0001' },
            body: JSON.stringify({ ...turn, appId: scope3.YOUTUBE_APP,
              tool: failure === 'broken tool' ? 'YOUTUBE_UPLOAD_VIDEO' : 'YOUTUBE_MULTIPART_UPLOAD_VIDEO',
              arguments: { title: 'Song', videoFile: failure === 'local path'
                ? '/tmp/video.mp4' : { beelineObjectId: scope3.IN_ROOM } } }),
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
      const { upload, calls } = await scope3.youtubeRoom();
      const result = await upload(scope3.IN_ROOM);
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
      expect(calls[4]!.body).toEqual(scope3.VIDEO);
      expect((calls[5]!.body as { arguments: unknown }).arguments).toEqual({ title: 'Song',
        videoFile: { name: 'song-take-2.mp4', mimetype: 'video/mp4', s3key: scope3.S3KEY } });
      const returned = JSON.stringify(result);
      for (const hidden of ['composio-project-key', scope3.S3KEY, scope3.PRESIGNED, 'composio-files'])
        expect(returned).not.toContain(hidden);
    });


    it('refuses YOUTUBE_UPLOAD_VIDEO and points the agent to the multipart tool', async () => {
      const { daemon, calls } = await scope3.youtubeRoom();
      await expect(daemon.execute('executeAppTool', { ...turn, appId: scope3.YOUTUBE_APP,
        tool: 'YOUTUBE_UPLOAD_VIDEO',
        arguments: { title: 'Song', videoFile: { beelineObjectId: scope3.IN_ROOM } } }, HELPER))
        .rejects.toThrow('use YOUTUBE_MULTIPART_UPLOAD_VIDEO instead');
      expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        'GET /api/v3/connected_accounts/ca_youtube']);
    });


    it('refuses an oversize Room file with no Composio request', async () => {
      const { upload, transport, getObject } = await scope3.youtubeRoom();
      await expect(upload(scope3.HUGE)).rejects.toThrow('Room file is larger than the 128 MB app tool limit');
      expect(transport).not.toHaveBeenCalled();
      expect(getObject).not.toHaveBeenCalled();
    });


    it('refuses a file from another Room or a missing object with no Composio request', async () => {
      const { upload, transport } = await scope3.youtubeRoom();
      await expect(upload(scope3.ELSEWHERE)).rejects.toThrow(`Room file ${scope3.ELSEWHERE} is not in this Room`);
      await expect(upload('99999999-9999-4999-8999-999999999999'))
        .rejects.toThrow('is not in this Room');
      await expect(upload('not-a-uuid')).rejects.toThrow('Room file not-a-uuid is not in this Room');
      expect(transport).not.toHaveBeenCalled();
    });


    it('keeps the API key out of a connection check error the provider echoes', async () => {
      const transport = vi.fn(async () =>
        Response.json({ message: 'account rejected key composio-project-key' }, { status: 401 }));
      await scope3.youtubeRoom();
      const daemon = scope2.daemonWith(fakeRegistry([]).client,
        new ComposioApps('composio-project-key', transport as typeof fetch));
      const error = await daemon.execute('executeAppTool', { ...turn, appId: scope3.YOUTUBE_APP,
        tool: 'YOUTUBE_LIST_CHANNEL_VIDEOS', arguments: {} }, HELPER).catch((e: unknown) => e as Error);
      expect(error.message).toBe('App provider request failed (401): account rejected key [redacted]');
      expect(transport).toHaveBeenCalledOnce();
    });


    it('runs a tool without Room files exactly as before', async () => {
      const { daemon, calls, getObject } = await scope3.youtubeRoom();
      await expect(daemon.execute('executeAppTool', { ...turn, appId: scope3.YOUTUBE_APP,
        tool: 'YOUTUBE_LIST_CHANNEL_VIDEOS', arguments: { maxResults: 5 } }, HELPER))
        .resolves.toEqual({ status: 'executed', data: { items: [] } });
      expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET', 'POST']);
      expect(calls[3]!.body).toEqual({ connected_account_id: 'ca_youtube', user_id: OWNER,
        arguments: { maxResults: 5 }, version: '20260930_00' });
      expect(getObject).not.toHaveBeenCalled();
    });


    it('lists and runs the YouTube Analytics report for the connected channel without a Google token', async () => {
      const { daemon, calls } = await scope3.youtubeRoom();
      const listed = await daemon.execute('listAppTools', { ...turn, appId: scope3.YOUTUBE_APP }, HELPER);
      expect(listed.tools.map((tool: { slug: string }) => tool.slug))
        .toEqual(['BEELINE_YOUTUBE_ANALYTICS_REPORT', 'YOUTUBE_LIST_CHANNEL_VIDEOS']);
      calls.length = 0;
      const result = await daemon.execute('executeAppTool', { ...turn, appId: scope3.YOUTUBE_APP,
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


  it('Reproduction MCP-DISCOVERY-1: offers Fly on its service page and replaces only an explicitly selected Squire route, retaining keys', async () => {
    await scope2.connectSquire();
    const keys = Array.from({ length: 6 }, (_, index) => ({ reference: `vault:fly-${index}`,
      service: 'fly', label: `Fly key ${index}`, fieldNames: ['access_token'], allowedHosts: ['api.fly.io'],
      createdAt: 1, stale: false, state: 'active' as const }));
    await applyVaultList(scope2.database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, keys);
    const registry = fakeRegistry([]);
    const discovery = new CompanyMcpDiscovery(async () => ({ status: 200,
      body: JSON.stringify({ resource: 'https://mcp.fly.io', authorization_servers: ['https://fly.io/mcp/oauth'] }) }));
    registry.client.companies.discover = discovery.discover.bind(discovery);
    const provider = scope2.fakeComposio(); provider.searchToolkits = vi.fn(async () => []);
    const daemon = scope2.daemonWith(registry.client, provider);
    const original = await daemon.execute('connectApp', { ...turn, app: 'fly', reason: 'Use Fly' }, HELPER);
    expect(original).toMatchObject({ transport: 'squire-api', connectionReference: 'vault:fly-0' });
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client, provider);
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
    await scope2.publishFlySignIn();
    const chosen = await selection;
    expect(chosen.authorizationUrl).toBe('https://fly.io/mcp/oauth/authorize?fixture=1');
    expect(chosen).toMatchObject({ appId: original.appId, transport: 'registry-mcp' });
    const after = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    const company = after.companies?.rows.find(row => row.id === 'fly');
    expect(company).toMatchObject({ subtitle: '1 app · 6 keys' });
    expect(company?.mcp).toBeUndefined();
    expect(company?.items.find(item => item.kind === 'connection')).toMatchObject({ title: 'Fly.io', subtitle: 'via Fly MCP' });
    expect(after.connections.map(key => key.reference).sort()).toEqual(keys.map(key => key.reference).sort());
    expect((await scope2.database.query(`SELECT reference,state,hosts FROM workspace_connections ORDER BY reference`)).rows)
      .toEqual(keys.map(key => ({ reference: key.reference, state: 'active', hosts: key.allowedHosts })));
    expect((await daemon.execute('readAgentWorkbench', { roomId: ROOM }, HELPER)).connections.map(key => key.label).sort())
      .toEqual(keys.map(key => key.label).sort());
    expect((await scope2.database.query(`SELECT reason,requested_by FROM workspace_app_routes WHERE transport='registry-mcp'`)).rows)
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
    const provider = scope2.fakeComposio(); provider.searchToolkits = vi.fn(async () => []);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client, provider);
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
    await scope2.publishFlySignIn();
    await expect(selection).resolves.toMatchObject({ transport: 'registry-mcp' });
  });


  it.each(['https://fly.io/mcp/', 'https://mcp.fly.io'])('MCP-URL-1: resolves %s to the provider MCP with saved keys', async query => {
    await scope2.connectSquire();
    await applyVaultList(scope2.database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
      reference: 'vault:fly', service: 'fly', label: 'Fly key', fieldNames: ['token'], allowedHosts: ['api.fly.io'],
      createdAt: 1, stale: false, state: 'active',
    }]);
    const registry = fakeRegistry([]);
    const discovery = new CompanyMcpDiscovery(async url => url.href === 'https://mcp.fly.io/.well-known/oauth-protected-resource'
      ? { status: 200, body: JSON.stringify({ resource: 'https://mcp.fly.io', authorization_servers: ['https://fly.io/mcp/oauth'] }) }
      : { status: 404, body: '' });
    registry.client.companies.discover = discovery.discover.bind(discovery);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client);
    await phone.execute('searchWorkbenchApps', { query }, OWNER);
    await vi.waitFor(async () => expect(await phone.execute('searchWorkbenchApps', { query }, OWNER))
      .toContainEqual(expect.objectContaining({ registryServerName: 'io.fly/company-mcp' })));
    const results = await phone.execute('searchWorkbenchApps', { query }, OWNER);
    const selected = results.find(row => row.registryServerName === 'io.fly/company-mcp')!;
    const pending = phone.execute('connectWorkbenchApp', { app: selected.name, helperAgentId: HELPER,
      registryServerName: selected.registryServerName, registryVersion: selected.registryVersion }, OWNER);
    await scope2.publishFlySignIn();
    await expect(pending).resolves.toMatchObject({ transport: 'registry-mcp', authorizationUrl: expect.stringContaining('https://fly.io/mcp/oauth/') });
    expect((await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER)).companies?.rows
      .find(row => row.id === 'fly')?.items.some(item => item.kind === 'key')).toBe(true);
  });


  it('MCP-DISCOVERY-1: cold results never wait for stalled providers; committed discovery is visible from another server', async () => {
    await scope2.connectSquire();
    await applyVaultList(scope2.database, { machine_id: 'machine-one', workspace_id: WORKSPACE, owner_identity_id: OWNER }, [{
      reference: 'vault:fly', service: 'fly', label: 'Fly key', fieldNames: ['token'], allowedHosts: ['api.fly.io'],
      createdAt: 1, stale: false, state: 'active',
    }]);
    let finishProbe!: (value: { status: number; body: string }) => void;
    let finishRegistry!: (value: []) => void;
    const registry = fakeRegistry([]);
    registry.client.search = () => new Promise(resolve => { finishRegistry = resolve; });
    const discovery = new CompanyMcpDiscovery(() => new Promise(resolve => { finishProbe = resolve; }));
    registry.client.companies.discover = discovery.discover.bind(discovery);
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client);
    const first = await phone.execute('searchWorkbenchApps', { query: 'fly' }, OWNER);
    expect(first.map(row => row.name)).toEqual(['Fly.io']);
    expect(first[0]?.description).toBe('1 key');
    await vi.waitFor(() => { expect(finishProbe).toBeTypeOf('function'); expect(finishRegistry).toBeTypeOf('function'); });
    const cold = await phone.execute('readWorkbench', { workspaceId: WORKSPACE }, OWNER);
    expect(cold.companies?.rows.find(row => row.id === 'fly')?.mcp).toBeUndefined();
    finishRegistry([]);
    finishProbe({ status: 200, body: JSON.stringify({ resource: 'https://mcp.fly.io', authorization_servers: ['https://fly.io/mcp/oauth'] }) });
    const other = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, fakeRegistry([]).client);
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
    const phone = new PhoneService(scope2.database, 'http://placeholder', undefined, undefined,
      undefined, false, scope2.database, undefined, undefined, registry.client);
    const first = await phone.execute('searchWorkbenchApps', { query: 'notion' }, OWNER);
    expect(first[0]?.name).toBe('Notion');
    await vi.waitFor(async () => expect((await scope2.database.query(`SELECT cache_key FROM connector_discovery_cache WHERE cache_key='search:notion'`)).rows).toHaveLength(1));
    const results = await phone.execute('searchWorkbenchApps', { query: 'notion' }, OWNER);
    expect(results[0]?.name).toBe('Notion');
    expect(results.some(row => row.name === 'insightfulpipe.com')).toBe(!official);
    if (official) expect(results).toEqual([expect.objectContaining({ name: 'Notion', registryServerName: 'com.notion/mcp' })]);
    else expect(results.map(row => row.name)).toEqual(['Notion', 'insightfulpipe.com']);
  });
});
