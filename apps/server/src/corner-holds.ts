import type { CornerHoldInput, CornerMergeHold } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { lockCornerWorkflowRun } from './corner-workflow.js';

export async function activeCornerHolds(
  db: SqlDatabase,
  cornerId: string,
): Promise<CornerMergeHold[]> {
  return (
    await db.query<CornerMergeHold>(
      `SELECT id::text,actor_id "actorId",standing,set_at::text "setAt"
     FROM corner_merge_holds WHERE corner_id=$1 AND released_at IS NULL ORDER BY set_at,id`,
      [cornerId],
    )
  ).rows;
}

/** Called in the caller's transaction, including corner creation. */
export async function setCornerHold(db: SqlDatabase, input: CornerHoldInput, actorId: string) {
  await lockCornerWorkflowRun(db, input.cornerId);
  const actor = (
    await db.query<{ role: CornerMergeHold['standing'] }>(
      `SELECT workspace_member.role FROM rooms corner
     JOIN corner_facts fact ON fact.corner_id=corner.id
     JOIN memberships room_member ON room_member.room_id=corner.id AND room_member.identity_id=$2
       AND room_member.removed_at IS NULL
     JOIN memberships workspace_member ON workspace_member.workspace_id=corner.workspace_id
       AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
       AND workspace_member.removed_at IS NULL AND workspace_member.role IN ('owner','admin','member')
     JOIN identities person ON person.id=$2 AND person.kind='human'
     WHERE corner.id=$1 AND corner.archived_at IS NULL FOR UPDATE OF corner`,
      [input.cornerId, actorId],
    )
  ).rows[0];
  if (!actor) throw new Error('hold access denied: current human corner membership required');
  if (input.releaseHoldId !== undefined) {
    const hold = (
      await db.query<{ actor_id: string; standing: CornerMergeHold['standing'] }>(
        `SELECT actor_id,standing FROM corner_merge_holds WHERE id=$1 AND corner_id=$2 AND released_at IS NULL FOR UPDATE`,
        [input.releaseHoldId, input.cornerId],
      )
    ).rows[0];
    if (!hold) throw new Error('active hold not found');
    const rank = { member: 0, admin: 1, owner: 2 };
    if (hold.actor_id !== actorId && rank[actor.role] <= rank[hold.standing])
      throw new Error(
        `hold release denied: only the holder or someone above their ${hold.standing} standing can release it`,
      );
    await db.query(`UPDATE corner_merge_holds SET released_at=now(),released_by=$2 WHERE id=$1`, [
      input.releaseHoldId,
      actorId,
    ]);
    return { holdId: input.releaseHoldId, roomId: input.cornerId };
  }
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO corner_merge_holds(corner_id,actor_id,standing) VALUES($1,$2,$3)
     ON CONFLICT(corner_id,actor_id) WHERE released_at IS NULL DO UPDATE SET actor_id=EXCLUDED.actor_id RETURNING id`,
      [input.cornerId, actorId, actor.role],
    )
  ).rows[0]!;
  return { holdId: row.id, roomId: input.cornerId };
}
