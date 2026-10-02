/**
 * Agent health for the ordered agent lists a Room reviewer and a workflow
 * role can name: which listed agent should take the work now, and whether an
 * agent holds a Room's reviewer post.
 *
 * Health is derived from facts this codebase already keeps, never a new
 * stored status:
 *  - "online" is the status on the agent's latest `live_outputs
 *    kind='presence'` row, however old. Presence is event-driven: a helper
 *    never calls in to keep it fresh, so its age says nothing. Only an event
 *    writes `offline` — an unanswered delivery (`ConnectionPresence`) or an
 *    `available:false` announce.
 *  - "recently failed" and "out of credit" both read the agent's most recent
 *    `agent_turns` row (index `agent_turns_agent_activity`) and, when it
 *    failed, the `turn-failed` message card's `silenceKind`
 *    (`turn-silence-notice.ts`). `allowance-spent` (the provider's API
 *    allowance, not the wallet feature) is a STANDING condition — it doesn't
 *    clear itself on a timer, only on a later non-failed turn — while every
 *    other failure kind (wrong-model, not-signed-in, hiccup, ...) is only
 *    disqualifying for `AGENT_RECENT_FAILURE_MS`.
 */
import type { SqlDatabase } from './database.js';

export const AGENT_RECENT_FAILURE_MS = 5 * 60 * 1000;

export type AgentHealthReason = 'offline' | 'recent-failure' | 'out-of-credit';
export type AgentHealth = { healthy: boolean; reason?: AgentHealthReason };

type CandidateRow = {
  agent_id: string;
  online: boolean;
  turn_status: 'working' | 'complete' | 'failed' | 'cancelled' | null;
  turn_created_at: Date | null;
  silence_kind: string | null;
};

function candidateHealth(row: CandidateRow, now: number): AgentHealth {
  if (!row.online) return { healthy: false, reason: 'offline' };
  if (row.turn_status === 'failed') {
    if (row.silence_kind === 'allowance-spent') return { healthy: false, reason: 'out-of-credit' };
    const age = row.turn_created_at ? now - row.turn_created_at.getTime() : Infinity;
    if (age < AGENT_RECENT_FAILURE_MS) return { healthy: false, reason: 'recent-failure' };
  }
  return { healthy: true };
}

/** Health of each listed agent that is a current agent member of `roomId`; non-members are absent. */
export async function roomAgentHealth(
  db: SqlDatabase,
  roomId: string,
  agentIds: readonly string[],
): Promise<Map<string, AgentHealth>> {
  if (!agentIds.length) return new Map();
  const rows = await db.query<CandidateRow>(
    `SELECT agent.agent_id,
            COALESCE((
              SELECT lo.body->>'status'='online'
              FROM live_outputs lo
              WHERE lo.agent_id=agent.agent_id AND lo.kind='presence'
              ORDER BY lo.updated_at DESC LIMIT 1
            ),false) online,
            latest.status turn_status,latest.created_at turn_created_at,
            failure.silence_kind
     FROM memberships member
     JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
     JOIN agents agent ON agent.agent_id=identity.id
     LEFT JOIN LATERAL (
       SELECT status,created_at,request_id,room_id FROM agent_turns
       WHERE agent_id=agent.agent_id ORDER BY created_at DESC LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT card->>'silenceKind' silence_kind FROM messages
       WHERE room_id=latest.room_id AND card_type='turn-failed'
         AND card->>'requestId'=latest.request_id AND card->>'agentId'=agent.agent_id
       ORDER BY created_at DESC LIMIT 1
     ) failure ON latest.status='failed'
     WHERE member.room_id=$1 AND member.removed_at IS NULL
       AND member.identity_id=ANY($2::text[])`,
    [roomId, [...new Set(agentIds)]],
  );
  const now = Date.now();
  return new Map(rows.rows.map((row) => [row.agent_id, candidateHealth(row, now)]));
}

/** The first healthy current Room member on `ordered`, skipping `exclude`; `null` when none is. */
export async function firstHealthyAgent(
  db: SqlDatabase,
  roomId: string,
  ordered: readonly string[],
  exclude: readonly string[] = [],
): Promise<string | null> {
  const health = await roomAgentHealth(db, roomId, ordered);
  return ordered.find((id) => !exclude.includes(id) && health.get(id)?.healthy) ?? null;
}

/**
 * Failover from `failed`: the first healthy agent after it on `ordered`, never
 * one before it, so a list only moves forward. An agent not on the list (a
 * human's `assign_workflow_role` pick) fails over from the top of the list.
 */
export async function nextHealthyAgent(
  db: SqlDatabase,
  roomId: string,
  ordered: readonly string[],
  failed: string,
): Promise<string | null> {
  return firstHealthyAgent(db, roomId, ordered.slice(ordered.indexOf(failed) + 1), [failed]);
}

/** A Room's reviewer list in order: the configured reviewer, then its fallbacks. */
export function reviewerList(room: {
  reviewer_agent_id: string | null;
  reviewer_fallback_ids: readonly string[] | null;
}): string[] {
  if (!room.reviewer_agent_id) return [];
  return [
    room.reviewer_agent_id,
    ...(room.reviewer_fallback_ids ?? []).filter((id) => id !== room.reviewer_agent_id),
  ];
}

/**
 * Whether `agentId` holds a Room's reviewer post: the configured reviewer
 * itself, or one of its fallbacks that is a current parent member. Used at
 * every point that accepts a fallback reviewer without loosening the fixed
 * reviewer check (`approve_merge`, the review validation stage, and the
 * corner-reviewer fast path in `DaemonService.access`).
 */
export async function isConfiguredReviewer(
  db: SqlDatabase,
  parentRoomId: string,
  agentId: string,
): Promise<boolean> {
  const room = (
    await db.query<{ reviewer_agent_id: string | null; reviewer_fallback_ids: string[] | null }>(
      `SELECT reviewer_agent_id,reviewer_fallback_ids FROM rooms WHERE id=$1`,
      [parentRoomId],
    )
  ).rows[0];
  if (!room?.reviewer_agent_id) return false;
  if (room.reviewer_agent_id === agentId) return true;
  if (!reviewerList(room).includes(agentId)) return false;
  const member = await db.query(
    `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
    [parentRoomId, agentId],
  );
  return member.rowCount > 0;
}
