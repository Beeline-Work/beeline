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

/**
 * An owner or admin's express instruction to merge now, for this exact head.
 * Authority is the corner's Workspace: a current human member of the corner
 * whose Workspace-level role is `owner` or `admin`. Recorded in the same
 * table as a reviewer's PASS, with `force: true` because an express order is
 * not re-gated behind checks, reviewer, yolo, or a hold (`cornerMergeGate`
 * reads it as its own route to `open`, independent of all four).
 */
export async function recordExpressMergeOrder(
  database: SqlDatabase,
  input: { cornerId: string; pullRequestNumber: number; headSha: string },
  actorId: string,
): Promise<{ roomId: string; headSha: string }> {
  const authorized = await database.query<{ ok: boolean }>(
    `SELECT true ok FROM rooms corner
     JOIN memberships room_member ON room_member.room_id=corner.id AND room_member.identity_id=$2
       AND room_member.removed_at IS NULL
     JOIN memberships workspace_member ON workspace_member.workspace_id=corner.workspace_id
       AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
       AND workspace_member.removed_at IS NULL AND workspace_member.role IN ('owner','admin')
     JOIN identities person ON person.id=$2 AND person.kind='human'
     WHERE corner.id=$1 AND corner.archived_at IS NULL`,
    [input.cornerId, actorId],
  );
  if (!authorized.rowCount)
    throw new Error('merge order denied: current Workspace owner or admin required');
  await recordCornerMergeApproval(database, {
    cornerId: input.cornerId,
    approvedBy: actorId,
    force: true,
    pullRequestNumber: input.pullRequestNumber,
    headSha: input.headSha,
  });
  return { roomId: input.cornerId, headSha: input.headSha };
}

/**
 * Why the server refused to record a reviewer's PASS. The code leads the
 * message, so the agent that called `approve_merge` reads which rule failed.
 */
export type CornerVerdictRejection =
  | 'NOT_CONFIGURED_REVIEWER'
  | 'NO_PULL_REQUEST'
  | 'STALE_HEAD'
  | 'STALE_BRIEF_REVISION';

export class CornerVerdictRejectedError extends Error {
  constructor(
    readonly code: CornerVerdictRejection,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CornerVerdictRejectedError';
  }
}
