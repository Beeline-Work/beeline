import { missingReviewAttachments } from './review-evidence.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { isZeroCheckCommander } from './corner-merge-approval.js';
import type { SqlDatabase } from './database.js';
import { assertCornerBriefAllowsMerge } from './corner-brief.js';
import { cornerImplementerSql } from './corner-worker.js';
import { cornerRunStateSql } from './corner-run.js';
import { CornerMergeGate } from './corner-lifecycle-checks-reported.js';
import { lockCornerLifecycle, loadCorner, loadCornerLifecycleState, backfillRun, CORNER_LIFECYCLE_SLUG } from './corner-lifecycle.js';



/**
 * The merge gate for one exact PR head, minus the checks verdict (the caller
 * supplies that live from GitHub). Shared by `pr_checks_status` and the server
 * merge, so the gate an agent reads is the gate `landCorner` merges on.
 */
export async function cornerMergeGate(
  db: SqlDatabase,
  cornerId: string,
  head: { number: number; headSha: string },
): Promise<CornerMergeGate> {
    db = new CornerAccessDatabase(db);
  const rows = await db.query<{
    configured_reviewer_id: string | null;
    approved: boolean;
    holds: CornerMergeGate['holds'];
  }>(
      `SELECT ${cornerReviewerSql()} configured_reviewer_id,
              EXISTS (
                SELECT 1 FROM corner_merge_approvals approval
                WHERE approval.corner_id=fact.corner_id AND approval.pull_request_number=$2
                  AND approval.head_sha=$3
                  AND (
                    -- A configured reviewer agent, still a parent member.
                    EXISTS (
                      SELECT 1 FROM memberships member
                      JOIN identities reviewer ON reviewer.id=member.identity_id AND reviewer.kind='agent'
                      WHERE member.room_id=parent.id AND member.identity_id=approval.approved_by
                        AND approval.approved_by IS DISTINCT FROM ${cornerImplementerSql('fact', 'corner')}
                        AND member.removed_at IS NULL
                        AND approval.approved_by=${cornerReviewerSql()}
                    )
                    -- Or a current Workspace owner or admin.
                    OR EXISTS (
                      SELECT 1 FROM memberships workspace_member
                      JOIN identities person ON person.id=workspace_member.identity_id AND person.kind='human'
                      WHERE workspace_member.workspace_id=corner.workspace_id
                        AND workspace_member.room_id IS NULL
                        AND workspace_member.identity_id=approval.approved_by
                        AND workspace_member.removed_at IS NULL
                        AND workspace_member.role IN ('owner','admin')
                    )
                  )
              ) approved,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hold.id::text,'actorId',hold.actor_id,
                'holderId',COALESCE(hold.set_by_agent_id,hold.actor_id),'holderName',(SELECT name FROM identities WHERE id=COALESCE(hold.set_by_agent_id,hold.actor_id)),
                'sourceMessageId',hold.source_message_id,'sourceAuthorId',hold.source_author_id,
                'sourceAuthorName',(SELECT name FROM identities WHERE id=hold.source_author_id),'sourceText',hold.source_text,
                'standing',hold.standing,'setAt',hold.set_at::text) ORDER BY hold.set_at,hold.id)
                FROM corner_merge_holds hold WHERE hold.corner_id=fact.corner_id AND hold.released_at IS NULL),
                '[]'::jsonb) holds
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       WHERE fact.corner_id=$1`,
    [cornerId, head.number, head.headSha],
  );
  const corner = rows.rows[0];
  if (!corner) throw new Error('corner not found');
  if (!corner.approved && !corner.configured_reviewer_id) {
    const approval = (await db.query<{ approved_by: string }>(
      `SELECT approved_by FROM corner_merge_approvals
       WHERE corner_id=$1 AND pull_request_number=$2 AND head_sha=$3`,
      [cornerId, head.number, head.headSha],
    )).rows[0];
    if (approval) corner.approved = await isZeroCheckCommander(db, cornerId, approval.approved_by);
  }
  const approval = (await db.query<{ approved_by: string }>(
    `SELECT approval.approved_by FROM corner_merge_approvals approval JOIN identities reviewer
       ON reviewer.id=approval.approved_by AND reviewer.kind='agent'
     WHERE corner_id=$1 AND pull_request_number=$2 AND head_sha=$3`,
    [cornerId,head.number,head.headSha])).rows[0];
  const evidenceMissing = Boolean(approval && await missingReviewAttachments(db, cornerId, head, approval.approved_by));
  if (evidenceMissing) corner.approved=false;
  const held = corner.holds.length > 0;
  return {
    ...(evidenceMissing ? {evidenceMissing:true} : {}),
    reviewerExists: Boolean(corner.configured_reviewer_id),
    approved: corner.approved,
    held,
    holds: corner.holds,
    open: corner.approved && !held,
  };
}


/**
 * Rechecks local merge authority under the run lock after the live gate read,
 * immediately before GitHub is asked to merge: the corner is open, the head
 * is unchanged, the brief still assigns repository work, a yes stands on this
 * head and no hold stands. Nothing is stored. GitHub's expected-head merge
 * merges a pull request at most once; a concurrent second attempt reads the
 * live pull request and confirms the merge instead of reporting a refusal.
 */
export async function confirmCornerMergeAuthority(
  database: SqlDatabase,
  cornerId: string,
  headSha: string,
  onBlocked?: (reason: string) => void,
): Promise<boolean> {
  const blocked = (reason: string) => { onBlocked?.(reason); return false; };
  return database.transaction(async (db) => {
    await lockCornerLifecycle(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    const pr = corner?.lifecycle.pr;
    if (!corner) return blocked('the corner no longer exists');
    if (corner.archived) return blocked('the corner is archived');
    if (!pr?.number) return blocked('the corner has no pull request');
    if (pr.headSha !== headSha) return blocked('the pull request head changed before the merge');
    // A brief revised during the GitHub read is seen here: revisions take this lock.
    await assertCornerBriefAllowsMerge(db, cornerId);
    const gate = await cornerMergeGate(db, cornerId, { number: pr.number, headSha });
    if (!gate.open) return blocked(gate.evidenceMissing ? 'missing review attachments: attach the screenshots or files claimed by the verdict' : gate.held ? 'a hold stands' : 'no yes on this head');
    return true;
  });
}


/**
 * Gives a run to corners opened before the workflow run existed (#1918),
 * derived from their lifecycle. Run once from `migrateData()`.
 */
export async function backfillCornerLifecycleRuns(database: SqlDatabase): Promise<number> {
  const missing = await database.query<{ corner_id: string }>(
    `SELECT fact.corner_id FROM corner_facts fact
     WHERE ${cornerRunStateSql('fact.corner_id')} IS NULL`,
  );
  for (const row of missing.rows) {
    await database.transaction(async (db) => {
      await lockCornerLifecycle(db, row.corner_id);
      if (await loadCornerLifecycleState(db, row.corner_id)) return;
      const corner = await loadCorner(db, row.corner_id);
      if (corner) await backfillRun(db, row.corner_id, corner);
    });
  }
  if (missing.rowCount)
    console.log(`backfillCornerLifecycleRuns: started ${missing.rowCount} corner run(s)`);
  return missing.rowCount;
}


/**
 * Deletes the copy of the corner contract that older servers seeded into every
 * Workspace as a `corner` workflow, with its versions. The corner lifecycle
 * never read it. Every such row carries a version written by the seed's
 * `corner-workflow-v1` extractor; a workflow a person saves later under the
 * slug `corner` has none, so it survives every run of `migrateData()`.
 */
export async function deleteStoredCornerWorkflows(database: SqlDatabase): Promise<number> {
  const deleted = await database.query(
    `DELETE FROM workspace_skills skill
     WHERE skill.slug=$1 AND skill.kind='workflow'
       AND EXISTS (
         SELECT 1 FROM workspace_skill_versions version
         WHERE version.skill_id=skill.id AND version.extractor_version='corner-workflow-v1'
       )`,
    [CORNER_LIFECYCLE_SLUG],
  );
  if (deleted.rowCount)
    console.log(`deleteStoredCornerWorkflows: deleted ${deleted.rowCount} stored corner workflow(s)`);
  return deleted.rowCount;
}
