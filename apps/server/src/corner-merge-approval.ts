import type { SqlDatabase } from './database.js';
import { advanceCorner, lockCornerLifecycle } from './corner-lifecycle.js';

/**
 * The one head-bound yes shared by a reviewer's PASS and a person's order.
 * One row per corner; a new commit cancels it because the gate matches the
 * exact head. A brief edit does not.
 */
export async function recordCornerMergeApproval(
  database: SqlDatabase,
  input: {
    cornerId: string;
    approvedBy: string;
    pullRequestNumber: number;
    headSha: string;
  },
): Promise<boolean> {
  const approval = await database.query(
    `INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(corner_id) DO UPDATE SET
       approved_by=EXCLUDED.approved_by,
       pull_request_number=EXCLUDED.pull_request_number,head_sha=EXCLUDED.head_sha,
       approved_at=now()
      WHERE corner_merge_approvals.pull_request_number IS DISTINCT FROM EXCLUDED.pull_request_number
        OR corner_merge_approvals.head_sha IS DISTINCT FROM EXCLUDED.head_sha
        OR corner_merge_approvals.approved_by IS DISTINCT FROM EXCLUDED.approved_by
     RETURNING corner_id`,
    [input.cornerId, input.approvedBy, input.pullRequestNumber, input.headSha],
  );
  return Boolean(approval.rowCount);
}

/**
 * A person's yes on the corner's current head: a current human member of the
 * corner whose Workspace role is `owner` or `admin`. It is the same yes as a
 * reviewer's PASS (`cornerMergeGate`), so it merges only with green checks
 * and no hold. The caller lands it at once through `landCorner`.
 */
export async function recordPersonMergeYes(
  database: SqlDatabase,
  cornerId: string,
  actorId: string,
): Promise<{ roomId: string; headSha: string; pullRequestNumber: number; recorded: boolean }> {
  return database.transaction(async (db) => {
    await lockCornerLifecycle(db, cornerId);
    const authorized = await db.query<{ ok: boolean }>(
      `SELECT true ok FROM rooms corner
       JOIN memberships room_member ON room_member.room_id=corner.id AND room_member.identity_id=$2
         AND room_member.removed_at IS NULL
       JOIN memberships workspace_member ON workspace_member.workspace_id=corner.workspace_id
         AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
         AND workspace_member.removed_at IS NULL AND workspace_member.role IN ('owner','admin')
       JOIN identities person ON person.id=$2 AND person.kind='human'
       WHERE corner.id=$1 AND corner.archived_at IS NULL`,
      [cornerId, actorId],
    );
    if (!authorized.rowCount)
      throw new Error('merge approval denied: current Workspace owner or admin required');
    const target = (await db.query<{ number: number | null; head_sha: string | null }>(
      `SELECT (fact.lifecycle->'pr'->>'number')::int number,
              fact.lifecycle->'pr'->>'headSha' head_sha
       FROM corner_facts fact WHERE fact.corner_id=$1`,
      [cornerId],
    )).rows[0];
    if (!target?.number || !target.head_sha) throw new Error('corner has no pull request to merge');
    const recorded = await recordCornerMergeApproval(db, {
      cornerId,
      approvedBy: actorId,
      pullRequestNumber: target.number,
      headSha: target.head_sha,
    });
    if (recorded) await advanceCorner(db, cornerId, { kind: 'approval', headSha: target.head_sha, by: 'person' });
    return { roomId: cornerId, headSha: target.head_sha, pullRequestNumber: target.number, recorded };
  });
}

/**
 * Why the server refused to record a reviewer's PASS. The code leads the
 * message, so the agent that called `approve_merge` reads which rule failed.
 */
export type CornerVerdictRejection =
  | 'NOT_CONFIGURED_REVIEWER'
  | 'AUTHOR'
  | 'NO_PULL_REQUEST'
  | 'STALE_HEAD';

export class CornerVerdictRejectedError extends Error {
  constructor(
    readonly code: CornerVerdictRejection,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CornerVerdictRejectedError';
  }
}
