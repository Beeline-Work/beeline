import type { SqlDatabase } from './database.js';
import { enqueueCornerBranchDeletion } from './corner-branch-cleanup.js';
import { enqueueCornerPullRequestClosure } from './corner-close.js';
import { workflowBackfillOnce } from './migrations/workflow-cleanup.js';

/** Explicit maintenance operation: run only after every cleanup worker has the containment guard. */
export async function backfillArchivedCornerCleanup(database: SqlDatabase) {
  await workflowBackfillOnce(database, 'archived-corner-github-cleanup-v1', db => db.transaction(async tx => {
    await enqueueCornerPullRequestClosure(tx);
    await enqueueCornerBranchDeletion(tx, undefined, true);
    await tx.query(`UPDATE corner_branch_deletions SET require_containment=true WHERE finished_at IS NULL
      OR last_error IN ('branch is used by an open pull request','branch is used by an unarchived corner')`);
    // Older workers treated temporary blockers as terminal. New workers recheck them daily.
    await tx.query(`UPDATE corner_branch_deletions SET finished_at=NULL,attempts=0,next_attempt_at=now()
      WHERE last_error IN ('branch is used by an open pull request','branch is used by an unarchived corner')`);
  }));
}
