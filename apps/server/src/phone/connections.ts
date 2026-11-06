import { unpairSquireMachine } from '../squire-machine.js';
import { selectRegistryApp } from '../app-connections.js';
import { phoneIdentity as identity } from '../phone-identity.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { waitForConnection } from '../connection-wait.js';
import { registryServerAppKey, registryServerDomain } from '@beeline/api-contract/workbench';
import { isAppRegistryPublisher } from '../mcp-registry-policy.js';
import { SQUIRE_MCP_TARGET } from '@beeline/api-contract/phone';
import { queueSquireWork, squireMachineAddress, squireMachineId, squireWorkStatus } from '../squire-machine.js';
import { createAgentCommand, type CommandRow } from '../agent-command.js';
import { randomUUID } from 'node:crypto';
import { composioToolkitForApp } from '../composio-apps.js';
import { appIdentity } from '@beeline/api-contract/workbench';
import { completeComposioSignIn } from '../app-connections.js';
import { type SqlDatabase } from '../database.js';
import { notifyAgentConfigChange, notifyConnectorAssignment, notifyConnectorHelper } from '../postgres-live.js';
import { ensureSystemDirectMessageRoom, settleSystemCard } from '../system-line.js';
import { connectorDisplayName, defaultConnectorSteps, grantSquireToOwnerMachineAgents, isConnectableConnector } from '../workbench.js';
import type { ConnectorStatus, ConnectorStep } from '@beeline/api-contract/workbench';
import { armRegistryConnector, backfillRegistryApps, connectApp, disconnectApp, hasExistingAppRoute } from '../app-connections.js';
import { APP_INPUT_MAX_LENGTH, CONNECTOR_ADAPTER_DENIED, connectorAdapter, connectorRequesterRole } from '@beeline/api-contract/workbench';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';
import { phoneViewerWorkbenchWorkspace, phoneAssertWorkbenchViewer } from './workbench-catalog.js';
import { phoneResolveViewerHelper } from './workbench-reads.js';
import { phoneResolveDirectMessage } from './members-invites.js';
import { phoneSendMessage } from './messages.js';



  /**
   * Workbench → Connect an app: the one front door, from a person. The server
   * resolves and records the route exactly as `connect_app` does, then hands
   * any sign-in or sign-up to the chosen machine's agent as the viewer's own
   * request in their DM with it — that agent completes it through Trusty
   * Squire at the owner's approval boundary, so no ceremony link is ever
   * handed out here.
   */
  export async function phoneConnectWorkbenchApp(ctx: PhoneContext, input: Input<'connectWorkbenchApp'>, viewerId: string): Promise<Output<'connectWorkbenchApp'>> {
    const app = typeof input.app === 'string' ? input.app.trim() : '';
    if (!app || app.length > APP_INPUT_MAX_LENGTH) throw new Error('app name is required');
    await ctx.viewerWorkbenchWorkspace(viewerId);
    const identity = appIdentity(app);
    if (!identity) throw new Error('Select an app from search results');
    // An existing route belongs to the person. Search can offer a direct
    // official sign-in to new connections, but it must not migrate an
    // existing Composio or Squire connection implicitly.
    const hasRoute = await hasExistingAppRoute(ctx.database, viewerId, identity.key);
    const existingRoute = (await ctx.database.query<{ transport: string }>(
      `SELECT transport FROM workspace_apps WHERE owner_identity_id=$1 AND app_key=$2 AND state='active'`,
      [viewerId, identity.key],
    )).rows[0];
    if ((input.registryServerName || input.registryVersion) &&
        (!hasRoute || !existingRoute || existingRoute.transport === 'squire-api')) {
      if (!input.registryServerName || !input.registryVersion ||
          registryServerAppKey(input.registryServerName) !== identity.key)
        throw new Error('Select the official sign-in from search results');
      if (!isAppRegistryPublisher(input.registryServerName, app)) throw new Error('Select the official sign-in from search results');
      const manifest = await ctx.mcpRegistry.selected(input.registryServerName, input.registryVersion);
      if (!manifest || !manifest.remotes.some((remote) => remote.type === 'streamable-http') ||
          manifest.secretInputNames.length > 0)
        throw new Error('The official sign-in is unavailable');
      const { matched, machineId, ws } = await ctx.resolveViewerHelper(
        input.helperAgentId, viewerId,
      );
      const dm = await ctx.resolveDirectMessage(
        { workspaceId: ws.workspace_id, participantId: matched.agent_id }, viewerId,
      );
      const row = await ctx.database.transaction(async (database) => {
        const connector = await armRegistryConnector(database, {
          workspaceId: ws.workspace_id,
          ownerId: viewerId,
          machineId,
          helperAgentId: matched.agent_id,
          manifest,
          installRoomId: dm.id,
          installCommandId: null,
        });
        if (connector.versionConflict) throw new Error('This sign-in needs an update before reconnecting');
        await selectRegistryApp(database,{workspaceId:ws.workspace_id,ownerId:viewerId,appKey:identity.key,
          connectorId:connector.id,machineId,name:manifest.title??identity.key,
          domain:registryServerDomain(manifest.name)??null});
        return connector;
      });
      if (row.versionConflict) throw new Error('This sign-in needs an update before reconnecting');
      if (row.status==='installing') await notifyConnectorHelper(ctx.database, row.id);
      const installed = (await ctx.database.query<{ id: string }>(
        `SELECT id FROM workspace_apps WHERE owner_identity_id=$1 AND app_key=$2
           AND transport='registry-mcp' AND connector_id=$3::uuid`,
        [viewerId, identity.key, row.id],
      )).rows[0];
      if (!installed) throw new Error('The official sign-in could not be attached');
      // Wait outside the transaction for the helper's existing OAuth ceremony.
      // The phone keeps one request open; it never polls connector state.
      const ready = row.sign_in?.url || row.status === 'connected' ? row : await waitForConnection(async () => {
        const current = (await ctx.database.query<{ status: string; sign_in: ConnectorStatus['signIn'] | null; status_error: string | null }>(
          `SELECT status,sign_in,status_error FROM workspace_connectors WHERE id=$1::uuid AND owner_identity_id=$2`,
          [row.id, viewerId],
        )).rows[0];
        return current && (current.sign_in?.url || current.status === 'connected' || current.status === 'error') ? current : undefined;
      }, { principal: 'connector', operation: 'status', commandId: row.id });
      if (ready?.status === 'error') throw new Error('The MCP connection could not start. Reconnect to retry.');
      return {
        appId: installed.id,
        status: ready?.status === 'connected' ? 'connected' : 'connecting',
        transport: 'registry-mcp',
        route: 'registry-mcp',
        ...(ready?.sign_in?.url ? { authorizationUrl: ready.sign_in.url } : {}),
      };
    }
    const existing = await ctx.database.query(
      `SELECT 1 FROM workspace_apps WHERE owner_identity_id=$1 AND app_key=$2`,
      [viewerId, identity.key],
    );
    if (existing.rows.length === 0 && !hasRoute && input.preferredRoute !== 'squire-api') {
      if (!ctx.composio) throw new Error('Select an app from search results');
      let catalogEntry;
      try {
        catalogEntry = await ctx.composio.toolkit(composioToolkitForApp(identity.key));
      } catch (error) {
        if ((error as { status?: number }).status === 404)
          throw new Error('Select an app from search results');
        throw error;
      }
      if (
        catalogEntry.slug !== composioToolkitForApp(identity.key) ||
        catalogEntry.enabled === false
      )
        throw new Error('Select an app from search results');
    }
    const { matched, machineId, ws } = await ctx.resolveViewerHelper(
      input.helperAgentId,
      viewerId,
    );
    const dm = await ctx.resolveDirectMessage(
      { workspaceId: ws.workspace_id, participantId: matched.agent_id },
      viewerId,
    );
    const outcome = await connectApp(ctx.database, ctx.mcpRegistry, {
      workspaceId: ws.workspace_id,
      ownerId: viewerId,
      machineId,
      helperAgentId: matched.agent_id,
      requestedBy: viewerId,
      app,
      reconnect: input.reconnect === true,
      ...(input.preferredRoute ? { preferredRoute: input.preferredRoute } : {}),
      installRoomId: dm.id,
      installCommandId: null,
      ...(ctx.composio ? { composio: ctx.composio } : {}),
    });
    if (outcome.status === 'unavailable') throw new Error(outcome.next);
    if (!outcome.appId || !outcome.transport) throw new Error(outcome.next);
    if (
      outcome.transport !== 'composio' &&
      (outcome.status === 'connecting' || outcome.status === 'needs_sign_in')
    ) {
      const agent = (
        await ctx.database.query<{ handle: string | null }>(
          `SELECT handle FROM identities WHERE id=$1`,
          [matched.agent_id],
        )
      ).rows[0];
      const verb = input.reconnect ? 'Reconnect' : 'Connect';
      await ctx.sendMessage(
        {
          roomId: dm.id,
          text: `${agent?.handle ? `@${agent.handle} ` : ''}${verb} ${outcome.name ?? app} in my Connectors.`,
        },
        viewerId,
      );
    }
    return {
      appId: outcome.appId,
      status: outcome.derived ?? 'connecting',
      transport: outcome.transport,
      ...(outcome.route ? { route: outcome.route } : {}),
      ...(outcome.authorizationUrl ? { authorizationUrl: outcome.authorizationUrl } : {}),
    };
  }


  export async function phoneCompleteAppSignIn(ctx: PhoneContext, sessionUri: string, appId: string, viewerId: string) {
    if (!ctx.composio) throw new Error('App sign-in is unavailable');
    let rooms: string[] = [];
    const completed = await completeComposioSignIn(
      ctx.database,
      ctx.composio,
      viewerId,
      sessionUri,
      appId,
      async (database, appId) => {
        const cards = (
          await database.query<{
            id: string;
            room_id: string;
            card: { appId: string; name: string; agentId: string; commandId?: string };
          }>(
            `SELECT id,room_id,card FROM messages WHERE card_type='app-sign-in'
         AND card->>'appId'=$1 AND card->>'ownerId'=$2
         AND card->>'status' IN ('pending','failed')
         FOR UPDATE`,
            [appId, viewerId],
          )
        ).rows;
        for (const card of cards) {
          const source = await settleSystemCard(database, card.id, {
            authorId: viewerId,
            subject: { kind: 'person', id: viewerId, name: systemMessage("phone-service.a-member") },
            verb: systemMessage("phone-service.connected"),
            object: card.card.name,
            consequence: systemMessage("phone-service.the-request-can-continue"),
          });
          const parent = card.card.commandId
            ? (
                await database.query<CommandRow>(
                  `SELECT * FROM agent_commands WHERE id=$1 AND room_id=$2 AND agent_id=$3`,
                  [card.card.commandId, card.room_id, card.card.agentId],
                )
              ).rows[0]
            : undefined;
          await createAgentCommand(database, {
            roomId: card.room_id,
            agentId: card.card.agentId,
            sourceMessageId: source.id,
            reason: 'app_connected',
            ...(parent ? { parent, retainDepth: true } : {}),
          });
        }
        rooms = [...new Set(cards.map((card) => card.room_id))];
      },
    );
    for (const roomId of rooms)
      ctx.live?.publish({ type: 'invalidate', roomId, reason: 'app-connected' });
    return completed;
  }


  export async function phoneDisconnectWorkbenchApp(ctx: PhoneContext,
    input: Input<'disconnectWorkbenchApp'>,
    viewerId: string,
  ): Promise<void> {
    // `workspaceId` is accepted for wire compatibility; an app is the
    // viewer's own across Workspaces, so ownership is the whole check.
    const result = await disconnectApp(ctx.database, {
      ownerId: viewerId,
      appId: input.appId,
      ...(ctx.composio
        ? { revokeComposio: (accountId: string) => ctx.composio!.deleteAccount(accountId) }
        : {}),
    });
    if (result.helperAgentId) await notifyConnectorAssignment(ctx.database, result.helperAgentId);
  }


  export async function phonePairConnector(ctx: PhoneContext,
    input: Input<'pairConnector'>,
    viewerId: string,
  ): Promise<Output<'pairConnector'>> {
    if (!isConnectableConnector(input.connectorType))
      throw new Error(`${connectorDisplayName(input.connectorType)} is not connectable yet`);
    const { matched, machineId, ws } = await phoneResolveViewerHelper(ctx,
      input.helperAgentId,
      viewerId,
    );
    return ctx.database.transaction((database) =>
      phoneArmConnectorPairing(ctx, database, {
        workspaceId: ws.workspace_id,
        ownerIdentityId: viewerId,
        connectorType: input.connectorType,
        helperAgentId: matched.agent_id,
        machineId,
      }),
    );
  }


  /**
   * The one row write behind every pairing: the Workbench page's Connect
   * (`pairConnector`, where the person picks one of their own machines) and an
   * accepted connector offer (`acceptConnectorOffer`, where the machine is the
   * offering agent's). Adapted kinds refuse an acceptor who does not own that
   * helper, so a foreign Workbench row cannot inherit its vault. Authorization
   * is otherwise the caller's; this arms the row the helper daemon derives its
   * install from and opens the status DM.
   */
  export async function phoneArmConnectorPairing(ctx: PhoneContext, database: SqlDatabase, input: {
      workspaceId: string;
      ownerIdentityId: string;
      connectorType: Input<'pairConnector'>['connectorType'];
      helperAgentId: string;
      machineId: string;
      forceReloginProvider?: string;
    }): Promise<Output<'pairConnector'>> {
    const adapter = connectorAdapter(input.connectorType);
    if (adapter) {
      const helperOwner = (
        await database.query<{ owner_id: string }>(
          `SELECT owner_id FROM agents WHERE agent_id=$1`,
          [input.helperAgentId],
        )
      ).rows[0];
      const role = connectorRequesterRole(input.ownerIdentityId, helperOwner?.owner_id ?? '');
      if (!adapter.authorize('connect', role).allowed) throw new Error(CONNECTOR_ADAPTER_DENIED);
    }
    if (input.connectorType === 'trusty-squire') {
      await queueSquireWork(database, input.helperAgentId, { install: true, forceReloginProvider: input.forceReloginProvider });
      await grantSquireToOwnerMachineAgents(database, { workspaceId: input.workspaceId,
        ownerIdentityId: input.ownerIdentityId, machineId: input.machineId });
      const status = await squireWorkStatus(database, input.helperAgentId);
      return { connectorId: squireMachineAddress(input.machineId), status };
    }
    const viewerId = input.ownerIdentityId;
    const machineId = input.machineId;
    const ws = { workspace_id: input.workspaceId };
    const matched = { agent_id: input.helperAgentId };
    const id = randomUUID();
    await database.query(
      `INSERT INTO workspace_connectors(
         id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,
         status,status_steps,pairing_generation
       ) VALUES ($1,$2,$3,$4,$5,$6,'installing',$7::jsonb,1)
       ON CONFLICT (workspace_id,owner_identity_id,connector_type,machine_id)
         WHERE connector_type <> 'registry-mcp' DO UPDATE
       SET helper_agent_id=EXCLUDED.helper_agent_id,
           status='installing',
           status_steps=EXCLUDED.status_steps,
           status_error=NULL,
           pending_ops='[]'::jsonb,
           connected_at=NULL,
           sign_in=NULL,
           force_relogin_provider=NULL,
           pairing_generation=workspace_connectors.pairing_generation + 1,
           updated_at=now()`,
      [
        id,
        ws.workspace_id,
        viewerId,
        input.connectorType,
        matched.agent_id,
        machineId,
        JSON.stringify(defaultConnectorSteps()),
      ],
    );
    // A conflicting row (a previous pairing of the same connector on the same
    // machine — a stale disconnected row, or a connected one being re-paired)
    // is re-armed above exactly like a fresh insert: the mobile poll sees
    // `installing` with default steps again, and the helper daemon — which
    // derives its assignments from `status` AND `helper_agent_id` — is woken
    // by `connector-assignment` (the 5-minute poll is only recovery) even when
    // the conflict row carried a different agent of the same machine or a
    // leftover `uninstall` op.
    const existing = (
      await database.query<{
        id: string;
        status: ConnectorStatus['status'];
        status_steps: ConnectorStep[] | null;
        status_error: string | null;
      }>(
        `SELECT id,status,status_steps,status_error FROM workspace_connectors
           WHERE workspace_id=$1 AND owner_identity_id=$2
             AND connector_type=$3 AND machine_id=$4`,
        [ws.workspace_id, viewerId, input.connectorType, machineId],
      )
    ).rows[0] ?? {
      id,
      status: 'installing' as const,
      status_steps: defaultConnectorSteps() as ConnectorStep[],
      status_error: null,
    };
    // Push the install to this helper now; the poll is only recovery.
    await notifyConnectorAssignment(database, matched.agent_id);
    await ensureSystemDirectMessageRoom(database, ws.workspace_id, viewerId);
    return {
      connectorId: existing.id,
      status: {
        connectorId: existing.id,
        status: existing.status,
        steps: existing.status_steps ?? [],
        ...(existing.status_error ? { errorMessage: existing.status_error } : {}),
      } as ConnectorStatus,
    };
  }


  export async function phoneAssertOwnedConnector(ctx: PhoneContext, connectorId: string, viewerId: string) {
    // Human-scoped: a connector is owned by the viewer. Adapted kinds
    // (Squire, YouTube) take that verdict from the typed adapter so
    // cross-requester disconnect is the adapter's refusal, not a second rule.
    const row = await ctx.database.query<{
      id: string;
      connector_type: Input<'pairConnector'>['connectorType'];
      status: string;
      helper_agent_id: string;
      owner_identity_id: string;
    }>(
      `SELECT id,connector_type,status,helper_agent_id,owner_identity_id
       FROM workspace_connectors WHERE id=$1::uuid`,
      [connectorId],
    );
    if (!row.rowCount) throw new Error('connector not found (access denied)');
    const connector = row.rows[0]!;
    const adapter = connectorAdapter(connector.connector_type);
    if (adapter) {
      const role = connectorRequesterRole(viewerId, connector.owner_identity_id);
      if (!adapter.authorize('disconnect', role).allowed)
        throw new Error('connector not found (access denied)');
      return connector;
    }
    if (connector.owner_identity_id !== viewerId)
      throw new Error('connector not found (access denied)');
    return connector;
  }


  /** Unpair revokes everything the helper holds, then waits for its uninstall ack. */
  export async function phoneUnpairConnector(ctx: PhoneContext, input: Input<'unpairConnector'>, viewerId: string): Promise<void> {
    await ctx.assertWorkbenchViewer(input.workspaceId, viewerId);
    const squireMachine = squireMachineId(input.connectorId);
    if (squireMachine) {
      await ctx.resolveViewerHelper(squireMachine, viewerId).catch(() => {
        throw new Error('Squire machine not found (access denied)');
      });
      await unpairSquireMachine(ctx.database,viewerId,squireMachine);
      return;
    }
    const connector = await ctx.assertOwnedConnector(input.connectorId, viewerId);
    // Receipts and connections are the connector's work; unpair clears them.
    await ctx.database.query(`DELETE FROM workspace_connections WHERE connector_id=$1::uuid`, [
      input.connectorId,
    ]);
    await ctx.database.query(
      `UPDATE workspace_connectors
       SET status='disconnected', status_steps='[]'::jsonb, status_error=NULL,
           pending_ops='[]'::jsonb, connected_at=NULL, updated_at=now()
       WHERE id=$1::uuid`,
      [input.connectorId],
    );
    await notifyConnectorAssignment(ctx.database, connector.helper_agent_id);
  }
