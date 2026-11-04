import { cornerRunStateSql } from './corner-run.js';
import type { SqlDatabase } from './database.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import { advanceCorner, lockCornerLifecycle } from './corner-lifecycle.js';
import { abandonCornerWorkflowRuns } from './workflow-runs.js';
import { deleteCornerWakeSources } from './corner-wake-cleanup.js';
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';

/** Archival writers take lifecycle first, then authority before command or
 * Room/member locks. Acquiring only at the archival trigger is too late. */
export async function lockCornerArchivalAuthority(database: SqlDatabase): Promise<void> {
  await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
}
import { releaseArchivedCornerHolds } from './corner-holds.js';
import { cornerOwnerSql } from './corner-worker.js';

/**
 * Cancels every pending or claimed input/resume/restart command for a corner, and any
 * turn still marked `working`, so a corner that just landed never leaves a
 * stale assignment behind. Shared by every path that archives a corner:
 * `closeCornerState` and the GitHub merge webhook.
 * Take command locks before the room's archival UPDATE/FOR UPDATE lock:
 * command output already holds its command when dispatch locks rooms FOR SHARE.
 */
export async function cancelCornerAgentCommands(database: SqlDatabase, cornerId: string): Promise<void> {
  await lockCornerArchivalAuthority(database);
  const active = await database.query<CommandRow>(
    `SELECT * FROM agent_commands
     WHERE room_id=$1 AND action IN ('input','resume') AND state IN ('pending','claimed')
     ORDER BY created_at DESC,id DESC FOR UPDATE`,
    [cornerId],
  );
  // Only a claimed command has a helper turn to stop. A pending one never started;
  // cancelling it below is enough, and a stop for it would stay pending forever.
  const assignments = new Map<string, CommandRow>();
  for (const command of active.rows) {
    if (command.state !== 'claimed') continue;
    const key = `${command.agent_id}:${command.turn_request_id}`;
    if (!assignments.has(key)) assignments.set(key, command);
  }
  for (const command of assignments.values())
    await createAgentCommand(database, {
      roomId: cornerId,
      agentId: command.agent_id,
      sourceMessageId: command.source_message_id,
      turnRequestId: command.turn_request_id,
      action: 'stop',
      reason: 'corner_close',
      parent: command,
      retainDepth: true,
    });
  await database.query(
    `UPDATE agent_commands SET state='cancelled',completed_at=now()
     WHERE room_id=$1 AND action IN ('input','resume','restart') AND state IN ('pending','claimed')`,
    [cornerId],
  );
  await database.query(
    `UPDATE agent_turns SET status='cancelled',created_at=now()
     WHERE room_id=$1 AND status='working'`,
    [cornerId],
  );
  await database.query(`DELETE FROM agent_pending_attachments WHERE room_id=$1`, [cornerId]);
}

/** Release migration: old archived corners cannot have an active assignment. */
export async function cancelArchivedCornerAssignments(database: SqlDatabase): Promise<void> {
  await database.query(
    `UPDATE agent_commands command SET state='cancelled',completed_at=now()
     FROM rooms corner WHERE corner.id=command.room_id
       AND corner.parent_id IS NOT NULL AND corner.archived_at IS NOT NULL
       AND command.state IN ('pending','claimed')`,
  );
  await database.query(
    `UPDATE agent_turns turn SET status='cancelled'
     FROM rooms corner WHERE corner.id=turn.room_id
       AND corner.parent_id IS NOT NULL AND corner.archived_at IS NOT NULL
       AND turn.status='working'`,
  );
}

/**
 * Release migration: stops created for corners that are long closed. Close used to
 * create a stop for commands that never started; no helper polls an archived
 * corner for them, so they stayed pending. A recent stop may still reach a helper
 * finishing its turn, so only day-old ones are settled.
 */
export async function cancelStaleClosedCornerStops(database: SqlDatabase): Promise<number> {
  const cancelled = await database.query(
    `UPDATE agent_commands command SET state='cancelled',completed_at=now()
     FROM rooms corner WHERE corner.id=command.room_id
       AND corner.parent_id IS NOT NULL AND corner.archived_at IS NOT NULL
       AND command.action='stop' AND command.state='pending'
       AND command.created_at<now()-interval '1 day'`,
  );
  return cancelled.rowCount;
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
       AND ${cornerRunStateSql('$1::uuid')} IS DISTINCT FROM 'landed'`,
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

/** The terminal corner state shared by helper completion and a human close request. */
export async function closeCornerState(database: SqlDatabase, cornerId: string) {
  await lockCornerLifecycle(database, cornerId);
  await lockCornerArchivalAuthority(database);
  const corner = (
    await database.query<{ parent_id: string; name: string }>(
      `SELECT parent_id,name FROM rooms
       WHERE id=$1 AND parent_id IS NOT NULL FOR KEY SHARE`,
      [cornerId],
    )
  ).rows[0];
  if (!corner) throw new Error('corner not found');
  const archived = await archiveCornerState(database, cornerId);
  await database.query(
    `UPDATE corner_github_cache SET lifecycle=lifecycle||'{"lifecycle":"done","checks":"unknown"}'::jsonb WHERE corner_id=$1`,
    [cornerId],
  );
  await advanceCorner(database, cornerId, { kind: 'closed' });
  return { parentId: corner.parent_id, archived };
}

/** One archival sequence for close and confirmed merge. Callers retain outcome-specific
 * lifecycle writes; locked standing corners deliberately do not enter this operation. */
export async function archiveCornerState(database: SqlDatabase, cornerId: string): Promise<boolean> {
  return database.transaction(async database => {
    await lockCornerLifecycle(database, cornerId);
    await lockCornerArchivalAuthority(database);
    if (!(await database.query(`SELECT 1 FROM rooms WHERE id=$1 AND parent_id IS NOT NULL FOR KEY SHARE`, [cornerId])).rowCount)
      throw new Error('corner not found');
    await cancelCornerAgentCommands(database, cornerId);
    // Match command output: command locks precede the Room archival write lock.
    const changed = await database.query(
      `UPDATE rooms SET archived_at=now(),updated_at=now() WHERE id=$1 AND archived_at IS NULL`, [cornerId]);
    await abandonCornerWorkflowRuns(database, cornerId);
    await deleteCornerWakeSources(database, [cornerId]);
    await releaseArchivedCornerHolds(database, [cornerId]);
    return Boolean(changed.rowCount);
  });
}

/** Account deletion: the deleted agents' corners settle as done/abandoned, with the reason. */
export async function markOwnedCornersAbandoned(database: SqlDatabase, agentIds: string[], reason: string): Promise<void> {
  await database.query(
    `UPDATE corner_github_cache SET lifecycle=lifecycle||$2::jsonb
     WHERE ${cornerOwnerSql('corner_github_cache.corner_id')}=ANY($1)`,
    [agentIds, JSON.stringify({ lifecycle: 'done', outcome: 'abandoned', reason })],
  );
}
