import type { SqlDatabase } from './database.js';

/** The one head-bound approval write shared by human merge and agent review.
 * `patchId` is the reviewer's own git-patch-id of the diff against the target
 * branch at approval time; a later head with the same patch-id (same change,
 * only caught up on main) reads as still approved without a fresh review. */
export async function recordCornerMergeApproval(
  database: SqlDatabase,
  input: {
    cornerId: string;
    approvedBy: string;
    force: boolean;
    pullRequestNumber: number;
    headSha: string;
    patchId?: string;
  },
): Promise<boolean> {
  const approval = await database.query(
    `INSERT INTO corner_merge_approvals(
       corner_id,approved_by,force,pull_request_number,head_sha,patch_id
     ) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(corner_id) DO UPDATE SET
       approved_by=EXCLUDED.approved_by,force=EXCLUDED.force,
       pull_request_number=EXCLUDED.pull_request_number,head_sha=EXCLUDED.head_sha,
       patch_id=EXCLUDED.patch_id,
       approved_at=now()
     WHERE corner_merge_approvals.pull_request_number IS DISTINCT FROM EXCLUDED.pull_request_number
        OR corner_merge_approvals.head_sha IS DISTINCT FROM EXCLUDED.head_sha
     RETURNING corner_id`,
    [
      input.cornerId,
      input.approvedBy,
      input.force,
      input.pullRequestNumber,
      input.headSha,
      input.patchId ?? null,
    ],
  );
  return Boolean(approval.rowCount);
}
