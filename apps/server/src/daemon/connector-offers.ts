import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { machineSquireReport } from '../squire-machine.js';
import { createHash, randomUUID } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { ensureSystemDirectMessageRoom, systemIdentityMention, systemLine } from '../system-line.js';
import { appIdentity, registryServerAppKey } from '@beeline/api-contract/workbench';
import { isAppRegistryPublisher, registryAppCompany } from '../mcp-registry-policy.js';
import { appGateFor, armRegistryConnector, backfillRegistryApps, recordAppUsage } from '../app-connections.js';
import { composioToolkitForApp } from '../composio-apps.js';
import { connectorDisplayName } from '../workbench.js';
import type { ConnectorKind } from '@beeline/api-contract/workbench';
import { CONNECTOR_OFFER_REASON_MAX_LENGTH, CONNECTOR_OFFER_SWITCH_KIND, connectorOfferConsequence, isOfferableConnectorKind, squireAccountSwitchConsequence, type ConnectorOfferCardView } from '@beeline/api-contract/connector-offers';
import { delegationView } from '../wallet.js';
import { notifyConnectorHelper } from '../postgres-live.js';
import type { DaemonContext } from './context.js';
import { Input, id, Output, registrySubject, seconds } from './values.js';
import { daemonAuthorizeScopedGrant, daemonGrantRequester } from './grants.js';
import { daemonOfferContext } from './workbench.js';



  /**
   * The per-call personal-resource gate. A call that belongs to a connected
   * app is authorized as `app:<key>` — whichever route carries it — and each
   * authorized call lands in that app's one usage ledger.
   */
  export async function daemonAuthorizeResource(ctx: DaemonContext, input: Input<'authorizeResourceCall'>, agentId: string) {
    const gate = await appGateFor(ctx.database, {
      roomId: input.roomId,
      agentId,
      target: typeof input.target === 'string' ? input.target.trim() : '',
    });
    if (gate.kind === 'refuse') return { allowed: false };
    const result = await daemonAuthorizeScopedGrant(ctx, input, agentId, 'mcp', gate.target);
    if (gate.kind === 'app' && result.allowed && input.consume !== false) {
      const requester = await daemonGrantRequester(ctx);
      await recordAppUsage(ctx.database, {
        appId: gate.appId,
        agentId,
        roomId: input.roomId,
        requesterId: requester.id,
        transport: gate.transport,
        operation:
          typeof input.operation === 'string' && input.operation.trim()
            ? input.operation.trim()
            : 'call',
        ...(result.grantId ? { grantId: result.grantId } : {}),
      });
    }
    return result;
  }


  /** Exact Registry selection, owner+machine row creation, and optional one-link fallback. */
  export async function daemonConnectMcpServer(ctx: DaemonContext, 
    input: Input<'connectMcpServer'>,
    agentId: string,
  ): Promise<Output<'connectMcpServer'>> {
    const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : '';
    const version = typeof input.version === 'string' ? input.version.trim() : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
    if (!serverName || !version || !reason || reason.length > 500)
      throw new Error('Registry server name, version and reason are required');

    // Integrity boundary: every call re-fetches the pinned record. A cached
    // search result, model-supplied URL, or package command is never trusted.
    const manifest = await ctx.mcpRegistry.exact(serverName, version);
    if (!manifest)
      return { status: 'unsupported', reason: 'The exact Registry entry was not found.' };
    // Claims can identify a protected app, but only the namespace can authorize its publisher.
    const claims = [registryServerAppKey(serverName), serverName.split('/').pop(), manifest.title, manifest.websiteUrl]
      .filter((value): value is string => Boolean(value));
    for (const claim of claims) {
      const key = appIdentity(claim)?.key;
      if (!key || isAppRegistryPublisher(manifest.name, claim)) continue;
      const known = registryAppCompany(claim)
        || await ctx.composio?.supportsOAuth(composioToolkitForApp(key));
      if (known) return { status: 'unsupported',
        reason: `This Registry publisher is not official for ${key}. Use connect for ${key} instead.` };
    }
    const remote = manifest.remotes.find((entry) => entry.type === 'streamable-http');
    if (!remote)
      return {
        status: 'unsupported',
        reason: manifest.remotes.length
          ? 'This server does not publish a streamable-http remote.'
          : 'This Registry entry publishes packages only; package execution is not supported.',
      };

    const context = await daemonOfferContext(ctx, input.roomId, agentId);
    const row = await ctx.database.transaction((database) =>
      armRegistryConnector(database, {
        workspaceId: context.workspaceId,
        ownerId: context.owner.pubkey,
        machineId: context.machine.machineId,
        helperAgentId: agentId,
        manifest,
        installRoomId: input.roomId,
        installCommandId: ctx.authorizedCommand?.id ?? null,
      }),
    );

    // A server connected by its exact coordinate is still one app.
    await backfillRegistryApps(ctx.database, row.id);
    if (row.versionConflict)
      return {
        status: 'unsupported',
        reason: `This server is already pinned to ${row.registry_version}; automatic upgrades are not supported.`,
      };
    if (row.created) await notifyConnectorHelper(ctx.database, row.id);
    if (row.status === 'connected') return { status: 'connected', connectorId: row.id };

    const signIn = row.sign_in;
    if (input.handoffToOwner && signIn?.url && signIn.attemptId) {
      const shouldPost =
        row.registry_squire_relayed_attempt !== signIn.attemptId &&
        row.registry_handoff_attempt !== signIn.attemptId;
      if (shouldPost) {
        const won = await ctx.database.query(
          `UPDATE workspace_connectors SET registry_handoff_attempt=$2,updated_at=now()
           WHERE id=$1::uuid AND registry_handoff_attempt IS DISTINCT FROM $2
             AND registry_squire_relayed_attempt IS DISTINCT FROM $2`,
          [row.id, signIn.attemptId],
        );
        if (won.rowCount) {
          const dmRoomId = await ensureSystemDirectMessageRoom(ctx.database, context.workspaceId, context.owner.pubkey);
          await systemLine(ctx.database, {
            id: createHash('sha256')
              .update(`registry-mcp-signin:${row.id}:${signIn.attemptId}`)
              .digest('hex'),
            roomId: dmRoomId,
            authorId: SYSTEM_IDENTITY_ID,
            subject: { kind: 'system', name: registrySubject(serverName) },
            verb: systemMessage("daemon-service.needs"),
            object: { text: systemMessage("daemon-service.provider-sign-in"), url: signIn.url },
            consequence: systemMessage("daemon-service.complete-this-sign-in-to-connect-the-tool"),
          });
          ctx.live.publish({ type: 'invalidate', roomId: dmRoomId, reason: 'message', agentId });
        }
      }
    }
    return signIn?.url
      ? { status: 'needs_sign_in', connectorId: row.id, authorizationUrl: signIn.url }
      : { status: 'connecting', connectorId: row.id };
  }


  /**
   * offer_connector: ONE card in the Room, spoken by the agent, addressed to
   * the person whose keys the tool will hold. The turn pauses on it the way a
   * grant ask pauses (the card's accept resumes it through the hidden
   * `connector-offer-decided` line). A repeat of the same offer inside the
   * window joins the open card rather than posting a second; a tool the
   * addressee already has, or that ANOTHER agent already offered here, is a
   * refusal the agent can restate — a second agent could never be woken by
   * the first agent's card, so it must not wait on it.
   *
   * `intent: 'switch'` is the inverse ask on the same chassis: the addressee
   * ALREADY has Trusty Squire connected on this machine, and the card asks
   * them to sign in to Google again with a different account. Accepting
   * re-arms that connector with `force_relogin_provider='google'`
   * (`acceptConnectorOffer`), so Squire's connect opens its sign-in page even
   * while the bound session is still valid.
   */
  export async function daemonOfferConnector(ctx: DaemonContext, 
    input: Input<'offerConnector'>,
    agentId: string,
    unified = false,
  ): Promise<Output<'offerConnector'>> {
    if (typeof input.roomId !== 'string' || !input.roomId) throw new Error('roomId is required');
    if (!isOfferableConnectorKind(input.connectorType))
      throw new Error(
        `connector type is invalid: ${String(input.connectorType)} cannot be offered from a Room`,
      );
    if (typeof input.reason !== 'string' || !input.reason.trim())
      throw new Error('offer reason is required');
    const reason = input.reason.trim().replace(/\s+/g, systemMessage("daemon-service.space"));
    if (reason.length > CONNECTOR_OFFER_REASON_MAX_LENGTH)
      throw new Error('offer reason is invalid: too long');
    const connectorType: ConnectorKind = input.connectorType;
    if (input.intent !== undefined && input.intent !== 'switch')
      throw new Error(`offer intent is invalid: ${String(input.intent)}`);
    const switching = input.intent === 'switch';
    if (switching && connectorType !== CONNECTOR_OFFER_SWITCH_KIND)
      throw new Error(
        `connector offer is invalid: only ${connectorDisplayName(CONNECTOR_OFFER_SWITCH_KIND)}'s account can be switched`,
      );
    const intent = switching ? 'switch' : 'add';
    const provider = switching ? 'google' : undefined;
    const offeredContext = await daemonOfferContext(ctx, input.roomId, agentId);
    const context = unified ? { ...offeredContext, addressee: offeredContext.owner, isCorner: false } : offeredContext;
    if (context.isCorner)
      throw new Error('connector offer is invalid: offer a tool from the Room, not from a corner');
    const connectorName = connectorDisplayName(connectorType);
    if (switching) {
      const bound = await machineSquireReport(ctx.database, context.addressee.pubkey,
        context.machine.machineId);
      if (bound?.status !== 'connected')
        throw new Error(
          `connector offer is invalid: ${context.addressee.name} has no connected ${connectorName} on this machine to switch; check connectors_status`,
        );
    }
    // The wallet has no connector row: it is connected while its owner's
    // grant to sign is active.
    const already = switching
      ? undefined
      : connectorType === 'trusty-squire'
        ? (await machineSquireReport(ctx.database, context.addressee.pubkey, context.machine.machineId))?.status === 'connected'
          ? { status: 'connected' } : undefined
      : connectorType === 'wallet'
        ? (await delegationView(ctx.database, context.addressee.pubkey)).active
          ? { status: 'connected' }
          : undefined
        : (
            await ctx.database.query<{ status: string }>(
              `SELECT status FROM workspace_connectors
               WHERE workspace_id=$1 AND owner_identity_id=$2 AND connector_type=$3
                 AND status IN ('installing','connected')
               ORDER BY updated_at DESC LIMIT 1`,
              [context.workspaceId, context.addressee.pubkey, connectorType],
            )
          ).rows[0];
    if (already)
      throw new Error(
        `connector offer conflict: ${context.addressee.name} already has ${connectorName} (${already.status}); check connectors_status`,
      );
    const result = await ctx.database.transaction(async (database) => {
      // One open offer per Room+connector, even when two agents race: lock
      // first, then read pending or connecting rows, matching the unique index
      // (age does not create a second card).
      await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `connector-offer:${input.roomId}:${connectorType}`,
      ]);
      const open = (
        await database.query<{
          id: string;
          agent_id: string;
          message_id: string | null;
          intent: string;
        }>(
          `SELECT id,agent_id,message_id,intent FROM connector_offers
           WHERE room_id=$1 AND connector_type=$2 AND status IN ('pending','connecting')
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [input.roomId, connectorType],
        )
      ).rows[0];
      if (open && open.intent !== intent)
        throw new Error(
          `connector offer conflict: another ${connectorName} card is already open here; let that card be answered`,
        );
      if (open && open.agent_id === agentId && open.message_id)
        return { offerId: open.id, messageId: open.message_id, joined: true };
      if (open && open.agent_id !== agentId) {
        const other = (
          await database.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [
            open.agent_id,
          ])
        ).rows[0];
        throw new Error(
          `connector offer conflict: ${other?.name ?? 'another agent'} already offered ${connectorName} here; let that card be answered`,
        );
      }
      const offerId = randomUUID();
      const messageId = id();
      const created = (
        await database.query<{ created_at: Date }>(
          `INSERT INTO connector_offers(
             id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id,
             intent,provider
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING created_at`,
          [
            offerId,
            agentId,
            context.workspaceId,
            input.roomId,
            context.addressee.pubkey,
            connectorType,
            reason,
            context.machine.machineId,
            intent,
            provider ?? null,
          ],
        )
      ).rows[0]!;
      const card: ConnectorOfferCardView = {
        offerId,
        agent: context.agent,
        addressee: context.addressee,
        connectorType,
        connectorName,
        reason,
        consequence: switching
          ? squireAccountSwitchConsequence(reason)
          : connectorOfferConsequence(connectorType, reason),
        helper: context.machine,
        status: 'pending',
        createdAt: seconds(created.created_at),
        ...(switching ? { intent: 'switch' as const, provider } : {}),
      };
      await database.query(`UPDATE messages message SET card=jsonb_set(message.card,
        '{replacementMessageId}',to_jsonb($3::text))
        FROM connector_offers failed WHERE failed.room_id=$1 AND failed.connector_type=$2
          AND failed.status='failed' AND message.room_id=failed.room_id
          AND message.card_type='connector-offer' AND message.card->>'offerId'=failed.id::text`,
        [input.roomId, connectorType, messageId]);
      // The addressee is reached by the card itself in the Room — a card is
      // outside `background.ts`'s push ceiling — not by a wake: this line has
      // no kind, so it starts no turn.
      const addresseeMention = systemIdentityMention({
        id: context.addressee.pubkey,
        kind: 'human',
        name: context.addressee.name,
        handle: context.addressee.handle ?? null,
      });
      await systemLine(database, {
        id: messageId,
        roomId: input.roomId,
        subject: { kind: 'agent', id: agentId, name: context.agent.name },
        verb: switching ? systemMessage("daemon-service.asked-to-switch", addresseeMention) : systemMessage("daemon-service.offered", addresseeMention),
        object: switching ? systemMessage("daemon-service.s-google-account", connectorName) : connectorName,
        consequence: reason,
        presentation: 'card',
        cardType: 'connector-offer',
        card: card as unknown as Record<string, unknown>,
      });
      await database.query(`UPDATE connector_offers SET message_id=$2 WHERE id=$1`, [
        offerId,
        messageId,
      ]);
      return { offerId, messageId, joined: false };
    });
    ctx.live.publish({
      type: 'invalidate',
      roomId: input.roomId,
      reason: 'connector-offer',
      agentId,
    });
    return {
      offerId: result.offerId,
      status: 'pending',
      messageId: result.messageId,
      joined: result.joined,
    };
  }
