import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { YouTubeUploadRefusal } from '../composio-apps.js';
import { consumeStarterVideoPost, restoreStarterVideoPost } from '../starter-onboarding.js';
import { ExpectedRefusalError } from '../command-refusal.js';
import { CommandRefusalError } from '../commander.js';
import { firstPartyIntegration } from '../first-party-integrations.js';
import { waitForConnection } from '../connection-wait.js';
import { machineSquireReport, queueSquireWork, squireMachineAddress, squireWorkStatus, recordSquireSignIn, forgetSquireSignIn, squireSignedIn } from '../squire-machine.js';
import { createHash, randomUUID } from 'node:crypto';
import { type SqlDatabase } from '../database.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
import { systemLine } from '../system-line.js';
import { APP_INPUT_MAX_LENGTH, builtinBeelineApp, appIdentity, appResourceTarget } from '@beeline/api-contract/workbench';
import { normalizeAppContinuation, registrableDomain, urlBelongsToApp, type AppTransport } from '@beeline/api-contract/app-connections';
import { isAppRegistryPublisher } from '../mcp-registry-policy.js';
import { connectApp, connectedAppUse, appConnections, hasExistingAppRoute, recordAppUsage } from '../app-connections.js';
import { composioToolkitForApp, resolveAppFiles } from '../composio-apps.js';
import { connectorDisplayName } from '../workbench.js';
import type { ConnectorStatus } from '@beeline/api-contract/workbench';
import { delegationView } from '../wallet.js';
import { notifyConnectorAssignment } from '../postgres-live.js';
import type { DaemonContext } from './context.js';
import { Input, Output, id } from './values.js';
import { daemonAccess } from './access.js';
import { daemonOfferContext, daemonAppCardMark } from './workbench.js';
import { daemonOfferConnector, daemonConnectMcpServer } from './connector-offers.js';
import { daemonRequestAgentGrant, daemonGrantRequester, daemonConsumeAgentGrant } from './grants.js';



  export async function daemonConnectService(ctx: DaemonContext, input: Input<'connect'>, agentId: string): Promise<Output<'connect'>> {
    const service = typeof input.service === 'string' ? input.service.trim() : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!service || service.length > APP_INPUT_MAX_LENGTH || !reason || reason.length > 500)
      throw new Error('service and reason are required');
    const builtin = builtinBeelineApp(service, `${reason} ${input.continuation ?? ''}`);
    if (builtin) {
      await daemonAccess(ctx, input.roomId, agentId);
      return { status: 'ready', app: builtin, next: `Use app_tool(app:${builtin}) to discover its tools. Existing tool permissions still apply.` };
    }
    const continuation = normalizeAppContinuation(input.continuation);
    const context = await daemonOfferContext(ctx, input.roomId, agentId);
    const commandId = ctx.authorizedCommand?.id;
    const assistant = service.toLowerCase().replace(/[-_\s]+/g, ' ');
    if (['grok', 'xai', 'x ai', 'grok bot', 'muse', 'meta muse', 'meta ai',
      'chatgpt', 'openai chatgpt', 'claude', 'cursor', 'mcp', 'beeline connector'].includes(assistant))
      return { status: 'ready', app: 'Beeline Rooms',
        next: 'In your AI assistant, add a custom connector with URL https://join.usebeeline.app, sign in with your Beeline account, tap Allow, then add the new member to a Room via its Members sheet > +. If the assistant has no custom-connector option yet, it cannot connect yet; the Muse directory listing is still pending.' };
    // Remove an entry when its provider approves Beeline sign-in.
    const pendingProviderApproval = new Set(['tiktok']);
    if (pendingProviderApproval.has(appIdentity(service)?.key ?? assistant))
      return { status: 'unavailable', app: service,
        next: 'TikTok sign-in is waiting on TikTok’s approval of Beeline. There is no working sign-in card yet.' };
    const postCard = async (database: SqlDatabase, card: {
      appId: string; appKey: string; name: string; connectorId?: string;
      connectKind?: string; resumeOnConnect?: boolean;
    }) => {
      await database.transaction(async database => {
        await database.query('SELECT pg_advisory_xact_lock(hashtext($1))',
          [`app-sign-in:${input.roomId}:${card.appId}:${context.owner.pubkey}`]);
        const existing = await database.query(`SELECT 1 FROM messages WHERE room_id=$1
          AND card_type='app-sign-in' AND card->>'appId'=$2 AND card->>'ownerId'=$3
          AND card->>'status'='pending'`, [input.roomId, card.appId, context.owner.pubkey]);
        if (existing.rowCount) return;
        await systemLine(database, { roomId: input.roomId,
          subject: { kind: 'agent', id: agentId, name: context.agent.name },
          verb: systemMessage("daemon-service.needs-a-connection-to"), object: card.name, consequence: systemMessage("daemon-service.sign-in-to-continue-the-request"),
          presentation: 'card', cardType: 'app-sign-in', card: { ...card,
            ownerId: context.owner.pubkey, agentId, commandId, status: 'pending',
            ...(continuation ? { continuation } : {}) } });
      });
      ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'app-sign-in', agentId });
    };
    const afterCommit = async (result: Output<'connect'>,
      finish: (database: SqlDatabase) => Promise<void>) => {
      if (ctx.afterCommit) ctx.afterCommit(finish);
      else await finish(ctx.database);
      return result;
    };
    const machine = async (kind: 'trusty-squire' | 'tailscale', dependent = false): Promise<Output<'connect'>> => {
      const name = connectorDisplayName(kind);
      let connectorId: string;
      if (kind === 'trusty-squire') {
        connectorId = squireMachineAddress(context.machine.machineId);
        const status = await squireWorkStatus(ctx.database, agentId);
        if (status.status === 'connected' && !input.reconnect && !input.switchGoogleAccount)
          return { status: 'ready', app: name, connectorId, next: `${name} is ready.` };
        if (status.status !== 'connected') {
          const offer = await daemonOfferConnector(ctx, { roomId: input.roomId,
            connectorType: 'trusty-squire', reason }, agentId, true);
          if (commandId && !offer.joined) await ctx.database.query(
            'UPDATE connector_offers SET command_id=$2 WHERE id=$1', [offer.offerId, commandId]);
          return { status: 'needs_approval', app: name, connectorId,
            next: 'The Trusty Squire connector card is ready. Tap it to install Squire on your agent’s machine, including its hosted machine; complete any sign-in on your phone, then this request resumes.' };
        }
        await ctx.database.transaction(database => queueSquireWork(database, agentId,
          { install: true, ...(input.switchGoogleAccount ? { forceReloginProvider: 'google' } : {}) }));
      } else {
        const existing = (await ctx.database.query<{ id: string; status: string }>(
          `SELECT id,status FROM workspace_connectors WHERE owner_identity_id=$1
            AND connector_type='tailscale' AND machine_id=$2 ORDER BY updated_at DESC LIMIT 1`,
          [context.owner.pubkey, context.machine.machineId])).rows[0];
        if (existing?.status === 'connected' && !input.reconnect)
          return { status: 'ready', app: name, connectorId: existing.id, next: `${name} is ready.` };
        connectorId = existing?.id ?? randomUUID();
        if (existing) await ctx.database.query(`UPDATE workspace_connectors SET status='installing',
          sign_in=NULL,status_error=NULL,helper_agent_id=$2,pairing_generation=pairing_generation+1,
          updated_at=now() WHERE id=$1`, [connectorId, agentId]);
        else await ctx.database.query(`INSERT INTO workspace_connectors
          (id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,status)
          VALUES($1,$2,$3,'tailscale',$4,$5,'installing')`,
          [connectorId, context.workspaceId, context.owner.pubkey, agentId, context.machine.machineId]);
        await notifyConnectorAssignment(ctx.database, agentId);
      }
      const result: Output<'connect'> = { status: 'unavailable', app: name, connectorId,
        next: 'The server is connecting this tool. Its completion will resume the request.' };
      return afterCommit(result, async database => {
        const status = await waitForConnection(async () => {
          const value = kind === 'trusty-squire' ? await squireWorkStatus(database, agentId)
            : (await database.query<{ status: string; sign_in: ConnectorStatus['signIn']; status_error: string | null }>(
              'SELECT status,sign_in,status_error FROM workspace_connectors WHERE id=$1', [connectorId])).rows[0];
          if (!value) return undefined;
          const signIn = 'sign_in' in value ? value.sign_in : value.signIn;
          if (value.status === 'connected' || value.status === 'error' || signIn?.url)
            return { status: value.status, signIn };
          return undefined;
        }, kind === 'trusty-squire'
          ? { principal: 'connector', operation: 'machine', commandId: `${context.owner.pubkey}:${context.machine.machineId}` }
          : { principal: 'connector', operation: 'status', commandId: connectorId });
        if (!status) return;
        if (status.status === 'connected') { Object.assign(result, { status: 'ready', next: `${name} is ready.` }); return; }
        if (!status.signIn?.url) { Object.assign(result, { status: 'error', next: `${name} could not connect. Reconnect to retry.` }); return; }
        const digest = createHash('sha256').update(`${context.owner.pubkey}:${connectorId}`).digest('hex');
        const appId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        await postCard(database, { appId, appKey: `machine:${kind}:${context.machine.machineId}`,
          name, connectorId, connectKind: kind, resumeOnConnect: !dependent });
        Object.assign(result, { status: 'needs_sign_in', appId, next: `The ${name} sign-in card is ready. Wait for the owner.` });
      });
    };
    const normalized = service.toLowerCase();
    if (['squire', 'trusty-squire', 'trusty squire'].includes(normalized)) return machine('trusty-squire');
    if (normalized === 'tailscale') return machine('tailscale');
    if (normalized === 'wallet') {
      if ((await delegationView(ctx.database, context.owner.pubkey)).active)
        return { status: 'ready', app: 'Wallet', next: 'Wallet is ready.' };
      const offer = await daemonOfferConnector(ctx, { roomId: input.roomId, connectorType: 'wallet', reason }, agentId, true);
      if (commandId) await ctx.database.query('UPDATE connector_offers SET command_id=$2 WHERE id=$1', [offer.offerId, commandId]);
      return { status: 'needs_approval', app: 'Wallet', next: 'Wait for the owner to approve connecting their wallet.' };
    }
    if (input.switchGoogleAccount) throw new Error('switchGoogleAccount applies only to Trusty Squire');
    let outcome: Output<'connectApp'>;
    if (!firstPartyIntegration(service)) {
      const key = appIdentity(service)?.key;
      const existing = key && await hasExistingAppRoute(ctx.database, context.owner.pubkey, key);
      if (!existing) {
        // The public Registry is only a route preference; when it is slow or down, the managed route still serves the app.
        let manifests;
        try { manifests = await ctx.mcpRegistry.search(service); }
        catch (error) {
          console.warn(`[connect] Registry search failed for ${service}; using the managed route`, error);
          manifests = [];
        }
        const match = manifests.find(entry => entry.name.toLowerCase() === normalized
          || entry.title?.toLowerCase() === normalized || entry.websiteUrl && appIdentity(entry.websiteUrl)?.key === key);
        // Relevance is not authority: a candidate must also have the app's official publisher.
        if (match && isAppRegistryPublisher(match.name, service)) {
          const installed = await daemonConnectMcpServer(ctx, { ...input, serverName: match.name,
            version: match.version, reason }, agentId);
          if (installed.status === 'unsupported') return { status: 'unavailable', app: service, next: installed.reason };
          const app = (await ctx.database.query<{ id: string; app_key: string }>(
            'SELECT id,app_key FROM workspace_apps WHERE connector_id=$1 AND owner_identity_id=$2',
            [installed.connectorId, context.owner.pubkey])).rows[0];
          outcome = { status: installed.status, app: service, transport: 'registry-mcp',
            connectorId: installed.connectorId, appId: app?.id, appKey: app?.app_key, next: 'The server is connecting the Registry tool.' };
        } else outcome = await daemonConnectAppFrontDoor(ctx, { ...input, app: service }, agentId);
      } else outcome = await daemonConnectAppFrontDoor(ctx, { ...input, app: service }, agentId);
    } else outcome = await daemonConnectAppFrontDoor(ctx, { ...input, app: service }, agentId);
    const result: Output<'connect'> = { ...outcome, status: outcome.status === 'connected' ? 'ready'
      : outcome.status === 'needs_sign_in' ? 'needs_sign_in' : outcome.status === 'unavailable' ? 'unavailable' : 'error',
      next: outcome.status === 'connected' ? outcome.next
        : outcome.status === 'unavailable' || outcome.status === 'error' || outcome.transport === 'composio' || firstPartyIntegration(service) ? outcome.next
        : 'The server is connecting this app. Its completion will resume the request.' };
    delete (result as { authorizationUrl?: string }).authorizationUrl;
    if (result.status === 'ready' || firstPartyIntegration(service) || outcome.transport === 'composio') return result;
    if (outcome.transport === 'registry-mcp' && outcome.connectorId && outcome.appId && outcome.appKey) {
      return afterCommit(result, async database => {
        const connector = await waitForConnection(async () => {
          const row = (await database.query<{ status: string; sign_in: ConnectorStatus['signIn'] }>(
            'SELECT status,sign_in FROM workspace_connectors WHERE id=$1', [outcome.connectorId])).rows[0];
          return row && (row.status === 'connected' || row.status === 'error' || row.sign_in?.url) ? row : undefined;
        }, { principal: 'connector', operation: 'status', commandId: outcome.connectorId! });
        if (!connector) return;
        if (connector.status === 'connected') { Object.assign(result, { status: 'ready', next: `${outcome.app} is ready.` }); return; }
        if (!connector.sign_in?.url) { Object.assign(result, { status: 'error', next: 'The Registry tool could not connect. Reconnect to retry.' }); return; }
        await postCard(database, { appId: outcome.appId!, appKey: outcome.appKey!, name: outcome.app,
          connectorId: outcome.connectorId, connectKind: 'registry-mcp' });
        Object.assign(result, { status: 'needs_sign_in', next: 'The sign-in card is ready. Wait for the owner.' });
      });
    }
    if (outcome.transport !== 'squire-api' && outcome.transport !== 'squire-browser') return result;
    if ((await machineSquireReport(ctx.database, context.owner.pubkey, context.machine.machineId))?.status !== 'connected') {
      const offer = await daemonOfferConnector(ctx, { roomId: input.roomId,
        connectorType: 'trusty-squire', reason }, agentId, true);
      if (commandId && !offer.joined) await ctx.database.query('UPDATE connector_offers SET command_id=$2 WHERE id=$1', [offer.offerId, commandId]);
      return { ...result, status: 'needs_approval',
        next: 'The Trusty Squire connector card is ready. Tap it to install Squire on your agent’s machine, including its hosted machine; complete any sign-in on your phone, then this request resumes.' };
    }
    if (!outcome.appId || !outcome.appKey || !commandId) return result;
    if (input.squireAvailable !== true)
      return { ...result, status: 'unavailable',
        next: 'Trusty Squire is unavailable in this agent session. Connect Trusty Squire on this machine and start a session with its tools mounted.' };
    if (outcome.transport === 'squire-browser') {
      // A session signed in through OAuth or SSO has no login to save in the vault.
      const signedInUrl = typeof input.signedInUrl === 'string' ? input.signedInUrl : '';
      const signedInDomain = input.squireSignedIn === true && urlBelongsToApp(signedInUrl, outcome.appKey)
        ? registrableDomain(new URL(signedInUrl).hostname) : undefined;
      if (signedInDomain) await recordSquireSignIn(ctx.database, agentId, outcome.appKey, signedInDomain);
      else if (input.reconnect) await forgetSquireSignIn(ctx.database, agentId, { appKey: outcome.appKey });
      if (await squireSignedIn(ctx.database, agentId, outcome.appKey))
        return { ...result, status: 'ready',
          next: `${outcome.app} is ready: your Squire session is signed in. Use your own operate_* tools on it.` };
    }
    const target = `connection-install:${outcome.appKey}`;
    const appOwner = (await ctx.database.query<{ owner_identity_id: string }>(
      'SELECT owner_identity_id FROM workspace_apps WHERE id=$1', [outcome.appId])).rows[0];
    const ownAccount = appOwner?.owner_identity_id === context.owner.pubkey;
    let consent = (await ctx.database.query<{ id: string; status: string }>(
      `SELECT grant_row.id,grant_row.status FROM agent_grants grant_row JOIN agents agent ON agent.agent_id=grant_row.agent_id
        LEFT JOIN workspace_apps consent_app ON consent_app.id=grant_row.app_id
        WHERE agent.owner_id=$1 AND grant_row.kind='mcp' AND grant_row.target=$2
          AND (NOT grant_row.auto OR $3::boolean)
          AND COALESCE(consent_app.owner_identity_id,agent.owner_id)=$4
          AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now())
        ORDER BY grant_row.created_at DESC LIMIT 1`,
      [context.owner.pubkey, target, ownAccount, appOwner?.owner_identity_id ?? context.owner.pubkey])).rows[0];
    if (ownAccount && consent?.status !== 'approved') {
      const approved = await daemonRequestAgentGrant(ctx, { ...input, kind: 'mcp', target, appId: outcome.appId,
        purpose: `Connect ${outcome.app} through Trusty Squire for this request`,
        reason: `Connect ${outcome.app} through Trusty Squire for this request` }, agentId);
      await ctx.database.query('UPDATE agent_grants SET command_id=$2 WHERE id=$1', [approved.grantId, commandId]);
      consent = { id: approved.grantId, status: approved.status };
    }
    if (!consent || consent.status === 'revoked') {
      const asked = await daemonRequestAgentGrant(ctx, { ...input, kind: 'mcp', target, appId: outcome.appId,
        purpose: `Connect ${outcome.app} through Trusty Squire for this request`,
        reason: `Connect ${outcome.app} through Trusty Squire for this request` }, agentId, true);
      await ctx.database.query('UPDATE agent_grants SET command_id=$2 WHERE id=$1', [asked.grantId, commandId]);
      return { ...result, status: 'needs_approval', grantId: asked.grantId,
        next: 'Wait for the owner’s connection approval.' };
    }
    if (consent.status !== 'approved' && consent.status !== 'once')
      return { ...result, status: consent.status === 'pending' ? 'needs_approval' : 'unavailable',
        grantId: consent.id, next: consent.status === 'pending'
          ? 'Wait for the owner’s connection approval.' : 'The owner declined this connection.' };
    if (consent.status === 'once') {
      const consumed = await ctx.database.query(`UPDATE agent_grants SET expires_at=now()
        WHERE id=$1 AND status='once' AND (expires_at IS NULL OR expires_at>now()) RETURNING id`, [consent.id]);
      if (!consumed.rowCount) throw new Error('Connection consent was already used');
    }
    const domain = appIdentity(service)?.domain;
    const url = domain ? `https://${domain}`
      : `https://www.google.com/search?${new URLSearchParams({ q: `${service} official website` })}`;
    const goal = outcome.transport === 'squire-browser'
      ? `Sign in to ${outcome.app} with the owner's saved account and save its login in the vault as service ${outcome.appKey}.`
      : input.reconnect
        ? `Repair the existing ${outcome.app} connection using the owner's account. Reauthorize or replace its existing API credential in the vault as service ${outcome.appKey}; do not select an alternative credential or another person's account. Never reveal a secret in the response.`
        : `Sign up or sign in to ${outcome.app} using the owner's account. Create an API key and capture it securely into the vault as service ${outcome.appKey}. Never reveal a secret in the response.`;
    return { ...result, status: 'needs_squire', squire: { url, goal },
      next: 'Use your own Squire operate_drive with the returned URL and goal. On low_confidence or needs_value, take a flat operate_* step, then resume operate_drive on the same session. Keep saved-login approval in Squire. Once a credential for this service is in the vault, call connect again.'
        + (outcome.transport === 'squire-browser' ? ' If your Squire session is already signed in, for example through Google, call connect again with signedInUrl set to a page only a signed-in user can open.' : '') };
  }


  /** Shared app routing for connect and its hidden one-release alias. */
  export async function daemonConnectAppFrontDoor(ctx: DaemonContext,
    input: Input<'connectApp'>,
    agentId: string,
  ): Promise<Output<'connectApp'>> {
    const app = typeof input.app === 'string' ? input.app.trim() : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
    if (!app || app.length > APP_INPUT_MAX_LENGTH || !reason || reason.length > 500)
      throw new Error('app and reason are required');
    const continuation = normalizeAppContinuation(input.continuation);
    const context = await daemonOfferContext(ctx, input.roomId, agentId);
    const firstParty = firstPartyIntegration(app);
    if (firstParty) {
      const provider = firstParty.provider({ linkWallet: ctx.linkWallet });
      if (!provider) return { status: 'unavailable', app: firstParty.name,
        appKey: firstParty.key, next: `${firstParty.name} sign-in is unavailable. Try again after its server configuration is restored.` };
      const account = await provider.status(context.owner.pubkey, ctx.database);
      if (account.connected && !input.reconnect) return { status: 'connected', app: firstParty.name,
        appKey: firstParty.key, next: `${firstParty.name} is ready.` };
      await ctx.database.transaction(async database => {
        await database.query('SELECT pg_advisory_xact_lock(hashtext($1))',
          [`app-sign-in:${input.roomId}:${firstParty.appId}:${context.owner.pubkey}`]);
        const exists = await database.query(`SELECT 1 FROM messages WHERE room_id=$1
          AND card_type='app-sign-in' AND card->>'appKey'=$2 AND card->>'ownerId'=$3
          AND card->>'status'='pending' LIMIT 1`, [input.roomId, firstParty.key, context.owner.pubkey]);
        if (exists.rowCount) return;
        await systemLine(database, { roomId: input.roomId,
          subject: { kind: 'agent', id: agentId, name: context.agent.name },
          verb: systemMessage("daemon-service.needs-a-connection-to"), object: firstParty.name,
          consequence: systemMessage("daemon-service.sign-in-to-continue-the-request"), presentation: 'card', cardType: 'app-sign-in',
          card: { appId: firstParty.appId, appKey: firstParty.key, name: firstParty.name,
            ownerId: context.owner.pubkey, agentId, status: 'pending',
            commandId: ctx.authorizedCommand?.id ?? null, ...(continuation ? { continuation } : {}) } });
        await database.query(`UPDATE workspace_apps SET state='disconnected',updated_at=now()
          WHERE owner_identity_id=$1 AND app_key='stripelinklinkcom'
          AND transport='squire-api' AND state='active'
          AND NOT EXISTS (SELECT 1 FROM workspace_connections WHERE owner_identity_id=$1
            AND service='stripelinklinkcom' AND state='active')`, [context.owner.pubkey]);
      });
      ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'app-sign-in', agentId });
      return { status: 'needs_sign_in', app: firstParty.name, appKey: firstParty.key,
        appId: firstParty.appId, next: `The ${firstParty.name} sign-in card is ready. Wait for the owner to sign in.` };
    }
    const outcome = await connectApp(ctx.database, ctx.mcpRegistry, {
      workspaceId: context.workspaceId,
      ownerId: context.owner.pubkey,
      machineId: context.machine.machineId,
      helperAgentId: agentId,
      requestedBy: agentId,
      app,
      reconnect: input.reconnect === true,
      noApi: input.noApi === true,
      installRoomId: input.roomId,
      installCommandId: ctx.authorizedCommand?.id ?? null,
      ...(ctx.composio ? { composio: ctx.composio } : {}),
      issueLink: false,
    });
    if (outcome.transport === 'composio' && outcome.status === 'needs_sign_in' &&
      outcome.appId && outcome.appKey) {
      const mark = await daemonAppCardMark(ctx, outcome.appKey, outcome.domain);
      await ctx.database.transaction(async (database) => {
        await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,
          [`app-sign-in:${input.roomId}:${outcome.appId}`]);
        const exists = await database.query(
          `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='app-sign-in'
           AND card->>'appId'=$2 AND card->>'status'='pending' LIMIT 1`,
          [input.roomId, outcome.appId],
        );
        if (exists.rowCount) return;
        await systemLine(database, {
          roomId: input.roomId,
          subject: { kind: 'agent', id: agentId, name: context.agent.name },
          verb: systemMessage("daemon-service.needs-a-connection-to"), object: outcome.name ?? app,
          consequence: systemMessage("daemon-service.sign-in-to-continue-the-request"),
          presentation: 'card', cardType: 'app-sign-in',
          card: { appId: outcome.appId, appKey: outcome.appKey,
            name: outcome.name ?? app, ...mark, ownerId: context.owner.pubkey,
            agentId, status: 'pending', commandId: ctx.authorizedCommand?.id ?? null,
            ...(continuation ? { continuation } : {}) },
        });
      });
      ctx.live.publish({ type: 'invalidate', roomId: input.roomId,
        reason: 'app-sign-in', agentId });
    }
    return {
      status: outcome.status,
      app: outcome.name ?? outcome.app,
      next: outcome.next,
      ...(outcome.appId ? { appId: outcome.appId } : {}),
      ...(outcome.appKey ? { appKey: outcome.appKey } : {}),
      ...(outcome.route ? { route: outcome.route } : {}),
      ...(outcome.transport ? { transport: outcome.transport } : {}),
      ...(outcome.connectorId ? { connectorId: outcome.connectorId } : {}),
      ...(outcome.connectionReference ? { connectionReference: outcome.connectionReference } : {}),
      ...(outcome.authorizationUrl && outcome.transport !== 'composio'
        ? { authorizationUrl: outcome.authorizationUrl } : {}),
    };
  }


  export async function daemonConnectedAppForTool(ctx: DaemonContext, appId: string, roomId: string, agentId: string, discovery = false) {
    if (typeof appId !== 'string' || !appId.trim())
      throw new CommandRefusalError('App id or key is required', 400);
    const selector = appId.trim();
    const isId = /^[0-9a-f-]{36}$/i.test(selector);
    const candidates = (await ctx.database.query<{ id: string; app_key: string;
      display_name: string; domain: string | null; transport: AppTransport;
      owner_identity_id: string; composio_account_id: string | null;
      composio_link_expires_at: Date | null;
      agent_owner_id: string }>(
      `SELECT app.id,app.app_key,app.display_name,app.domain,app.transport,
              app.owner_identity_id,app.composio_account_id,
              app.composio_link_expires_at,
              agent.owner_id agent_owner_id
       FROM workspace_apps app JOIN agents agent ON agent.agent_id=$3
       JOIN rooms room ON room.id=$2
       LEFT JOIN memberships owner_member ON owner_member.workspace_id=room.workspace_id
         AND owner_member.room_id IS NULL AND owner_member.identity_id=app.owner_identity_id
         AND owner_member.removed_at IS NULL
       WHERE ${isId ? 'app.id=$1::uuid' : 'app.app_key=$1'}
         AND (app.owner_identity_id=agent.owner_id OR owner_member.identity_id IS NOT NULL)
         AND app.state='active'
       ORDER BY app.id`,
      [isId ? selector : selector.replace(/^app:/, ''), roomId, agentId],
    )).rows;
    // connect status advertises the agent owner's active apps, across Workspaces.
    // Resolve those keys before considering apps shared by other Room members.
    const owned = candidates.filter(row => row.owner_identity_id === row.agent_owner_id);
    const rows = !isId && owned.length ? owned : candidates;
    if (rows.length > 1)
      throw new CommandRefusalError(`Connected app key is ambiguous; use an exact app id: ${rows.map(row => row.id).join(', ')}`, 400);
    const row = rows[0];
    if (!row) throw new ExpectedRefusalError('Connected app is unavailable in this Room');
    if (row.transport !== 'composio') {
      // Only managed-OAuth apps run through app tools; name the route that serves this one.
      if (row.owner_identity_id !== row.agent_owner_id)
        throw new CommandRefusalError(`${row.display_name} is another person's ${row.transport} app; only their own agents can use it.`, 403);
      if (discovery) return row;
      const connections = row.transport === 'squire-api'
        ? await appConnections(ctx.database, row.owner_identity_id, row.app_key) : [];
      const reference = connections.find(connection => connection.state === 'active')?.reference;
      throw new CommandRefusalError(`${row.display_name} is connected through ${row.transport}, not app tools. ${
        connectedAppUse({ transport: row.transport, name: row.display_name,
          appKey: row.app_key, domain: row.domain ?? row.display_name,
          connectionReference: reference })}`, 400);
    }
    return row;
  }


  export async function daemonListAppTools(ctx: DaemonContext, input: Input<'listAppTools'>, agentId: string) {
    const row = await daemonConnectedAppForTool(ctx, input.appId, input.roomId, agentId, true);
    if (row.transport !== 'composio') {
      const connections = row.transport === 'squire-api'
        ? await appConnections(ctx.database, row.owner_identity_id, row.app_key) : [];
      return { tools: [], transport: row.transport,
        next: connectedAppUse({ transport: row.transport, name: row.display_name,
          appKey: row.app_key, domain: row.domain ?? row.display_name,
          connectionReference: connections.find(connection => connection.state === 'active')?.reference }),
        ...(row.transport === 'squire-api' ? { service: row.app_key,
          credentials: connections.map(connection => ({
            reference: connection.reference, allowedHosts: connection.hosts,
          })) } : {}),
      };
    }
    if (!ctx.composio) throw new Error('App tools are unavailable');
    if (row.composio_link_expires_at || !row.composio_account_id)
      return { tools: [], next: 'App sign-in is pending. Complete sign-in in Beeline.' };
    if (!(await ctx.composio.account(row.composio_account_id,
      row.owner_identity_id, composioToolkitForApp(row.app_key))))
      throw new Error('App account is unavailable; reconnect it');
    const { tools, next } = await ctx.composio.listTools(composioToolkitForApp(row.app_key), input.query);
    if (!tools.length && !input.query && !next)
      throw new Error('App provider returned no tools');
    return { tools, next: next ?? 'Use app_tool with query set to a tool slug or search phrase for matching input schemas.' };
  }


  export async function daemonExecuteAppTool(ctx: DaemonContext, input: Input<'executeAppTool'>, agentId: string) {
    if (!ctx.composio) throw new Error('App tools are unavailable');
    // Room files are checked before any provider request, including the account check.
    const files = input.arguments && typeof input.arguments === 'object'
      ? await resolveAppFiles(input.arguments, async (objectId) => {
        if (!ctx.objects) throw new Error('Room files are unavailable for app tools');
        const file = await ctx.objects.readRoomObject(input.roomId, agentId, objectId,
          ctx.database);
        if (!file) throw new Error(`Room file ${objectId.slice(0, 64)} is not in this Room`);
        return file;
      })
      : undefined;
    const row = await daemonConnectedAppForTool(ctx, input.appId, input.roomId, agentId);
    if (row.composio_link_expires_at || !row.composio_account_id ||
      !(await ctx.composio.account(row.composio_account_id,
      row.owner_identity_id, composioToolkitForApp(row.app_key))))
      return { status: 'needs_connection' as const };
    const rootRequester = await daemonGrantRequester(ctx);
    const nonhumanWake = rootRequester.kind !== 'human' ||
      rootRequester.id === SYSTEM_IDENTITY_ID || rootRequester.id === SCHEDULE_SCHEDULER_ID;
    const requester = nonhumanWake && row.agent_owner_id === row.owner_identity_id
      ? { id: row.agent_owner_id, kind: 'human' as const }
      : rootRequester;
    if (requester.kind !== 'human') throw new Error('App use requires a person’s request');
    let grantId: string | undefined;
    if (row.agent_owner_id !== row.owner_identity_id) {
      const grant = (await ctx.database.query<{ id: string; status: string }>(
        `SELECT id,status FROM agent_grants WHERE app_id=$1::uuid AND agent_id=$2
         AND room_id=$3 AND requested_by=$4 AND kind='mcp' AND target=$5
         AND auto=false AND (status='pending' OR decided_by=$6)
         AND status IN ('pending','approved','once')
         AND (expires_at IS NULL OR expires_at>now())
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [row.id, agentId, input.roomId, requester.id, appResourceTarget(row.app_key),
          row.owner_identity_id],
      )).rows[0];
      if (!grant) {
        const asked = await daemonRequestAgentGrant(ctx, { ...input, kind: 'mcp',
          target: appResourceTarget(row.app_key), appId: row.id,
          purpose: `Use ${row.app_key} to complete the requested task`,
          reason: `use ${row.app_key} for this request` }, agentId);
        return { status: 'needs_permission' as const, grantId: asked.grantId };
      }
      if (grant.status === 'pending')
        return { status: 'needs_permission' as const, grantId: grant.id };
      grantId = grant.id;
      if (grant.status === 'once')
        await daemonConsumeAgentGrant(ctx, { grantId }, agentId);
    }
    const args = input.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
      JSON.stringify(args).length > 65_536)
      throw new Error('App tool arguments are invalid');
    const claim = input.tool === 'YOUTUBE_MULTIPART_UPLOAD_VIDEO'
      ? await ctx.database.transaction(db => consumeStarterVideoPost(db, input.roomId, agentId, args)) : undefined;
    const execute = async (database: SqlDatabase) => {
      let data: unknown;
      try {
        data = await ctx.composio!.execute({ accountId: row.composio_account_id!,
          userId: row.owner_identity_id, toolkit: composioToolkitForApp(row.app_key),
          tool: input.tool, arguments: args, files });
      } catch (error) {
        if (claim && error instanceof YouTubeUploadRefusal) await restoreStarterVideoPost(database, claim);
        throw error;
      }
      await recordAppUsage(database, { appId: row.id, agentId,
        roomId: input.roomId, requesterId: requester.id, transport: 'composio',
        operation: input.tool, ...(grantId ? { grantId } : {}) });
      return { status: 'executed' as const, data };
    };
    if (claim && ctx.commandTransaction) {
      ctx.deferredAppTool = execute;
      return { status: 'executed' as const, data: undefined };
    }
    return execute(ctx.database);
  }
