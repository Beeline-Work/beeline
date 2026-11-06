import { SYSTEM_IDENTITY_ID, createHash, randomUUID, describe, expect, it, HUMAN, HELPER, OTHER_HELPER, WORKSPACE, fixtureScope1 } from './test-support-workbench.integration.test-support.js';

describe('workbench connectors', () => {
const scope1 = fixtureScope1();


  it('keeps connection detail, ledger, and management sovereign', async () => {
    const connectorId = await scope1.pairOwnerConnector();
    await scope1.daemonOperation('postConnectionUsage', {
      requestId: createHash('sha256').update('turn-2').digest('hex'),
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'get_pull_request',
          statusCode: 200,
          bytes: 1200,
        },
      ],
    });
    const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connections: { connectionId: string }[];
    };
    const connectionId = view.connections[0]!.connectionId;
    const detail = (await scope1.phoneOperation('readConnectionDetail', {
      workspaceId: WORKSPACE,
      connectionId,
    })) as {
      connection: { reference: string; fieldNames: string[]; createdAt: number };
      grants: { grantId: string }[];
      ledger: { operation: string }[];
    };
    expect(detail.connection.reference).toBe('github.com/acme/tooling');
    expect(detail.connection.fieldNames).toEqual(['token']);
    expect(detail.connection.createdAt).toBeGreaterThan(0);
    expect(detail.grants.map((grant) => grant.grantId)).toEqual(['hoots']);
    expect(detail.ledger).toHaveLength(1);

    // Member B can neither read nor manage member A's connection.
    expect(
      (
        await scope1.operation(
          'readConnectionDetail',
          { workspaceId: WORKSPACE, connectionId },
          scope1.recipientToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await scope1.operation(
          'revokeConnectionGrants',
          { workspaceId: WORKSPACE, connectionId },
          scope1.recipientToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (await scope1.operation('unpairConnector', { workspaceId: WORKSPACE, connectorId }, scope1.recipientToken))
        .status,
    ).toBe(403);

    // A helper that does not serve the connector cannot report against it:
    // the usage resolves to nothing, so no ledger row and no receipt card.
    await scope1.daemonOperation(
      'postConnectionUsage',
      {
        requestId: createHash('sha256').update('foreign-turn').digest('hex'),
        agentId: OTHER_HELPER,
        usage: [{ ref: 'github.com/acme/tooling', service: 'github', operation: 'x' }],
      },
      scope1.otherHelperToken,
    );
    const foreign = await scope1.database.query<{ count: string }>(
      `SELECT count(*)::text count FROM connection_receipts WHERE connection_id=$1::uuid`,
      [connectionId],
    );
    expect(foreign.rows[0]!.count).toBe('1');
  });


  it('revokes grants and unpairing clears connections, receipts, and eventually the row', async () => {
    const connectorId = await scope1.pairOwnerConnector('tailscale');
    const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connections: { connectionId: string }[];
    };
    const connectionId = view.connections[0]!.connectionId;
    const revoked = (await scope1.phoneOperation('revokeConnectionGrants', {
      workspaceId: WORKSPACE,
      connectionId,
    })) as { revoked: number; pending?: number };
    expect(revoked).toEqual({ revoked: 0, failed: 0, pending: 1 });
    const pendingGrants = await scope1.database.query<{ grants: Array<Record<string, unknown>> }>(
      `SELECT grants FROM workspace_connections WHERE id=$1::uuid`,
      [connectionId],
    );
    expect(pendingGrants.rows[0]!.grants[0]).toMatchObject({ grantId: 'hoots' });
    expect(pendingGrants.rows[0]!.grants[0]!.revokedAt).toBeUndefined();
    expect(pendingGrants.rows[0]!.grants[0]!.revokingAt).toEqual(expect.any(Number));
    // The helper is asked to drop its egress grants on the next poll, and the
    // queue stays until that helper confirms.
    const queue = await scope1.daemonOperation('getConnectorAssignments', {});
    const kinds = (queue.body as { assignments?: { kind: string }[] }).assignments?.map(
      (a) => a.kind,
    );
    expect(kinds).toContain('revoke-grants');
    const retry = await scope1.daemonOperation('getConnectorAssignments', {});
    expect(
      (retry.body as { assignments?: { kind: string }[] }).assignments?.map((a) => a.kind),
    ).toContain('revoke-grants');
    await scope1.daemonOperation('revokeConnectionGrants', { ref: 'github.com/acme/tooling' });
    const confirmed = await scope1.database.query<{ grants: Array<Record<string, unknown>> }>(
      `SELECT grants FROM workspace_connections WHERE id=$1::uuid`,
      [connectionId],
    );
    expect(confirmed.rows[0]!.grants[0]!.revokedAt).toEqual(expect.any(Number));
    expect(confirmed.rows[0]!.grants[0]!.revokingAt).toBeUndefined();

    await scope1.phoneOperation('unpairConnector', { workspaceId: WORKSPACE, connectorId });
    const cleared = await scope1.database.query<{ count: string }>(
      `SELECT count(*)::text count FROM workspace_connections WHERE COALESCE(connector_id::text,'squire:' || machine_id)=$1`,
      [connectorId],
    );
    expect(cleared.rows[0]!.count).toBe('0');
    const receipts = await scope1.database.query<{ count: string }>(
      `SELECT count(*)::text count FROM connection_receipts WHERE owner_identity_id=$1`,
      [HUMAN],
    );
    expect(receipts.rows[0]!.count).toBe('0');
    // The uninstall assignment reaches the helper; its status poll is the
    // ack path that reaps the row.
    const after = await scope1.daemonOperation('getConnectorAssignments', {});
    expect(
      (after.body as { assignments?: { kind: string }[] }).assignments?.map((a) => a.kind),
    ).toContain('uninstall');
    await scope1.daemonOperation('getConnectorStatus', {});
    const gone = await scope1.database.query<{ count: string }>(
      `SELECT count(*)::text count FROM workspace_connectors WHERE id=$1::uuid`,
      [connectorId],
    );
    expect(gone.rows[0]!.count).toBe('0');
  });


  it('re-pairs a stale disconnected row as a fresh install instead of leaving it dead', async () => {
    // A previous pairing attempt left a stale row (the helper never acked the
    // uninstall, so the reap never ran): disconnected, no steps, an error
    // line, a leftover sync op, and a connected_at timestamp. Re-pairing must
    // re-arm it exactly like a fresh insert — the connect screen's only path
    // back, since a disconnected row has no unpair UI.
    const staleId = randomUUID();
    await scope1.database.query(
      `INSERT INTO workspace_connectors(
         id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,
         status,status_steps,status_error,pending_ops,connected_at
       ) VALUES ($1,$2,$3,'tailscale',$4,$5,'disconnected','[]'::jsonb,
                 'last install failed','["sync"]'::jsonb,now())`,
      [staleId, WORKSPACE, HUMAN, HELPER, HELPER],
    );
    const repaired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as {
      connectorId: string;
      status: { status: string; steps: { label: string; status: string }[]; errorMessage?: string };
    };
    expect(repaired.connectorId).toBe(staleId);
    expect(repaired.status.status).toBe('installing');
    expect(repaired.status.steps).toEqual([
      { label: 'Install on helper', status: 'pending' },
      { label: 'Connect provider account', status: 'pending' },
    ]);
    expect(repaired.status.errorMessage).toBeUndefined();

    const row = await scope1.database.query<{
      status_error: string | null;
      connected_at: Date | null;
      pending_ops: string[];
      helper_agent_id: string;
    }>(
      `SELECT status_error,connected_at,pending_ops,helper_agent_id
       FROM workspace_connectors WHERE id=$1::uuid`,
      [staleId],
    );
    expect(row.rows[0]!.status_error).toBeNull();
    expect(row.rows[0]!.connected_at).toBeNull();
    expect(row.rows[0]!.pending_ops).toEqual([]);
    expect(row.rows[0]!.helper_agent_id).toBe(HELPER);

    // The helper daemon derives its assignments from the re-armed row: the
    // install assignment arrives on its next poll.
    const queue = await scope1.daemonOperation('getConnectorAssignments', {});
    expect(
      (queue.body as { assignments?: { kind: string; connectorId: string }[] }).assignments,
    ).toContainEqual({
      kind: 'install',
      connectorId: staleId,
      connectorType: 'tailscale',
      pairingGeneration: 2,
    });
  });


  it('re-pairing a connected connector starts a fresh install again', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await scope1.daemonOperation('installConnector', { connectorId: paired.connectorId });
    const connected = await scope1.database.query<{ status: string }>(
      `SELECT status FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(connected.rows[0]!.status).toBe('connected');

    const again = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string; status: { status: string; steps: unknown[] } };
    expect(again.connectorId).toBe(paired.connectorId);
    expect(again.status.status).toBe('installing');
    expect(again.status.steps.length).toBeGreaterThan(0);
  });


  it('drops the previous attempt\u2019s sign-in surface when connect needed no ceremony', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await scope1.daemonOperation('installConnector', {
      connectorId: paired.connectorId,
      signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
    });
    const withCeremony = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { signIn?: { url: string } } }[];
    };
    expect(
      withCeremony.connectors.find((row) => row.connectorId === paired.connectorId)?.status.signIn
        ?.url,
    ).toBe('https://tunnel.test/#p=hunter22');

    // That tunnel died with the connect process. The shared profile already
    // carries the session, so the next install prints no ceremony at all —
    // the phone must not keep offering the dead page.
    await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    });
    await scope1.daemonOperation('installConnector', { connectorId: paired.connectorId });
    const after = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { status: string; signIn?: { url: string } } }[];
    };
    const row = after.connectors.find((entry) => entry.connectorId === paired.connectorId);
    expect(row?.status.status).toBe('connected');
    expect(row?.status.signIn).toBeUndefined();
  });


  it('a steps-only progress report keeps the live ceremony; the run\u2019s verdict clears it', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    const signInUrl = async () => {
      const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
        connectors: { connectorId: string; status: { signIn?: { url: string } } }[];
      };
      return view.connectors.find((row) => row.connectorId === paired.connectorId)?.status.signIn
        ?.url;
    };
    await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'done' }],
      signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
    });
    expect(await signInUrl()).toBe('https://tunnel.test/#p=hunter22');

    // The same run posting later progress says nothing about its surface.
    await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'paired to workspace', status: 'pending' }],
    });
    expect(await signInUrl()).toBe('https://tunnel.test/#p=hunter22');

    // A LATER run that printed no ceremony says so, and the dead tunnel goes.
    await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      signIn: null,
    });
    expect(await signInUrl()).toBeUndefined();
  });


  it('an explicit re-pair drops the previous ceremony instead of re-offering it', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await scope1.daemonOperation('installConnector', {
      connectorId: paired.connectorId,
      signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
    });
    await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    });
    const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      connectors: { connectorId: string; status: { status: string; signIn?: { url: string } } }[];
    };
    const row = view.connectors.find((entry) => entry.connectorId === paired.connectorId);
    expect(row?.status.status).toBe('installing');
    expect(row?.status.signIn).toBeUndefined();
  });


  it('answers the connector status the helper named, not the oldest row', async () => {
    // A helper carries another tool row beside its Squire row, and
    // that one is created first. An unscoped read would hand the
    // helper another connector's state for its own assignment.
    const tailscale = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    const squire = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'trusty-squire',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await scope1.daemonOperation('postConnectorStatus', {
      connectorId: squire.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
    });

    const unscoped = await scope1.daemonOperation('getConnectorStatus', {});
    expect(unscoped.body.connectorId).toBe(tailscale.connectorId);

    const scoped = await scope1.daemonOperation('getConnectorStatus', {
      connectorId: squire.connectorId,
    });
    expect(scoped.body.connectorId).toBe(squire.connectorId);
    expect(scoped.body.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://tunnel.test/#p=hunter22',
    });
  });


  it('pairs Tailscale on the selected helper and queues its installer', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string; status: { status: string } };

    expect(paired.status.status).toBe('installing');
    const queue = await scope1.daemonOperation('getConnectorAssignments', {});
    expect(queue.body.assignments).toContainEqual({
      kind: 'install',
      connectorId: paired.connectorId,
      connectorType: 'tailscale',
      pairingGeneration: 1,
    });
    const view = (await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE })) as {
      catalog: { connectorType: string; available: boolean }[];
    };
    expect(view.catalog).toContainEqual(
      expect.objectContaining({ connectorType: 'tailscale', available: true }),
    );
  });


  it('posts the Tailscale login link to the helper owner DM instead of only failing', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    const url = 'https://login.tailscale.com/a/owner-link';
    const posted = await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      pairingGeneration: 1,
      steps: [{ label: 'Tailnet signed in', status: 'running' }],
      signIn: { method: 'oauth', url },
    });
    expect(posted.status).toBe(200);
    const dm = await scope1.database.query<{ text: string; author_id: string; system_event: Record<string, any> }>(
      `SELECT m.text,m.author_id,m.system_event FROM messages m
       JOIN rooms r ON r.id=m.room_id
       WHERE r.workspace_id=$1 AND m.presentation='system'
         AND m.system_event->'object'->>'url'=$2`,
      [WORKSPACE, url],
    );
    expect(dm.rows).toHaveLength(1);
    expect(dm.rows[0]!.author_id).toBe(SYSTEM_IDENTITY_ID);
    expect(dm.rows[0]!.text).toContain('needs');
    expect(dm.rows[0]!.text).not.toContain(url);
    expect(dm.rows[0]!.system_event.object.url).toBe(url);
    const participants = await scope1.database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships WHERE room_id=(
         SELECT room_id FROM messages WHERE id=(
           SELECT id FROM messages WHERE system_event->'object'->>'url'=$1 LIMIT 1
         )
       )`,
      [url],
    );
    expect(participants.rows.map((row) => row.identity_id).sort()).toEqual(
      [HUMAN, SYSTEM_IDENTITY_ID].sort(),
    );
  });


  it('keeps connector receipts in the read-only System DM', async () => {
    const connectorId = await scope1.pairOwnerConnector('tailscale');
    await scope1.daemonOperation('postConnectionUsage', {
      requestId: createHash('sha256').update('turn-3').digest('hex'),
      agentId: HELPER,
      usage: [
        {
          ref: 'github.com/acme/tooling',
          service: 'github',
          operation: 'fetch_credential github.com/acme/tooling',
          eventClass: 'approval',
        },
      ],
    });
    const room = await scope1.database.query<{ id: string }>(
      `SELECT r.id FROM rooms r
       JOIN messages m ON m.room_id=r.id
       WHERE r.workspace_id=$1 AND m.card_type='connection-receipt' LIMIT 1`,
      [WORKSPACE],
    );
    const response = await scope1.operation('sendRoomMessage', {
      roomId: room.rows[0]!.id,
      text: 'hello?',
    });
    expect(response.status).toBe(403);
  });


  it('unpairs an owner Squire machine and keeps late broker reports detached until re-pair', async () => {
    const connectorId = await scope1.pairOwnerConnector();
    expect((await scope1.database.query(`SELECT 1 FROM agent_grants WHERE agent_id=$1 AND kind='mcp' AND target='squire' AND status IN ('approved','once')`, [HELPER])).rowCount).toBeGreaterThan(0);
    expect((await scope1.operation('unpairConnector', { workspaceId: WORKSPACE, connectorId }, scope1.recipientToken)).status).toBe(403);
    await scope1.phoneOperation('unpairConnector', { workspaceId: WORKSPACE, connectorId });
    const view = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    expect(view.connections).toEqual([]);
    expect(view.helpers[0].squire.status).toBe('not-added');
    expect((await scope1.database.query(`SELECT 1 FROM workspace_connectors WHERE connector_type='trusty-squire'`)).rowCount).toBe(0);
    expect((await scope1.database.query(`SELECT 1 FROM agent_grants WHERE agent_id=$1
      AND kind='mcp' AND target='squire' AND status IN ('approved','once')`, [HELPER])).rowCount).toBe(0);
    await scope1.daemonOperation('postConnectorVault', { connections: [{ reference: 'late-key',
      service: 'github', label: 'Late key', fieldNames: [], allowedHosts: [], createdAt: 0, stale: false, state: 'active' }] });
    const detached = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    expect(detached.connections).toEqual([]); expect(detached.helpers[0].squire.status).toBe('not-added');
    await scope1.pairOwnerConnector();
    const paired = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }) as any;
    expect(paired.helpers[0].squire.status).toBe('connected'); expect(paired.connections.length).toBeGreaterThan(0);
  });


  it('does not copy an owner machine vault to another owner', async () => {
    await scope1.pairOwnerConnector();
    await scope1.daemonOperation('postConnectorVault', { connections: [{ reference: 'owner-key',
      service: 'github', label: 'Owner key', fieldNames: [], allowedHosts: [], createdAt: 0, stale: false, state: 'active' }] });
    const other = await scope1.phoneOperation('readWorkbench', { workspaceId: WORKSPACE }, scope1.recipientToken) as any;
    expect(other.connections).toEqual([]);
    expect(other.helpers[0].squire).toBeUndefined();
  });


  it('ignores a late install report after unpair', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await scope1.phoneOperation('unpairConnector', {
      workspaceId: WORKSPACE,
      connectorId: paired.connectorId,
    });
    const late = await scope1.daemonOperation('installConnector', {
      connectorId: paired.connectorId,
      pairingGeneration: 1,
    });
    expect(late.status).toBe(404);
    const row = await scope1.database.query<{ status: string }>(
      `SELECT status FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('disconnected');
  });


  it('a stale status report cannot overwrite a disconnect', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      pairingGeneration: 1,
    });
    await scope1.phoneOperation('unpairConnector', {
      workspaceId: WORKSPACE,
      connectorId: paired.connectorId,
    });
    const late = await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'late helper error',
      pairingGeneration: 1,
    });
    expect(late.status).toBe(404);
    const row = await scope1.database.query<{ status: string; status_error: string | null }>(
      `SELECT status,status_error FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('disconnected');
    expect(row.rows[0]!.status_error).toBeNull();
  });


  it('a stale status report cannot overwrite a re-pair', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    });
    const late = await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'stale generation error',
      pairingGeneration: 1,
    });
    expect(late.status).toBe(404);
    const row = await scope1.database.query<{
      status: string;
      status_error: string | null;
      pairing_generation: number;
    }>(
      `SELECT status,status_error,pairing_generation FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('installing');
    expect(row.rows[0]!.status_error).toBeNull();
    expect(row.rows[0]!.pairing_generation).toBe(2);
  });


  it('a generation-less status report cannot overwrite a re-pair', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    });
    const late = await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'stale generation-less error',
    });
    expect(late.status).toBe(404);
    const row = await scope1.database.query<{
      status: string;
      status_error: string | null;
      pairing_generation: number;
    }>(
      `SELECT status,status_error,pairing_generation FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('installing');
    expect(row.rows[0]!.status_error).toBeNull();
    expect(row.rows[0]!.pairing_generation).toBe(2);
  });


  it('a generation-less status report still updates an eligible generation-1 row', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    const report = await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
    });
    expect(report.status).toBe(200);
    const row = await scope1.database.query<{
      status: string;
      status_steps: { label: string; status: string }[];
      pairing_generation: number;
    }>(
      `SELECT status,status_steps,pairing_generation FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('installing');
    expect(row.rows[0]!.status_steps).toEqual([
      { label: 'waiting for sign-in', status: 'pending' },
    ]);
    expect(row.rows[0]!.pairing_generation).toBe(1);
  });


  it('an explicit current-generation status report succeeds; stale generations and disconnected rows remain rejected', async () => {
    const paired = (await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    })) as { connectorId: string };
    const first = await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      pairingGeneration: 1,
    });
    expect(first.status).toBe(200);

    await scope1.phoneOperation('pairConnector', {
      workspaceId: WORKSPACE,
      connectorType: 'tailscale',
      helperAgentId: HELPER,
    });
    const current = await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      pairingGeneration: 2,
    });
    expect(current.status).toBe(200);

    const stale = await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'stale generation error',
      pairingGeneration: 1,
    });
    expect(stale.status).toBe(404);

    await scope1.phoneOperation('unpairConnector', {
      workspaceId: WORKSPACE,
      connectorId: paired.connectorId,
    });
    const disconnected = await scope1.daemonOperation('postConnectorStatus', {
      connectorId: paired.connectorId,
      steps: [{ label: 'trusty-squire failed', status: 'failed' }],
      errorMessage: 'late helper error',
      pairingGeneration: 2,
    });
    expect(disconnected.status).toBe(404);

    const row = await scope1.database.query<{
      status: string;
      status_error: string | null;
      pairing_generation: number;
      status_steps: { label: string; status: string }[];
    }>(
      `SELECT status,status_error,pairing_generation,status_steps FROM workspace_connectors WHERE id=$1::uuid`,
      [paired.connectorId],
    );
    expect(row.rows[0]!.status).toBe('disconnected');
    expect(row.rows[0]!.status_error).toBeNull();
    expect(row.rows[0]!.pairing_generation).toBe(2);
    expect(row.rows[0]!.status_steps).toEqual([]);
  });
});
