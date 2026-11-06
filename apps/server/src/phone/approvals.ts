import { dropQueuedOrdersForStop } from '../agent-command-queue.js';
import { lockAgentCommandQueue } from '../agent-command-queue.js';
import { endAgentTurn } from '../agent-turn-end.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { deleteCornerBranchBestEffort } from '../corner-branch-cleanup.js';
import { cornerKindSql } from '../corner-opening.js';
import { type CommandRow } from '../agent-command.js';
import { type SqlDatabase } from '../database.js';
import { lockCornerLifecycle, setCornerLockedFact } from '../corner-lifecycle.js';
import { identitySubject, systemIdentityMention, systemLine } from '../system-line.js';
import { closeCornerPullRequestBestEffort, closeCornerState, lockCornerArchivalAuthority } from '../corner-close.js';
import type { PhoneContext } from './context.js';
import { Input } from './types.js';
import { phoneHasRoomAccess, phoneRequireIdentity, phoneRequireRoomWorkspaceManager, phoneRequireWorkspaceMember } from './access.js';
import { messageId, SPENDING_OWNER_AUTHORITY_MESSAGE } from './values.js';


  /**
   * Stop a turn in progress, at the asker's word.
   *
   * The authority is the request, not the Room: whoever wrote the message this
   * turn answers may withdraw it, and nobody else may — not a Workspace owner,
   * not the agent's owner, not another member watching the line tick. A
   * question is the asker's to take back, and a Room where anyone can silence
   * anyone else's agent mid-sentence is a different feature with different
   * consequences.
   *
   * Three facts settle together, in one transaction, and in this order for a
   * reason:
   *
   *   1. The receipt turns `cancelled`. This is what retires the turn status
   *      line on every reader's phone, and it is written the moment the stop is
   *      accepted rather than when the helper gets around to obeying — the
   *      person withdrew the question, so nobody is waiting for that answer
   *      any more, whatever the harness does next. `cancelled` is terminal
   *      (`DaemonService.turnReceipt`), so the run that lands a second later
   *      cannot overwrite the stop with `complete`.
   *   2. One attributed system line inscribes WHO stopped it. A turn that
   *      simply vanished would read as an agent that gave up; the Room carries
   *      the actual fact instead, in the ordinary grammar, naming the person by
   *      handle.
   *   3. That same line IS the intake item. It mentions the agent — the only
   *      thing that wakes a daemon — and carries the stopped turn's request id
   *      in the row's `request_id`, which is how the helper knows which of its
   *      sessions to cancel. `turn-cancelled` is a CONTROL kind, so it can
   *      never start the very turn it exists to end.
   */
  export async function phoneCancelAgentTurn(ctx: PhoneContext, input: Input<'cancelAgentTurn'>, viewerId: string) {
    if (!(await ctx.hasRoomAccess(input.roomId, viewerId))) throw new Error('room access denied');
    const stopper = await ctx.requireIdentity(viewerId);
    const agent = await ctx.requireIdentity(input.agentId);
    await ctx.database.transaction(async (database) => {
      const member = (
        await database.query(
          `SELECT 1 FROM memberships room_member
         JOIN rooms room ON room_member.room_id=COALESCE(room.parent_id,room.id)
         JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
           AND workspace_member.room_id IS NULL AND workspace_member.identity_id=room_member.identity_id
           AND workspace_member.removed_at IS NULL
         WHERE room.id=$1 AND room_member.identity_id=$2 AND room_member.removed_at IS NULL
         FOR SHARE OF room_member,workspace_member`,
          [input.roomId, viewerId],
        )
      ).rows[0];
      if (!member) throw new Error('room access denied');
      await lockAgentCommandQueue(database, input.roomId, input.agentId);
      const commands = await database.query<CommandRow>(
        `SELECT agent_commands.* FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3
         AND action IN ('input','resume') AND state IN ('pending','claimed')
         AND EXISTS(SELECT 1 FROM messages source WHERE source.id=agent_commands.root_source_message_id) ORDER BY created_at DESC,id DESC FOR UPDATE`,
        [input.roomId, input.agentId, input.requestId],
      );
      const command = commands.rows[0];
      if (!command || !await endAgentTurn(database, command, 'cancelled', 'stop'))
        throw new Error('running turn not found');
      const dropped = commands.rows[0] ? await dropQueuedOrdersForStop(database, commands.rows[0]) : 0;
      await systemLine(database, {
        roomId: input.roomId,
        authorId: viewerId,
        subject: identitySubject({ id: stopper.pubkey, kind: stopper.kind, name: stopper.name }),
        verb: systemMessage("phone-service.stopped"),
        object: { text: agent.name, id: agent.pubkey },
        consequence: systemMessage("phone-service.turn-cancelled", dropped ? systemMessage("phone-service.queued-dropped", dropped, dropped === 1 ? systemMessage("phone-service.order") : systemMessage("phone-service.orders")) : ''),
        kind: 'turn-cancelled',
        wakes: [input.agentId],
        requestId: input.requestId,
      });
    });
    // No publish here on purpose. Every phone operation carrying a `roomId`
    // already invalidates that Room (`server.ts`), which is what repaints the
    // status line. Helpers receive work through their command socket.
  }

  /**
   * Apply a human close or lock change using the same corner management permission.
   * A lock change preserves the corner's assignments; a close cancels them.
   */
  export async function phoneRequestCornerClose(ctx: PhoneContext, roomId: string, viewerId: string, locked?: boolean) {
    const authorize = async (database: SqlDatabase) => {
      await lockCornerLifecycle(database, roomId);
      if (locked === undefined) await lockCornerArchivalAuthority(database);
      const access = await database.query<{ workspace_role: string }>(
        `SELECT workspace_member.role workspace_role FROM memberships room_member
         JOIN rooms room ON room_member.room_id=COALESCE(room.parent_id,room.id)
         JOIN memberships workspace_member
           ON workspace_member.workspace_id=room.workspace_id
          AND workspace_member.room_id IS NULL
          AND workspace_member.identity_id=room_member.identity_id
          AND workspace_member.removed_at IS NULL
         JOIN identities viewer ON viewer.id=room_member.identity_id AND viewer.kind='human'
         WHERE room.id=$1 AND room_member.identity_id=$2
           AND room_member.removed_at IS NULL
         FOR SHARE OF room_member,workspace_member,room,viewer`,
        [roomId, viewerId],
      );
      if (!access.rowCount) throw new Error('room access denied');
      const room = (
        await database.query<{ created_by: string | null; kind: string }>(
          `SELECT room.created_by,${cornerKindSql('room.id')} kind
           FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id
           WHERE room.id=$1 AND room.parent_id IS NOT NULL
           FOR KEY SHARE OF room FOR UPDATE OF fact`,
          [roomId],
        )
      ).rows[0];
      if (!room) throw new Error('corner not found');
      const manager = ['owner', 'admin'].includes(access.rows[0]!.workspace_role);
      if (room.kind === 'human' && room.created_by !== viewerId && !manager)
        throw new Error(
          'corner close access denied: only the creator or a workspace owner or admin can close this corner',
        );
    };
    await ctx.database.transaction(authorize);
    if (locked === undefined)
      await closeCornerPullRequestBestEffort(ctx.database, roomId,
        ctx.github ? id => ctx.github!.closeCornerPullRequest(id) : undefined);
    const archived = await ctx.database.transaction(async database => {
      await authorize(database);
      if (locked !== undefined) {
        await setCornerLockedFact(database, roomId, locked);
      } else {
        return (await closeCornerState(database, roomId)).archived;
      }
    });
    if (archived) await deleteCornerBranchBestEffort(roomId, ctx.github ? id => ctx.github!.deleteCornerBranch(id) : undefined);
  }

  /** Decline a connector or settle a target-branch proposal under its existing authority. */
  export async function phoneDecideApprovalCard(ctx: PhoneContext, input: Input<'decideApprovalCard'>, viewerId: string) {
    if (!['allow', 'deny'].includes(input.decision)) throw new Error('approval decision is invalid');
    const decider = await phoneRequireIdentity(ctx, viewerId);
    if (decider.kind !== 'human') throw new Error('a person must decide');
    await ctx.database.transaction(async database => {
      const row = (await database.query<{ card_type: string; card: Record<string, any> }>(
        `SELECT card_type,card FROM messages WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL FOR UPDATE`, [input.messageId, input.roomId],
      )).rows[0];
      if (!row) throw new Error('approval not found');
      const card = row.card;
      const status = input.decision === 'deny' ? 'denied' : 'allowed';
      if (row.card_type === 'target-branch') {
        await phoneRequireRoomWorkspaceManager(ctx, input.roomId, viewerId, database);
        if (card.status) throw new Error('approval already decided');
        if (input.decision === 'allow') {
          const room = (await database.query<{ repository_target_branch: string }>(`SELECT repository_target_branch FROM rooms WHERE id=$1`, [input.roomId])).rows[0];
          if (room?.repository_target_branch !== card.to) throw new Error('confirm the target branch before settling its card');
        }
      } else if (row.card_type === 'connector-offer' && input.decision === 'deny') {
        const offer = (await database.query<{ addressee_id: string; connector_type: string; workspace_id: string; agent_id: string; command_id: string | null }>(
          `SELECT addressee_id,connector_type,workspace_id,agent_id,command_id FROM connector_offers WHERE id::text=$1 AND room_id=$2 AND status='pending' FOR UPDATE`, [card.offerId, input.roomId],
        )).rows[0];
        if (!offer) throw new Error('connector offer not pending');
        await phoneRequireWorkspaceMember(ctx, offer.workspace_id, viewerId, database);
        if (offer.addressee_id !== viewerId) {
          if (offer.connector_type === 'wallet') throw new Error('only the wallet owner can decide');
          await phoneRequireRoomWorkspaceManager(ctx, input.roomId, viewerId, database);
        }
        await database.query(`UPDATE connector_offers SET status='denied',accepted_by=$2,accepted_at=now() WHERE id::text=$1`, [card.offerId, viewerId]);
        await systemLine(database, { roomId: input.roomId, subject: identitySubject({ id: viewerId, kind: 'human', name: decider.name }),
          verb: systemMessage("phone-service.declined"), object: card.connectorName, kind: 'connector-offer-decided', wakes: [offer.agent_id],
          ...(offer.command_id ? { commandId: offer.command_id } : {}), cardType: 'connector-offer-decision', card: { offerId: card.offerId, status: 'denied' } });
      } else throw new Error('approval kind cannot be decided here');
      await database.query(`UPDATE messages SET card=card || $2::jsonb WHERE id=$1`, [input.messageId,
        JSON.stringify({ status, decidedBy: decider, decidedAt: Math.floor(Date.now()/1000),
          ...(row.card_type === 'connector-offer' ? { acceptedBy: decider, acceptedAt: Math.floor(Date.now()/1000) } : {}) })]);
    });
    return { messageId: input.messageId };
  }


  export async function phoneDecidePermission(ctx: PhoneContext, input: Input<'decideWritePermission'>, viewerId: string) {
    const pending = (
      await ctx.database.query<{
        principal_id: string;
        request_id: string;
        status: string;
        card: Record<string, unknown> | null;
      }>(
        `SELECT p.principal_id,p.request_id,p.status,card.card
         FROM permission_authority p
         LEFT JOIN LATERAL (
           SELECT m.card FROM messages m
           WHERE m.room_id=p.room_id AND m.card_type='permission'
             AND m.card->>'permissionId'=p.permission_id
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1
         ) card ON true
         WHERE p.permission_id=$1 AND p.room_id=$2`,
        [input.permissionId, input.roomId],
      )
    ).rows[0];
    if (!pending || pending.status !== 'pending') throw new Error('permission not found');
    const card = pending.card;
    const cardAgent = card?.agent as { pubkey?: unknown } | undefined;
    if (card?.purpose === 'squire-spending') {
      // Trusty Squire spending is the spending agent's owner's call alone.
      const owner = await ctx.database.query(
        `SELECT 1 FROM agents WHERE agent_id=$1 AND owner_id=$2`,
        [cardAgent?.pubkey, viewerId],
      );
      if (!owner.rowCount) throw new Error(SPENDING_OWNER_AUTHORITY_MESSAGE);
    } else if (viewerId !== pending.principal_id)
      await phoneRequireRoomWorkspaceManager(ctx, input.roomId, viewerId);
    if (
      pending.request_id !== input.requestId ||
      cardAgent?.pubkey !== input.agentId ||
      card?.repository !== input.repository
    )
      throw new Error('permission decision is invalid');
    const status = input.decision === 'allow' ? 'authorized' : 'denied';
    const id = messageId();
    const decider = await phoneRequireIdentity(ctx, viewerId);
    const agent = await phoneRequireIdentity(ctx, input.agentId);
    const requester = await phoneRequireIdentity(ctx, pending.principal_id);
    await ctx.database.transaction(async (database) => {
      if (viewerId === pending.principal_id) {
        const access = await database.query(
          `SELECT room_member.id FROM memberships workspace_member
           JOIN rooms room ON room.workspace_id=workspace_member.workspace_id
           JOIN memberships room_member ON room_member.room_id=COALESCE(room.parent_id,room.id)
             AND room_member.identity_id=workspace_member.identity_id
           WHERE room.id=$1 AND workspace_member.room_id IS NULL
             AND workspace_member.identity_id=$2 AND workspace_member.removed_at IS NULL
             AND room_member.removed_at IS NULL
           FOR UPDATE OF workspace_member,room_member`,
          [input.roomId, viewerId],
        );
        if (!access.rowCount) throw new Error('room access denied');
      }
      const updated = await database.query(
        `UPDATE permission_authority SET status=$2,updated_at=now()
         WHERE permission_id=$1 AND room_id=$3 AND status='pending'`,
        [input.permissionId, status, input.roomId],
      );
      if (!updated.rowCount) throw new Error('permission not found');
      const tool = typeof card?.tool === 'string' ? card.tool : systemMessage("phone-service.edit-files");
      await systemLine(database, {
        id,
        roomId: input.roomId,
        authorId: viewerId,
        subject: identitySubject({ id: decider.pubkey, kind: decider.kind, name: decider.name }),
        verb: input.decision === 'allow' ? systemMessage("phone-service.allowed") : systemMessage("phone-service.denied"),
        object: {
          text: systemMessage("phone-service.to", systemIdentityMention({
            id: agent.pubkey,
            kind: agent.kind,
            name: agent.name,
            handle: agent.handle ?? null,
          }), tool),
          id: agent.pubkey,
        },
        presentation: 'card',
        cardType: 'permission',
        card: {
          permissionId: input.permissionId,
          requestId: input.requestId,
          agent,
          requester,
          decider,
          decidedAt: Math.floor(Date.now()/1000),
          ...(typeof card?.reason === 'string' ? { reason: card.reason } : {}),
          tool,
          repository: input.repository,
          ...(card?.purpose === 'squire-spending' ? { purpose: 'squire-spending' } : {}),
          status: input.decision === 'allow' ? 'allowed' : 'denied',
        },
      });
    });
    return { messageId: id };
  }
