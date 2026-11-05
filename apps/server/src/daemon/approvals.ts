import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { squireApprovalAction } from '@beeline/api-contract/phone';
import { approvalCardSource } from '../approval-card-source.js';
import { machineSquireReport, queueSquireWork, squireMachineAddress } from '../squire-machine.js';
import { createHash, randomUUID } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { ensureSystemDirectMessageRoom, ensureSystemIdentity, systemLine } from '../system-line.js';
import { connectorDisplayName } from '../workbench.js';
import type { ConnectorKind } from '@beeline/api-contract/workbench';
import { squireLoginWallConsequence, type ConnectorOfferCardView } from '@beeline/api-contract/connector-offers';
import { notifyConnectorAssignment } from '../postgres-live.js';
import type { DaemonContext } from './context.js';
import { id, Input, Output, seconds } from './values.js';
import { daemonIdentity, daemonAccess } from './access.js';
import { daemonOfferContext } from './workbench.js';
import { daemonWriteResult } from './corner-messages.js';


  // Root provenance can cross Rooms or name a private command instead of a message.
  export async function daemonApprovalSource(ctx: DaemonContext, cardKind: 'grant-request' | 'squire-approval', database = ctx.database): Promise<{ sourceRoomId?: string; sourceMessageId?: string }> {
    const command = ctx.authorizedCommand;
    if (!command) return {};
    const source = (await database.query<{ id: string; room_id: string }>(
      `SELECT id,room_id FROM messages WHERE id=ANY($1::text[]) AND deleted_at IS NULL
       ORDER BY CASE WHEN id=$2 THEN 0 ELSE 1 END LIMIT 1`,
      [[command.root_source_message_id, command.source_message_id].filter(Boolean), command.root_source_message_id],
    )).rows[0];
    return approvalCardSource(cardKind, source ? { sourceRoomId: source.room_id, sourceMessageId: source.id } : {}, source);
  }


  /**
   * Squire owns the decision and its passkey page. Beeline only places that
   * page in the resource owner's @System DM so Telegram is not a
   * prerequisite for seeing it.
   */
  export async function daemonLinkSpendApproval(ctx: DaemonContext, input: Input<'createLinkSpendRequest'>,
    agentId: string, ownerId: string, requestId: string, approvalUrl: string): Promise<void> {
    const url = new URL(approvalUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.link.com'))
      throw new Error('Link returned an invalid approval URL');
    const context = (await ctx.database.query<{ workspace_id: string; agent_name: string;
      agent_handle: string | null; agent_avatar: string | null }>(
      `SELECT room.workspace_id,identity.name agent_name,identity.handle agent_handle,
        identity.avatar agent_avatar FROM rooms room JOIN identities identity ON identity.id=$2
       WHERE room.id=$1`, [input.roomId, agentId])).rows[0];
    if (!context) throw new Error('Link request Room not found');
    const member = await ctx.database.query(`SELECT 1 FROM memberships WHERE workspace_id=$1
      AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [context.workspace_id, ownerId]);
    if (!member.rowCount) throw new Error('resource owner access denied');
    const roomId = await ensureSystemDirectMessageRoom(ctx.database, context.workspace_id, ownerId);
    const title = systemMessage("daemon-service.link-purchase-at", input.merchant);
    const detail = systemMessage("daemon-service.usd", (input.amount / 100).toFixed(2), input.description).slice(0, 500);
    const source = await daemonApprovalSource(ctx, 'squire-approval');
    const line = await systemLine(ctx.database, {
      id: createHash('sha256').update(`link-approval:${requestId}`).digest('hex'),
      roomId, authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: systemMessage("daemon-service.link") },
      verb: systemMessage("daemon-service.needs-your-approval-for"), object: title, consequence: detail,
      presentation: 'card', cardType: 'squire-approval',
      card: {
        agent: { pubkey: agentId, kind: 'agent', name: context.agent_name,
          ...(context.agent_handle ? { handle: context.agent_handle } : {}),
          ...(context.agent_avatar ? { avatar: context.agent_avatar } : {}) },
        tool: 'Link', title, detail, approvalUrl, approvalId: requestId,
        linkKind: 'approval',
        expiresAt: Date.now() + 24 * 60 * 60_000,
        ...source,
      },
    });
    if (line.inserted) ctx.live.publish({ type: 'invalidate', roomId, reason: 'message', agentId });
  }


  export async function daemonSquireApproval(ctx: DaemonContext, input: Input<'postSquireApproval'>, agentId: string, database = ctx.database) {
    for (const key of ['action', 'reason', 'reference'] as const) {
      if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > 1000)) throw new Error(`Squire ${key} is invalid`);
    }
    if (input.facts !== undefined && (!Array.isArray(input.facts) || input.facts.length > 3 || input.facts.some(fact => !fact || typeof fact.label !== 'string' || fact.label.length > 40 || typeof fact.value !== 'string' || fact.value.length > 500))) throw new Error('Squire facts are invalid');
    if (!input.tool.trim() || input.tool.length > 80) throw new Error('Squire tool is invalid');
    if (!input.title.trim() || input.title.length > 120)
      throw new Error('Squire approval title is invalid');
    if (!input.detail.trim() || input.detail.length > 500)
      throw new Error('Squire approval detail is invalid');
    if (
      input.approvalId !== undefined &&
      (!input.approvalId.trim() || input.approvalId.length > 240)
    )
      throw new Error('Squire approval id is invalid');
    if (input.expiresAt !== undefined &&
      (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0))
      throw new Error('Squire approval expiry is invalid');
    if (
      input.signInUrl !== undefined &&
      (!input.signInUrl.trim() || input.signInUrl.length > 2_048)
    )
      throw new Error('Squire sign-in URL is invalid');
    let approvalUrl: URL;
    try {
      approvalUrl = new URL(input.approvalUrl);
    } catch {
      throw new Error('Squire approval URL is invalid');
    }
    if (
      !['http:', 'https:'].includes(approvalUrl.protocol) ||
      approvalUrl.username ||
      approvalUrl.password ||
      !['approval', 'passkey', 'vouch'].includes(input.linkKind)
    )
      throw new Error('Squire approval URL is invalid');
    const context = (
      await database.query<{
        workspace_id: string;
        owner_id: string;
        agent_name: string;
        agent_handle: string | null;
        agent_avatar: string | null;
      }>(
        `SELECT room.workspace_id,agent.owner_id,identity.name agent_name,
                identity.handle agent_handle,identity.avatar agent_avatar
         FROM rooms room
         JOIN agents agent ON agent.agent_id=$2
         JOIN identities identity ON identity.id=agent.agent_id
         WHERE room.id=$1`,
        [input.roomId, agentId],
      )
    ).rows[0];
    if (!context) throw new Error('agent not found');
    const member = await database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
       AND identity_id=$2 AND removed_at IS NULL`,
      [context.workspace_id, context.owner_id],
    );
    if (!member.rowCount) throw new Error('resource owner access denied');
    const roomId = await ensureSystemDirectMessageRoom(database, context.workspace_id, context.owner_id);
    const dedupeKey = input.approvalId?.trim() || approvalUrl.toString();
    const messageId = createHash('sha256')
      .update(`squire-approval:v1:${context.workspace_id}:${agentId}:${dedupeKey}`)
      .digest('hex');
    const source = await daemonApprovalSource(ctx, 'squire-approval', database);
    const agent = {
      pubkey: agentId,
      kind: 'agent' as const,
      name: context.agent_name,
      ...(context.agent_handle ? { handle: context.agent_handle } : {}),
      ...(context.agent_avatar ? { avatar: context.agent_avatar } : {}),
    };
    const line = await systemLine(database, {
      id: messageId,
      roomId,
      authorId: SYSTEM_IDENTITY_ID,
      subject: {
        kind: 'system',
        name: connectorDisplayName(systemMessage("daemon-service.trusty-squire")),
      },
      verb: systemMessage("daemon-service.needs-your-approval-for"),
      object: input.title.trim(),
      consequence: input.detail.trim(),
      presentation: 'card',
      cardType: 'squire-approval',
      card: {
        agent,
        tool: input.tool.trim(),
        title: input.title.trim(),
        detail: input.detail.trim(),
        ...(input.reason ? { reason: input.reason.trim().slice(0, 1000) } : {}),
        ...(input.action ? { action: input.action.trim().slice(0, 240) } : {}),
        ...(input.reference ? { reference: input.reference.trim().slice(0, 1000) } : {}),
        ...(input.facts ? { facts: input.facts.slice(0, 3).map(fact => ({ label: fact.label.slice(0, 40), value: fact.value.slice(0, 500) })) } : {}),
        approvalUrl: approvalUrl.toString(),
        ...(input.approvalId ? { approvalId: input.approvalId.trim() } : {}),
        expiresAt: input.expiresAt ?? Date.now() + 24 * 60 * 60_000,
        linkKind: input.linkKind,
        ...(ctx.authorizedCommand ? { commandId: ctx.authorizedCommand.id, generationId: ctx.authorizedCommand.generation_id } : {}),
        ...source,
      },
    });
    // A Registry OAuth turn whose Squire call produced this approval link has
    // already delivered the one owner link. Only the row whose OWN sign-in page
    // Squire was driving is marked, so a second registry row in the same turn —
    // or an unrelated Squire approval — never suppresses its own owner handoff.
    if (input.signInUrl) {
      await database.query(
        `UPDATE workspace_connectors
         SET registry_squire_relayed_attempt=sign_in->>'attemptId',updated_at=now()
         WHERE connector_type='registry-mcp' AND status='installing'
           AND install_agent_id=$1 AND install_room_id=$2
           AND sign_in->>'attemptId' IS NOT NULL AND sign_in->>'url'=$3`,
        [agentId, input.roomId, input.signInUrl],
      );
    }
    if (line.inserted && database === ctx.database)
      ctx.live.publish({ type: 'invalidate', roomId, reason: 'message', agentId });
    return { id: line.id, createdAt: Math.floor(Date.now() / 1000) };
  }


  /**
   * Squire's own decision on a pending approval, relayed by the helper over
   * the task connection it kept alive for exactly this wait. Posted to the
   * Room the turn actually ran in (never the @System DM `postSquireApproval`
   * used, since a task-relay approval posts no DM card) with `kind:
   * 'squire-approval-decided'` and `wakes: [agentId]`, so the agent's paused
   * turn resumes the same way a decided grant resumes it.
   */
  export async function daemonSquireApprovalDecision(ctx: DaemonContext, 
    input: Input<'postSquireApprovalDecision'>,
    agentId: string,
  ): Promise<Output<'postSquireApprovalDecision'>> {
    const approvalId = input.approvalId.trim();
    if (!approvalId || approvalId.length > 240) throw new Error('Squire approval id is invalid');
    if (input.status !== 'approved' && input.status !== 'denied' && input.status !== 'expired')
      throw new Error('Squire approval status is invalid');
    const tool = input.tool.trim();
    if (!tool || tool.length > 80) throw new Error('Squire tool is invalid');
    const title = input.title.trim();
    if (!title || title.length > 120) throw new Error('Squire approval title is invalid');
    const detail = input.detail.trim();
    if (detail.length > 500) throw new Error('Squire approval detail is invalid');
    if (!input.requestId?.trim())
      throw new Error('Squire approval decision requires the paused turn id');
    const agent = await daemonIdentity(ctx, agentId);
    await ensureSystemIdentity(ctx.database);
    const id = createHash('sha256')
      .update(`squire-approval-decided:v1:${input.roomId}:${agentId}:${approvalId}`)
      .digest('hex');
    const settledRooms: string[] = [];
    const line = await ctx.database.transaction(async database => {
    const original = (await database.query<{ action: string | null }>(
      `SELECT card->>'action' AS action FROM messages WHERE card_type='squire-approval'
       AND card->'agent'->>'pubkey'=$1 AND card->>'approvalId'=$2
       AND room_id IN (SELECT id FROM rooms WHERE workspace_id=(SELECT workspace_id FROM rooms WHERE id=$3)) LIMIT 1`,
      [agentId, approvalId, input.roomId],
    )).rows[0];
    const action = original?.action || squireApprovalAction(tool, detail);
    const decision = await systemLine(database, {
      id,
      roomId: input.roomId,
      authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: systemMessage("daemon-service.the-request-to", action) },
      verb: input.status === 'expired' ? systemMessage("daemon-service.expired") : input.status === 'approved' ? systemMessage("daemon-service.was-allowed") : systemMessage("daemon-service.was-denied"),
      // A resume kind: it answers the turn that asked for this approval, and
      // must never start a second one (`RESUME_KINDS`).
      kind: 'squire-approval-decided',
      requestId: input.requestId,
      wakes: [agentId],
      presentation: 'card',
      cardType: 'squire-approval-decision',
      card: { approvalId, tool, title, detail, status: input.status, agentId, agentName: agent.name },
    });
    // Squire's authenticated notification provides a decision, but no human identity.
    // Never substitute the requesting agent's owner for the actual decision-maker.
    const changed = await database.query<{ room_id: string }>(
      `UPDATE messages approval SET card=approval.card || $4::jsonb
       WHERE approval.card_type='squire-approval' AND approval.card->'agent'->>'pubkey'=$1
         AND approval.card->>'approvalId'=$2 AND approval.card->>'status' IS NULL
         AND approval.room_id IN (SELECT id FROM rooms WHERE workspace_id=(SELECT workspace_id FROM rooms WHERE id=$3))
       RETURNING approval.room_id`,
      [agentId, approvalId, input.roomId, JSON.stringify({ status: input.status, decidedAt: Math.floor(Date.now()/1000) })],
    );
    settledRooms.push(...changed.rows.map(row => row.room_id));
    return decision;
    });
    for (const roomId of new Set(settledRooms)) ctx.live.publish({ type: 'invalidate', roomId, reason: 'message', agentId });
    if (line.inserted)
      ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message', agentId });
    return { id: line.id, createdAt: Math.floor(Date.now() / 1000) };
  }


  /** Only an expired shared Google session needs an owner-facing reconnect. */
  export async function daemonSquireLoginWall(ctx: DaemonContext, 
    input: Input<'postSquireLoginWall'>,
    agentId: string,
  ): Promise<Output<'postSquireLoginWall'>> {
    if (typeof input.roomId !== 'string' || !input.roomId) throw new Error('roomId is required');
    if (
      input.wall !== 'google_session' &&
      input.wall !== 'oauth_sign_in' &&
      input.wall !== 'awaiting_human'
    )
      throw new Error('Squire login wall is invalid');
    if (typeof input.message !== 'string' || !input.message.trim())
      throw new Error('Squire login wall message is required');
    const notActioned = { id: '', createdAt: Math.floor(Date.now() / 1000), cardPosted: false };
    if (input.wall !== 'google_session') return notActioned;
    const provider = 'google';
    const context = await daemonOfferContext(ctx, input.roomId, agentId);
    const connectorType: ConnectorKind = 'trusty-squire';
    const connectorName = connectorDisplayName(connectorType);
    const reason = squireLoginWallConsequence(provider);
    const result = await ctx.database.transaction(async (database) => {
      // Same lock `offerConnector` takes: one open offer per Room+connector,
      // even when two turns on the same stale session race.
      await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `connector-offer:${input.roomId}:${connectorType}`,
      ]);
      // An open offer is checked BEFORE the connector's own status: the first
      // trigger already moved that row off 'connected' into 'installing', so
      // a second stuck turn on the SAME reconnect must still join the open
      // card rather than finding no connected row and reporting notActioned.
      const open = (
        await database.query<{ id: string }>(
          `SELECT id FROM connector_offers
           WHERE room_id=$1 AND connector_type=$2 AND status IN ('pending','connecting')
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [input.roomId, connectorType],
        )
      ).rows[0];
      if (open) return { offerId: open.id, cardPosted: false };
      const report = await machineSquireReport(database, context.owner.pubkey, context.machine.machineId);
      if (report?.status !== 'connected') return undefined;
      const connected = { id: squireMachineAddress(context.machine.machineId), machine_id: context.machine.machineId };
      const offerId = randomUUID();
      const messageId = id();
      const created = (
        await database.query<{ created_at: Date }>(
          `INSERT INTO connector_offers(
             id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id,
             intent,provider,status,accepted_by,accepted_at,connector_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reconnect',$9,'connecting',NULL,NULL,$10)
           RETURNING created_at`,
          [
            offerId,
            agentId,
            context.workspaceId,
            input.roomId,
            context.owner.pubkey,
            connectorType,
            reason,
            connected.machine_id ?? context.machine.machineId,
            provider ?? null,
            null,
          ],
        )
      ).rows[0]!;
      const card: ConnectorOfferCardView = {
        offerId,
        agent: context.agent,
        addressee: context.owner,
        connectorType,
        connectorName,
        reason,
        consequence: squireLoginWallConsequence(provider),
        helper: context.machine,
        status: 'connecting',
        createdAt: seconds(created.created_at),
        connectorId: connected.id,
        intent: 'reconnect',
        ...(provider ? { provider } : {}),
      };
      await systemLine(database, {
        id: messageId,
        roomId: input.roomId,
        subject: { kind: 'agent', id: agentId, name: context.agent.name },
        verb: systemMessage("daemon-service.needs"),
        object: systemMessage("daemon-service.google-sign-in"),
        consequence: reason,
        presentation: 'card',
        cardType: 'connector-offer',
        card: card as unknown as Record<string, unknown>,
      });
      await database.query(`UPDATE connector_offers SET message_id=$2 WHERE id=$1`, [
        offerId,
        messageId,
      ]);
      await queueSquireWork(database, agentId, { install: true, forceReloginProvider: provider });
      return { offerId, cardPosted: true };
    });
    if (!result) return notActioned;
    await notifyConnectorAssignment(ctx.database, agentId);
    ctx.live.publish({
      type: 'invalidate',
      roomId: input.roomId,
      reason: 'connector-offer',
      agentId,
    });
    return {
      id: result.offerId,
      createdAt: Math.floor(Date.now() / 1000),
      cardPosted: result.cardPosted,
      offerId: result.offerId,
    };
  }


  export async function daemonPermissionRequest(ctx: DaemonContext, input: Input<'postPermissionRequest'>, agentId: string) {
    await daemonAccess(ctx, input.roomId, agentId);
    if (input.purpose !== undefined && (typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.trim().length > 240))
      throw new Error('permission purpose must be 1–240 characters');
    const scope = input.scope;
    const repository =
      scope.type === 'room.create'
        ? scope.repository?.key
        : scope.type === 'money.spend'
          ? scope.merchant
          : scope.type === 'schedule.change'
            ? scope.scheduleId
            : scope.type === 'mission.control'
              ? scope.missionId
              : scope.target;
    const tool =
      scope.type === 'operation.execute' ||
      scope.type === 'message.send' ||
      scope.type === 'content.publish'
        ? scope.connectorId
        : scope.type;
    const messageId = await ctx.database.transaction(async (database) => {
      const inserted = await database.query(
        `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
         VALUES($1,$2,$3,$4,$5::jsonb,'pending') ON CONFLICT(permission_id) DO NOTHING
         RETURNING permission_id`,
        [
          input.permissionId,
          input.roomId,
          input.principalId,
          input.requestId,
          JSON.stringify(scope),
        ],
      );
      if (!inserted.rowCount) {
        return (
          await database.query<{ id: string }>(
            `SELECT id FROM messages WHERE room_id=$1 AND card_type='permission'
             AND card->>'permissionId'=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
            [input.roomId, input.permissionId],
          )
        ).rows[0]?.id;
      }
      const identities = await database.query<{
        id: string;
        kind: 'human' | 'agent';
        name: string;
        handle: string | null;
        avatar: string | null;
      }>(`SELECT id,kind,name,handle,avatar FROM identities WHERE id=ANY($1::text[])`, [
        [input.principalId, agentId],
      ]);
      const requesterRow = identities.rows.find((row) => row.id === input.principalId);
      const agentRow = identities.rows.find((row) => row.id === agentId);
      if (!requesterRow || requesterRow.kind !== 'human' || !agentRow || agentRow.kind !== 'agent')
        throw new Error('permission identities are invalid');
      const requester = {
        pubkey: requesterRow.id,
        kind: requesterRow.kind,
        name: requesterRow.name,
        ...(requesterRow.handle ? { handle: requesterRow.handle } : {}),
        ...(requesterRow.avatar ? { avatar: requesterRow.avatar } : {}),
      };
      const agent = {
        pubkey: agentRow.id,
        kind: agentRow.kind,
        name: agentRow.name,
        ...(agentRow.handle ? { handle: agentRow.handle } : {}),
        ...(agentRow.avatar ? { avatar: agentRow.avatar } : {}),
      };
      // Squire spending is the agent owner's call; the card names who decides.
      const spendingOwnerId = scope.type === 'money.spend'
        ? (await database.query<{ owner_id: string | null }>(
            `SELECT owner_id FROM agents WHERE agent_id=$1`, [agentId],
          )).rows[0]?.owner_id ?? undefined
        : undefined;
      const created = id();
      await systemLine(database, {
        id: created,
        roomId: input.roomId,
        subject: { kind: 'agent', id: agentId, name: agent.name },
        verb: systemMessage("daemon-service.asked-to", requester.handle ? systemMessage("daemon-service.requester-mention", requester.handle) : ''),
        object: tool,
        presentation: 'card',
        requestId: input.requestId,
        cardType: 'permission',
        card: {
          ...(input.purpose ? { reason: input.purpose.trim().slice(0, 240) } : {}),
          permissionId: input.permissionId,
          requestId: input.requestId,
          agent,
          requester,
          tool,
          ...(repository ? { repository } : {}),
          ...(scope.type === 'money.spend'
            ? { purpose: 'squire-spending', ...(spendingOwnerId ? { ownerId: spendingOwnerId } : {}) }
            : {}),
          status: 'pending',
        },
      });
      return created;
    });
    if (!messageId) throw new Error('permission request is invalid');
    ctx.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'permission', agentId });
    return { id: messageId, createdAt: Math.floor(Date.now() / 1000) };
  }

  export async function daemonPermissionExecution(ctx: DaemonContext, input: Input<'postPermissionExecution'>, agentId: string) {
    await daemonAccess(ctx, input.roomId, agentId);
    await ctx.database.query(
      `UPDATE permission_authority SET status=$2,result=$3,updated_at=now() WHERE permission_id=$1`,
      [input.permissionId, input.status, input.result ?? null],
    );
    return daemonWriteResult(ctx);
  }
