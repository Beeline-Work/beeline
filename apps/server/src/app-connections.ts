import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { machineSquireReport } from './squire-machine.js';
import { randomUUID } from 'node:crypto';
import { appIdentity, appResourceTarget, appKeyForHost, registrableDomain, registryServerAppKey, type AppConnectionStatus, type AppRoute, type AppTransport, type ConnectAppStatus, type WorkbenchAppView } from '@beeline/api-contract/workbench';
import type { ConnectorStatus, RegistryMcpManifest } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { ComposioApps, composioToolkitForApp } from './composio-apps.js';
export { connectApp, disconnectApp, recordOwnerGitHubSelection, completeComposioSignIn, beginComposioAppSignIn, appGateFor, recordAppUsage, backfillRegistryApps } from './app-connections-connect-app.js';



/** Direct OAuth remotes verified against the official MCP Registry. */
export const OFFICIAL_REGISTRY_APPS: Readonly<Record<string, string>> = {
  stripe: 'com.stripe/mcp',
  linear: 'app.linear/linear',
};


/**
 * The one front door for apps (`@beeline/api-contract/app-connections`).
 *
 * Route selection keeps managed sign-ins and official MCP connections; OAuth
 * takes priority over a stored API route when the app supports it. `connectApp` then
 * installs an official Registry MCP for a new Stripe/Linear connection;
 * `resolveAppRoute` handles Composio, Squire API, then Squire browser.
 * Every decision it makes is written to `workspace_app_routes` and logged.
 * Two rules keep a route from being skipped silently:
 *   - an existing managed sign-in or MCP route stays selected; a stored Squire
 *     API route can become OAuth after a successful support check;
 *   - the Squire browser is reached only from the Squire API route, on the
 *     explicit fact that the app has no API.
 * An OAuth support check that fails is `unavailable`, not "unsupported".
 */

type ExistingApp = {
  readonly transport: AppTransport;
  readonly state: 'active' | 'disconnected';
  /** A vault key for the app already exists (so it plainly has an API route). */
  readonly hasCredential: boolean;
};


export type WorkbenchBacking =
  | {
      readonly transport: 'registry-mcp';
      readonly connectorId: string;
      readonly serverName: string;
      readonly machineId: string | null;
    }
  | { readonly transport: 'squire-api'; readonly reference: string };


/** `withheld`: the app signs in only through a custom OAuth config that is not set up. */
export type ComposioPick = 'supported' | 'none' | 'withheld' | 'unavailable';


export type AppRouteDecision =
  | { readonly kind: 'keep'; readonly transport: AppTransport; readonly note?: string }
  | {
      readonly kind: 'route';
      readonly route: AppRoute;
      readonly transport: AppTransport;
      readonly reason: string;
      readonly backing?: WorkbenchBacking;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };


export type AppRouteProbes = {
  /** A connected Workbench connection that already serves this app. */
  workbench(): Promise<WorkbenchBacking | undefined>;
  /** Managed OAuth support for this exact app. Absent only in old unit fixtures. */
  composio?(): Promise<ComposioPick>;
};


/** The fixed route order. Probes run lazily, only as far as the order needs. */
export async function resolveAppRoute(
  input: { readonly existing?: ExistingApp; readonly reconnect: boolean; readonly noApi: boolean;
    readonly preferredRoute?: 'composio' | 'squire-api'; readonly appKey?: string },
  probes: AppRouteProbes,
): Promise<AppRouteDecision> {
  const existing = input.existing?.state === 'active' ? input.existing : undefined;
  if (input.appKey === 'github') {
    const backing = await probes.workbench();
    if (backing?.transport === 'squire-api')
      return { kind: 'route', route: 'workbench', transport: backing.transport,
        reason: 'use the owner’s vaulted GitHub token', backing };
  }
  // OAuth routes share the established sign-in decision below, including its wording.
  if (existing && !(existing.transport === 'squire-api' && !input.noApi &&
      await probes.composio?.() === 'supported')) {
    if (!input.noApi) return { kind: 'keep', transport: existing.transport };
    if (existing.transport !== 'squire-api')
      return {
        kind: 'keep',
        transport: existing.transport,
        note:
          existing.transport === 'squire-browser'
            ? 'already served through the browser'
            : 'noApi applies only to the Trusty Squire API route',
      };
    if (existing.hasCredential)
      return {
        kind: 'keep',
        transport: existing.transport,
        note: 'an API key for this app is already vaulted',
      };
    return {
      kind: 'route',
      route: 'squire-browser',
      transport: 'squire-browser',
      reason: 'Trusty Squire reported that the app has no API',
    };
  }
  const backing = await probes.workbench();
  if (backing && !(backing.transport === 'squire-api' && await probes.composio?.() === 'supported'))
    return {
      kind: 'route',
      route: 'workbench',
      transport: backing.transport,
      reason:
        backing.transport === 'registry-mcp'
          ? `already connected in Connectors through ${backing.serverName}`
          : `already connected in Connectors through vault key ${backing.reference}`,
      backing,
    };
  if (input.preferredRoute === 'squire-api' && await probes.composio?.() !== 'supported')
    return { kind: 'route', route: 'squire-api', transport: 'squire-api',
      reason: 'person selected Trusty Squire for this new connection' };
  const oauth = await probes.composio?.() ?? 'unavailable';
  if (oauth === 'unavailable')
    return { kind: 'unavailable', reason: 'The app connection could not be checked. Try again shortly.' };
  if (oauth === 'withheld')
    return { kind: 'unavailable', reason: 'This app is not available to connect yet.' };
  if (oauth === 'supported')
    return { kind: 'route', route: 'composio', transport: 'composio',
      reason: input.preferredRoute === 'composio'
        ? 'person selected this sign-in for a new connection'
        : 'managed OAuth is supported for this app' };
  if (input.preferredRoute === 'composio')
    return { kind: 'unavailable', reason: 'This sign-in is unavailable right now.' };
  return {
    kind: 'route',
    route: 'squire-api',
    transport: 'squire-api',
    reason: 'managed OAuth is unsupported; Trusty Squire provisions an API key',
  };
}


// --- Registry connector row (shared by connect_mcp_server and connect_app) ----

type RegistryConnectorRow = {
  id: string;
  status: 'installing' | 'connected' | 'error' | 'disconnected';
  registry_version: string;
  sign_in: ConnectorStatus['signIn'] | null;
  registry_handoff_attempt: string | null;
  registry_squire_relayed_attempt: string | null;
  versionConflict?: true;
};


const REGISTRY_STEPS = JSON.stringify([
  { label: 'Discover remote authentication', status: 'pending' },
  { label: 'Connect provider account', status: 'pending' },
]);


/**
 * One owner+machine Registry row for an exact, freshly fetched manifest:
 * reused while live, re-armed from error/disconnected, created otherwise.
 * Run inside the caller's transaction.
 */
export async function armRegistryConnector(
  database: SqlDatabase,
  input: {
    readonly workspaceId: string;
    readonly ownerId: string;
    readonly machineId: string;
    readonly helperAgentId: string;
    readonly manifest: RegistryMcpManifest;
    readonly installRoomId: string | null;
    readonly installCommandId: string | null;
  },
): Promise<RegistryConnectorRow> {
  const {manifest}=input;
  const row=(await database.query<RegistryConnectorRow>(`
    INSERT INTO workspace_connectors(
      id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,
      status,status_steps,registry_server_name,registry_version,registry_manifest,
      display_name,website_url,install_agent_id,install_room_id,install_command_id
    ) VALUES($1,$2,$3,'registry-mcp',$4,$5,'installing',$6::jsonb,$7,$8,$9::jsonb,$10,$11,$4,$12,$13)
    ON CONFLICT(workspace_id,owner_identity_id,machine_id,registry_server_name)
      WHERE connector_type='registry-mcp' DO UPDATE
    SET (helper_agent_id,status,status_steps,status_error,sign_in,registry_manifest,
      display_name,website_url,install_agent_id,install_room_id,install_command_id,
      registry_handoff_attempt,registry_squire_relayed_attempt,pairing_generation,updated_at) = (
      SELECT
        CASE WHEN rearm THEN excluded.helper_agent_id ELSE workspace_connectors.helper_agent_id END,
        CASE WHEN rearm THEN 'installing' ELSE workspace_connectors.status END,
        CASE WHEN rearm THEN excluded.status_steps ELSE workspace_connectors.status_steps END,
        CASE WHEN rearm THEN NULL ELSE workspace_connectors.status_error END,
        CASE WHEN rearm THEN NULL ELSE workspace_connectors.sign_in END,
        CASE WHEN rearm THEN excluded.registry_manifest ELSE workspace_connectors.registry_manifest END,
        CASE WHEN rearm THEN excluded.display_name ELSE workspace_connectors.display_name END,
        CASE WHEN rearm THEN excluded.website_url ELSE workspace_connectors.website_url END,
        CASE WHEN rearm THEN excluded.install_agent_id ELSE workspace_connectors.install_agent_id END,
        CASE WHEN rearm THEN excluded.install_room_id ELSE workspace_connectors.install_room_id END,
        CASE WHEN rearm THEN excluded.install_command_id ELSE workspace_connectors.install_command_id END,
        CASE WHEN rearm THEN NULL ELSE workspace_connectors.registry_handoff_attempt END,
        CASE WHEN rearm THEN NULL ELSE workspace_connectors.registry_squire_relayed_attempt END,
        workspace_connectors.pairing_generation+CASE WHEN rearm THEN 1 ELSE 0 END,
        CASE WHEN rearm THEN now() ELSE workspace_connectors.updated_at END
      FROM (SELECT workspace_connectors.registry_version=excluded.registry_version
        AND workspace_connectors.status IN ('error','disconnected') rearm) policy
    ) RETURNING id,status,registry_version,sign_in,registry_handoff_attempt,registry_squire_relayed_attempt`,
    [randomUUID(),input.workspaceId,input.ownerId,input.helperAgentId,input.machineId,
      REGISTRY_STEPS,manifest.name,manifest.version,JSON.stringify(manifest),manifest.title??manifest.name,
      manifest.websiteUrl??null,input.installRoomId,input.installCommandId])).rows[0]!;
  return {...row,...(row.registry_version!==manifest.version?{versionConflict:true as const}:{})};
}


// --- The app store ----------------------------------------------------------------

export type AppRow = {
  id: string;
  workspace_id: string;
  owner_identity_id: string;
  app_key: string;
  display_name: string;
  domain: string | null;
  transport: AppTransport;
  route: AppRoute;
  connector_id: string | null;
  composio_account_id: string | null;
  composio_link_expires_at: Date | null;
  sign_in_error: string | null;
  authorised_at: Date | null;
  machine_id: string | null;
  state: 'active' | 'disconnected';
  created_at: Date;
};


type ConnectionFact = {
  reference: string;
  service: string;
  hosts: string[];
  state: 'active' | 'error';
};


/**
 * Every vault key of this owner that belongs to the app. The Workbench is the
 * PERSON's, across Workspaces, and so is the Squire vault behind it.
 */
export async function appConnections(
  database: SqlDatabase,
  ownerId: string,
  appKey: string,
): Promise<ConnectionFact[]> {
  const rows = (
    await database.query<ConnectionFact>(
      `SELECT c.reference,c.service,c.hosts,c.state
       FROM workspace_connections c
       WHERE c.owner_identity_id=$1 AND c.machine_id IS NOT NULL
       ORDER BY c.state, c.created_at, c.reference`,
      [ownerId],
    )
  ).rows;
  return rows.filter((row) => connectionAppKeys(row).includes(appKey));
}


/** A person's existing app or vault route always wins over a new offer. */
export async function hasExistingAppRoute(
  database: SqlDatabase,
  ownerId: string,
  appKey: string,
): Promise<boolean> {
  const app = await database.query(
    `SELECT 1 FROM workspace_apps WHERE owner_identity_id=$1 AND app_key=$2 AND state='active' LIMIT 1`,
    [ownerId, appKey],
  );
  if (app.rows.length) return true;
  if ((await appConnections(database, ownerId, appKey)).some((row) => row.state === 'active'))
    return true;
  const registry = await database.query<{ registry_server_name: string }>(
    `SELECT registry_server_name FROM workspace_connectors
     WHERE owner_identity_id=$1 AND connector_type='registry-mcp' AND status='connected'`,
    [ownerId],
  );
  return registry.rows.some((row) => registryServerAppKey(row.registry_server_name) === appKey);
}


/** The apps one vault key belongs to: its service and the hosts it may reach. */
function connectionAppKeys(connection: {
  readonly service: string | null;
  readonly hosts: readonly string[];
}): readonly string[] {
  const keys = new Set<string>();
  const service = connection.service ? appIdentity(connection.service) : undefined;
  if (service) keys.add(service.key);
  for (const host of connection.hosts ?? []) {
    const key = appKeyForHost(host);
    if (key) keys.add(key);
  }
  return [...keys];
}


async function squireConnected(database: SqlDatabase, ownerId: string, machineId?: string | null): Promise<boolean> {
  return (await machineSquireReport(database, ownerId, machineId ?? undefined))?.status === 'connected';
}


export type Derived = {
  status: AppConnectionStatus;
  errorMessage?: string;
  /** The Squire connector is missing: sign-in cannot start on any route. */
  needsSquire?: boolean;
  signInUrl?: string;
  connectionReference?: string;
};


/** A composio row that is not actually connected — a fresh sign-in is the remedy. */
export const APP_SIGN_IN_NEEDS_ATTENTION = systemMessage("app-connections.app-sign-in-needs-attention");

export const APP_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

const APP_SIGN_IN_TIMED_OUT = systemMessage("app-connections.app-sign-in-timed-out-open-the-connection-card-and-sign-in-again");


export async function failAppSignInCards(database: SqlDatabase, appId: string, reason: string): Promise<void> {
  await database.query(
    `UPDATE messages SET card=jsonb_set(jsonb_set(card,'{status}','"failed"'::jsonb),
       '{errorMessage}',to_jsonb($2::text))
     WHERE card_type='app-sign-in' AND card->>'appId'=$1 AND card->>'status'='pending'`,
    [appId, reason.slice(0, 500)],
  );
}


/** The app's live state, read from whatever serves it — never stored twice. */
export async function deriveStatus(database: SqlDatabase, row: AppRow, composio?: ComposioApps): Promise<Derived> {
  if (row.transport === 'composio') {
    if (!composio) return { status: 'error', errorMessage: systemMessage("app-connections.app-sign-in-is-unavailable") };
    if (row.sign_in_error) return { status: 'error', errorMessage: row.sign_in_error };
    if (!row.composio_account_id) return { status: 'connecting' };
    let account;
    try {
      account = await composio.accountStatus(row.composio_account_id, row.owner_identity_id,
        composioToolkitForApp(row.app_key));
    } catch {
      return { status: 'error', errorMessage: systemMessage("app-connections.app-connection-could-not-be-checked-try-again") };
    }
    if (account.status === 'failed')
      return { status: 'error', errorMessage: account.reason ?? APP_SIGN_IN_NEEDS_ATTENTION };
    // Provider activation alone is not enough. The phone must redeem the
    // single-use verifier session under the authenticated Beeline identity.
    if (row.composio_link_expires_at)
      return row.composio_link_expires_at > new Date()
        ? { status: 'connecting' }
        : { status: 'error', errorMessage: APP_SIGN_IN_TIMED_OUT };
    return account.status === 'active'
      ? { status: 'connected' }
      : { status: 'error', errorMessage: APP_SIGN_IN_NEEDS_ATTENTION };
  }
  if (row.transport === 'registry-mcp') {
    const connector = row.connector_id
      ? (
          await database.query<{
            status: 'installing' | 'connected' | 'error' | 'disconnected';
            status_error: string | null;
            sign_in: ConnectorStatus['signIn'] | null;
          }>(`SELECT status,status_error,sign_in FROM workspace_connectors WHERE id=$1::uuid`, [
            row.connector_id,
          ])
        ).rows[0]
      : undefined;
    if (!connector || connector.status === 'disconnected')
      return { status: 'error', errorMessage: systemMessage("app-connections.the-mcp-connection-was-removed-reconnect-it") };
    if (connector.status === 'connected') return { status: 'connected' };
    if (connector.status === 'error')
      return { status: 'error', errorMessage: connector.status_error ?? systemMessage("app-connections.connection-failed") };
    const needsSquire = connector.sign_in?.url
      ? !(await squireConnected(database, row.owner_identity_id, row.machine_id))
      : false;
    return {
      status: 'connecting',
      ...(connector.sign_in?.url ? { signInUrl: connector.sign_in.url } : {}),
      ...(needsSquire ? { needsSquire } : {}),
    };
  }
  const connections = await appConnections(database, row.owner_identity_id, row.app_key);
  const active = connections.find((connection) => connection.state === 'active');
  if (active) return { status: 'connected', connectionReference: active.reference };
  if (!(await squireConnected(database, row.owner_identity_id, row.machine_id)))
    return {
      status: 'error',
      needsSquire: true,
      errorMessage: systemMessage("app-connections.connect-trusty-squire-in-connectors-first"),
    };
  if (connections[0])
    return {
      status: 'error',
      errorMessage: systemMessage("app-connections.its-vault-key-needs-attention-in-trusty-squire"),
      connectionReference: connections[0].reference,
    };
  return { status: 'connecting' };
}


export const APP_COLUMNS = `a.id,a.workspace_id,a.owner_identity_id,a.app_key,a.display_name,a.domain,
  a.transport,a.route,a.connector_id,a.composio_account_id,a.composio_link_expires_at,a.sign_in_error,
  a.machine_id,a.state,a.created_at,COALESCE(a.authorised_at,
    CASE WHEN a.transport='composio' AND a.composio_account_id IS NOT NULL
      AND a.composio_link_expires_at IS NULL AND a.sign_in_error IS NULL THEN a.created_at END,
    (SELECT c.connected_at FROM workspace_connectors c WHERE c.id=a.connector_id)) authorised_at`;


/**
 * The person's apps — ONE row per app, across every Workspace, because the
 * Workbench is personal — for Workbench and `workbench_status`.
 */
export async function readOwnerApps(
  database: SqlDatabase,
  ownerId: string,
  composio?: ComposioApps,
  options?:{readonly pure?:boolean},
): Promise<WorkbenchAppView[]> {
  const rows = (
    await database.query<
      AppRow & { helper_name: string | null; account_label: string;
        workspace_name: string; use_count: string; last_used_at: Date | null;
        last_agent_id: string | null; last_agent_name: string | null;
        last_room_id: string | null; last_room_name: string | null }
    >(
      `SELECT ${APP_COLUMNS},
              (SELECT COALESCE(MAX(sibling.machine_name),MIN(i.name)) FROM agents sibling
                 JOIN identities i ON i.id=sibling.agent_id
                WHERE sibling.owner_id=a.owner_identity_id
                  AND COALESCE(sibling.machine_id,sibling.agent_id)=a.machine_id) helper_name,
              (SELECT COUNT(*) FROM workspace_app_usage u WHERE u.app_id=a.id) use_count,
              COALESCE(NULLIF(owner.handle,''),owner.name) account_label,
              workspace.name workspace_name,
              last_use.created_at last_used_at,
              last_use.agent_id last_agent_id,agent.name last_agent_name,
              last_use.room_id last_room_id,room.name last_room_name
       FROM workspace_apps a
       JOIN identities owner ON owner.id=a.owner_identity_id
       JOIN workspaces workspace ON workspace.id=a.workspace_id
       LEFT JOIN LATERAL (
         SELECT u.created_at,u.agent_id,u.room_id FROM workspace_app_usage u
         WHERE u.app_id=a.id AND u.transport='composio'
         ORDER BY u.created_at DESC,u.id DESC LIMIT 1
       ) last_use ON true
       LEFT JOIN identities agent ON agent.id=last_use.agent_id
       LEFT JOIN rooms room ON room.id=last_use.room_id
       WHERE a.owner_identity_id=$1 AND a.state='active'
       ORDER BY a.created_at, a.app_key`,
      [ownerId],
    )
  ).rows;
  const views: WorkbenchAppView[] = [];
  for (const row of rows) {
    // The pure display reports only committed activation/error metadata.
    // Provider reconciliation remains an explicit sign-in/work operation.
    const derived:Derived = options?.pure&&row.transport==='composio'
      ?row.sign_in_error?{status:'error',errorMessage:row.sign_in_error}:row.authorised_at?{status:'connected'}:{status:'connecting'}
      :await deriveStatus(database, row, composio);
    if (!options?.pure&&row.transport === 'composio' && derived.status === 'error' &&
      derived.errorMessage && derived.errorMessage !== 'App connection could not be checked. Try again.') {
      // A card update must not turn a readable Workbench status into a failed read.
      try { await failAppSignInCards(database, row.id, derived.errorMessage); }
      catch { /* The Workbench error remains visible even if a Room card cannot update. */ }
    }
    if (!options?.pure&&derived.status === 'connected' && !row.authorised_at) {
      await database.query(`UPDATE workspace_apps SET authorised_at=COALESCE(authorised_at,now()) WHERE id=$1`, [row.id]);
    }
    if (!options?.pure&&row.transport === 'composio' && !row.authorised_at && derived.status === 'error'
      && (row.sign_in_error || (row.composio_link_expires_at && row.composio_link_expires_at <= new Date()))) {
      await database.query(`DELETE FROM workspace_apps WHERE id=$1 AND authorised_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM workspace_app_usage WHERE app_id=$1)
        AND NOT EXISTS(SELECT 1 FROM messages WHERE card_type='app-sign-in'
          AND card->>'appId'=$1::text AND card->>'status'='connected')`, [row.id]);
      continue;
    }
    views.push({
      hasConnected: Boolean(row.authorised_at) || derived.status === 'connected',
      appId: row.id,
      ...(row.connector_id ? { connectorId: row.connector_id } : {}),
      appKey: row.app_key,
      name: row.display_name,
      ...(row.domain ? { domain: row.domain } : {}),
      transport: row.transport,
      route: row.route,
      status: derived.status,
      ...(derived.errorMessage ? { errorMessage: derived.errorMessage } : {}),
      ...(row.helper_name ? { helperName: row.helper_name } : {}),
      ...(row.machine_id ? { helperId: row.machine_id } : {}),
      ...(derived.connectionReference
        ? { connectionReference: derived.connectionReference }
        : {}),
      accountLabel: row.account_label,
      workspaceName: row.workspace_name,
      useCount: Number(row.use_count),
      ...(row.last_used_at && row.last_agent_id && row.last_agent_name &&
        row.last_room_id && row.last_room_name ? { lastUse: {
          agentId: row.last_agent_id, agentName: row.last_agent_name,
          roomId: row.last_room_id, roomName: row.last_room_name,
          usedAt: Math.floor(row.last_used_at.getTime() / 1000),
        } } : {}),
      ...(row.last_used_at ? { lastUsedAt: Math.floor(row.last_used_at.getTime() / 1000) } : {}),
      createdAt: Math.floor(row.created_at.getTime() / 1000),
    });
  }
  return views;
}


export function displayNameFor(input: string, key: string, manifest?: RegistryMcpManifest): string {
  if (manifest?.title) return manifest.title;
  const typed = input.trim();
  if (appIdentity(typed)?.domain) return key.charAt(0).toUpperCase() + key.slice(1);
  return typed.slice(0, 80);
}


function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return undefined;
  }
}


export type ConnectAppParams = {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly machineId: string;
  /** The helper agent that serves this machine's connectors. */
  readonly helperAgentId: string;
  /** Who asked: a person (Workbench) or an agent (`connect_app`). */
  readonly requestedBy: string;
  readonly app: string;
  readonly reconnect?: boolean;
  readonly noApi?: boolean;
  readonly preferredRoute?: 'composio' | 'squire-api';
  /** Where an agent's install turn waits, so a finished sign-in resumes it. */
  readonly installRoomId?: string | null;
  readonly installCommandId?: string | null;
  /** Configured only when the project's callback verifier is enabled. */
  readonly composio?: ComposioApps;
  /** Room cards issue a fresh link only when the person taps Connect. */
  readonly issueLink?: boolean;
};


export type ConnectAppOutcome = {
  readonly status: ConnectAppStatus;
  readonly app: string;
  readonly appKey?: string;
  readonly appId?: string;
  readonly name?: string;
  readonly domain?: string;
  readonly route?: AppRoute;
  readonly transport?: AppTransport;
  readonly connectorId?: string;
  readonly authorizationUrl?: string;
  readonly derived?: AppConnectionStatus;
  readonly connectionReference?: string;
  readonly next: string;
};


/** How an agent uses a connected app on its route. */
export function connectedAppUse(app: {
  readonly transport?: AppTransport;
  readonly name: string;
  readonly appKey?: string;
  readonly domain: string;
  readonly connectionReference?: string;
}): string {
  if (app.transport === 'composio') return `Use the server app tools for ${app.name}.`;
  if (app.transport === 'registry-mcp') return `Use the mounted ${app.name} MCP tools.`;
  if (app.transport === 'squire-browser')
    return `Use Trusty Squire operate_* tools on ${app.domain}.`;
  return `Call ${app.name}'s API with Trusty Squire use_credential (${app.connectionReference ? `reference ${JSON.stringify(app.connectionReference)}` : `service "${app.appKey}"`}).`;
}


export function nextStep(
  outcome: Omit<ConnectAppOutcome, 'next'>,
  derived: Derived,
  errorNote?: string,
): string {
  const name = outcome.name ?? outcome.app;
  const target = outcome.appKey ? appResourceTarget(outcome.appKey) : 'this app';
  const where = outcome.domain ?? name;
  if (outcome.status === 'unavailable')
    return errorNote ?? 'The app connection could not be checked. Try again shortly.';
  if (outcome.status === 'needs_squire')
    return `Trusty Squire must be connected before the server can finish connecting ${name}.`;
  if (outcome.status === 'needs_sign_in')
    if (outcome.transport === 'composio')
      return `${derived.status === 'error' && derived.errorMessage ? `${derived.errorMessage}. ` : ''}The person must complete ${name} sign-in from the connection card. The app resumes on this same route after sign-in.`;
  if (outcome.status === 'needs_sign_in')
    return `The owner must complete ${name} sign-in from the connection card.`;
  if (outcome.status === 'error')
    return `${errorNote ?? derived.errorMessage ?? 'The connection failed'}. The route stays ${outcome.transport}; reconnect to repair this connection.`;
  if (outcome.status === 'connected')
    return `${connectedAppUse({ ...outcome, name, domain: where })} Every ${outcome.transport === 'composio' ? 'execution' : 'call'} is authorized as ${target}.`;
  if (outcome.transport === 'registry-mcp')
    return `The server is preparing ${name} connection.`;
  return `The server is connecting ${name} through Trusty Squire.`;
}

export async function selectRegistryApp(database:SqlDatabase,input:{workspaceId:string;ownerId:string;appKey:string;
  connectorId:string;machineId:string;name:string;domain:string|null}):Promise<string>{
  const row=(await database.query<{app_id:string}>(`
    WITH selected AS (
      INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,domain,
        transport,route,connector_id,machine_id,state)
      VALUES($1,$2,$3,$4,$5,$6,'registry-mcp','registry-mcp',$7,$8,'active')
      ON CONFLICT(owner_identity_id,app_key) DO UPDATE SET transport='registry-mcp',route='registry-mcp',
        connector_id=excluded.connector_id,machine_id=excluded.machine_id,display_name=excluded.display_name,
        domain=excluded.domain,state='active',composio_account_id=NULL,composio_link_expires_at=NULL,
        sign_in_error=NULL,updated_at=now()
      WHERE workspace_apps.transport='squire-api' OR workspace_apps.state='disconnected'
      RETURNING id
    ) INSERT INTO workspace_app_routes(id,app_id,route,transport,reason,requested_by)
      SELECT $9::uuid,id,'registry-mcp','registry-mcp','person selected verified company MCP',$3 FROM selected
      RETURNING app_id`,[randomUUID(),input.workspaceId,input.ownerId,input.appKey,input.name,input.domain,
      input.connectorId,input.machineId,randomUUID()])).rows[0];
  if(!row) throw new Error('This app already has a connection');
  return row.app_id;
}
