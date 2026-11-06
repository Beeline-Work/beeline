import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { recordFreeAgentGuideStarted } from '../free-agent-warning.js';
import { beginAgentSignInCards, AGENT_SIGN_IN_NO_ANSWER_MESSAGE, completeAgentSignInCard } from '../agent-sign-in.js';
import { isTaggedLoginText } from '../agent-command.js';
import { randomBytes } from 'node:crypto';
import { createAgentPairingCode } from '@beeline/api-contract/phone';
import type { AgentDetailView } from '@beeline/api-contract/phone';
import { type AgentGrantDecision, type AgentGrantStatus } from '@beeline/api-contract/agent-grants';
import { notifyAgentConfigRoom } from '../postgres-live.js';
import { settleGrantCard } from '../agent-retirement.js';
import { identitySubject, systemLine } from '../system-line.js';
import type { PhoneContext } from './context.js';
import { Input } from './types.js';
import { phoneRequireWorkspaceMember, phoneRequireWorkspaceAgent, phoneRequireGrantAuthority, phoneRequireIdentity } from './access.js';
import { hash, normalizeAgentName, messageId } from './values.js';
import { phoneAvailableAgentHandle } from './pairing.js';
import { effortCatalogAxis } from './read-projection.js';


  export async function phoneCreatePairing(ctx: PhoneContext, input: Input<'createAgentPairingCode'>, viewerId: string) {
    await phoneRequireWorkspaceMember(ctx, input.workspaceId, viewerId);
    const code = createAgentPairingCode(randomBytes(8));
    const expiresAt = Date.now() + 15 * 60_000;
    await ctx.database.query(
      `INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at) VALUES($1,$2,$3,$4)`,
      [hash(code), input.workspaceId, viewerId, new Date(expiresAt)],
    );
    await recordFreeAgentGuideStarted(ctx.database, viewerId, input.workspaceId);
    return { code, expiresAt: Math.floor(expiresAt / 1000) };
  }

  export async function phoneUpdateAgentSoul(ctx: PhoneContext, input: Input<'updateAgentSoul'>, viewerId: string) {
    await phoneRequireWorkspaceAgent(ctx, input.workspaceId, input.agentId, viewerId);
    const name = normalizeAgentName(input.name);
    await ctx.database.transaction(async (database) => {
      const handle = await phoneAvailableAgentHandle(ctx,
        database,
        input.workspaceId,
        input.agentId,
        name,
      );
      await database.query(`UPDATE agents SET soul=$2::jsonb,updated_at=now() WHERE agent_id=$1`, [
        input.agentId,
        JSON.stringify({
          name,
          instructions: input.instructions,
          avatarSeed: input.avatarSeed,
          ...(input.avatar ? { avatar: input.avatar } : {}),
        }),
      ]);
      await database.query(
        `UPDATE identities SET name=$2,handle=$3,avatar=COALESCE((SELECT '/v1/agent-avatars/'||id::text FROM agent_avatars WHERE agent_id=$1),$4,avatar),updated_at=now() WHERE id=$1`,
        [input.agentId, name, handle, input.avatar ?? null],
      );
    });
  }

  export async function phoneUpdateAgentModel(ctx: PhoneContext, input: Input<'updateAgentModelSelection'>, viewerId: string) {
    await phoneRequireWorkspaceAgent(ctx, input.workspaceId, input.agentId, viewerId);
    const hasModel = Object.prototype.hasOwnProperty.call(input, 'model');
    const hasEffort = Object.prototype.hasOwnProperty.call(input, 'effort');
    const hasFastMode = Object.prototype.hasOwnProperty.call(input, 'fastMode');
    if (hasFastMode && typeof input.fastMode !== 'boolean')
      throw new Error('invalid Fast mode value');
    await ctx.database.transaction(async (database) => {
      const context = (
        await database.query<{
          selected_model: string | null;
          selected_effort: string | null;
          fast_mode: boolean;
          model_catalog: AgentDetailView['catalog'];
          agent_id: string;
          agent_kind: 'human' | 'agent';
          agent_name: string;
          agent_handle: string | null;
          actor_id: string;
          actor_kind: 'human' | 'agent';
          actor_name: string;
          actor_handle: string | null;
        }>(
          `SELECT config.selected_model,config.selected_effort,config.fast_mode,config.model_catalog,
                  agent.id agent_id,agent.kind agent_kind,agent.name agent_name,agent.handle agent_handle,
                  actor.id actor_id,actor.kind actor_kind,actor.name actor_name,actor.handle actor_handle
           FROM agents config JOIN identities agent ON agent.id=config.agent_id
           JOIN identities actor ON actor.id=$2 WHERE config.agent_id=$1 FOR UPDATE`,
          [input.agentId, viewerId],
        )
      ).rows[0];
      if (!context) throw new Error('agent not found');
      if (hasModel && input.model) {
        const axis = context.model_catalog.find((candidate) => candidate.category === 'model');
        if (!axis?.options.some((choice) => choice.id === input.model)) {
          throw new Error('model is not available in the live harness catalog');
        }
      }
      if (hasEffort && input.effort) {
        const axis = effortCatalogAxis(context.model_catalog);
        if (!axis?.options.some((choice) => choice.id === input.effort)) {
          throw new Error('effort is not available in the live harness catalog');
        }
      }
      if (input.fastMode === true) {
        const axis = context.model_catalog.find(
          (candidate) => candidate.id === 'fast-mode' && candidate.category === 'model_config',
        );
        const modelAxis = context.model_catalog.find((candidate) => candidate.category === 'model');
        if (
          !axis?.options.some((choice) => choice.id === 'on') ||
          !axis.options.some((choice) => choice.id === 'off') ||
          (hasModel && input.model !== context.selected_model) ||
          (modelAxis && context.selected_model && modelAxis.currentValue !== context.selected_model)
        ) {
          throw new Error('Fast mode is unavailable for the selected model and harness');
        }
      }
      const resetFastMode = hasModel && input.model !== context.selected_model;
      await database.query(
        `UPDATE agents
         SET selected_model=CASE WHEN $2 THEN $3 ELSE selected_model END,
             selected_effort=CASE WHEN $4 THEN $5 ELSE selected_effort END,
             fast_mode=CASE WHEN $6 THEN $7 WHEN $8 THEN false ELSE fast_mode END,
             updated_at=now()
         WHERE agent_id=$1`,
        [
          input.agentId,
          hasModel,
          input.model ?? null,
          hasEffort,
          input.effort ?? null,
          hasFastMode,
          input.fastMode ?? false,
          resetFastMode,
        ],
      );
      const changes: Array<{ axis: 'model' | 'effort' | 'fast mode'; value: string | null }> = [];
      if (hasModel && (input.model ?? null) !== context.selected_model)
        changes.push({ axis: 'model', value: input.model ?? null });
      if (hasEffort && (input.effort ?? null) !== context.selected_effort)
        changes.push({ axis: 'effort', value: input.effort ?? null });
      const nextFastMode = hasFastMode
        ? input.fastMode!
        : resetFastMode
          ? false
          : context.fast_mode;
      if (nextFastMode !== context.fast_mode)
        changes.push({ axis: 'fast mode', value: nextFastMode ? 'on' : 'off' });
      if (!changes.length) return;
      const rooms = await database.query<{ room_id: string }>(
        `SELECT membership.room_id FROM memberships membership
         JOIN rooms room ON room.id=membership.room_id
         WHERE membership.identity_id=$1 AND membership.workspace_id=$2
           AND membership.removed_at IS NULL AND room.archived_at IS NULL`,
        [input.agentId, input.workspaceId],
      );
      // Hot-restart wake: every daemon live subscription of these Rooms filters
      // on the target agent, so its retained sessions retire at once and the
      // next turn cold-activates against the saved selection — exactly what
      // session start reads. A change that wrote nothing sends no wake, and a
      // plain reconnect never sees one. The direct pg_notify rides this same
      // transaction (delivered on commit, dropped on rollback) to every server
      // machine's live listener, since the agents table carries no Room for a
      // row trigger to name.
      for (const room of rooms.rows) {
        await notifyAgentConfigRoom(database, room.room_id, input.agentId);
      }
      // Selected model and effort remain queryable on agents.
    });
  }

  /**
   * An exact `@agent /login` message already wrote its card under routing
   * (`agent-command.ts`); once that commits, ask the agent's machine for the
   * claude.ai link without holding the send open.
   */
  export function phoneBeginAgentSignIn(ctx: PhoneContext, input: { roomId: string; text: string }, messageId: string) {
    if (!ctx.live || !isTaggedLoginText(input.text)) return;
    void beginAgentSignInCards(ctx.database, ctx.live, input.roomId, messageId).catch((error) =>
      console.error(
        '[agent-sign-in] start failed',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  /** Owner-only; the card and sign-in forwarding rules live in `agent-sign-in.ts`. */
  export async function phoneCompleteAgentSignIn(ctx: PhoneContext, input: Input<'completeAgentSignIn'>, viewerId: string) {
    if (!ctx.live) throw new Error(AGENT_SIGN_IN_NO_ANSWER_MESSAGE);
    return completeAgentSignInCard(ctx.database, ctx.live, input, viewerId);
  }

  export async function phoneRefreshAgentModelCatalog(ctx: PhoneContext,
    input: Input<'refreshAgentModelCatalog'>,
    viewerId: string,
  ) {
    await phoneRequireWorkspaceAgent(ctx, input.workspaceId, input.agentId, viewerId);
    await ctx.database.transaction(async (database) => {
      // Empty the stale snapshot first. A successful daemon probe replaces it;
      // a failed probe therefore cannot leave the phone offering choices for
      // the wrong model.
      await database.query(
        `UPDATE agents SET model_catalog='[]'::jsonb,updated_at=now() WHERE agent_id=$1`,
        [input.agentId],
      );
      const rooms = await database.query<{ room_id: string }>(
        `SELECT membership.room_id FROM memberships membership
         JOIN rooms room ON room.id=membership.room_id
         WHERE membership.identity_id=$1 AND membership.workspace_id=$2
           AND membership.removed_at IS NULL AND room.archived_at IS NULL`,
        [input.agentId, input.workspaceId],
      );
      for (const room of rooms.rows) {
        await notifyAgentConfigRoom(database, room.room_id, input.agentId);
      }
    });
  }

  /**
   * Repository grants require a Workspace manager; personal resources require
   * their owner. Authority is checked here, never entrusted to the phone. The
   * decision settles the card in place and posts one system line mentioning
   * the agent so its daemon wakes and resumes the paused turn.
   */
  export async function phoneDecideAgentGrant(ctx: PhoneContext, input: Input<'decideAgentGrant'>, viewerId: string,
    defer?: (notification: () => void) => void) {
    const decision: AgentGrantDecision | undefined =
      input.decision === 'always' || input.decision === 'once' || input.decision === 'deny'
        ? input.decision
        : undefined;
    if (!decision) throw new Error('grant decision is invalid');
    const grant = await phoneRequireGrantAuthority(ctx, input.grantId, viewerId);
    if (grant.kind === 'shared_asset' && decision === 'once')
      throw new Error('shared asset isolation: a standing approval is required');
    if (grant.status !== 'pending') throw new Error('grant decision conflict: already decided');
    // Existing pending Squire cards may still live in the source Room. Find
    // the card by its exact grant id so an upgrade settles either placement.
    const cardRoomIds =
      (
        await ctx.database.query<{ room_id: string }>(
          `SELECT message.room_id FROM messages message
         JOIN rooms room ON room.id=message.room_id
         WHERE room.workspace_id=$2 AND message.card_type='grant-request'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(message.card->'grants') entry
             WHERE entry->>'grantId'=$1
           )
         ORDER BY message.created_at DESC,message.id DESC`,
          [input.grantId, grant.workspace_id],
        )
      ).rows.map((row) => row.room_id);
    if (!cardRoomIds.length) cardRoomIds.push(grant.room_id);
    const status: AgentGrantStatus =
      decision === 'always' ? 'approved' : decision === 'once' ? 'once' : 'denied';
    const decider = await phoneRequireIdentity(ctx, viewerId);
    await ctx.database.transaction(async (database) => {
      const updated = await database.query<{ decided_at: Date }>(
        `UPDATE agent_grants SET status=$2,decided_by=$3,decided_at=now()
         WHERE id::text=$1 AND status='pending' AND superseded_at IS NULL RETURNING decided_at`,
        [input.grantId, status, viewerId],
      );
      const decidedAt = updated.rows[0]?.decided_at;
      if (!decidedAt) throw new Error('grant decision conflict: already decided or superseded; open the current card');
      for (const roomId of new Set(cardRoomIds))
        await settleGrantCard(database, {
          roomId, grantId: input.grantId, status, decidedBy: decider, decidedAt,
        });
      // The text this composes is exactly `formatGrantDecisionLine`'s shape
      // (`<decider> approved command npm test`): the daemon recognises the
      // owner's answer structurally with `parseGrantDecisionLine`, and the
      // mention on a freshly-inserted row is what wakes it (a settled card's
      // own JSONB update carries no mention and would not be seen as new).
      // C101: kept deliberately for that wake, but never rendered — the
      // settled card above already carries the same answer for a human
      // reader, so this row is excluded from every phone-visible transcript
      // query (`roomMessages`/`messageRows`) by its card_type.
      await systemLine(database, {
        roomId: grant.room_id,
        authorId: viewerId,
        subject: identitySubject({ id: decider.pubkey, kind: decider.kind, name: decider.name }),
        verb:
          decision === 'always' ? systemMessage("phone-service.approved") : decision === 'once' ? systemMessage("phone-service.approved-once") : systemMessage("phone-service.declined"),
        // A resume kind: it answers a turn already paused on the ask, and must
        // never start a second one (`RESUME_KINDS`).
        kind: 'grant-decided',
        commandId: (
          await database.query<{ command_id: string }>(
            `SELECT command_id FROM agent_grants WHERE id=$1`,
            [input.grantId],
          )
        ).rows[0]?.command_id,
        object: systemMessage("phone-service.grant-target", grant.kind, grant.target),
        wakes: [grant.agent_id],
        cardType: 'grant-decision',
        card: { grantId: input.grantId, status },
      });
    });
    for (const roomId of new Set(cardRoomIds)) {
      if (roomId === grant.room_id) continue;
      const notify = () => ctx.live?.publish({ type: 'invalidate', roomId, reason: 'grant' });
      if (defer) defer(notify); else notify();
    }
    return { grantId: input.grantId, status, roomId: grant.room_id };
  }

  /** Revoke is one tap on the profile; a command rule stops matching at once. */
  export async function phoneRevokeAgentGrant(ctx: PhoneContext, input: Input<'revokeAgentGrant'>, viewerId: string) {
    const grant = await phoneRequireGrantAuthority(ctx, input.grantId, viewerId);
    // The profile shows who revoked it and when, in the same two columns.
    const revoked = await ctx.database.query(
      `UPDATE agent_grants SET status='revoked',decided_by=$2,decided_at=now()
       WHERE id::text=$1 AND status IN ('approved','once')`,
      [input.grantId, viewerId],
    );
    if (!revoked.rowCount) throw new Error('grant revoke conflict: grant is not active');
    return { grantId: input.grantId, status: 'revoked' as const, roomId: grant.room_id };
  }
