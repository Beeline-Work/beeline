import { cornerReviewerSql } from './corner-reviewer.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import type { SqlDatabase } from './database.js';

/** Dispatch uses current presence, never a past turn failure or cooldown. */
export type AgentHealthReason = 'offline';
export type AgentHealth = { healthy: boolean; reason?: AgentHealthReason };
type CandidateRow = { agent_id: string; online: boolean };

/** Health of each listed agent that is a current agent member of `roomId`; non-members are absent. */
export async function roomAgentHealth(
  db: SqlDatabase,
  roomId: string,
  agentIds: readonly string[],
): Promise<Map<string, AgentHealth>> {
    db = new CornerAccessDatabase(db);
  if (!agentIds.length) return new Map();
  const rows = await db.query<CandidateRow>(
    `SELECT agent.agent_id,
            COALESCE((
              SELECT lo.body->>'status'='online'
              FROM live_outputs lo
              WHERE lo.agent_id=agent.agent_id AND lo.kind='presence'
              ORDER BY lo.updated_at DESC LIMIT 1
            ),false) online
     FROM memberships member
     JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
     JOIN agents agent ON agent.agent_id=identity.id
     WHERE member.room_id=$1 AND member.removed_at IS NULL
       AND member.identity_id=ANY($2::text[])`,
    [roomId, [...new Set(agentIds)]],
  );
  return new Map(rows.rows.map(row => [row.agent_id, row.online
    ? {healthy:true} : {healthy:false,reason:'offline' as const}]));
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

/**
 * The reviewer post for one corner: its override or the parent Room reviewer,
 * also a current agent member of the parent Room. It is the ONE predicate
 * every reviewer surface uses — `approveCornerMerge` and the reviewer
 * instruction `getAgentConfiguration.isReviewer` projects — so the
 * instruction a reviewer receives can never name a PASS the gate refuses.
 */
export async function isCornerReviewer(
  db: SqlDatabase,
  cornerId: string,
  agentId: string,
): Promise<boolean> {
    db = new CornerAccessDatabase(db);
  const member = await db.query(
    `SELECT 1 FROM rooms corner
     JOIN rooms parent ON parent.id=corner.parent_id
     JOIN room_access reviewer ON reviewer.room_id=parent.id AND reviewer.identity_id=$2
       AND reviewer.removed_at IS NULL
     JOIN identities identity ON identity.id=reviewer.identity_id AND identity.kind='agent'
     WHERE corner.id=$1 AND ${cornerReviewerSql()}=$2`,
    [cornerId, agentId],
  );
  return member.rowCount > 0;
}
