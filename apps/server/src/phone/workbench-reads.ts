import { MCP_SCOPES } from '../rooms-mcp-connections.js';
import { registryServerAppKey, registryServerDomain } from '@beeline/api-contract/workbench';
import { companyForMcp } from '../company-mcp-discovery.js';
import { COMPANY_APPS, resolveCompany } from '../company-registry.js';
import { companyHost } from '../company-registry.js';
import { companyPopularity, projectWorkbenchCompanies } from '../workbench-companies.js';
import { queueOwnerSquireWork, squireMachineId, squireWorkStatus } from '../squire-machine.js';
import { composioToolkitForApp } from '../composio-apps.js';
import { appIdentity } from '@beeline/api-contract/workbench';
import { connectorCatalog, isMetadataStale } from '../workbench.js';
import type { ConnectorStatus, ConnectorStep } from '@beeline/api-contract/workbench';
import { readOwnerApps } from '../app-connections.js';
import { faviconDomain, uniqueVaultConnections } from '@beeline/api-contract/workbench';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';
import { phoneReadAppCatalog } from './workbench-catalog.js';
import { seconds } from './values.js';



  export async function phoneReadConnectorInstall(ctx: PhoneContext, 
    input: Input<'readConnectorInstall'>,
    viewerId: string,
  ): Promise<Output<'readConnectorInstall'>> {
    if (input.connectorId === 'trusty-squire' || squireMachineId(input.connectorId)) {
      const machineId = squireMachineId(input.connectorId);
      const agent = (await ctx.database.query<{ agent_id: string }>(
        `SELECT agent_id FROM agents WHERE owner_id=$1
          AND ($2::text IS NULL OR COALESCE(machine_id,agent_id)=$2)
        ORDER BY (squire_work->>'install') DESC NULLS LAST,updated_at DESC LIMIT 1`,
        [viewerId, machineId ?? null],
      )).rows[0];
      if (!agent) {
        if (machineId) throw new Error('Squire machine not found (access denied)');
        return null;
      }
      const status = await squireWorkStatus(ctx.database, agent.agent_id);
      return { connectorId: status.connectorId, status };
    }
    const row = (
      await ctx.database.query<{
        id: string;
        owner_identity_id: string;
        status: ConnectorStatus['status'];
        status_steps: ConnectorStep[];
        sign_in: ConnectorStatus['signIn'];
        helper_name: string | null;
      }>(
        `SELECT c.id,c.owner_identity_id,c.status,c.status_steps,c.sign_in,
         COALESCE((SELECT MAX(sibling.machine_name) FROM agents sibling
           WHERE sibling.machine_id=c.machine_id AND sibling.owner_id=c.owner_identity_id),i.name) helper_name
       FROM workspace_connectors c JOIN identities i ON i.id=c.helper_agent_id
       WHERE c.id::text=$1 OR (c.connector_type=$1 AND c.owner_identity_id=$2)
       ORDER BY c.created_at DESC LIMIT 1`,
        [input.connectorId, viewerId],
      )
    ).rows[0];
    if (!row) return null;
    if (row.owner_identity_id !== viewerId) throw new Error('connector not found (access denied)');
    return {
      connectorId: row.id,
      status: {
        connectorId: row.id,
        status: row.status,
        steps: row.status_steps ?? [],
        ...(row.sign_in ? { signIn: row.sign_in } : {}),
        ...(row.helper_name ? { helperName: row.helper_name } : {}),
      },
    };
  }


  /**
   * Every read here is scoped to the VIEWER and to nobody else.
   *
   * The Workbench is a property of the HUMAN, not of a workspace: it lives in
   * personal settings, which cross workspace boundaries, and a paired tool and
   * its keys belong to the person who provisioned them wherever they are
   * working. `workspace_connections` was always keyed on `owner_identity_id`
   * alone; only the connector half carried a workspace, which made the screen
   * demand a workspace id no caller had and gave a person a separate helper
   * per workspace. Read both halves by owner. `input.workspaceId` is accepted
   * and ignored for wire compatibility with clients that still send it.
   */
  export async function phoneReadWorkbench(ctx: PhoneContext, 
    input: Input<'readWorkbench'>,
    viewerId: string,
  ): Promise<Output<'readWorkbench'>> {
    const linkAccount = (await ctx.linkWallet?.status(viewerId));
    if ((input.refreshVault)) {
      const machines = (await ctx.database.query<{ machine_id: string }>(
        `SELECT DISTINCT COALESCE(machine_id,agent_id) machine_id FROM agents WHERE owner_id=$1`, [viewerId],
      )).rows;
      await ctx.database.transaction(async (db) => {
        for (const machine of machines) await queueOwnerSquireWork(db, viewerId, machine.machine_id, 'sync');
      });
    }
    const connectors = (
      await ctx.database.query<{
        id: string;
        connector_type: Input<'pairConnector'>['connectorType'];
        status: ConnectorStatus['status'];
        status_steps: ConnectorStep[];
        status_error: string | null;
        helper_agent_id: string;
        helper_name: string | null;
        squire_version: string | null;
        signed_in_as: string | null;
        sign_in: ConnectorStatus['signIn'] | null;
        registry_server_name: string | null;
        registry_version: string | null;
        display_name: string | null;
        website_url: string | null;
        connected_at: Date | null;
        created_at: Date;
      }>(
        `SELECT c.id,c.connector_type,c.status,c.status_steps,c.status_error,
                c.helper_agent_id,
                COALESCE((SELECT MAX(sibling.machine_name) FROM agents sibling
                          WHERE sibling.machine_id=c.machine_id
                            AND sibling.owner_id=c.owner_identity_id),i.name) helper_name,
                c.squire_version,
                c.signed_in_as,c.sign_in,c.registry_server_name,
                c.registry_version,c.display_name,c.website_url,c.connected_at,c.created_at
         FROM workspace_connectors c
         JOIN identities i ON i.id=c.helper_agent_id
         WHERE c.owner_identity_id=$1
         ORDER BY c.created_at`,
        [viewerId],
      )
    ).rows;
    const connections = (
      await ctx.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        service: string | null;
        label: string | null;
        hosts: string[];
        state: 'active' | 'error';
        connection_metadata: Record<string, unknown>;
        last_synced_at: Date | null;
        created_at: Date;
      }>(
        // KEYS reads newest-first the way the Squire vault itself lists them,
        // so the vault's own `createdAt` orders the rows; ordering by service
        // instead floated four unrelated `default` labels to the top. A 0 is
        // "no vault time" (an unparseable timestamp), which falls back to the
        // row's own insert time rather than sinking the key to the bottom.
        `SELECT id,COALESCE(connector_id::text,'squire:' || machine_id) connector_id,reference,service,label,hosts,state,connection_metadata,last_synced_at,created_at
         FROM workspace_connections
         WHERE owner_identity_id=$1
         ORDER BY COALESCE(NULLIF((connection_metadata->>'vaultCreatedAt')::double precision, 0), extract(epoch from created_at)) DESC, reference`,
        [viewerId],
      )
    ).rows;
    const helpers = (
      await ctx.database.query<{
        id: string;
        name: string;
        online: boolean;
        squire_report: import('@beeline/api-contract/workbench').SquireMachineReport | null;
        reconnecting: boolean;
        google_session_expired: boolean;
        squire_error: string | null;
        signed_in_as: string | null;
      }>(
        // A helper is a MACHINE, not an individual agent: agents sharing a
        // machine_id are grouped into one row. An agent without a machine_id
        // (pre-migration helper) is its own machine; remote MCP members are excluded.
        // Work reports older than machine health cannot poison sibling status.
        // Untimestamped legacy work follows its Squire report, never general agent updates.
        // Online is true when ANY
        // agent on that machine has recent durable presence evidence (the
        // same 90-second window readers use). Name is the machine_name if set,
        // falling back to the first agent's identity name.
        `SELECT COALESCE(a.machine_id,a.agent_id) id,
                COALESCE(MAX(a.machine_name),MIN(i.name)) name,
                bool_or(p.online) online,
                bool_or(COALESCE(work.current->>'install','false')='true' AND NOT work.current ? 'errorMessage') reconnecting,
                MAX(work.current->>'signedInAs') signed_in_as,
                MAX(work.current->>'errorMessage') squire_error,
                bool_or(work.current->>'forceReloginProvider'='google') google_session_expired,
                (array_agg(a.squire_report ORDER BY (a.squire_report->>'status'='connected') DESC NULLS LAST, (a.squire_report->>'reportedAt')::double precision DESC NULLS LAST)
                  FILTER (WHERE a.squire_report IS NOT NULL))[1] squire_report
         FROM agents a
         JOIN identities i ON i.id=a.agent_id AND NOT i.hidden_from_roster
         JOIN memberships m ON m.identity_id=a.agent_id
           AND m.room_id IS NULL AND m.removed_at IS NULL
         LEFT JOIN LATERAL(
           SELECT EXISTS(
             SELECT 1 FROM live_outputs p
             WHERE p.agent_id=a.agent_id AND p.kind='presence'
               AND p.body->>'status'='online'
               AND (p.updated_at>now()-interval '90 seconds' OR p.body->>'held'='true')
           ) online
         ) p ON true
         LEFT JOIN LATERAL (
           SELECT MAX((s.squire_report->>'reportedAt')::double precision) connected_at
           FROM agents s JOIN identities si ON si.id=s.agent_id AND NOT si.hidden_from_roster
           WHERE s.owner_id=a.owner_id AND COALESCE(s.machine_id,s.agent_id)=COALESCE(a.machine_id,a.agent_id)
             AND s.squire_report->>'status'='connected'
             AND EXISTS (SELECT 1 FROM memberships sm WHERE sm.identity_id=s.agent_id
               AND sm.room_id IS NULL AND sm.removed_at IS NULL)
         ) latest ON true
         CROSS JOIN LATERAL (
           SELECT CASE WHEN COALESCE((a.squire_work->>'reportedAt')::double precision,
             (a.squire_report->>'reportedAt')::double precision,0) < latest.connected_at
             THEN '{}'::jsonb ELSE a.squire_work END current
         ) work
         WHERE a.owner_id=$1
           AND NOT EXISTS (SELECT 1 FROM rooms_mcp_members remote WHERE remote.member_id=a.agent_id)
         GROUP BY COALESCE(a.machine_id,a.agent_id)
         ORDER BY name`,
        [viewerId],
      )
    ).rows;

    // Squire API rows point at vault credentials. They remain installed for
    // agent use, but the person's Connectors page presents them under Keys.
    const apps = (await readOwnerApps(ctx.database, viewerId, ctx.composio))
      .filter((app) => app.transport !== 'squire-api' && app.hasConnected);
    const catalogKeys = new Set([
      'gmail',
      'googlecalendar',
      'slack',
      'googledrive',
      'googlesheets',
      'notion',
      'linear',
      'hubspot',
      'airtable',
      'asana',
      'jira',
      'supabase',
      ...apps
        .filter((app) => app.transport === 'composio')
        .map((app) => composioToolkitForApp(app.appKey)),
    ]);
    const appCatalog = (await phoneReadAppCatalog(ctx, catalogKeys));
    const appMetadata = new Map(appCatalog.map((item) => [item.appKey, item]));
    const uniqueConnections = uniqueVaultConnections(connections);
    const walletRow = (
      await ctx.database.query<{
        created_at: Date;
        delegation_expires_at: Date | null;
        delegation_standing: boolean;
      }>(
        (`SELECT created_at,delegation_expires_at,delegation_standing FROM wallet_bindings WHERE identity_id=$1`),
        [viewerId],
      )
    ).rows[0];
    const aiClients = (await ctx.database.query<{
      client_id: string; name: string; logo: string | null; connected_at: Date; last_used_at: Date | null;
    }>(`SELECT c.client_id,app.name,app.logo,c.connected_at,c.last_used_at FROM rooms_mcp_connections c
      JOIN rooms_mcp_clients app ON app.id=c.client_id WHERE c.identity_id=$1 AND c.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM rooms_mcp_families f WHERE f.client_id=c.client_id AND f.identity_id=c.identity_id AND f.revoked_at IS NULL)
      ORDER BY c.connected_at DESC LIMIT 100`, [viewerId])).rows;
    const view: Output<'readWorkbench'> = {
      aiClients: aiClients.map(c => ({ clientId: c.client_id, name: c.name, ...(c.logo ? { logo: c.logo } : {}), scopes: [...MCP_SCOPES],
        connectedAt: seconds(c.connected_at), lastUsedAt: c.last_used_at ? seconds(c.last_used_at) : null })),
      workspaceId: input.workspaceId,
      ...(linkAccount ? { linkAccount } : {}),
      catalog: connectorCatalog(),
      ...(walletRow
        ? {
            wallet: {
              createdAt: seconds(walletRow.created_at),
              delegationActive:
                walletRow.delegation_standing ||
                (walletRow.delegation_expires_at !== null &&
                  walletRow.delegation_expires_at.getTime() > Date.now()),
              delegationExpiresAt: walletRow.delegation_expires_at
                ? seconds(walletRow.delegation_expires_at)
                : null,
            },
          }
        : {}),
      helpers: helpers.map((row) => ({
        id: row.id,
        name: row.name,
        online: row.online,
        squireEligible: true,
        ...(row.squire_report || row.reconnecting || row.google_session_expired || row.squire_error ? {
          squire: { ...(row.squire_report ?? { status: 'not-added' as const, reportedAt: 0 }),
            ...(row.squire_error ? { status: 'error' as const, errorMessage: row.squire_error } : {}),
            reconnecting: row.reconnecting, googleSessionExpired: row.google_session_expired ?? false,
            ...(row.signed_in_as ? { signedInAs: row.signed_in_as } : {}) },
        } : {}),
      })),
      apps: apps.map((app) => {
        const metadata = appMetadata.get(composioToolkitForApp(app.appKey));
        return {
          ...app,
          ...(app.transport === 'composio' && !app.domain && metadata?.domain
            ? { domain: metadata.domain }
            : {}),
          ...(metadata?.description ? { description: metadata.description } : {}),
          ...(metadata?.logo ? { logo: metadata.logo } : {}),
        };
      }),
      appCatalog,
      connectors: connectors.map((row) => ({
        connectorId: row.id,
        connectorType: row.connector_type,
        status: {
          connectorId: row.id,
          status: row.status,
          steps: row.status_steps ?? [],
          ...(row.helper_name ? { helperName: row.helper_name } : {}),
          ...(row.signed_in_as ? { signedInAs: row.signed_in_as } : {}),
          ...(row.squire_version ? { squireVersion: row.squire_version } : {}),
          ...(row.sign_in ? { signIn: row.sign_in } : {}),
          ...(row.status_error ? { errorMessage: row.status_error } : {}),
        } as ConnectorStatus,
        helperAgentId: row.helper_agent_id,
        ...(row.registry_server_name ? { registryServerName: row.registry_server_name } : {}),
        ...(row.registry_version ? { registryVersion: row.registry_version } : {}),
        ...(row.display_name ? { displayName: row.display_name } : {}),
        ...(row.website_url ? { websiteUrl: row.website_url } : {}),
        ...(row.connected_at ? { connectedAt: seconds(row.connected_at) } : {}),
        createdAt: seconds(row.created_at),
      })),
      // One Squire vault entry is reported once by every paired helper that
      // can see it. Keep the newest owner's row as the detail anchor; neither
      // duplicate rows nor connector installations are deleted.
      connections: uniqueConnections.map((row) => ({
        connectionId: row.id,
        connectorId: row.connector_id,
        reference: row.reference,
        service: row.service,
        label: row.label ?? row.reference,
        allowedHosts: row.hosts ?? [],
        fieldNames: Array.isArray(row.connection_metadata.fieldNames)
          ? row.connection_metadata.fieldNames.filter(
              (field): field is string => typeof field === 'string',
            )
          : [],
        loginHosts: Array.isArray(row.connection_metadata.loginHosts) ? row.connection_metadata.loginHosts.filter((h): h is string => typeof h === 'string') : [],
        keyName: typeof row.connection_metadata.keyName === 'string' ? row.connection_metadata.keyName : undefined,
        credentialKind: typeof row.connection_metadata.credentialKind === 'string' ? row.connection_metadata.credentialKind : undefined,
        expiresAt: typeof row.connection_metadata.expiresAt === 'number' ? row.connection_metadata.expiresAt : undefined,
        faviconDomain: companyHost(typeof row.connection_metadata.faviconDomain === 'string' ? row.connection_metadata.faviconDomain : undefined) ?? faviconDomain(row.hosts ?? []),
        state: row.state,
        ...(row.last_synced_at
          ? {
              lastSyncedAt: seconds(row.last_synced_at),
              ...(isMetadataStale(row.last_synced_at) ? { stale: true } : {}),
            }
          : { stale: true }),
        createdAt:
          typeof row.connection_metadata.vaultCreatedAt === 'number' &&
          Number.isFinite(row.connection_metadata.vaultCreatedAt) &&
          row.connection_metadata.vaultCreatedAt > 0
            ? row.connection_metadata.vaultCreatedAt
            : seconds(row.created_at),
      })),
    };
    const ownedCompanies = new Set([...view.connections.map(key => resolveCompany(key).id),
      ...(view.apps ?? []).filter(app => app.transport === 'squire-api').map(app => resolveCompany(app).id)]);
    const oauthApps = new Set<string>();
    if ((ctx.composio)) await Promise.all(COMPANY_APPS.filter(app => ownedCompanies.has(resolveCompany({ domain: app.domain }).id))
      .map(async app => {
        try {
          if (await ctx.composio!.supportsOAuth(composioToolkitForApp(app.appKey))) oauthApps.add(app.appKey);
        } catch { /* Keep existing routes available when provider discovery is unavailable. */ }
      }));
    const companies = projectWorkbenchCompanies(view, ctx.publicOrigin, (await companyPopularity(ctx.database)), undefined, oauthApps);
    const keys = companies.rows.flatMap(company => {
      const known = companyForMcp(company.domain ?? company.id);
      return known ? [`company:${known.id}`, `search:${known.id}`] : [];
    });
    const cached = await ctx.connectorDiscovery.read((keys));
    const rows = companies.rows.map(company => {
      if (company.kind !== 'company' || company.items.some(item => item.kind === 'connection')) return company;
      const known = companyForMcp(company.domain ?? company.id);
      if (!known) return company;
      const cacheKey = `company:${known.id}`;
      ctx.connectorDiscovery.warm(cacheKey, viewerId, cached.get(cacheKey));
      const manifest = [...cached.get(cacheKey)?.manifests ?? [], ...cached.get(`search:${known.id}`)?.manifests ?? []]
        .find(manifest => registryServerAppKey(manifest.name) === appIdentity(known.domain!)?.key
          && known.hosts.includes(registryServerDomain(manifest.name) ?? '') && !manifest.secretInputNames.length
          && manifest.remotes.some(remote => remote.type === 'streamable-http'));
      if (!manifest) return company;
      return { ...company, mcp: { appKey: registryServerAppKey(manifest.name)!, appName: company.name,
        name: company.name, purpose: manifest.description ?? '', providerId: company.id, providerName: company.name,
        domain: company.domain, logo: company.logo, registryServerName: manifest.name,
        registryVersion: manifest.version, flow: 'app' as const } };
    });
    return { ...view, companies: { ...companies, rows } };
  }


  /**
   * One of the viewer's own machines, as the connector queue needs it: the
   * machine, the agent on it with the freshest live presence, and a Workspace
   * the viewer shares with that agent.
   */
  export async function phoneResolveViewerHelper(ctx: PhoneContext, helperAgentId: string, viewerId: string) {
    const input = { helperAgentId };
    // The input helperAgentId may be a machine_id (from a new client) or an
    // agent_id (back-compat from an older client). Resolve it to a machine:
    // if it matches an agent's machine_id, use that machine; otherwise treat
    // it as an agent_id and find its machine (for legacy agents, machine_id
    // IS the agent_id).
    // The input helperAgentId may be a machine_id or an agent_id.
    // A machine can host several agents, while the connector queue is bound
    // to one exact agent. Prefer the agent with the freshest live presence;
    // otherwise an online machine can arm an offline sibling and leave the
    // install row pending forever. The null fallback preserves old direct
    // callers that paired a legacy agent before presence was available.
    const candidate = await ctx.database.query<{
      agent_id: string;
      machine_id: string | null;
    }>(
      `SELECT a.agent_id,a.machine_id
         FROM agents a
         JOIN memberships m ON m.identity_id=a.agent_id
           AND m.room_id IS NULL AND m.removed_at IS NULL
         LEFT JOIN LATERAL(
           SELECT p.updated_at
           FROM live_outputs p
           WHERE p.agent_id=a.agent_id AND p.kind='presence'
             AND p.body->>'status'='online'
             AND (p.updated_at>now()-interval '90 seconds' OR p.body->>'held'='true')
           ORDER BY p.updated_at DESC LIMIT 1
         ) presence ON true
        WHERE a.owner_id=$1 AND (a.machine_id=$2 OR a.agent_id=$2)
        ORDER BY presence.updated_at DESC NULLS LAST,a.agent_id
        LIMIT 1`,
      [viewerId, input.helperAgentId],
    );
    const matched = candidate.rows[0];
    if (!matched)
      throw new Error('the connector helper must be a current agent you share a Workspace with');
    const machineId = matched.machine_id ?? matched.agent_id;
    const machine = await ctx.database.query<{ workspace_id: string }>(
      `SELECT mv.workspace_id
         FROM memberships mv
        WHERE mv.room_id IS NULL AND mv.removed_at IS NULL AND mv.identity_id=$1
          AND EXISTS(
            SELECT 1 FROM memberships mh
            WHERE mh.workspace_id=mv.workspace_id AND mh.room_id IS NULL
              AND mh.removed_at IS NULL AND mh.identity_id=$2
          )
        ORDER BY mv.joined_at, mv.workspace_id LIMIT 1`,
      [viewerId, matched.agent_id],
    );
    const ws = machine.rows[0];
    if (!ws)
      throw new Error('the connector helper must be a current agent you share a Workspace with');
    return { matched, machineId, ws };
  }
