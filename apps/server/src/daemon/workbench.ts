import { FIRST_PARTY_INTEGRATIONS } from '../first-party-integrations.js';
import { machineSquireReport } from '../squire-machine.js';
import { registrableDomain } from '@beeline/api-contract/app-connections';
import { connectorIntentIndex } from '../connector-intent-index.js';
import { readOwnerApps } from '../app-connections.js';
import { composioToolkitForApp } from '../composio-apps.js';
import { connectorCatalog } from '../workbench.js';
import { connectorPurpose, isOfferableConnectorKind } from '@beeline/api-contract/connector-offers';
import { delegationView } from '../wallet.js';
import type { DaemonContext } from './context.js';
import { id, Input, Output } from './values.js';



  /**
   * The logo and web domain an app sign-in card stores so the card shows the
   * app's mark instead of a letter. The provider's (usually cached) toolkit
   * metadata names the logo; the app row's domain wins over the metadata's.
   * Only https logos are kept. A slow or failing lookup never delays or
   * blocks the card.
   */
  export async function daemonAppCardMark(ctx: DaemonContext, appKey: string, domain?: string): Promise<{ logo?: string; domain?: string }> {
    const mark = (logo?: string, metadataDomain?: string) => ({
      ...(logo && /^https:\/\//i.test(logo) ? { logo } : {}),
      ...(domain ?? metadataDomain ? { domain: domain ?? metadataDomain } : {}),
    });
    if (!ctx.composio) return mark();
    try {
      const metadata = await ctx.composio.toolkit(composioToolkitForApp(appKey));
      return mark(metadata?.logo,
        metadata?.appUrl ? registrableDomain(new URL(metadata.appUrl).hostname) : undefined);
    } catch {
      return mark();
    }
  }


  // --- R5: connector offers -------------------------------------------------

  /**
   * The Room, this agent's machine, and the person this turn answers. The
   * ADDRESSEE is the human whose message woke the agent — whose keys an added
   * tool will hold — read from the command that woke it (the command IS the
   * trigger, so a scheduled or subscription wake resolves too). An agent-woken
   * turn addresses nobody human; the offering agent's owner stands in.
   */
  export async function daemonOfferContext(ctx: DaemonContext, roomId: string, agentId: string) {
    const context = (
      await ctx.database.query<{
        workspace_id: string;
        parent_id: string | null;
        owner_id: string;
        machine_id: string | null;
        machine_name: string | null;
        agent_name: string;
        agent_handle: string | null;
        agent_avatar: string | null;
        owner_name: string;
        owner_handle: string | null;
        owner_avatar: string | null;
      }>(
        `SELECT room.workspace_id,room.parent_id,a.owner_id,a.machine_id,a.machine_name,
                agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
                owner.name owner_name,owner.handle owner_handle,owner.avatar owner_avatar
         FROM rooms room
         JOIN agents a ON a.agent_id=$2
         JOIN identities agent ON agent.id=a.agent_id
         JOIN identities owner ON owner.id=a.owner_id
         WHERE room.id=$1`,
        [roomId, agentId],
      )
    ).rows[0];
    if (!context) throw new Error('agent not found');
    const woke = ctx.authorizedCommand?.source_message_id
      ? await ctx.database.query<{
          id: string;
          name: string;
          handle: string | null;
          avatar: string | null;
        }>(
          `SELECT identity.id,identity.name,identity.handle,identity.avatar
           FROM messages message JOIN identities identity ON identity.id=message.author_id
           WHERE message.id=$1 AND identity.kind='human' AND identity.hidden_from_roster=false`,
          [ctx.authorizedCommand.source_message_id],
        )
      : await ctx.database.query<{
          id: string;
          name: string;
          handle: string | null;
          avatar: string | null;
        }>(
          `SELECT identity.id,identity.name,identity.handle,identity.avatar
           FROM agent_commands command
           JOIN messages message ON message.id=command.source_message_id
           JOIN identities identity ON identity.id=message.author_id
           WHERE command.room_id=$1 AND command.agent_id=$2
             AND identity.kind='human' AND identity.hidden_from_roster=false
           ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
          [roomId, agentId],
        );
    const addresseeRow = woke.rows[0];
    const addressee = addresseeRow
      ? {
          pubkey: addresseeRow.id,
          kind: 'human' as const,
          name: addresseeRow.name,
          ...(addresseeRow.handle ? { handle: addresseeRow.handle } : {}),
          ...(addresseeRow.avatar ? { avatar: addresseeRow.avatar } : {}),
        }
      : {
          pubkey: context.owner_id,
          kind: 'human' as const,
          name: context.owner_name,
          ...(context.owner_handle ? { handle: context.owner_handle } : {}),
          ...(context.owner_avatar ? { avatar: context.owner_avatar } : {}),
        };
    const agent = {
      pubkey: agentId,
      kind: 'agent' as const,
      name: context.agent_name,
      ...(context.agent_handle ? { handle: context.agent_handle } : {}),
      ...(context.agent_avatar ? { avatar: context.agent_avatar } : {}),
    };
    // A legacy daemon that never reported a machine IS its own machine, the
    // same identity `pairConnector` resolves for it.
    const machine = {
      machineId: context.machine_id ?? agentId,
      name: context.machine_name ?? context.agent_name,
    };
    const owner = {
      pubkey: context.owner_id,
      kind: 'human' as const,
      name: context.owner_name,
      ...(context.owner_handle ? { handle: context.owner_handle } : {}),
      ...(context.owner_avatar ? { avatar: context.owner_avatar } : {}),
    };
    return {
      workspaceId: context.workspace_id,
      isCorner: context.parent_id !== null,
      addressee,
      owner,
      agent,
      machine,
    };
  }


  /**
   * workbench_status: what the Workbench can add, and what the owner of this
   * helper's machine already has. Names only — a connection is listed by
   * service and label, never by anything the vault holds.
   */
  export async function daemonAgentWorkbench(ctx: DaemonContext,
    input: Input<'readAgentWorkbench'>,
    agentId: string,
  ): Promise<Output<'readAgentWorkbench'>> {
    if (typeof input.roomId !== 'string' || !input.roomId) throw new Error('roomId is required');
    const context = await daemonOfferContext(ctx, input.roomId, agentId);
    const paired = (
      await ctx.database.query<{
        id: string;
        connector_type: string;
        status: 'installing' | 'connected' | 'error' | 'disconnected';
        status_error: string | null;
        machine_id: string | null;
        helper_agent_id: string;
        helper_name: string;
        updated_at: Date;
        registry_server_name: string | null;
        registry_version: string | null;
        display_name: string | null;
        website_url: string | null;
      }>(
        `SELECT k.id,k.connector_type,k.status,k.status_error,k.machine_id,k.helper_agent_id,
                k.registry_server_name,k.registry_version,k.display_name,k.website_url,
                COALESCE(NULLIF(a.machine_name,''),helper.name) helper_name,k.updated_at
         FROM workspace_connectors k
         JOIN identities helper ON helper.id=k.helper_agent_id
         LEFT JOIN agents a ON a.agent_id=k.helper_agent_id
         WHERE k.owner_identity_id=$1
         ORDER BY k.updated_at DESC`,
        [context.owner.pubkey],
      )
    ).rows;
    const walletConnected = (await delegationView(ctx.database, context.owner.pubkey)).active;
    const catalog = connectorCatalog().map((entry) => {
      if (entry.connectorType === 'trusty-squire') return {
        connectorType: entry.connectorType, name: entry.name, purpose: connectorPurpose(entry.connectorType),
        available: entry.available, offerable: !context.isCorner,
      };
      if (entry.connectorType === 'wallet' && walletConnected)
        return {
          connectorType: entry.connectorType,
          name: entry.name,
          purpose: connectorPurpose(entry.connectorType),
          available: entry.available,
          offerable: !context.isCorner && isOfferableConnectorKind(entry.connectorType),
          paired: {
            status: 'connected' as const,
            helperName: context.machine.name,
            onThisMachine: true,
          },
        };
      // The most recently touched row wins; a live one over a disconnected one.
      const rows = paired.filter((row) => row.connector_type === entry.connectorType);
      const here = rows.filter((candidate) =>
        (candidate.machine_id ?? candidate.helper_agent_id) === context.machine.machineId);
      const row = here.find((candidate) => candidate.status === 'connected')
        ?? here.find((candidate) => candidate.status !== 'disconnected')
        ?? rows.find((candidate) => candidate.status === 'connected')
        ?? rows.find((candidate) => candidate.status !== 'disconnected')
        ?? here[0] ?? rows[0];
      return {
        connectorType: entry.connectorType,
        name: entry.name,
        purpose: connectorPurpose(entry.connectorType),
        available: entry.available,
        offerable:
          entry.available &&
          !context.isCorner &&
          isOfferableConnectorKind(entry.connectorType),
        ...(row
          ? {
              paired: {
                status: row.status,
                helperName: row.helper_name,
                onThisMachine:
                  (row.machine_id ?? row.helper_agent_id) === context.machine.machineId,
                ...(row.status === 'error' ? { errorMessage: row.status_error ?? 'Connection failed' } : {}),
              },
            }
          : {}),
      };
    });
    const connections = (
      await ctx.database.query<{
        connector_type: string;
        service: string | null;
        label: string | null;
        reference: string;
        state: 'active' | 'error';
      }>(
        `SELECT COALESCE(k.connector_type,'trusty-squire') connector_type,NULLIF(c.service,'') service,c.label,c.reference,c.state
         FROM workspace_connections c
         LEFT JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE c.owner_identity_id=$1
         ORDER BY c.service,c.reference`,
        [context.owner.pubkey],
      )
    ).rows;
    const ownerSelectedApps = new Set(
      (
        await ctx.database.query<{ app_id: string }>(
          `SELECT a.id AS app_id FROM workspace_apps a
       JOIN LATERAL (
         SELECT requested_by FROM workspace_app_routes
         WHERE app_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1
       ) r ON r.requested_by=a.owner_identity_id
       WHERE a.owner_identity_id=$1 AND a.state='active'`,
          [context.owner.pubkey],
        )
      ).rows.map((row) => row.app_id),
    );
    const registryServers = paired.flatMap((row) =>
      row.registry_server_name && row.registry_version
        ? [
            {
              connectorId: row.id,
              serverName: row.registry_server_name,
              version: row.registry_version,
              displayName: row.display_name ?? row.registry_server_name,
              status: row.status,
              ...(row.website_url ? { websiteUrl: row.website_url } : {}),
              onThisMachine: (row.machine_id ?? row.helper_agent_id) === context.machine.machineId,
            },
          ]
        : [],
    );
    return {
      addressee: {
        identityId: context.addressee.pubkey,
        name: context.addressee.name,
        ...(context.addressee.handle ? { handle: context.addressee.handle } : {}),
      },
      owner: {
        identityId: context.owner.pubkey,
        name: context.owner.name,
        ...(context.owner.handle ? { handle: context.owner.handle } : {}),
      },
      catalog,
      connections: connections.map((row) => ({
        connectorType: row.connector_type,
        service: row.service,
        label: row.label ?? row.reference,
        state: row.state,
      })),
      registryServers,
      firstPartyIntegrations: await Promise.all(FIRST_PARTY_INTEGRATIONS.map(async entry => {
        const provider = entry.provider({ linkWallet: ctx.linkWallet });
        const account = await provider?.status(context.owner.pubkey, ctx.database);
        return { key: entry.key, name: entry.name,
          status: !provider || account?.ineligible ? 'broken' as const
            : account?.connected ? 'connected' as const : 'not-connected' as const };
      })),
      apps: (await readOwnerApps(ctx.database, context.owner.pubkey, ctx.composio)).map(
        (app) => ({
          appId: app.appId,
          appKey: app.appKey,
          name: app.name,
          transport: app.transport,
          selectedByOwner: ownerSelectedApps.has(app.appId),
          ...(app.connectorId ? { connectorId: app.connectorId } : {}),
          ...(app.connectionReference ? { connectionReference: app.connectionReference } : {}),
          status: app.status,
          ...(app.errorMessage ? { errorMessage: app.errorMessage } : {}),
        }),
      ),
      machine: { ...context.machine, squire: await machineSquireReport(ctx.database,
        context.owner.pubkey, context.machine.machineId) },
    };
  }


  export async function daemonSearchMcpRegistry(ctx: DaemonContext,
    input: Input<'searchMcpRegistry'>,
  ): Promise<Output<'searchMcpRegistry'>> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query || query.length > 120) throw new Error('Registry search query is invalid');
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Registry search limit is invalid');
    return { servers: await ctx.mcpRegistry.search(query, Math.min(10, limit)) };
  }


  export function daemonWarmConnectorIndex(ctx: DaemonContext): Promise<void> {
    return connectorIntentIndex(ctx.mcpRegistry, ctx.composio).refresh();
  }
