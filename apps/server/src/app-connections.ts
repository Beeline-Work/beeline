import { randomUUID } from 'node:crypto';
import {
  appIdentity,
  appResourceTarget,
  appKeyForHost,
  registrableDomain,
  registryServerAppKey,
  registryServerDomain,
  selectOfficialHostedServer,
  type AppConnectionStatus,
  type AppRoute,
  type AppTransport,
  type ConnectAppStatus,
  type WorkbenchAppView,
} from '@beeline/api-contract/workbench';
import type { ConnectorStatus, RegistryMcpManifest } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { McpRegistryClient } from './mcp-registry.js';
import { notifyConnectorHelper } from './postgres-live.js';

/**
 * The one front door for apps (`@beeline/api-contract/app-connections`).
 *
 * `resolveAppRoute` is the ONLY place the route order lives:
 *   workbench → registry-mcp (official hosted server) → squire-api → squire-browser.
 * Every decision it makes is written to `workspace_app_routes` and logged.
 * Two rules keep a route from being skipped silently:
 *   - an app that already has a route keeps it — an error or a refused use is
 *     reported on THAT route, never answered by trying the next one; only an
 *     explicit reconnect re-resolves, and it starts again from the top;
 *   - the Squire browser is reached only from the Squire API route, on the
 *     explicit fact that the app has no API.
 * A Registry search that fails is `unavailable`, not "no official server".
 */

type ExistingApp = {
  readonly transport: AppTransport;
  readonly state: 'active' | 'disconnected';
  /** A vault key for the app already exists (so it plainly has an API route). */
  readonly hasCredential: boolean;
};

type WorkbenchBacking =
  | {
      readonly transport: 'registry-mcp';
      readonly connectorId: string;
      readonly serverName: string;
      readonly machineId: string | null;
    }
  | { readonly transport: 'squire-api'; readonly reference: string };

type RegistryPick =
  | { readonly status: 'official'; readonly manifest: RegistryMcpManifest }
  | { readonly status: 'none' }
  | { readonly status: 'unavailable' };

type AppRouteDecision =
  | { readonly kind: 'keep'; readonly transport: AppTransport; readonly note?: string }
  | {
      readonly kind: 'route';
      readonly route: AppRoute;
      readonly transport: AppTransport;
      readonly reason: string;
      readonly backing?: WorkbenchBacking;
      readonly manifest?: RegistryMcpManifest;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type AppRouteProbes = {
  /** A connected Workbench connection that already serves this app. */
  workbench(): Promise<WorkbenchBacking | undefined>;
  /** The app's official hosted MCP server, if the Registry publishes one. */
  registry(): Promise<RegistryPick>;
};

/** The fixed route order. Probes run lazily, only as far as the order needs. */
export async function resolveAppRoute(
  input: { readonly existing?: ExistingApp; readonly reconnect: boolean; readonly noApi: boolean },
  probes: AppRouteProbes,
): Promise<AppRouteDecision> {
  const existing = input.existing?.state === 'active' ? input.existing : undefined;
  if (existing && !input.reconnect) {
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
  if (backing)
    return {
      kind: 'route',
      route: 'workbench',
      transport: backing.transport,
      reason:
        backing.transport === 'registry-mcp'
          ? `already connected in Workbench through ${backing.serverName}`
          : `already connected in Workbench through vault key ${backing.reference}`,
      backing,
    };
  const registry = await probes.registry();
  if (registry.status === 'unavailable')
    return {
      kind: 'unavailable',
      reason:
        'The MCP Registry could not be searched, so the route cannot be chosen yet; try again shortly.',
    };
  if (registry.status === 'official')
    return {
      kind: 'route',
      route: 'registry-mcp',
      transport: 'registry-mcp',
      reason: `official hosted MCP server ${registry.manifest.name}@${registry.manifest.version}`,
      manifest: registry.manifest,
    };
  return {
    kind: 'route',
    route: 'squire-api',
    transport: 'squire-api',
    reason: 'no official hosted MCP server; Trusty Squire provisions an API key',
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
  created: boolean;
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
  const { manifest } = input;
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `registry-mcp:${input.workspaceId}:${input.ownerId}:${input.machineId}:${manifest.name}`,
  ]);
  const existing = (
    await database.query<Omit<RegistryConnectorRow, 'created' | 'versionConflict'>>(
      `SELECT id,status,registry_version,sign_in,registry_handoff_attempt,
              registry_squire_relayed_attempt
       FROM workspace_connectors
       WHERE workspace_id=$1 AND owner_identity_id=$2 AND machine_id=$3
         AND connector_type='registry-mcp' AND registry_server_name=$4
       FOR UPDATE`,
      [input.workspaceId, input.ownerId, input.machineId, manifest.name],
    )
  ).rows[0];
  if (existing && existing.registry_version !== manifest.version)
    return { ...existing, versionConflict: true, created: false };
  if (existing) {
    if (existing.status === 'error' || existing.status === 'disconnected') {
      await database.query(
        `UPDATE workspace_connectors SET helper_agent_id=$2,status='installing',
           status_steps=$3::jsonb,status_error=NULL,sign_in=NULL,
           registry_manifest=$4::jsonb,display_name=$5,website_url=$6,
           install_agent_id=$7,install_room_id=$8,install_command_id=$9,
           registry_handoff_attempt=NULL,registry_squire_relayed_attempt=NULL,
           pairing_generation=pairing_generation+1,updated_at=now()
         WHERE id=$1`,
        [
          existing.id,
          input.helperAgentId,
          REGISTRY_STEPS,
          JSON.stringify(manifest),
          manifest.title ?? manifest.name,
          manifest.websiteUrl ?? null,
          input.helperAgentId,
          input.installRoomId,
          input.installCommandId,
        ],
      );
      return { ...existing, status: 'installing', sign_in: null, created: true };
    }
    return { ...existing, created: false };
  }
  const id = randomUUID();
  await database.query(
    `INSERT INTO workspace_connectors(
       id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,
       status,status_steps,registry_server_name,registry_version,registry_manifest,
       display_name,website_url,install_agent_id,install_room_id,install_command_id
     ) VALUES($1,$2,$3,'registry-mcp',$4,$5,'installing',$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`,
    [
      id,
      input.workspaceId,
      input.ownerId,
      input.helperAgentId,
      input.machineId,
      REGISTRY_STEPS,
      manifest.name,
      manifest.version,
      JSON.stringify(manifest),
      manifest.title ?? manifest.name,
      manifest.websiteUrl ?? null,
      input.helperAgentId,
      input.installRoomId,
      input.installCommandId,
    ],
  );
  return {
    id,
    status: 'installing',
    registry_version: manifest.version,
    sign_in: null,
    registry_handoff_attempt: null,
    registry_squire_relayed_attempt: null,
    created: true,
  };
}

// --- The app store ----------------------------------------------------------------

type AppRow = {
  id: string;
  workspace_id: string;
  owner_identity_id: string;
  app_key: string;
  display_name: string;
  domain: string | null;
  transport: AppTransport;
  route: AppRoute;
  connector_id: string | null;
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
async function appConnections(
  database: SqlDatabase,
  ownerId: string,
  appKey: string,
): Promise<ConnectionFact[]> {
  const rows = (
    await database.query<ConnectionFact>(
      `SELECT c.reference,c.service,c.hosts,c.state
       FROM workspace_connections c
       JOIN workspace_connectors k ON k.id=c.connector_id
       WHERE c.owner_identity_id=$1
         AND k.connector_type='trusty-squire' AND k.status<>'disconnected'
       ORDER BY c.state, c.created_at, c.reference`,
      [ownerId],
    )
  ).rows;
  return rows.filter((row) => connectionAppKeys(row).includes(appKey));
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

async function squireConnected(database: SqlDatabase, ownerId: string): Promise<boolean> {
  return Boolean(
    (
      await database.query(
        `SELECT 1 FROM workspace_connectors
         WHERE owner_identity_id=$1
           AND connector_type='trusty-squire' AND status='connected' LIMIT 1`,
        [ownerId],
      )
    ).rows[0],
  );
}

type Derived = {
  status: AppConnectionStatus;
  errorMessage?: string;
  /** The Squire connector is missing: sign-in cannot start on any route. */
  needsSquire?: boolean;
  signInUrl?: string;
  connectionReference?: string;
};

/** The app's live state, read from whatever serves it — never stored twice. */
async function deriveStatus(database: SqlDatabase, row: AppRow): Promise<Derived> {
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
      return { status: 'error', errorMessage: 'The MCP connection was removed; reconnect it' };
    if (connector.status === 'connected') return { status: 'connected' };
    if (connector.status === 'error')
      return { status: 'error', errorMessage: connector.status_error ?? 'Connection failed' };
    const needsSquire = connector.sign_in?.url
      ? !(await squireConnected(database, row.owner_identity_id))
      : false;
    return {
      status: 'connecting',
      ...(connector.sign_in?.url ? { signInUrl: connector.sign_in.url } : {}),
      ...(needsSquire ? { needsSquire } : {}),
    };
  }
  const connections = await appConnections(database, row.owner_identity_id, row.app_key);
  const active = connections.find((connection) => connection.state === 'active');
  if (!(await squireConnected(database, row.owner_identity_id)))
    return {
      status: 'error',
      needsSquire: true,
      errorMessage: 'Connect Trusty Squire in Workbench first',
      ...(active ? { connectionReference: active.reference } : {}),
    };
  if (active) return { status: 'connected', connectionReference: active.reference };
  if (connections[0])
    return {
      status: 'error',
      errorMessage: 'Its vault key needs attention in Trusty Squire',
      connectionReference: connections[0].reference,
    };
  return { status: 'connecting' };
}

const APP_COLUMNS = `a.id,a.workspace_id,a.owner_identity_id,a.app_key,a.display_name,a.domain,
  a.transport,a.route,a.connector_id,a.machine_id,a.state,a.created_at`;

/**
 * The person's apps — ONE row per app, across every Workspace, because the
 * Workbench is personal — for Workbench and `workbench_status`.
 */
export async function readOwnerApps(
  database: SqlDatabase,
  ownerId: string,
): Promise<WorkbenchAppView[]> {
  const rows = (
    await database.query<
      AppRow & { helper_name: string | null; use_count: string; last_used_at: Date | null }
    >(
      `SELECT ${APP_COLUMNS},
              (SELECT COALESCE(MAX(sibling.machine_name),MIN(i.name)) FROM agents sibling
                 JOIN identities i ON i.id=sibling.agent_id
                WHERE sibling.owner_id=a.owner_identity_id
                  AND COALESCE(sibling.machine_id,sibling.agent_id)=a.machine_id) helper_name,
              (SELECT COUNT(*) FROM workspace_app_usage u WHERE u.app_id=a.id) use_count,
              (SELECT MAX(u.created_at) FROM workspace_app_usage u WHERE u.app_id=a.id) last_used_at
       FROM workspace_apps a
       WHERE a.owner_identity_id=$1 AND a.state='active'
       ORDER BY a.created_at, a.app_key`,
      [ownerId],
    )
  ).rows;
  const views: WorkbenchAppView[] = [];
  for (const row of rows) {
    const derived = await deriveStatus(database, row);
    views.push({
      appId: row.id,
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
      useCount: Number(row.use_count),
      ...(row.last_used_at ? { lastUsedAt: Math.floor(row.last_used_at.getTime() / 1000) } : {}),
      createdAt: Math.floor(row.created_at.getTime() / 1000),
    });
  }
  return views;
}

function displayNameFor(input: string, key: string, manifest?: RegistryMcpManifest): string {
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

type ConnectAppParams = {
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
  /** Where an agent's install turn waits, so a finished sign-in resumes it. */
  readonly installRoomId?: string | null;
  readonly installCommandId?: string | null;
};

type ConnectAppOutcome = {
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
  readonly next: string;
};

function nextStep(
  outcome: Omit<ConnectAppOutcome, 'next'>,
  derived: Derived,
  errorNote?: string,
): string {
  const name = outcome.name ?? outcome.app;
  const target = outcome.appKey ? appResourceTarget(outcome.appKey) : 'this app';
  const where = outcome.domain ?? name;
  if (outcome.status === 'unavailable')
    return 'The MCP Registry could not be searched, so no route was chosen. Try again shortly; Beeline never skips ahead to another route.';
  if (outcome.status === 'needs_squire')
    return `Trusty Squire handles every sign-in, sign-up and payment for apps, and it is not connected for this owner. Offer it with offer_connector (connectorType trusty-squire), then call connect_app again.`;
  if (outcome.status === 'needs_sign_in')
    return `Open authorizationUrl with Trusty Squire (operate_start, operate_login, operate_observe, then operate_finish). Any passkey or vouch step goes to the owner through Squire; never paste the link into chat. Call connect_app again when Squire finishes.`;
  if (outcome.status === 'error')
    return `${errorNote ?? derived.errorMessage ?? 'The connection failed'}. The route stays ${outcome.transport}; call connect_app with reconnect: true to resolve it again from the top.`;
  if (outcome.status === 'connected') {
    if (outcome.transport === 'registry-mcp')
      return `Use the mounted ${name} MCP tools. Every call is authorized as ${target}.`;
    if (outcome.transport === 'squire-browser')
      return `Use Trusty Squire operate_* tools on ${where}. Every call is authorized as ${target}.`;
    return `Call ${name}'s API with Trusty Squire use_credential (service "${outcome.appKey}"). Every call is authorized as ${target}.`;
  }
  if (outcome.transport === 'registry-mcp')
    return `The helper is preparing ${name}'s MCP sign-in. Call connect_app again in a moment.`;
  if (outcome.transport === 'squire-browser')
    return `${name} has no API: with Trusty Squire, sign up or sign in on ${where} and store that sign-in with store_credential (service "${outcome.appKey}", auth_strategy "username_password"). Call connect_app again when it is vaulted.`;
  return `With Trusty Squire, sign up or sign in on ${where}, create an API key and store it with store_credential (service "${outcome.appKey}") — never in chat. Call connect_app again when it is vaulted. If ${name} has no API at all, call connect_app with noApi: true.`;
}

/**
 * The one front door. Chooses (or keeps) the app's route in the fixed order,
 * records the choice, arms what the route needs, and reports the next step.
 */
export async function connectApp(
  database: SqlDatabase,
  registryClient: McpRegistryClient,
  params: ConnectAppParams,
): Promise<ConnectAppOutcome> {
  const identity = appIdentity(params.app);
  if (!identity)
    return {
      status: 'error',
      app: params.app,
      next: 'Name the app by its product name or website, e.g. "Linear" or "linear.app".',
    };
  const key = identity.key;
  const lockKey = `app:${params.ownerId}:${key}`;
  const readExisting = async (db: SqlDatabase) =>
    (
      await db.query<AppRow>(
        `SELECT ${APP_COLUMNS} FROM workspace_apps a
         WHERE a.owner_identity_id=$1 AND a.app_key=$2`,
        [params.ownerId, key],
      )
    ).rows[0];

  let registryMemo: Promise<RegistryPick> | undefined;
  const registryProbe = (db: SqlDatabase) => async (): Promise<RegistryPick> => {
    registryMemo ??= (async () => {
      let servers: readonly RegistryMcpManifest[];
      try {
        servers = await registryClient.search(key, 10);
      } catch {
        return { status: 'unavailable' } as const;
      }
      const pick = selectOfficialHostedServer(servers, key);
      if (!pick) return { status: 'none' } as const;
      // An app already pinned on this machine keeps its pinned version.
      const pinned = (
        await db.query<{ registry_version: string }>(
          `SELECT registry_version FROM workspace_connectors
           WHERE workspace_id=$1 AND owner_identity_id=$2 AND machine_id=$3
             AND connector_type='registry-mcp' AND registry_server_name=$4`,
          [params.workspaceId, params.ownerId, params.machineId, pick.name],
        )
      ).rows[0]?.registry_version;
      try {
        // Integrity boundary: the exact pinned record is always re-fetched.
        const manifest = await registryClient.exact(pick.name, pinned ?? pick.version);
        return manifest && manifest.remotes.some((remote) => remote.type === 'streamable-http')
          ? ({ status: 'official', manifest } as const)
          : ({ status: 'unavailable' } as const);
      } catch {
        return { status: 'unavailable' } as const;
      }
    })();
    return registryMemo;
  };
  const workbenchProbe = (db: SqlDatabase) => async (): Promise<WorkbenchBacking | undefined> => {
    const registry = (
      await db.query<{ id: string; registry_server_name: string; machine_id: string | null }>(
        `SELECT id,registry_server_name,machine_id FROM workspace_connectors
         WHERE owner_identity_id=$1 AND connector_type='registry-mcp' AND status='connected'
         ORDER BY (workspace_id=$2 AND machine_id=$3) DESC, (machine_id=$3) DESC, updated_at DESC`,
        [params.ownerId, params.workspaceId, params.machineId],
      )
    ).rows.find((row) => registryServerAppKey(row.registry_server_name) === key);
    if (registry)
      return {
        transport: 'registry-mcp',
        connectorId: registry.id,
        serverName: registry.registry_server_name,
        machineId: registry.machine_id,
      };
    const vaulted = (await appConnections(db, params.ownerId, key)).find(
      (connection) => connection.state === 'active',
    );
    return vaulted ? { transport: 'squire-api', reference: vaulted.reference } : undefined;
  };
  const existingFacts = async (db: SqlDatabase, row: AppRow | undefined) =>
    row
      ? {
          transport: row.transport,
          state: row.state,
          hasCredential: (await appConnections(db, params.ownerId, key)).some(
            (connection) => connection.state === 'active',
          ),
        }
      : undefined;
  const resolveWith = async (db: SqlDatabase, row: AppRow | undefined) =>
    resolveAppRoute(
      {
        ...(row ? { existing: await existingFacts(db, row) } : {}),
        reconnect: params.reconnect === true,
        noApi: params.noApi === true,
      },
      { workbench: workbenchProbe(db), registry: registryProbe(db) },
    );

  // Network (the Registry) is read before the transaction; the transaction
  // re-decides under the app lock with that memoized answer.
  const preview = await resolveWith(database, await readExisting(database));
  if (preview.kind === 'unavailable')
    return {
      status: 'unavailable',
      app: params.app,
      appKey: key,
      next: nextStep({ status: 'unavailable', app: params.app, appKey: key }, { status: 'error' }),
    };

  const applied = await database.transaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
    const existing = await readExisting(db);
    const decision = await resolveWith(db, existing);
    if (decision.kind === 'unavailable') return { decision, row: existing };
    let row = existing;
    let armedConnector: RegistryConnectorRow | undefined;
    if (decision.kind === 'route') {
      let connectorId: string | null = null;
      let manifest = decision.manifest;
      if (decision.backing?.transport === 'registry-mcp') connectorId = decision.backing.connectorId;
      if (decision.transport === 'registry-mcp' && manifest) {
        armedConnector = await armRegistryConnector(db, {
          workspaceId: params.workspaceId,
          ownerId: params.ownerId,
          machineId: params.machineId,
          helperAgentId: params.helperAgentId,
          manifest,
          installRoomId: params.installRoomId ?? null,
          installCommandId: params.installCommandId ?? null,
        });
        if (armedConnector.versionConflict) manifest = undefined;
        connectorId = armedConnector.id;
      }
      const name = displayNameFor(params.app, key, manifest);
      const domain =
        identity.domain ??
        domainOf(manifest?.websiteUrl) ??
        (manifest ? registryServerDomain(manifest.name) : undefined) ??
        null;
      const id = existing?.id ?? randomUUID();
      await db.query(
        `INSERT INTO workspace_apps(
           id,workspace_id,owner_identity_id,app_key,display_name,domain,transport,route,
           connector_id,machine_id,state
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
         ON CONFLICT (owner_identity_id,app_key) DO UPDATE
         SET workspace_id=EXCLUDED.workspace_id,display_name=EXCLUDED.display_name,
             domain=COALESCE(EXCLUDED.domain,workspace_apps.domain),
             transport=EXCLUDED.transport,route=EXCLUDED.route,
             connector_id=EXCLUDED.connector_id,machine_id=EXCLUDED.machine_id,
             state='active',updated_at=now()`,
        [
          id,
          params.workspaceId,
          params.ownerId,
          key,
          existing && decision.route === 'squire-browser' ? existing.display_name : name,
          domain,
          decision.transport,
          decision.route,
          decision.transport === 'registry-mcp' ? connectorId : null,
          decision.backing?.transport === 'registry-mcp'
            ? decision.backing.machineId
            : params.machineId,
        ],
      );
      await db.query(
        `INSERT INTO workspace_app_routes(id,app_id,route,transport,reason,requested_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), id, decision.route, decision.transport, decision.reason, params.requestedBy],
      );
      console.log(
        `connectApp: workspace=${params.workspaceId} owner=${params.ownerId} app=${key} route=${decision.route} transport=${decision.transport} reason="${decision.reason}"`,
      );
      row = await readExisting(db);
    } else if (
      existing?.transport === 'registry-mcp' &&
      existing.connector_id &&
      params.installRoomId &&
      params.installCommandId
    ) {
      // The agent now driving the sign-in is the turn a finished OAuth resumes.
      await db.query(
        `UPDATE workspace_connectors
         SET install_agent_id=$2,install_room_id=$3,install_command_id=$4,updated_at=now()
         WHERE id=$1::uuid AND status='installing' AND helper_agent_id=$2`,
        [existing.connector_id, params.helperAgentId, params.installRoomId, params.installCommandId],
      );
    }
    return { decision, row, armedConnector };
  });

  if (applied.decision.kind === 'unavailable' || !applied.row)
    return {
      status: 'unavailable',
      app: params.app,
      appKey: key,
      next: nextStep({ status: 'unavailable', app: params.app, appKey: key }, { status: 'error' }),
    };
  if (applied.armedConnector?.created) await notifyConnectorHelper(database, applied.armedConnector.id);

  const row = applied.row;
  const derived = await deriveStatus(database, row);
  const versionNote = applied.armedConnector?.versionConflict
    ? `This machine already pins another version of the server (${applied.armedConnector.registry_version}); automatic upgrades are not supported`
    : undefined;
  const decisionNote = applied.decision.kind === 'keep' ? applied.decision.note : undefined;
  const status: ConnectAppStatus = versionNote
    ? 'error'
    : derived.needsSquire
      ? 'needs_squire'
      : derived.status === 'connected'
        ? 'connected'
        : derived.status === 'error'
          ? 'error'
          : derived.signInUrl
            ? 'needs_sign_in'
            : 'connecting';
  const base = {
    status,
    app: params.app,
    appKey: key,
    appId: row.id,
    name: row.display_name,
    ...(row.domain ? { domain: row.domain } : {}),
    ...(applied.decision.kind === 'route' ? { route: applied.decision.route } : {}),
    transport: row.transport,
    ...(row.connector_id ? { connectorId: row.connector_id } : {}),
    ...(status === 'needs_sign_in' && derived.signInUrl
      ? { authorizationUrl: derived.signInUrl }
      : {}),
    derived: derived.status,
  };
  const next = nextStep(base, derived, versionNote);
  return { ...base, next: decisionNote ? `Kept the ${row.transport} route: ${decisionNote}. ${next}` : next };
}

/**
 * Disconnect every route of one app: the Registry connector it holds is
 * unpaired, and the app's standing approvals are revoked, so a reconnect
 * starts from a fresh route decision and a fresh permission decision. A vault
 * key stays in Trusty Squire, which owns it.
 */
export async function disconnectApp(
  database: SqlDatabase,
  input: { readonly ownerId: string; readonly appId: string },
): Promise<{ helperAgentId?: string }> {
  return database.transaction(async (db) => {
    const row = (
      await db.query<AppRow>(
        `SELECT ${APP_COLUMNS} FROM workspace_apps a
         WHERE a.id=$1::uuid AND a.owner_identity_id=$2 FOR UPDATE`,
        [input.appId, input.ownerId],
      )
    ).rows[0];
    if (!row) throw new Error('app not found (access denied)');
    await db.query(
      `UPDATE workspace_apps SET state='disconnected',updated_at=now() WHERE id=$1::uuid`,
      [row.id],
    );
    await db.query(
      `UPDATE agent_grants g SET status='revoked',decided_by=$2,decided_at=now()
       FROM agents a
       WHERE a.agent_id=g.agent_id AND a.owner_id=$2
         AND g.kind='mcp' AND g.target=$1 AND g.status IN ('approved','once')`,
      [appResourceTarget(row.app_key), input.ownerId],
    );
    if (row.transport !== 'registry-mcp' || !row.connector_id) return {};
    await db.query(`DELETE FROM workspace_connections WHERE connector_id=$1::uuid`, [
      row.connector_id,
    ]);
    const connector = (
      await db.query<{ helper_agent_id: string }>(
        `UPDATE workspace_connectors
         SET status='disconnected', status_steps='[]'::jsonb, status_error=NULL,
             pending_ops='[]'::jsonb, connected_at=NULL, updated_at=now()
         WHERE id=$1::uuid RETURNING helper_agent_id`,
        [row.connector_id],
      )
    ).rows[0];
    return connector ? { helperAgentId: connector.helper_agent_id } : {};
  });
}

type AppGate =
  | { readonly kind: 'resource'; readonly target: string }
  | { readonly kind: 'app'; readonly target: string; readonly appId: string; readonly transport: AppTransport }
  | { readonly kind: 'refuse' };

/**
 * The app a per-call resource authorization belongs to. A Registry route and
 * a Squire call that names a connected app both resolve to `app:<key>`, so
 * every route of one app answers to one permission decision; a call for a
 * disconnected app is refused outright rather than falling back to Squire's
 * own gate.
 */
export async function appGateFor(
  database: SqlDatabase,
  input: {
    readonly roomId: string;
    readonly agentId: string;
    readonly target: string;
    readonly appKeys?: readonly string[];
  },
): Promise<AppGate> {
  const registryName = input.target.startsWith('registry-mcp:')
    ? input.target.slice('registry-mcp:'.length)
    : undefined;
  const keys =
    registryName !== undefined
      ? [
          registryServerAppKey(registryName) ??
            appIdentity(registryName.split('/').pop() ?? '')?.key,
        ].filter((key): key is string => Boolean(key))
      : input.target === 'squire'
        ? [
            ...new Set(
              (input.appKeys ?? []).filter((key) => typeof key === 'string' && key.length > 0),
            ),
          ]
        : [];
  if (registryName === undefined && !keys.length) return { kind: 'resource', target: input.target };
  const rows = (
    await database.query<{
      id: string;
      app_key: string;
      transport: AppTransport;
      state: 'active' | 'disconnected';
    }>(
      `SELECT app.id,app.app_key,app.transport,app.state
       FROM agents owner_agent
       JOIN workspace_apps app ON app.owner_identity_id=owner_agent.owner_id
       LEFT JOIN workspace_connectors k ON k.id=app.connector_id
       WHERE owner_agent.agent_id=$1
         AND (($2::text IS NOT NULL AND app.transport='registry-mcp' AND k.registry_server_name=$2)
           OR app.app_key=ANY($3::text[]))
       ORDER BY app.app_key`,
      [input.agentId, registryName ?? null, keys],
    )
  ).rows;
  if (!rows.length) return { kind: 'resource', target: input.target };
  // A call that names a disconnected app is refused, whatever else it names:
  // an active sibling's approval never covers it.
  if (rows.some((row) => row.state !== 'active')) return { kind: 'refuse' };
  // One call, one app: a call naming two connected apps has no single
  // decision or ledger to answer to, so it is refused rather than charged to
  // whichever sorts first.
  const apps = new Map(rows.map((row) => [row.id, row]));
  if (apps.size !== 1) return { kind: 'refuse' };
  const row = rows[0]!;
  return {
    kind: 'app',
    target: appResourceTarget(row.app_key),
    appId: row.id,
    transport: row.transport,
  };
}

/** One usage row per authorized call, for every route alike. */
export async function recordAppUsage(
  database: SqlDatabase,
  input: {
    readonly appId: string;
    readonly agentId: string;
    readonly roomId: string;
    readonly requesterId: string | null;
    readonly transport: AppTransport;
    readonly operation: string;
    readonly grantId?: string;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO workspace_app_usage(
       id,app_id,agent_id,room_id,requester_id,transport,operation,grant_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      input.appId,
      input.agentId,
      input.roomId,
      input.requesterId,
      input.transport,
      input.operation.slice(0, 120),
      input.grantId ?? null,
    ],
  );
}

/**
 * Every Registry connector that predates the front door becomes an app row,
 * so it is one Workbench row and answers to `app:<key>` like any other.
 */
export async function backfillRegistryApps(
  database: SqlDatabase,
  connectorId?: string,
): Promise<number> {
  const rows = (
    await database.query<{
      id: string;
      workspace_id: string;
      owner_identity_id: string;
      registry_server_name: string;
      display_name: string | null;
      website_url: string | null;
      machine_id: string | null;
    }>(
      `SELECT k.id,k.workspace_id,k.owner_identity_id,k.registry_server_name,k.display_name,
              k.website_url,k.machine_id
       FROM workspace_connectors k
       WHERE k.connector_type='registry-mcp' AND k.status<>'disconnected'
         AND k.registry_server_name IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM workspace_apps a WHERE a.connector_id=k.id)
         AND ($1::uuid IS NULL OR k.id=$1::uuid)
       ORDER BY k.created_at`,
      [connectorId ?? null],
    )
  ).rows;
  let created = 0;
  for (const row of rows) {
    const key =
      registryServerAppKey(row.registry_server_name) ??
      appIdentity(row.registry_server_name.split('/').pop() ?? '')?.key;
    if (!key) continue;
    const inserted = await database.query(
      `INSERT INTO workspace_apps(
         id,workspace_id,owner_identity_id,app_key,display_name,domain,transport,route,
         connector_id,machine_id,state
       ) VALUES ($1,$2,$3,$4,$5,$6,'registry-mcp','registry-mcp',$7,$8,'active')
       ON CONFLICT (owner_identity_id,app_key) DO NOTHING`,
      [
        randomUUID(),
        row.workspace_id,
        row.owner_identity_id,
        key,
        row.display_name ?? row.registry_server_name,
        domainOf(row.website_url ?? undefined) ?? registryServerDomain(row.registry_server_name) ?? null,
        row.id,
        row.machine_id,
      ],
    );
    created += inserted.rowCount;
  }
  if (created) console.log(`backfillRegistryApps: created ${created} app row(s)`);
  return created;
}
