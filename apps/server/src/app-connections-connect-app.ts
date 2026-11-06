import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { randomUUID } from 'node:crypto';
import { appIdentity, appResourceTarget, registryServerAppKey, registryServerDomain, type AppTransport, type ConnectAppStatus } from '@beeline/api-contract/workbench';
import type { RegistryMcpManifest } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { McpRegistryClient } from './mcp-registry.js';
import { ComposioApps, composioToolkitForApp, requiresCustomAuth } from './composio-apps.js';
import { notifyConnectorHelper } from './postgres-live.js';
import { ConnectAppParams, ConnectAppOutcome, OFFICIAL_REGISTRY_APPS, hasExistingAppRoute, armRegistryConnector, AppRow, APP_COLUMNS, ComposioPick, WorkbenchBacking, appConnections, resolveAppRoute, nextStep, displayNameFor, deriveStatus, Derived, APP_SIGN_IN_TIMEOUT_MS, failAppSignInCards, APP_SIGN_IN_NEEDS_ATTENTION, AppRouteDecision } from './app-connections.js';



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
  // Only a new connection is eligible for the higher-priority official
  // Registry route. A person's existing app, vault key, or Registry connector
  // is authoritative even when this call is a retry.
  const officialName = OFFICIAL_REGISTRY_APPS[key];
  if (officialName && !params.preferredRoute &&
      !await hasExistingAppRoute(database, params.ownerId, key)) {
    let manifest: RegistryMcpManifest | undefined;
    try {
      const listed = await registryClient.search(key);
      const offered = listed.find((entry) => entry.name === officialName &&
        entry.remotes.some((remote) => remote.type === 'streamable-http') &&
        entry.secretInputNames.length === 0);
      if (offered) manifest = await registryClient.exact(offered.name, offered.version);
    } catch (error) {
      // A slow or down Registry must not block the managed routes below.
      console.warn(`[connect] Registry lookup failed for ${key}; using the managed route`, error);
    }
    if (manifest && manifest.name === officialName &&
        manifest.remotes.some((remote) => remote.type === 'streamable-http') &&
        manifest.secretInputNames.length === 0) {
      const armed = await database.transaction((db) => armRegistryConnector(db, {
        workspaceId: params.workspaceId,
        ownerId: params.ownerId,
        machineId: params.machineId,
        helperAgentId: params.helperAgentId,
        manifest,
        installRoomId: params.installRoomId ?? null,
        installCommandId: params.installCommandId ?? null,
      }));
      if (!armed.versionConflict) {
        await backfillRegistryApps(database, armed.id);
        if (armed.status==='installing') await notifyConnectorHelper(database, armed.id);
      }
    }
  }
  const readExisting = async (db: SqlDatabase) =>
    (
      await db.query<AppRow & {change_id:string}>(
        `SELECT ${APP_COLUMNS},a.xmin::text change_id FROM workspace_apps a
         WHERE a.owner_identity_id=$1 AND a.app_key=$2`,
        [params.ownerId, key],
      )
    ).rows[0];

  let composioMemo: Promise<ComposioPick> | undefined;
  const composioProbe = (): Promise<ComposioPick> =>
    (composioMemo ??= (async () => {
      // Without a configured provider we cannot prove that OAuth is unsupported.
      // Keep the route unresolved rather than silently selecting Squire.
      if (!params.composio) return 'unavailable';
      try {
        const toolkit = composioToolkitForApp(key);
        if (await params.composio.supportsOAuth(toolkit)) return 'supported';
        return requiresCustomAuth(toolkit) ? 'withheld' : 'none';
      } catch {
        return 'unavailable';
      }
    })());
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
        appKey: key,
        reconnect: params.reconnect === true,
        noApi: params.noApi === true,
        ...(params.preferredRoute ? { preferredRoute: params.preferredRoute } : {}),
      },
      { workbench: workbenchProbe(db), composio: composioProbe },
    );

  const existing = await readExisting(database);
  const preview = await resolveWith(database, existing);
  if (preview.kind === 'unavailable')
    return {
      status: 'unavailable',
      app: params.app,
      appKey: key,
      next: nextStep({ status: 'unavailable', app: params.app, appKey: key }, { status: 'error' },
        preview.reason),
    };

  const applied = await database.transaction(async (db) => {
    let decision = preview;
    let row = existing;
    if (decision.kind === 'route') {
      let connectorId: string | null = null;
      if (decision.backing?.transport === 'registry-mcp') connectorId = decision.backing.connectorId;
      const name = displayNameFor(params.app, key);
      const domain = identity.domain ?? null;
      const id = existing?.id ?? randomUUID();
      const changed=await db.query(
        `WITH changed AS (INSERT INTO workspace_apps(
           id,workspace_id,owner_identity_id,app_key,display_name,domain,transport,route,
           connector_id,machine_id,state
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
         ON CONFLICT (owner_identity_id,app_key) DO UPDATE
         SET workspace_id=EXCLUDED.workspace_id,display_name=EXCLUDED.display_name,
             domain=COALESCE(EXCLUDED.domain,workspace_apps.domain),
             transport=EXCLUDED.transport,route=EXCLUDED.route,
             connector_id=EXCLUDED.connector_id,machine_id=EXCLUDED.machine_id,
             composio_account_id=CASE WHEN EXCLUDED.transport='composio' AND workspace_apps.transport='composio'
               THEN workspace_apps.composio_account_id ELSE NULL END,
             composio_link_expires_at=CASE WHEN EXCLUDED.transport='composio' AND workspace_apps.transport='composio'
               THEN workspace_apps.composio_link_expires_at ELSE NULL END,
             sign_in_error=NULL,
             state='active',updated_at=now()
         WHERE workspace_apps.xmin::text=$11
           OR (workspace_apps.transport='squire-api' AND excluded.transport='composio' AND workspace_apps.state='active')
         RETURNING id,route,transport
       ) INSERT INTO workspace_app_routes(id,app_id,route,transport,reason,requested_by)
         SELECT $12::uuid,id,route,transport,$13,$14 FROM changed RETURNING app_id`,
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
          existing?.change_id??null,randomUUID(),decision.reason,params.requestedBy,
        ],
      );
      row = await readExisting(db);
      if (!changed.rowCount && row) decision={kind:'keep',transport:row.transport};
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
        [
          existing.connector_id,
          params.helperAgentId,
          params.installRoomId,
          params.installCommandId,
        ],
      );
    }
    await recordExistingOwnerGitHubSelection(db, row, decision, params);
    return { decision, row };
  });

  if (!applied.row)
    return {
      status: 'unavailable',
      app: params.app,
      appKey: key,
      next: nextStep({ status: 'unavailable', app: params.app, appKey: key }, { status: 'error' }),
    };
  const row = applied.row;
  let authorizationUrl: string | undefined;
  let linkFailed = false;
  if (row.transport === 'composio' && params.composio && params.issueLink !== false) {
    const current = await deriveStatus(database, row, params.composio);
    if (current.status !== 'connected') {
      try {
        authorizationUrl = (await beginComposioAppSignIn(database, params.composio,
          params.ownerId, row.id)).authorizationUrl;
      } catch (error) {
        // Keep this route. A retry can issue another link; never fall through.
        linkFailed = true;
        await database.query(`UPDATE workspace_apps SET sign_in_error=$2,composio_account_id=NULL,composio_link_expires_at=NULL,updated_at=now() WHERE id=$1::uuid`,
          [row.id, error instanceof Error ? error.message : 'App sign-in failed']);
      }
    }
  }
  // Reconnect requests owner setup on the same route. Vault presence alone
  // cannot prove that the existing key has access to the requested resource.
  const derived: Derived = params.reconnect && row.transport === 'squire-api'
    ? { status: 'connecting' }
    : await deriveStatus(database, { ...row,
    ...(authorizationUrl ? { composio_account_id: null,
      composio_link_expires_at: new Date(Date.now() + APP_SIGN_IN_TIMEOUT_MS),
      sign_in_error: null } : {}),
  }, params.composio);
  if (row.transport === 'composio' && derived.status === 'error' &&
    derived.errorMessage && derived.errorMessage !== 'App connection could not be checked. Try again.') {
    try { await failAppSignInCards(database, row.id, derived.errorMessage); }
    catch { /* The agent still receives the connection error. */ }
  }
  const versionNote = undefined;
  const decisionNote = applied.decision.kind === 'keep' ? applied.decision.note : undefined;
  const status: ConnectAppStatus = versionNote || linkFailed
    ? 'error'
    : derived.needsSquire
      ? 'needs_squire'
      : derived.status === 'connected'
        ? 'connected'
        : derived.status === 'error'
          ? row.transport === 'composio' &&
            (derived.errorMessage === APP_SIGN_IN_NEEDS_ATTENTION ||
              params.issueLink === false && params.reconnect)
            ? 'needs_sign_in'
            : 'error'
        : row.transport === 'composio'
          ? 'needs_sign_in'
          : authorizationUrl || derived.signInUrl
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
    ...(status === 'needs_sign_in' && (authorizationUrl || derived.signInUrl)
      ? { authorizationUrl: authorizationUrl ?? derived.signInUrl }
      : {}),
    ...(derived.connectionReference ? { connectionReference: derived.connectionReference } : {}),
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
  input: { readonly ownerId: string; readonly appId: string;
    readonly revokeComposio?: (accountId: string) => Promise<void> },
): Promise<{ helperAgentId?: string }> {
  const observed=(await database.query<{transport:string;composio_account_id:string|null;change_id:string}>(
    'SELECT transport,composio_account_id,xmin::text change_id FROM workspace_apps WHERE id=$1::uuid AND owner_identity_id=$2',
    [input.appId,input.ownerId])).rows[0];
  if(!observed) throw new Error('app not found (access denied)');
  if(observed.transport==='composio' && observed.composio_account_id){
    if(!input.revokeComposio) throw new Error('App connection cannot be revoked now');
    await input.revokeComposio(observed.composio_account_id);
  }
  const row=(await database.query<{helper_agent_id:string|null}>(`
    WITH disconnected AS (
      UPDATE workspace_apps SET state='disconnected',updated_at=now()
      WHERE id=$1::uuid AND owner_identity_id=$2
        AND xmin::text=$3
      RETURNING id,app_key,transport,connector_id,composio_account_id
    ), revoked AS (
      UPDATE agent_grants grant_row SET status='revoked',decided_by=$2,decided_at=now()
      FROM disconnected app WHERE grant_row.kind='mcp'
        AND grant_row.target='${appResourceTarget('')}'||app.app_key
        AND grant_row.status IN ('pending','approved','once')
        AND (grant_row.app_id=app.id OR (grant_row.app_id IS NULL AND EXISTS (
          SELECT 1 FROM agents agent WHERE agent.agent_id=grant_row.agent_id AND agent.owner_id=$2)))
      RETURNING grant_row.id
    ), removed AS (
      DELETE FROM workspace_connections connection USING disconnected app
      WHERE app.transport='registry-mcp' AND connection.connector_id=app.connector_id RETURNING connection.reference
    ), connector AS (
      UPDATE workspace_connectors source SET status='disconnected',status_steps='[]'::jsonb,status_error=NULL,
        pending_ops='[]'::jsonb,connected_at=NULL,updated_at=now()
      FROM disconnected app WHERE app.transport='registry-mcp' AND source.id=app.connector_id
      RETURNING source.helper_agent_id
    ) SELECT (SELECT helper_agent_id FROM connector) helper_agent_id FROM disconnected app`,
    [input.appId,input.ownerId,observed.change_id])).rows[0];
  if(!row) throw new Error('App connection changed while disconnecting');
  return row.helper_agent_id?{helperAgentId:row.helper_agent_id}:{};
}


/** Record an owner's explicit choice to keep the current GitHub connection. */
async function recordExistingOwnerGitHubSelection(
  database: SqlDatabase,
  row: AppRow | undefined,
  decision: AppRouteDecision,
  params: ConnectAppParams,
): Promise<void> {
  if (
    row?.app_key !== 'github' ||
    decision.kind !== 'keep' ||
    params.requestedBy !== params.ownerId
  ) return;
  await database.query(
    `INSERT INTO workspace_app_routes(id,app_id,route,transport,reason,requested_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      randomUUID(),
      row.id,
      row.route,
      row.transport,
      'person selected the existing GitHub connection',
      params.requestedBy,
    ],
  );
}


/** Record a person's selection on the current connection, never a historical lifecycle. */
export async function recordOwnerGitHubSelection(
  database: SqlDatabase,
  appId: string,
  ownerId: string,
  transport: 'composio' | 'registry-mcp',
  connectorId?: string,
): Promise<void> {
  const app = (
    await database.query<{ route: string; transport: string }>(
      `SELECT route,transport FROM workspace_apps
     WHERE id=$1::uuid AND owner_identity_id=$2 AND app_key='github'
       AND state='active' AND transport=$3
       AND ($4::uuid IS NULL OR connector_id=$4::uuid) FOR UPDATE`,
      [appId, ownerId, transport, connectorId ?? null],
    )
  ).rows[0];
  if (!app) return;
  await database.query(
    `INSERT INTO workspace_app_routes(id,app_id,route,transport,reason,requested_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), appId, app.route, app.transport, 'person selected GitHub sign-in', ownerId],
  );
}


/** The phone redeems a verifier session as its authenticated Beeline identity. */
export async function completeComposioSignIn(
  database: SqlDatabase,
  composio: ComposioApps,
  viewerId: string,
  sessionUri: string,
  appId: string,
  settle?: (database: SqlDatabase, appId: string) => Promise<void>,
): Promise<{ appId: string }> {
  const pending = (await database.query<{ id: string; app_key: string; composio_account_id: string }>(
    `SELECT id,app_key,composio_account_id FROM workspace_apps
     WHERE id=$1::uuid AND owner_identity_id=$2 AND transport='composio'
       AND state='active' AND composio_link_expires_at>now()`, [appId, viewerId],
  )).rows[0];
  if (!pending) throw new Error('App sign-in is no longer pending for this person');
  let completed: { accountId: string; toolkit: string };
  try {
    completed = await composio.completeAuth(sessionUri, viewerId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : systemMessage("app-connections.app-sign-in-failed");
    await database.query(
      `UPDATE workspace_apps SET sign_in_error=$3,composio_link_expires_at=NULL,updated_at=now()
       WHERE id=$1::uuid AND owner_identity_id=$2 AND transport='composio'
         AND state='active' AND composio_account_id=$4 AND composio_link_expires_at>now()`,
      [appId, viewerId, reason, pending.composio_account_id],
    );
    await failAppSignInCards(database, appId, reason);
    throw error;
  }
  const result = await database.transaction(async (db) => {
    const current = (await db.query<{ id: string; app_key: string }>(
      `SELECT id,app_key FROM workspace_apps WHERE id=$1::uuid AND owner_identity_id=$2
         AND composio_account_id=$3 AND transport='composio' AND state='active'
         AND composio_link_expires_at>now() FOR UPDATE`,
      [appId, viewerId, completed.accountId],
    )).rows[0];
    if (!current || composioToolkitForApp(current.app_key) !== completed.toolkit)
      throw new Error('App sign-in is no longer pending for this person');
    let verified: Awaited<ReturnType<ComposioApps['accountStatus']>>;
    try { verified = await composio.accountStatus(completed.accountId, viewerId, completed.toolkit); }
    catch (error) {
      const reason = error instanceof Error ? error.message : systemMessage("app-connections.app-sign-in-failed");
      await db.query(`UPDATE workspace_apps SET sign_in_error=$2,composio_link_expires_at=NULL,updated_at=now() WHERE id=$1::uuid`,
        [pending.id, reason]);
      await failAppSignInCards(db, pending.id, reason);
      return { error };
    }
    if (verified.status !== 'active') {
      const error = new Error(verified.reason ?? 'App sign-in could not be verified. Sign in again.');
      await db.query(`UPDATE workspace_apps SET sign_in_error=$2,composio_link_expires_at=NULL,updated_at=now() WHERE id=$1::uuid`,
        [pending.id, error.message]);
      await failAppSignInCards(db, pending.id, error.message);
      return { error };
    }
    const updated = await db.query(
      `UPDATE workspace_apps SET composio_link_expires_at=NULL,sign_in_error=NULL,authorised_at=COALESCE(authorised_at,now()),updated_at=now()
       WHERE id=$1::uuid AND owner_identity_id=$2 AND composio_account_id=$3
         AND composio_link_expires_at>now()`,
      [pending.id, viewerId, completed.accountId],
    );
    if (!updated.rowCount) throw new Error('App sign-in is no longer pending for this person');
    await recordOwnerGitHubSelection(db, pending.id, viewerId, 'composio');
    await settle?.(db, pending.id);
    return { appId: pending.id };
  });
  if ('error' in result) throw result.error;
  return result;
}


/** A card tap issues a fresh link; the link itself is never persisted in Room history. */
export async function beginComposioAppSignIn(
  database: SqlDatabase,
  composio: ComposioApps,
  ownerId: string,
  appId: string,
): Promise<{ authorizationUrl: string }> {
  const result = await database.transaction(async (db) => {
    const row = (
      await db.query<AppRow>(
        `SELECT ${APP_COLUMNS} FROM workspace_apps a
         WHERE a.id=$1::uuid AND a.owner_identity_id=$2
           AND a.state='active' FOR UPDATE`, [appId, ownerId],
      )
    ).rows[0];
    if (!row) throw new Error('This app connection is no longer in your Connectors. Return to Connectors and connect it again.');
    if (row.transport !== 'composio') throw new Error(row.transport === 'registry-mcp'
      ? 'This app connects through your helper. Reconnect it from Connectors.'
      : 'This app connects through Trusty Squire. Reconnect it from Connectors.');
    const toolkit = composioToolkitForApp(row.app_key);
    if (row.composio_account_id) {
      if (!row.composio_link_expires_at &&
        await composio.account(row.composio_account_id, ownerId, toolkit))
        throw new Error('App is already connected');
      await composio.deleteAccount(row.composio_account_id);
    }
    let link;
    try { link = await composio.link(ownerId, toolkit); }
    catch (error) {
      const reason = error instanceof Error ? error.message : systemMessage("app-connections.app-sign-in-failed");
      await db.query(`UPDATE workspace_apps SET sign_in_error=$2,composio_account_id=NULL,composio_link_expires_at=NULL,updated_at=now() WHERE id=$1::uuid`,
        [row.id, reason]);
      await failAppSignInCards(db, row.id, reason);
      return { error };
    }
    await db.query(
      `UPDATE workspace_apps SET composio_account_id=$3,composio_link_expires_at=$4,sign_in_error=NULL,updated_at=now()
       WHERE id=$1::uuid AND owner_identity_id=$2`,
      [appId, ownerId, link.accountId,
        new Date(Math.min(link.expiresAt.getTime(), Date.now() + APP_SIGN_IN_TIMEOUT_MS))],
    );
    await db.query(
      `UPDATE messages SET card=(card-'errorMessage')||'{"status":"pending"}'::jsonb
       WHERE card_type='app-sign-in' AND card->>'appId'=$1 AND card->>'status'='failed'`,
      [appId],
    );
    return { authorizationUrl: link.url };
  });
  if ('error' in result) throw result.error;
  return result;
}


type AppGate =
  | { readonly kind: 'resource'; readonly target: string }
  | { readonly kind: 'app'; readonly target: string; readonly appId: string; readonly transport: AppTransport }
  | { readonly kind: 'refuse' };


/**
 * The app a per-call resource authorization belongs to. A Registry route
 * resolves to `app:<key>`, so it answers to that app's one permission
 * decision; a route for a disconnected app is refused outright. A Squire call
 * answers to Squire's own gate whatever apps it names: it only reaches the
 * owner's own vault.
 */
export async function appGateFor(
  database: SqlDatabase,
  input: {
    readonly roomId: string;
    readonly agentId: string;
    readonly target: string;
  },
): Promise<AppGate> {
  if (!input.target.startsWith('registry-mcp:')) return { kind: 'resource', target: input.target };
  const registryName = input.target.slice('registry-mcp:'.length);
  const keys = [
    registryServerAppKey(registryName) ?? appIdentity(registryName.split('/').pop() ?? '')?.key,
  ].filter((key): key is string => Boolean(key));
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
      [input.agentId, registryName, keys],
    )
  ).rows;
  if (!rows.length) {
    // A name that resolves only to another person's connected app is not an
    // owner-machine resource of this helper. Its credentials are never mounted
    // here, so a grant cannot turn this helper into that person's connection.
    const foreign = await database.query(
      `SELECT 1 FROM workspace_apps app
       LEFT JOIN workspace_connectors k ON k.id=app.connector_id
       WHERE app.owner_identity_id<>(SELECT owner_id FROM agents WHERE agent_id=$1)
         AND app.state='active'
         AND (($2::text IS NOT NULL AND app.transport='registry-mcp' AND k.registry_server_name=$2)
           OR app.app_key=ANY($3::text[]))
       LIMIT 1`,
      [input.agentId, registryName, keys],
    );
    if (foreign.rowCount) return { kind: 'refuse' };
    return { kind: 'resource', target: input.target };
  }
  // A call that names a disconnected app is refused, whatever else it names:
  // an active sibling's approval never covers it.
  if (rows.some((row) => row.state !== 'active')) return { kind: 'refuse' };
  // One call, one app: a call naming two connected apps has no single
  // decision or ledger to answer to, so it is refused rather than charged to
  // whichever sorts first.
  const apps = new Map(rows.map((row) => [row.id, row]));
  if (apps.size !== 1) return { kind: 'refuse' };
  const row = rows[0]!;
  // Managed OAuth is never mounted in Squire or a helper MCP route. Only the
  // server's executeAppTool operation can reach that connected account.
  if (row.transport === 'composio') return { kind: 'refuse' };
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
        registryServerDomain(row.registry_server_name) ?? null,
        row.id,
        row.machine_id,
      ],
    );
    created += inserted.rowCount;
  }
  if (created) console.log(`backfillRegistryApps: created ${created} app row(s)`);
  return created;
}
