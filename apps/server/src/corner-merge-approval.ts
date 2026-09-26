import type { SqlDatabase } from './database.js';

/** The one head-bound approval write shared by human merge and agent review. */
export async function recordCornerMergeApproval(
  database: SqlDatabase,
  input: {
    cornerId: string;
    approvedBy: string;
    force: boolean;
    pullRequestNumber: number;
    headSha: string;
  },
): Promise<boolean> {
  const approval = await database.query(
    `INSERT INTO corner_merge_approvals(
       corner_id,approved_by,force,pull_request_number,head_sha,brief_revision
     ) VALUES($1,$2,$3,$4,$5,(SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$1))
     ON CONFLICT(corner_id) DO UPDATE SET
       approved_by=EXCLUDED.approved_by,force=EXCLUDED.force,
       pull_request_number=EXCLUDED.pull_request_number,head_sha=EXCLUDED.head_sha,
       brief_revision=EXCLUDED.brief_revision,
       approved_at=now()
      WHERE corner_merge_approvals.pull_request_number IS DISTINCT FROM EXCLUDED.pull_request_number
        OR corner_merge_approvals.head_sha IS DISTINCT FROM EXCLUDED.head_sha
        OR corner_merge_approvals.approved_by IS DISTINCT FROM EXCLUDED.approved_by
        OR corner_merge_approvals.brief_revision IS DISTINCT FROM EXCLUDED.brief_revision
     RETURNING corner_id`,
    [input.cornerId, input.approvedBy, input.force, input.pullRequestNumber, input.headSha],
  );
  return Boolean(approval.rowCount);
}
