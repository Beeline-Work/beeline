import { cornerRunOutcomeSql } from './corner-run.js';
import type { SqlDatabase } from './database.js';
import { advanceCorner } from './corner-lifecycle.js';

export { lockCornerArchivalAuthority, archiveCornerState } from './corner-lifecycle.js';
import { cornerOwnerSql } from './corner-worker.js';

/** Release migration: old archived corners cannot have an active assignment. */
export async function cancelArchivedCornerAssignments(database: SqlDatabase): Promise<void> {
  await database.query(
    `SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(command.id,command.generation_id,'cancelled',NULL,NULL) ended FROM agent_commands command ,rooms corner WHERE corner.id=command.room_id
       AND corner.parent_id IS NOT NULL AND corner.archived_at IS NOT NULL
       AND command.state IN ('pending','claimed')) terminal`,
  );
}

/** GitHub failure must never prevent a person or agent from closing a corner. */
export async function closeCornerPullRequestBestEffort(
  database: SqlDatabase,
  cornerId: string,
  closePullRequest?: (cornerId: string) => Promise<{ status: string; blocker?: string }>,
): Promise<void> {
  const pending = await database.query(
    `SELECT 1 FROM corner_github_cache WHERE corner_id=$1
       AND lifecycle->'pr'->>'number' IS NOT NULL
       AND lifecycle->'pr'->>'mergedAt' IS NULL
       AND ${cornerRunOutcomeSql('$1::uuid')} IS DISTINCT FROM 'landed'`,
    [cornerId],
  );
  if (!pending.rowCount) return;
  try {
    if (!closePullRequest) throw new Error('GitHub is not configured on this server');
    const result = await closePullRequest(cornerId);
    if (result.status === 'blocked') throw new Error(result.blocker);
  } catch (error) {
    console.error(`[server] could not close pull request for corner ${cornerId}; closing corner anyway:`, error);
  }
}

/** A close adapter emits its authorized event; the machine executes cleanup. */
export async function closeCornerState(database: SqlDatabase, cornerId: string) {
  const outcome = await advanceCorner(database, cornerId, { kind: 'closed' });
  const corner = (await database.query<{ parent_id: string }>('SELECT parent_id FROM rooms WHERE id=$1 AND parent_id IS NOT NULL', [cornerId])).rows[0];
  if (!corner) throw new Error('corner not found');
  return { parentId: corner.parent_id, archived: outcome.archived === true };
}

/** Account deletion: the deleted agents' corners settle as done/abandoned, with the reason. */
export async function markOwnedCornersAbandoned(database: SqlDatabase, agentIds: string[], reason: string): Promise<void> {
  await database.query(
    `UPDATE corner_github_cache SET lifecycle=lifecycle||$2::jsonb
     WHERE ${cornerOwnerSql('corner_github_cache.corner_id')}=ANY($1)`,
    [agentIds, JSON.stringify({ lifecycle: 'done', outcome: 'abandoned', reason })],
  );
}
