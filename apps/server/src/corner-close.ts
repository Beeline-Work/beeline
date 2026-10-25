import { enqueueCornerBranchDeletion } from './corner-branch-cleanup.js';
import type { SqlDatabase } from './database.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import { advanceCorner, lockCornerLifecycle } from './corner-lifecycle.js';
import { abandonCornerWorkflowRuns } from './workflow-runs.js';
import { deleteCornerWakeSources } from './corner-wake-cleanup.js';

/**
 * Cancels every pending or claimed input/resume/restart command for a corner, and any
 * turn still marked `working`, so a corner that just landed never leaves a
 * stale assignment behind. Shared by every path that archives a corner:
 * `closeCornerState` and the GitHub merge webhook.
 * Take command locks before the room's archival UPDATE/FOR UPDATE lock:
 * command output already holds its command when dispatch locks rooms FOR SHARE.
 */
export async function cancelCornerAgentCommands(database: SqlDatabase, cornerId: string): Promise<void> {
  const active = await database.query<CommandRow>(
    `SELECT * FROM agent_commands
     WHERE room_id=$1 AND action IN ('input','resume') AND state IN ('pending','claimed')
     ORDER BY created_at DESC,id DESC FOR UPDATE`,
    [cornerId],
  );
  const assignments = new Map<string, CommandRow>();
  for (const command of active.rows) {
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

/** GitHub failure must never prevent a person or agent from closing a corner. */
export async function closeCornerPullRequestBestEffort(
  database: SqlDatabase,
  cornerId: string,
  closePullRequest?: (cornerId: string) => Promise<{ status: string; blocker?: string }>,
): Promise<void> {
  const pending = await database.query(
    `SELECT 1 FROM corner_facts WHERE corner_id=$1
       AND lifecycle->'pr'->>'number' IS NOT NULL
       AND lifecycle->'pr'->>'mergedAt' IS NULL
       AND workflow_state IS DISTINCT FROM 'landed'`,
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
  const corner = (
    await database.query<{ parent_id: string; name: string }>(
      `SELECT parent_id,name FROM rooms
       WHERE id=$1 AND parent_id IS NOT NULL FOR KEY SHARE`,
      [cornerId],
    )
  ).rows[0];
  if (!corner) throw new Error('corner not found');
  await cancelCornerAgentCommands(database, cornerId);
  // Match command output: command locks precede the room's archival write lock.
  await database.query(
    `UPDATE rooms SET archived_at=COALESCE(archived_at,now()),updated_at=now() WHERE id=$1`,
    [cornerId],
  );
  await database.query(
    `UPDATE corner_facts SET close_requested=true,
       lifecycle=lifecycle||'{"lifecycle":"done","checks":"unknown"}'::jsonb,
       updated_at=now() WHERE corner_id=$1`,
    [cornerId],
  );
  await abandonCornerWorkflowRuns(database, cornerId);
  await deleteCornerWakeSources(database, [cornerId]);
  await advanceCorner(database, cornerId, { kind: 'closed' });
  await enqueueCornerBranchDeletion(database, cornerId);
  return { parentId: corner.parent_id };
}
