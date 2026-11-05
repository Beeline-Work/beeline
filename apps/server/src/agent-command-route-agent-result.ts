import { endAgentTurn } from './agent-turn-end.js';
import { ExpectedRefusalError } from './command-refusal.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { assertCurrentTurnOwner, commandOwnerFenceCteSql, commandOwnerFenceMatchesSql, commandOwnerLiveSql, registerOwnedEffectFence } from './turn-ownership.js';
import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';
import { recordMcpMention, recordMcpMemberWebhook } from './rooms-mcp-members.js';
import { commandOrder, reportToCommander } from './commander.js';
import { workflowOutputBindingCtes } from './workflow-step-output.js';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { resolveCurrentMemberMentions, typedMentionHandles, isChannelMentionToken } from './message-mentions.js';
import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';
import { CommandRow, nextAgentDepth, commandValidityCtes, reviewerQuietSql, waitingReportSql, ordinaryWakeSql } from './agent-command.js';
import { createAgentCommand } from './agent-command-create-agent-command.js';



export async function routeAgentResult(
  db: SqlDatabase,
  parent: CommandRow | undefined,
  sourceId: string,
  speaker?: { roomId: string; agentId: string; initialAgentDepth?: 1 },
) {
  const addressedRoomId = speaker?.roomId ?? parent?.room_id;
  const agentId = speaker?.agentId ?? parent?.agent_id;
  const woken: string[] = [];
  const notWoken: { handle: string; reason: string }[] = [];
  if (!addressedRoomId || !agentId) return { woken, notWoken };
  const source = (await db.query<{ text: string; room_id: string }>(
    `SELECT text,room_id FROM messages WHERE id=$1 AND room_id=$2 AND author_id=$3
       AND presentation='message' AND deleted_at IS NULL`,
    [sourceId, addressedRoomId, agentId],
  )).rows[0];
  if (!source) return { woken, notWoken };
  const roomId = source.room_id;
  const mentions = await resolveCurrentMemberMentions(db, roomId, source.text, parent && parent.room_id !== roomId ? undefined : agentId);
  for (const handle of typedMentionHandles(source.text)) {
    if (isChannelMentionToken(handle)) continue;
    if (!mentions.some(mention => mention.handle === handle))
      notWoken.push({ handle, reason: 'not another current member or not an unambiguous handle' });
  }
  for (const mention of mentions) {
    if (mention.kind !== 'agent') {
      notWoken.push({ handle: mention.handle, reason: 'person tagged; no agent turn' });
      continue;
    }
    if (mention.mcpMember) {
      // An external member's tag is delivery, not another helper command.
      // Preserve it and its webhook even when the helper chain is exhausted.
      await recordMcpMention(db, mention.id, roomId, sourceId);
      if (mention.mcpCallbackUrl) {
        await recordMcpMemberWebhook(db, mention.id, mention.mcpCallbackUrl, roomId, sourceId, source.text);
        woken.push(mention.handle);
      } else {
        const live = (await db.query(`SELECT 1 FROM rooms_mcp_members member
          JOIN rooms_mcp_connections connection ON connection.client_id=member.client_id
            AND connection.identity_id=member.owner_id AND connection.revoked_at IS NULL
          WHERE member.member_id=$1 AND (member.last_bridge_poll_at>now()-interval '60 seconds'
            OR EXISTS(SELECT 1 FROM rooms_mcp_event_subscriptions subscription
              JOIN rooms_mcp_event_deliveries delivery ON delivery.subscription_id=subscription.id AND delivery.message_id=$2
              WHERE subscription.member_id=member.member_id AND subscription.expires_at>now()))`,
        [mention.id, sourceId])).rowCount;
        if (live) woken.push(mention.handle);
        else notWoken.push({ handle: mention.handle, reason: 'no live wake route; sees it on next list_mentions' });
      }
      continue;
    }
    // Tags are conversation, never a delegation or an implementer change.
    const dispatch = (db: SqlDatabase) => createAgentCommand(db, {
      roomId,
      agentId: mention.id,
      sourceMessageId: sourceId,
      parent,
      reason: 'agent_tag',
      inheritPrivatePayload: false,
    });
    // An external member contributes the first hop without owning a command.
    // Commit that depth with the helper wake so a claim cannot see depth zero.
    const dispatched = speaker?.initialAgentDepth && !parent
      ? await db.transaction(async (tx) => {
        const command = await dispatch(tx);
        if (command) await tx.query('UPDATE agent_commands SET agent_depth=$2 WHERE id=$1',
          [command.id, speaker.initialAgentDepth]);
        return command;
      })
      : await dispatch(db);
    if (dispatched) woken.push(mention.handle);
    else notWoken.push({ handle: mention.handle, reason: parent && nextAgentDepth(parent.agent_depth) === undefined
      ? 'agent tag chain depth limit reached' : 'agent or place is no longer available' });
  }
  return { woken, notWoken };
}


/**
 * Marks the handback-limit line so push delivery (`background.ts`) can send it
 * to the corner's commissioner. The phone has no renderer for it, so the line
 * still shows as a plain system line.
 */
export const CORNER_REVIEW_DEADLOCK_CARD_TYPE = 'corner-review-deadlock';


/** Legacy discriminator retained for historical checks-blocked lines. */
export const CORNER_CHECKS_BLOCKED_CARD_TYPE = 'corner-checks-blocked';


/** Historical discriminator; new queue refusals are private commander reports. */
export const CORNER_AGENT_UNREACHABLE_CARD_TYPE = 'corner-agent-unreachable';


/**
 * Marks the line a green head with no other reviewer writes. Its card names
 * the people whose yes can merge it (`card.approverIds`), and push delivery
 * (`corner-owed.ts`) sends it to them; like the two above it renders as a
 * plain system line.
 */
export const CORNER_MERGE_YES_CARD_TYPE = 'corner-merge-yes';


/** Push one helper's eligible orders after an actual connection or pickup event.
 * Busy Rooms wait for the committed command release; other Rooms remain eligible.
 * Bootstrap also enumerates every pending Room, independently of this bounded hint.
 * There is no unscoped discovery or elapsed-time retry admission. */
export async function renudgeStrandedPendingCommands(db: SqlDatabase, agentId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `WITH due AS MATERIALIZED (
       SELECT command.id
       FROM agent_commands command
       JOIN agent_connections connection ON connection.agent_id=command.agent_id
         AND connection.released_at IS NULL
       JOIN live_server_instances server ON server.instance_id=connection.instance_id
         AND server.renewed_at>clock_timestamp()-interval '90 seconds'
       WHERE command.state='pending' AND command.action='input'
         AND command.reason IN ('human_tag','direct_message','order')
         AND command.agent_id=$1
         AND NOT EXISTS (
           SELECT 1 FROM agent_commands busy
           WHERE busy.agent_id=command.agent_id AND busy.room_id=command.room_id
             AND busy.state='claimed' AND ${commandOwnerLiveSql('busy', 'clock_timestamp()')}
         )
       ORDER BY command.created_at,command.id LIMIT 100
       FOR UPDATE OF command SKIP LOCKED
     ), renudged AS (
       UPDATE agent_commands command SET renudged_at=clock_timestamp()
       FROM due WHERE command.id=due.id AND command.state='pending'
       RETURNING command.id
     ) SELECT count(*)::int count FROM renudged`,
    [agentId],
  );
  return Number(result.rows[0]?.count ?? 0);
}


/** Claims and human Stops serialize before taking command or turn row locks. */
export async function lockAgentCommandQueue(db: SqlDatabase, roomId: string, agentId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('agent-command-queue:' || ($1::uuid)::text || ':' || $2::text))", [roomId, agentId]);
}


/** The Stop transaction's timestamp fences orders accepted after the Stop. */
export async function dropQueuedOrdersForStop(db: SqlDatabase, stopped: CommandRow): Promise<number> {
  const order = await commandOrder(db, stopped);
  if (order.private_payload?.kind !== 'order' || order.agent_id !== stopped.agent_id) return 0;
  const dropped = await db.query<CommandRow>(
    `SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(agent_commands.id,agent_commands.generation_id,'cancelled','stop',NULL) ended FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action='input'
       AND state='pending'
       AND private_payload->>'kind'='order'
       AND private_payload->>'authorId'=$3 AND private_payload->>'fromRoomId'=$4
       AND created_at<=now() AND turn_request_id<>$5) terminal`,
    [stopped.room_id, stopped.agent_id, order.private_payload.authorId,
      order.private_payload.fromRoomId, stopped.turn_request_id],
  );
  if (dropped.rowCount) {
    await reportToCommander(db, stopped.room_id, stopped.agent_id,
      systemMessage("agent-command.failed-queued-dropped-by-a-stop-the-running-turn-was-cancelled", dropped.rowCount, dropped.rowCount === 1 ? systemMessage("agent-command.order-was") : systemMessage("agent-command.orders-were")),
      dropped.rows[0], createHash('sha256').update(`stop-orders:${stopped.id}`).digest('hex'), { automatic: true });
  }
  return dropped.rowCount;
}


export type WakeDropLog = { drops: Record<string, unknown>[] };


export function logStaleWakeDrops(drops: WakeDropLog['drops'] | undefined): void {
  for (const drop of drops ?? []) console.info(JSON.stringify(drop));
}


export class StaleWakeClaimRefused extends Error {
  constructor(readonly drops: WakeDropLog['drops']) { super('command claim conflict'); }
  log(): void { logStaleWakeDrops(this.drops); }
}


export async function claimAgentCommand(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  commandId: string,
  generation: string,
  owner?: HelperTurnOwnershipSource,
  allPending = false,
): Promise<CommandRow> {
  if (!generation || generation.length > 200) throw new Error('command generation is required');
  if (owner) {
    await assertCurrentTurnOwner(db, agentId, owner);
    const existing = (await db.query<CommandRow & { turn_cancelled: boolean }>(
      `SELECT command.*,EXISTS(SELECT 1 FROM agent_turns turn
         WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
           AND turn.request_id=command.turn_request_id AND turn.status='cancelled') turn_cancelled
       FROM agent_commands command WHERE command.id=$1 AND command.room_id=$2 AND command.agent_id=$3
         AND command.state='claimed' AND command.generation_id=$4
         AND beeline_command_claim_open(command.id)
         AND command.turn_owner_connection_id=$5 AND command.turn_owner_epoch=$6
       FOR UPDATE OF command`,
      [commandId, roomId, agentId, generation, owner.connectionId, owner.epoch],
    )).rows[0];
    if (existing) {
      if (existing.turn_cancelled) throw new Error('command turn cancelled');
      return existing; // A resolved replay is a read, never a fake working/progress write.
    }
  }
    const row = (
      await db.query<CommandRow & WakeDropLog & { turn_claimed: boolean }>(
        `WITH claim_fence AS MATERIALIZED (
             SELECT pg_advisory_xact_lock(hashtext('agent-command-queue:' || ($2::uuid)::text || ':' || $3::text))
           ), ${commandValidityCtes('$2', '$3', '$1', true, false)}, eligible AS MATERIALIZED (
             SELECT agent_commands.* FROM agent_commands CROSS JOIN claim_fence
             WHERE (id=$1 OR ($7::boolean AND state='pending' AND action IN ('input','resume')))
               AND room_id=$2 AND agent_id=$3 AND
               beeline_command_claim_open(id) AND
               (state='pending' OR (state='claimed' AND generation_id=$4)
                )
               AND (generation_id IS DISTINCT FROM $4 OR
                 (turn_owner_connection_id IS NOT DISTINCT FROM $5::text AND turn_owner_epoch IS NOT DISTINCT FROM $6::bigint))
               AND NOT EXISTS(SELECT 1 FROM cancelled_wakes cancelled WHERE cancelled.id=agent_commands.id)
               AND ${reviewerQuietSql('agent_commands')} AND ${waitingReportSql('agent_commands')}

               AND (${ordinaryWakeSql('agent_commands')} OR (state='claimed' AND generation_id=$4) OR NOT EXISTS (
                 SELECT 1 FROM agent_commands human WHERE human.room_id=$2 AND human.agent_id=$3
                   AND human.reason<>'computer_activity' AND human.action IN ('input','resume')
                   AND (human.state='pending' OR (human.state='claimed' AND ${commandOwnerLiveSql('human')}))
               ))
             FOR UPDATE OF agent_commands
           ), working AS (
             INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
             SELECT room_id,turn_request_id,agent_id,'working',$4 FROM eligible
             WHERE action<>'stop' AND action<>'restart'
             ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET
               status='working',generation_id=EXCLUDED.generation_id,failure_reason=NULL,created_at=now(),
               started_at=CASE WHEN agent_turns.status='working'
                 AND agent_turns.generation_id=EXCLUDED.generation_id
                 THEN agent_turns.started_at ELSE now() END
             WHERE agent_turns.status<>'cancelled'
             RETURNING room_id,agent_id,request_id
           ), claimed AS (
             UPDATE agent_commands command SET state='claimed',generation_id=$4,
               lease_expires_at=NULL,claimed_at=now(),
               turn_owner_connection_id=$5::text,turn_owner_epoch=$6::bigint
             FROM eligible
             WHERE command.id=eligible.id AND
               (eligible.action='stop' OR eligible.action='restart' OR EXISTS(SELECT 1 FROM working
                 WHERE working.room_id=command.room_id AND working.agent_id=command.agent_id
                   AND working.request_id=command.turn_request_id))
             RETURNING command.*
           ), resolved_corner_attention AS (
             UPDATE messages notice SET card=jsonb_set(notice.card,'{status}','"resolved"')
             FROM claimed command
             WHERE command.action IN ('input','resume') AND notice.room_id=command.room_id
               AND notice.card_type='${CORNER_AGENT_UNREACHABLE_CARD_TYPE}'
               AND notice.card->>'agentId'=command.agent_id
               AND COALESCE(notice.card->>'status','open')='open'
             RETURNING notice.id
           ), ${workflowOutputBindingCtes('claimed')}, claim_result AS (
           SELECT claimed.*,true turn_claimed FROM claimed
           UNION ALL
           SELECT eligible.*,false turn_claimed FROM eligible
           WHERE eligible.action<>'stop' AND eligible.action<>'restart'
             AND NOT EXISTS(SELECT 1 FROM working WHERE working.room_id=eligible.room_id
               AND working.agent_id=eligible.agent_id AND working.request_id=eligible.turn_request_id)
           ) SELECT claim_result.*,wake_drop_log.drops FROM wake_drop_log LEFT JOIN claim_result ON true
             ORDER BY claim_result.created_at,claim_result.id`,
        [commandId, roomId, agentId, generation, owner?.connectionId ?? null, owner?.epoch ?? null, allPending],
      )
    ).rows[0];
    if (!row?.id) {
      if (row?.drops.length) throw new StaleWakeClaimRefused(row.drops);
      throw new Error('command claim conflict');
    }
    logStaleWakeDrops(row.drops);
    if (!row.turn_claimed) throw new Error('command turn cancelled');
    if (owner) await registerOwnedEffectFence(db, row);
    return row;
}


/** Connected-app ingress selects an order; claimAgentCommand alone decides eligibility.
 * Explicit calls reuse a live MCP generation across tools until report, never a helper owner. */
export async function claimMcpOrder(db: SqlDatabase, agentId: string, target: string,
  generation: string, commandId?: string): Promise<CommandRow | undefined> {
  const waiting = (await db.query<CommandRow>(
    `SELECT command.* FROM agent_commands command
     JOIN rooms room ON room.id=command.room_id AND room.archived_at IS NULL
     JOIN room_access member ON member.room_id=room.id AND member.identity_id=$1 AND member.removed_at IS NULL
     WHERE command.agent_id=$1 AND command.action IN ('input','resume')
       AND command.private_payload->>'kind'='order'
       AND ($3::text IS NULL OR (command.id=$3 AND command.room_id=$2))
       AND (command.state='pending' OR (command.state='claimed' AND
         ($3::text IS NOT NULL AND command.generation_id LIKE 'mcp:%')))
     ORDER BY (command.room_id=$2) DESC,command.created_at,command.id`,
    [agentId, target, commandId ?? null])).rows;
  if (!commandId && !waiting.some(row => row.room_id === target) && waiting.length > 1)
    throw new ExpectedRefusalError(`ambiguous report; pass commandId from the order: ${waiting.map(row => `${row.id} at ${row.room_id}`).join(', ')}`);
  const selected = waiting[0];
  if (!selected) return undefined;
  // Stop and claims take this same queue lock before inspecting or writing ownership.
  await lockAgentCommandQueue(db, selected.room_id, agentId);
  const current = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1 FOR UPDATE`, [selected.id])).rows[0];
  const reuse = commandId && current?.state === 'claimed' && current.generation_id?.startsWith('mcp:');
  return claimAgentCommand(db, selected.room_id, agentId, selected.id, reuse ? current.generation_id! : generation);
}


/** Inbox dismissal does not start a turn: queued non-orders may be handled
 * directly, while orders still require a report and live owners retain their work. */
export async function dismissAgentCommandWakes(db: SqlDatabase, roomId: string, agentId: string,
  commandId?: string): Promise<number> {
  return db.transaction(async db => {
    await lockAgentCommandQueue(db, roomId, agentId);
    const waiting = (await db.query<CommandRow>(`SELECT command.* FROM agent_commands command
      JOIN rooms room ON room.id=command.room_id AND room.archived_at IS NULL
      JOIN room_access member ON member.room_id=room.id AND member.identity_id=command.agent_id AND member.removed_at IS NULL
      WHERE command.room_id=$1 AND command.agent_id=$2 AND command.action IN ('input','resume') AND command.reason<>'mcp_call'
        AND ($3::text IS NULL OR command.id=$3)
        AND ($3::text IS NOT NULL OR COALESCE(command.private_payload->>'kind','')<>'order')
        AND command.state='pending'
      ORDER BY command.created_at,command.id FOR UPDATE OF command`, [roomId,agentId,commandId ?? null])).rows;
    if (waiting.some(command => command.private_payload?.kind === 'order'))
      throw new ExpectedRefusalError('that wake is an order; answer it with report');
    for (const command of waiting) await endAgentTurn(db, command, 'complete');
    return waiting.length;
  });
}


/** A refused report leaves its order owed, without reviving a Stop or cancelled turn. */
export async function releaseUnreportedMcpOrder(db: SqlDatabase, commandId: string, generation: string): Promise<void> {
  const command = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [commandId])).rows[0];
  if (!command) return;
  await lockAgentCommandQueue(db, command.room_id, command.agent_id);
  await db.query(`WITH released AS (
    UPDATE agent_commands command SET state='pending',generation_id=NULL,lease_expires_at=NULL,claimed_at=NULL
    WHERE id=$1 AND state='claimed' AND generation_id=$2
      AND NOT EXISTS (SELECT 1 FROM agent_turns turn WHERE turn.room_id=command.room_id
        AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id AND turn.status='cancelled')
    RETURNING room_id,agent_id,turn_request_id
  ) DELETE FROM agent_turns turn USING released
    WHERE turn.room_id=released.room_id AND turn.agent_id=released.agent_id
      AND turn.request_id=released.turn_request_id AND turn.status='working' AND turn.generation_id=$2`, [commandId, generation]);
}


export async function authorizeCommandOutput(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  requestId: unknown,
  generation: unknown,
  allowCompleted = false,
  registerEffect = true,
): Promise<CommandRow> {
  const row =
    typeof requestId === 'string' && typeof generation === 'string'
      ? (
          await db.query<CommandRow & { turn_cancelled: boolean }>(
            `WITH ${commandOwnerFenceCteSql('owned_command.room_id=$1 AND owned_command.agent_id=$2 AND owned_command.turn_request_id=$3 AND owned_command.generation_id=$4')}
             SELECT command.*,
               EXISTS(SELECT 1 FROM agent_turns turn
                 WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
                   AND turn.request_id=command.turn_request_id AND turn.status='cancelled') turn_cancelled
             FROM agent_commands command
             WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
               AND command.action IN ('input','resume') AND command.generation_id=$4
               AND ${commandOwnerFenceMatchesSql('command')}
             ORDER BY command.created_at DESC,command.id DESC LIMIT 1 FOR UPDATE OF command`,
            [roomId, agentId, requestId, generation],
          )
        ).rows[0]
      : undefined;
  if (!row || (row.state !== 'claimed' && !(allowCompleted && row.state === 'complete'))) {
    console.error('command output rejected', {
      command: row?.id,
      agent: agentId,
      room: roomId,
      generation: typeof generation === 'string' ? generation : undefined,
    });
    throw new Error('command output authority rejected');
  }
  if (row.turn_cancelled) throw new Error('command turn cancelled');
  if (row.turn_owner_connection_id) {
    await assertCurrentTurnOwner(db, agentId, {
      connectionId: row.turn_owner_connection_id, epoch: Number(row.turn_owner_epoch),
    });
    if (registerEffect) await registerOwnedEffectFence(db, row);
  }
  return row;
}


export type MergeCard = {
  cornerId?: string;
  name?: string;
  pullRequest?: { number?: number; url?: string; mergeCommitSha?: string };
};


/**
 * A parent-Room merge card's sentence names only the pull request title, so an
 * agent woken by a `merged` subscription reads which corner and pull request
 * landed from the card itself.
 */
export function mergeCardDetail(card: MergeCard | null): string {
  if (!card) return '';
  const corner = card.cornerId
    ? `corner ${card.name ? `${card.name} (${card.cornerId})` : card.cornerId}`
    : '';
  const pr = card.pullRequest;
  const pullRequest =
    pr?.number || pr?.url
      ? ['pull request', pr.number ? `#${pr.number}` : '', pr.url ?? ''].filter(Boolean).join(' ')
      : '';
  const commit = pr?.mergeCommitSha ? `merge commit ${pr.mergeCommitSha}` : '';
  const detail = [corner, pullRequest, commit].filter(Boolean).join(' · ');
  return detail ? `\n${detail}` : '';
}


export type WorkflowWakeCard = {
  runId?: string;
  workflowSlug?: string;
  note?: string;
  seq?: number;
  /** A gate answer's transition card carries the person's note in its contents. */
  contents?: { note?: unknown };
};


/**
 * A Squire decision wake names the exact approval, tool and status, so the
 * woken agent calls that tool's resume step instead of asking again.
 */
export function squireDecisionDetail(cardType: string | null, card: WorkflowWakeCard | null): string {
  if (cardType !== 'squire-approval-decision' || !card) return '';
  const { approvalId, tool, status } = card as { approvalId?: unknown; tool?: unknown; status?: unknown };
  if (typeof approvalId !== 'string' || typeof tool !== 'string' || typeof status !== 'string') return '';
  const next = status === 'approved'
    ? `Call ${tool} with action "resume" and approval_id "${approvalId}" now, then continue the work that needed it.`
    : 'Do not call its resume step.';
  return `\nSquire approval ${approvalId} for ${tool}: ${status}. ${next}`;
}


/**
 * A wake from a saved workflow run (a `workflow-handoff` card, or a gate's
 * choice/poll card once answered — see `postWorkflowGate`) states the run id
 * and workflow name plainly, so a woken agent treats its own wake as proof a
 * run already exists rather than reaching for `start_workflow` again. The
 * corner's lifecycle bookkeeping (`corner-workflow-handoff`) is excluded:
 * every corner turn would otherwise carry this line for no reason, since a
 * corner is never started through `start_workflow`. A gate answer's optional
 * note is quoted ahead of it.
 */
export function workflowWakeDetail(
  cardType: string | null,
  card: WorkflowWakeCard | null,
  state: string | null,
  outcomes: Record<string, string> | null,
  status: string | null,
): string {
  if (!card?.runId || !card.workflowSlug || cardType === CORNER_LIFECYCLE_CARD_TYPE) return '';
  const answerNote = card.note ?? (typeof card.contents?.note === 'string' ? card.contents.note : undefined);
  const note = answerNote ? `\nTheir note with the answer: ${JSON.stringify(answerNote)}` : '';
  const allowed = status ? 'none' : Object.entries(outcomes ?? {})
    .map(([outcome, target]) => `${outcome} -> ${target}`).join(', ') || 'none';
  // A dispatch card's seq is the attempt this wake is for; a later card makes it stale.
  const attempt = cardType === 'workflow-handoff' && !status
    ? `\nThis wake is attempt ${card.seq}: pass "attempt": ${card.seq} to app_tool’s beeline:workflow advance action. Discover its schema with app_tool(app="beeline:workflow") before acting. If you cannot do this step, hand off outcome "blocked" with contents {"reason": "..."} and it moves to the next agent on the role.`
    : '';
  return `${note}\nYou are in run ${card.runId} of ${card.workflowSlug}. Continue this run; do not start a new one.` +
    (state ? `\nCurrent state: ${state}${status ? ` (${status})` : ''}. Allowed outcomes: ${allowed}. Read the pinned contract and requirements with app_tool(app="beeline:workflow", tool="read", args={runId}).` : '') +
    attempt;
}
