import { phoneFetch, ensureSystemDirectMessageRoom, SYSTEM_IDENTITY_ID, createHash, randomUUID, describe, expect, it, migrate, companyPopularity, applyVaultList, HUMAN, RECIPIENT, HELPER, OTHER_HELPER, WORKSPACE, fixtureScope1 } from './test-support-workbench.integration.test-support.js';

describe('workbench connectors', () => {
const scope1 = fixtureScope1();


  it('retires persisted Composio rows and keeps every other connector’s keys', async () => {
    const squireId = await scope1.pairOwnerConnector();
    const composioId = randomUUID();
    await scope1.database.query(
      `INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,connector_type,
         helper_agent_id,machine_id,status)
       VALUES($1,$2,$3,'composio',$4,$4,'installing')`,
      [composioId, WORKSPACE, HUMAN, HELPER],
    );
    await scope1.database.query(
      `INSERT INTO workspace_connections(id,connector_id,owner_identity_id,reference,service)
       VALUES($1,$2,$3,'composio:github','github')`,
      [randomUUID(), composioId, HUMAN],
    );
    await migrate(scope1.database);
    expect(
      (
        await scope1.database.query(
          `SELECT id FROM workspace_connectors WHERE connector_type='composio'`,
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await scope1.database.query<{ reference: string }>(
          `SELECT reference FROM workspace_connections WHERE owner_identity_id=$1`,
          [HUMAN],
        )
      ).rows,
    ).toEqual([{ reference: 'github.com/acme/tooling' }]);
    expect(
      (await scope1.database.query(`SELECT squire_report FROM agents WHERE agent_id=$1`, [HELPER]))
        .rows[0],
    ).toMatchObject({ squire_report: { status: 'connected' } });
    const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      catalog: { connectorType: string }[];
    };
    expect(view.catalog.map((entry) => entry.connectorType)).not.toContain('composio');
    const helperAssignments = await scope1.daemonOperation('getConnectorAssignments', {});
    expect(JSON.stringify(helperAssignments.body)).not.toContain('composio');
  });


  it('writes owner-approved Squire ledger grants for every owner agent on the machine', async () => {
    const SIBLING = 'd'.repeat(64);
    const MACHINE = 'machine-squire-box';
    await scope1.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Moth','moth')`,
      [SIBLING],
    );
    await scope1.database.query(`UPDATE agents SET machine_id=$2 WHERE agent_id=$1`, [HELPER, MACHINE]);
    await scope1.database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,$3)`, [
      SIBLING,
      HUMAN,
      MACHINE,
    ]);
    await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, SIBLING],
    );

    await scope1.pairOwnerConnector();

    const grants = await scope1.database.query<{
      agent_id: string;
      requested_by: string;
      decided_by: string;
      status: string;
      kind: string;
      target: string;
      reason: string;
    }>(
      `SELECT agent_id,requested_by,decided_by,status,kind,target,reason FROM agent_grants
       WHERE kind='mcp' AND target='squire' ORDER BY agent_id`,
    );
    expect(grants.rows).toEqual([
      {
        agent_id: HELPER,
        requested_by: HUMAN,
        decided_by: HUMAN,
        status: 'approved',
        kind: 'mcp',
        target: 'squire',
        reason: 'Trusty Squire connected on this machine',
      },
      {
        agent_id: SIBLING,
        requested_by: HUMAN,
        decided_by: HUMAN,
        status: 'approved',
        kind: 'mcp',
        target: 'squire',
        reason: 'Trusty Squire connected on this machine',
      },
    ]);
    expect(grants.rows.map((row) => row.agent_id)).not.toContain(OTHER_HELPER);
    expect((await scope1.database.query(`SELECT 1 FROM messages WHERE card_type='grant-auto'`)).rowCount).toBe(0);

  });



  it('R12b: reads one owner install by row id or type, with a 403 for another member', async () => {
    const connectorId = await scope1.pairOwnerConnector();
    for (const target of [connectorId, 'trusty-squire']) {
      expect(await scope1.phoneOperation('readConnectorInstall', { workspaceId: WORKSPACE, connectorId: target })).toMatchObject({ connectorId, status: { status: 'connected' } });
    }
    expect((await scope1.operation('readConnectorInstall', { workspaceId: WORKSPACE, connectorId }, scope1.recipientToken)).status).toBe(403);
  });


  it('pairs, syncs metadata, and scopes the workbench view to the viewer', async () => {
    const connectorId = await scope1.pairOwnerConnector();
    const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { status: string } }[];
      connections: { reference: string; lastSyncedAt?: number; stale?: boolean }[];
    };
    expect(view.connectors).toEqual([]);
    expect((view as any).helpers[0].squire.status).toBe('connected');
    expect(view.connections[0]).toMatchObject({
      reference: 'github.com/acme/tooling',
      // The brand domain the row's mark fetches, derived server-side from the
      // credential's first allowed host.
      faviconDomain: 'github.com',
    });
    expect(view.connections[0]!.stale).toBeFalsy();

    // A different member sees none of this: connections are owner-scoped.
    const otherView = (await scope1.phoneOperation(
      'readWorkbench',
      { workspaceId: WORKSPACE },
      scope1.recipientToken,
    )) as { connectors: unknown[]; connections: unknown[] };
    expect(otherView.connectors).toEqual([]);
    expect(otherView.connections).toEqual([]);
  });


  it('ranks discovery using distinct eligible active owners across apps and built-ins', async () => {
    await scope1.database.query('UPDATE identities SET hidden_from_roster=true WHERE id=$1', [RECIPIENT]);
    for (const [key, owner, state] of [['gmail', HUMAN, 'active'], ['googledrive', HUMAN, 'active'], ['stripe', RECIPIENT, 'active'], ['linear', HUMAN, 'disconnected']]) {
      await scope1.database.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route,state)
        VALUES($1,$2,$3,$4,$4,'composio','composio',$5)`, [randomUUID(), WORKSPACE, owner, key, state]);
    }
    await scope1.database.query(`INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,helper_agent_id,connector_type,status)
      VALUES($1,$2,$3,$4,'google-calendar','connected')`, [randomUUID(), WORKSPACE, HUMAN, HELPER]);
    const popularity = await companyPopularity(scope1.database);
    expect([...popularity]).toEqual([['google', 1]]);
  });


  it('projects companies from persisted metadata, isolates owners and includes hosted helpers', async () => {
    const freeAgent = 'e'.repeat(64);
    await scope1.database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Free server')", [freeAgent]);
    await scope1.database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [freeAgent, HUMAN]);
    await scope1.database.query("INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,state) VALUES($1,$2,$3,'sealed','running')", [freeAgent, WORKSPACE, HUMAN]);
    await scope1.database.query("INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')", [WORKSPACE, freeAgent]);
    await scope1.daemonOperation('postConnectorVault', { connections: [{ reference: 'synthetic-login', service: 'x-y-z', label: 'production-login',
      allowedHosts: [], loginHosts: ['login.example.co.uk'], faviconDomain: 'example.co.uk', keyName: 'EXAMPLE_LOGIN', credentialKind: 'login', expiresAt: 1,
      fieldNames: ['session'], createdAt: 1, state: 'active', stale: false }] });
    const view = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as import('@beeline/api-contract/workbench').WorkbenchView;
    expect(view.helpers.map(h => h.id)).toEqual(expect.arrayContaining([HELPER, freeAgent]));
    expect(view.helpers[0]?.squireEligible).toBe(true);
    expect(view.connections[0]).toMatchObject({ loginHosts: ['login.example.co.uk'], keyName: 'EXAMPLE_LOGIN', credentialKind: 'login', expiresAt: 1 });
    expect(view.companies?.rows.find(r => r.id === 'example.co.uk')).toMatchObject({ section: 'attention', items: [{ kind: 'login', title: 'Production login', status: 'Expired' }] });
    expect(view.companies?.rows.find(r => r.kind === 'sign-in-service')).toMatchObject({ items: [], machines: expect.arrayContaining([expect.objectContaining({ id: HELPER }), expect.objectContaining({ id: freeAgent })]) });
    const other = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }, scope1.recipientToken) as typeof view;
    expect(other.companies?.rows.some(r => r.id === 'example.co.uk')).toBe(false);
    const response = await phoneFetch(`${scope1.origin}/v1/company-logos/sentry`);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png'); expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });


  it('Reproduction squire-machine-status-2: reads broker reports with no Squire connection row', async () => {
    expect((await scope1.database.query("SELECT 1 FROM workspace_connectors WHERE connector_type='trusty-squire'")).rows).toEqual([]);
    for (const input of [{ connections: [] }, { connections: [], errorMessage: 'Squire broker unavailable' },
      { connections: [], notAdded: true }]) {
      expect((await scope1.daemonOperation('postConnectorVault', input)).status).toBe(200);
      const view = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
      expect(view.connectors).toEqual([]);
      expect(view.helpers[0].squire.status).toBe('notAdded' in input ? 'not-added'
        : 'errorMessage' in input ? 'error' : 'connected');
      expect(view.helpers[0].squire.errorMessage).toBe('errorMessage' in input ? input.errorMessage : undefined);
      console.log('Reproduction squire-machine-status-2: phone readWorkbench →', view.helpers[0].squire.status);
    }
  });


  it('Reproduction R1: stale sibling work loses to health, fresh reconnect failure wins', async () => {
    await scope1.database.query("UPDATE agents SET owner_id=$1,machine_id='squire'", [HUMAN]);
    await scope1.database.query("UPDATE agents SET squire_report=$2::jsonb WHERE agent_id=$1",
      [HELPER, JSON.stringify({ status: 'connected', reportedAt: 200 })]);
    for (const [reportedAt, status] of [[100, 'connected'], [300, 'error']] as const) {
      await scope1.database.query('UPDATE agents SET squire_work=$2::jsonb WHERE agent_id=$1',
        [OTHER_HELPER, JSON.stringify({ install: true, reportedAt, forceReloginProvider: 'google', errorMessage: 'Expired sign-in' })]);
      const view = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
      expect(view.helpers).toHaveLength(1);
      expect(view.helpers[0].squire.status).toBe(status);
      expect(view.helpers[0].squire.googleSessionExpired).toBe(status === 'error');
    }
    await scope1.database.query("UPDATE agents SET squire_work=squire_work-'reportedAt',updated_at=to_timestamp(100) WHERE agent_id=$1", [OTHER_HELPER]);
    const legacy = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    expect(legacy.helpers[0].squire.status).toBe('connected');
    await scope1.database.query('UPDATE agents SET updated_at=to_timestamp(300) WHERE agent_id=$1', [OTHER_HELPER]);
    const unrelatedUpdate = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    expect(unrelatedUpdate.helpers[0].squire.status).toBe('connected');
    await scope1.database.query("UPDATE agents SET squire_report='{\"status\":\"error\",\"reportedAt\":400,\"errorMessage\":\"Broker unavailable\"}'::jsonb");
    const broken = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    expect(broken.helpers[0].squire.status).toBe('error');
    await scope1.database.query('UPDATE agents SET squire_report=$2::jsonb WHERE agent_id=$1',
      [HELPER, JSON.stringify({ status: 'connected', reportedAt: 500 })]);
    await scope1.database.query('UPDATE identities SET hidden_from_roster=true WHERE id=$1', [OTHER_HELPER]);
    const view = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    expect(view.helpers[0].squire.status).toBe('connected');
  });


  it('Reproduction R1: remote MCP members are not computers', async () => {
    await scope1.database.query("UPDATE agents SET owner_id=$1 WHERE agent_id=$2", [HUMAN, OTHER_HELPER]);
    await scope1.database.query("INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('cursor','Cursor','[]')");
    await scope1.database.query("INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label) VALUES('cursor',$1,$2,'Cursor2')", [HUMAN, OTHER_HELPER]);
    const view = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    expect(view.helpers.map((h: any) => h.id)).toEqual([HELPER]);
  });


  it('Reproduction squire-false-card: reconnect work overrides a connected broker report in the phone view', async () => {
    await scope1.daemonOperation('postConnectorVault', { connections: [] });
    await scope1.database.query(`UPDATE agents SET squire_work='{"install":true,"generation":1,"signedInAs":"owner@example.com"}'::jsonb WHERE agent_id=$1`, [HELPER]);
    const view = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    const machine = view.companies.rows.find((row: any) => row.kind === 'sign-in-service').machines[0];
    expect(machine).toMatchObject({ reconnecting: true, signedInAs: 'owner@example.com', statusText: 'Waiting for sign-in' });
  });


  it('Reproduction squire-spinner: failed Google reconnect overrides a healthy broker report', async () => {
    await scope1.daemonOperation('postConnectorVault', { connections: [] });
    const roomId = await ensureSystemDirectMessageRoom(scope1.database, WORKSPACE, HUMAN);
    await scope1.database.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [roomId, HELPER]);
    await scope1.database.query(`UPDATE agents SET squire_work=$2::jsonb WHERE agent_id=$1`, [HELPER,
      JSON.stringify({ install: true, generation: 1, forceReloginProvider: 'google', errorMessage: 'Google reconnect failed' })]);
    const view = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    const service = view.companies.rows.find((row: any) => row.kind === 'sign-in-service');
    expect(service.section).toBe('attention');
    expect(service.machines[0]).toMatchObject({ online: true, status: 'error', reconnecting: false,
      statusText: 'Google sign-in expired', error: 'Google reconnect failed' });
  });


  it('keeps one generation of Squire sign-in work across sibling agents on a machine', async () => {
    const sibling = 'd'.repeat(64);
    await scope1.database.query("UPDATE agents SET machine_id='shared-machine' WHERE agent_id=$1", [HELPER]);
    await scope1.database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Sibling')", [sibling]);
    await scope1.database.query("INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'shared-machine')",
      [sibling, HUMAN]);
    await scope1.database.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')",
      [WORKSPACE, sibling]);
    const siblingToken = (await scope1.auth.exchangeDaemonToken(
      (await scope1.auth.createDaemonExchange(sibling)).exchangeToken))!.daemonToken;
    const first = await scope1.phoneOperation('pairConnector', { connectorType: 'trusty-squire', helperAgentId: HELPER }) as any;
    await scope1.phoneOperation('pairConnector', { connectorType: 'trusty-squire', helperAgentId: sibling });
    expect((await scope1.daemonOperation('getConnectorAssignments', {})).body.assignments).toEqual([]);
    expect((await scope1.daemonOperation('getConnectorAssignments', {}, siblingToken)).body.assignments)
      .toContainEqual({ kind: 'install', connectorType: 'trusty-squire', connectorId: first.connectorId, pairingGeneration: 2 });
    expect((await scope1.daemonOperation('postConnectorStatus', { connectorId: first.connectorId,
      pairingGeneration: 1, steps: [], errorMessage: 'Old attempt failed' })).status).not.toBe(200);
    expect((await scope1.daemonOperation('postConnectorStatus', { connectorId: first.connectorId,
      pairingGeneration: 2, steps: [], signIn: { method: 'streamed-page', url: 'https://sign-in.test' } },
      siblingToken)).status).toBe(200);
    const install = await scope1.phoneOperation('readConnectorInstall', { connectorId: first.connectorId }) as any;
    expect(install.status.signIn.url).toBe('https://sign-in.test');
  });


  it('migrates duplicate Squire rows without losing vault grants or receipts', async () => {
    await scope1.database.query('ALTER TABLE workspace_connectors DROP CONSTRAINT workspace_connectors_no_squire');
    await scope1.database.query('DROP INDEX workspace_connections_machine_reference_unique');
    const connectors = [randomUUID(), randomUUID(), randomUUID()];
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    for (let index = 0; index < connectors.length; index++) {
      // NULL machine ids reproduce legacy duplicate rows; the helper supplies the machine identity.
      await scope1.database.query(`INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,
        connector_type,helper_agent_id,status) VALUES($1,$2,$3,'trusty-squire',$4,'connected')`,
        [connectors[index], WORKSPACE, HUMAN, HELPER]);
      await scope1.database.query(`INSERT INTO workspace_connections(id,connector_id,owner_identity_id,
        reference,service,grants) VALUES($1,$2,$3,'shared-key','github',$4::jsonb)`,
        [keys[index], connectors[index], HUMAN, JSON.stringify([{ grantId: `grant-${index}` }])]);
      await scope1.database.query(`INSERT INTO connection_receipts(id,connection_id,workspace_id,
        owner_identity_id,agent_id,operation) VALUES($1,$2,$3,$4,$5,'read')`,
        [randomUUID(), keys[index], WORKSPACE, HUMAN, HELPER]);
    }
    await migrate(scope1.database);
    expect((await scope1.database.query("SELECT 1 FROM workspace_connectors WHERE connector_type='trusty-squire'")).rows).toEqual([]);
    const keysAfter = (await scope1.database.query<{ id: string; connector_id: string | null;
      machine_id: string; grants: unknown[] }>('SELECT id,connector_id,machine_id,grants FROM workspace_connections')).rows;
    expect(keysAfter).toHaveLength(1);
    expect(keysAfter[0]).toMatchObject({ connector_id: null, machine_id: HELPER });
    expect(keysAfter[0]!.grants).toHaveLength(3);
    expect((await scope1.database.query('SELECT connection_id FROM connection_receipts')).rows)
      .toEqual(Array.from({ length: 3 }, () => ({ connection_id: keysAfter[0]!.id })));
    await migrate(scope1.database);
    expect((await scope1.database.query('SELECT id FROM workspace_connections')).rows).toHaveLength(1);
    expect((await scope1.database.query('SELECT squire_report FROM agents WHERE agent_id=$1', [HELPER])).rows[0])
      .toEqual({ squire_report: null });
  });


  it('refreshes edited and deleted keys from Squire before the phone re-reads the list', async () => {
    const connectorId = await scope1.pairOwnerConnector();

    const refreshing = (await scope1.phoneOperation('readWorkbench', {
      workspaceId: WORKSPACE,
      refreshVault: true,
    })) as { connections: { reference: string; stale?: boolean }[] };
    expect(
      refreshing.connections.find((row) => row.reference === 'github.com/acme/tooling')?.stale,
    ).toBe(true);
    const editAssignment = await scope1.daemonOperation('getConnectorAssignments', {});
    expect(editAssignment.body.assignments).toContainEqual({
      kind: 'sync',
      connectorId,
      connectorType: 'trusty-squire',
    });

    await scope1.daemonOperation('postConnectorVault', {
      connections: [
        {
          reference: 'github.com/acme/tooling',
          service: 'github-renamed',
          label: 'Renamed tooling',
          fieldNames: ['token'],
          allowedHosts: ['api.github.example'],
          createdAt: Math.floor(Date.now() / 1000),
          stale: false,
          state: 'active',
        },
      ],
    });
    const edited = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connections: { reference: string; service: string; label: string; allowedHosts: string[] }[];
    };
    expect(
      edited.connections.find((row) => row.reference === 'github.com/acme/tooling'),
    ).toMatchObject({
      service: 'github-renamed',
      label: 'Renamed tooling',
      allowedHosts: ['api.github.example'],
    });

    await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE, refreshVault: true });
    const deleteAssignment = await scope1.daemonOperation('getConnectorAssignments', {});
    expect(deleteAssignment.body.assignments).toContainEqual({
      kind: 'sync',
      connectorId,
      connectorType: 'trusty-squire',
    });
    await scope1.daemonOperation('postConnectorVault', { connections: [] });
    const deleted = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connections: { reference: string }[];
    };
    expect(deleted.connections.map((row) => row.reference)).not.toContain(
      'github.com/acme/tooling',
    );
  });


  it('clears a stale Trusty Squire error after the helper reaches its vault', async () => {
    const sibling = 'd'.repeat(64);
    await scope1.database.query(`UPDATE agents SET machine_id='owner-machine' WHERE agent_id=$1`,
      [HELPER]);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Sibling')`,
      [sibling]);
    await scope1.database.query(`INSERT INTO agents(agent_id,owner_id,machine_id)
      VALUES($1,$2,'owner-machine')`, [sibling, HUMAN]);
    const siblingToken = (await scope1.auth.exchangeDaemonToken(
      (await scope1.auth.createDaemonExchange(sibling)).exchangeToken,
    ))!.daemonToken;
    const connectorId = await scope1.pairOwnerConnector();
    await scope1.daemonOperation('postConnectorVault', { connections: [], errorMessage: 'Earlier install failed' });
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member')`, [WORKSPACE, sibling]);
    await scope1.daemonOperation('postConnectorVault', { connections: [] }, siblingToken);
    const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { status: string; errorMessage?: string } }[];
    };
    expect((view as any).helpers[0].squire)
      .toMatchObject({ status: 'connected' });
    expect((view as any).helpers[0].squire)
      .not.toHaveProperty('errorMessage');
    console.log('Workbench: Trusty Squire connected after a successful vault read');
  });


  it('shares live Squire failures and recovery between the agent and phone without dropping keys', async () => {
    const roomId = randomUUID();
    await scope1.database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Status')`,
      [roomId, WORKSPACE, HUMAN]);
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [WORKSPACE, roomId, HUMAN, HELPER]);
    const connectorId = await scope1.pairOwnerConnector();
    // A foreign owner on this machine must not inherit this account's verdict.
    await scope1.database.query(`UPDATE agents SET machine_id='shared-machine' WHERE agent_id=ANY($1::text[])`,
      [[HELPER, OTHER_HELPER]]);
    await scope1.database.query(`UPDATE workspace_connections SET machine_id='shared-machine' WHERE owner_identity_id=$1`, [HUMAN]);
    await scope1.daemonOperation('postConnectorVault', { connections: [] }, scope1.otherHelperToken);

    const failed = await scope1.daemonOperation('postConnectorVault', {
      connections: [], errorMessage: 'Squire broker unavailable',
    });
    expect(failed.status).toBe(200);
    const phoneFailed = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { status: string; errorMessage?: string } }[];
      connections: { reference: string }[];
    };
    expect((phoneFailed as any).helpers[0].squire)
      .toMatchObject({ status: 'error', errorMessage: 'Squire broker unavailable' });
    expect(phoneFailed.connections.map((row) => row.reference)).toContain('github.com/acme/tooling');
    const agentFailed = await scope1.daemonOperation('readAgentWorkbench', { roomId });
    expect(agentFailed.status).toBe(200);
    expect(agentFailed.body.catalog).toContainEqual(expect.objectContaining({
      connectorType: 'trusty-squire',
      available: true,
    }));
    expect(agentFailed.body.machine.squire).toMatchObject({
      status: 'error', errorMessage: 'Squire broker unavailable',
    });
    expect((await scope1.database.query(`SELECT squire_report FROM agents WHERE agent_id=$1`, [OTHER_HELPER])).rows[0])
      .toMatchObject({ squire_report: { status: 'connected' } });

    await scope1.daemonOperation('postConnectorVault', { connections: [{
      reference: 'github.com/acme/tooling', service: 'github', label: 'Acme tooling',
      fieldNames: ['token'], allowedHosts: ['github.com'], createdAt: 0, stale: false, state: 'active',
    }] });
    const agentRecovered = await scope1.daemonOperation('readAgentWorkbench', { roomId });
    expect(agentRecovered.body.machine.squire).toMatchObject({ status: 'connected' });
    expect(agentRecovered.body.catalog).toContainEqual(expect.objectContaining({
      connectorType: 'trusty-squire', available: true,
    }));
    const phoneRecovered = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as typeof phoneFailed;
    expect((phoneRecovered as any).helpers[0].squire)
      .toMatchObject({ status: 'connected' });
    console.log('Reproduction squire-status-1: phone and agent Workbench agree on failure and recovery; keys preserved');
  });


  it('lists keys in vault created-at order, not by service', async () => {
    const connectorId = await scope1.pairOwnerConnector();
    // The helper reports what `vaultConnectionMeta` produced from Squire's
    // ISO-8601 `created_at`: epoch seconds, newest first in the vault.
    const vaultTime = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    await applyVaultList(scope1.database, { machine_id: HELPER, workspace_id: WORKSPACE, owner_identity_id: HUMAN }, [
      {
        reference: 'alpha',
        service: 'alpha',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: vaultTime('2026-09-14T09:00:00.000Z'),
        stale: false,
        state: 'active',
      },
      {
        reference: 'zeta',
        service: 'zeta',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: vaultTime('2026-09-17T09:00:00.000Z'),
        stale: false,
        state: 'active',
      },
      {
        reference: 'mu',
        service: 'mu',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: vaultTime('2026-09-15T09:00:00.000Z'),
        stale: false,
        state: 'active',
      },
      {
        reference: 'beta',
        service: 'beta',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: vaultTime('2026-09-16T09:00:00.000Z'),
        stale: false,
        state: 'active',
      },
      // The helper could not read this entry's vault created_at (0), so the
      // row falls back to its own created_at instead of sinking to the bottom.
      {
        reference: 'gamma',
        service: 'gamma',
        label: 'default',
        fieldNames: ['token'],
        allowedHosts: [],
        createdAt: 0,
        stale: false,
        state: 'active',
      },
    ]);
    const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connections: { reference: string; service: string; label: string }[];
    };
    const ours = view.connections.filter((row) =>
      ['alpha', 'zeta', 'mu', 'beta', 'gamma'].includes(row.reference),
    );
    expect(ours.map((row) => row.reference)).toEqual(['gamma', 'zeta', 'beta', 'mu', 'alpha']);
    expect(ours.every((row) => row.label === 'default')).toBe(true);
  });


  it('reads the workbench when the client sends no workspace id (the settings screen path)', async () => {
    // The Workbench screen navigates with NO route params, so the client sends
    // workspaceId:''. It must NOT be cast to a uuid — the helpers query used to
    // do exactly that and threw `invalid input syntax for type uuid: ""`, which
    // surfaced as "Workbench is unavailable right now" for every member.
    const connectorId = await scope1.pairOwnerConnector();
    const response = await scope1.operation('readWorkbench', { workspaceId: '' });
    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      connectors: { connectorId: string }[];
      catalog: unknown[];
    };
    expect(view.connectors).toEqual([]);
    expect((view as any).helpers[0].squire.status).toBe('connected');
    expect(view.catalog.length).toBeGreaterThan(0);
  });


  it('pairs a connector when the client sends no workspace id (the connect-screen path)', async () => {
    // The connect screen sends workspaceId:''. pairConnector must derive the
    // Workspace from a viewer/helper co-membership instead of casting '' to a
    // uuid (which threw a 400 "invalid input syntax for type uuid").
    const response = await scope1.operation('pairConnector', {
      workspaceId: '',
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    });
    expect(response.status).toBe(200);
    const paired = (await response.json()) as { connectorId: string; status: { status: string } };
    expect(paired.status.status).toBe('installing');
    // And it is readable back through the human-scoped, param-less read.
    const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: '' })) as {
      connectors: { connectorId: string }[];
    };
    expect(view.connectors).toEqual([]);
    expect(paired.connectorId).toBe(`squire:${HELPER}`);
  });


  it('rejects pairing a connector that is not connectable and a helper outside the Workspace', async () => {
    expect(
      (
        await scope1.operation('pairConnector', {
          workspaceId: WORKSPACE,
          connectorType: 'wallet',
          helperAgentId: HELPER,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await scope1.operation('pairConnector', {
          workspaceId: WORKSPACE,
          connectorType: 'trusty-squire',
          helperAgentId: 'd'.repeat(64),
        })
      ).status,
    ).toBe(503);
  });


  it('records ordinary usage on the key but no longer DMs it to the owner', async () => {
    const connectorId = await scope1.pairOwnerConnector();
    const requestId = createHash('sha256').update('turn-quiet').digest('hex');
    await scope1.daemonOperation('postConnectionUsage', {
      requestId,
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'get_pull_request',
          statusCode: 200,
          bytes: 1200,
        },
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'list_files',
          statusCode: 200,
          bytes: 800,
        },
      ],
    });
    // The key's own record keeps every call.
    const rows = await scope1.database.query<{ operation: string; event_class: string | null }>(
      `SELECT r.operation,r.event_class FROM connection_receipts r
       JOIN workspace_connections c ON c.id=r.connection_id
       WHERE COALESCE(c.connector_id::text,'squire:' || c.machine_id)=$1 AND r.turn_key=$2`,
      [connectorId, requestId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.event_class === null)).toBe(true);
    // And the owner receives no receipt DM at all.
    const cards = await scope1.connectionReceiptCards();
    expect(cards).toHaveLength(0);
  });


  it('uses the same System DM for connector receipts', async () => {
    const roomId = await ensureSystemDirectMessageRoom(scope1.database, WORKSPACE, HUMAN);
    expect(
      (await scope1.phone.readChats(WORKSPACE, HUMAN))?.chats.some((chat) => chat.room.id === roomId),
    ).toBe(true);

    const identity = (
      await scope1.database.query<{ name: string; handle: string; avatar: string }>(
        `SELECT name,handle,avatar FROM identities WHERE id=$1`,
        [SYSTEM_IDENTITY_ID],
      )
    ).rows[0];
    expect(identity).toEqual({
      name: 'System',
      handle: 'system',
      avatar: '/v1/connectors/logo/system.svg',
    });

    await scope1.pairOwnerConnector();
    await scope1.daemonOperation('postConnectionUsage', {
      requestId: createHash('sha256').update('first-visible-receipt').digest('hex'),
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          operation: 'fetch_credential github.com/acme/tooling',
          eventClass: 'approval',
        },
      ],
    });
    const chat = (await scope1.phone.readChats(WORKSPACE, HUMAN))?.chats.find(
      (candidate) => candidate.room.id === roomId,
    );
    expect(chat?.latestMessage?.text).toContain('@bee used Acme tooling');
    expect(chat?.directMessage?.peer).toMatchObject({
      name: 'System',
      handle: 'system',
      avatar: 'http://placeholder/v1/connectors/logo/system.svg',
    });

    const logo = await phoneFetch(`${scope1.origin}/v1/connectors/logo/trusty-squire.svg`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/svg+xml');
    expect(await logo.text()).toContain('aria-label="Trusty Squire"');
    const systemLogo = await phoneFetch(`${scope1.origin}/v1/connectors/logo/system.svg`);
    expect(systemLogo.status).toBe(200);
    expect(await systemLogo.text()).toContain('aria-label="System"');
    const googleLogo = await phoneFetch(`${scope1.origin}/v1/connectors/logo/google.svg`);
    expect(googleLogo.status).toBe(200);
    expect(await googleLogo.text()).toContain('aria-label="Google Workspace"');
  });


  it('DMs exactly one receipt card for an approval-class event', async () => {
    const connectorId = await scope1.pairOwnerConnector();
    const requestId = createHash('sha256').update('turn-approval').digest('hex');
    await scope1.daemonOperation('postConnectionUsage', {
      requestId,
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'fetch_credential github.com/acme/tooling',
          statusCode: 200,
          bytes: 120,
          eventClass: 'approval',
        },
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'list_files',
          statusCode: 200,
          bytes: 800,
        },
      ],
    });
    const cards = await scope1.connectionReceiptCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.author_id).toBe(SYSTEM_IDENTITY_ID);
    expect(cards[0]!.text).toContain('@bee used Acme tooling');
    // The card is about the approval-class event, not the ordinary use.
    expect(cards[0]!.text).toContain('fetch_credential');
  });


  it("aggregates a second approval-class report into the turn's existing card", async () => {
    const connectorId = await scope1.pairOwnerConnector();
    const requestId = createHash('sha256').update('turn-batched').digest('hex');
    const approval = {
      ref: 'github.com/acme/tooling',
      service: 'github',
      operation: 'grant_app_access github.com/acme/tooling',
      statusCode: 200,
      bytes: 100,
      eventClass: 'approval' as const,
    };
    await scope1.daemonOperation('postConnectionUsage', {
      requestId,
      agentId: HELPER,
      usage: [approval],
    });
    await scope1.daemonOperation('postConnectionUsage', {
      requestId,
      agentId: HELPER,
      usage: [
        { ...approval, bytes: 200 },
        // Ordinary use in the same turn neither opens nor restates a card.
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'list_files',
          statusCode: 200,
          bytes: 800,
        },
      ],
    });
    const cards = await scope1.connectionReceiptCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toContain('2 calls');
  });
});
