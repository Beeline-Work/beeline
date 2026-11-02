import type { GitHubAppClient } from '@beeline/auth/github';
import type { SqlDatabase } from './database.js';
import { deleteArchivedCornerBranch, type CornerBranchCleanupResult } from './corner-branch-cleanup.js';
import { workflowBackfillOnce } from './migrations/workflow-cleanup.js';

/** Explicit maintenance: discover historical archives afresh; never queue branch deletion. */
export async function backfillArchivedCornerCleanup(database: SqlDatabase, app: GitHubAppClient) {
  await workflowBackfillOnce(database, 'archived-corner-github-cleanup-v1', db => db.transaction(async tx => {
  }));
  const corners = await database.query<{ id: string }>(
    `SELECT corner.id FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
     WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NOT NULL ORDER BY corner.id`);
  const results: CornerBranchCleanupResult[] = [];
  for (const corner of corners.rows)
    results.push(await deleteArchivedCornerBranch(database, app, corner.id, true));
  return results;
}
