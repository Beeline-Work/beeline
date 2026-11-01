import { createHash } from 'node:crypto';
import { CommandRefusalError } from './command-refusal.js';
import { systemLine } from './system-line.js';
import type { CornerHoldInput, CornerMergeHold } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { lockCornerLifecycle } from './corner-lifecycle.js';

export async function activeCornerHolds(
  db: SqlDatabase,
  cornerId: string,
): Promise<CornerMergeHold[]> {
  return (
    await db.query<CornerMergeHold>(
      `SELECT id::text,actor_id "actorId",COALESCE(set_by_agent_id,actor_id) "holderId",
       (SELECT name FROM identities WHERE identities.id=COALESCE(set_by_agent_id,actor_id)) "holderName",standing,set_at::text "setAt"
     FROM corner_merge_holds WHERE corner_id=$1 AND released_at IS NULL ORDER BY set_at,id`,
      [cornerId],
    )
  ).rows;
}

/** Called in the caller's transaction, including corner creation. */
export async function setCornerHold(db: SqlDatabase, input: CornerHoldInput, actorId: string, agentId?: string) {
  if (agentId && input.releaseHoldId === undefined)
    throw new CommandRefusalError('Agents cannot set merge holds; close the PR to stop it.', 403);
  await lockCornerLifecycle(db, input.cornerId);
  const actor = (
    await db.query<{ role: CornerMergeHold['standing'] }>(
      `SELECT workspace_member.role FROM rooms corner
     JOIN corner_facts fact ON fact.corner_id=corner.id
     JOIN memberships room_member ON room_member.room_id=corner.parent_id AND room_member.identity_id=$2
       AND room_member.removed_at IS NULL
     JOIN memberships workspace_member ON workspace_member.workspace_id=corner.workspace_id
       AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
       AND workspace_member.removed_at IS NULL AND workspace_member.role IN ('owner','admin','member')
     JOIN identities person ON person.id=$2 AND person.kind='human'
     WHERE corner.id=$1 AND corner.archived_at IS NULL FOR UPDATE OF corner`,
      [input.cornerId, actorId],
    )
  ).rows[0];
  if (!actor) throw new Error('hold access denied: current human Room membership required');
  if (input.releaseHoldId !== undefined) {
    const hold = (
      await db.query<{ actor_id: string; set_by_agent_id: string | null; holder_name: string; standing: CornerMergeHold['standing'] }>(
        `SELECT actor_id,set_by_agent_id,(SELECT name FROM identities WHERE id=COALESCE(set_by_agent_id,actor_id)) holder_name,standing FROM corner_merge_holds WHERE id=$1 AND corner_id=$2 AND released_at IS NULL FOR UPDATE`,
        [input.releaseHoldId, input.cornerId],
      )
    ).rows[0];
    if (!hold) throw new Error('active hold not found');
    const rank = { member: 0, admin: 1, owner: 2 };
    if (agentId && hold.set_by_agent_id !== agentId)
      throw new Error(`hold release denied: only ${hold.holder_name} can release this hold through an agent turn`);
    if (!agentId && !hold.set_by_agent_id && hold.actor_id !== actorId && rank[actor.role] <= rank[hold.standing])
      throw new Error(
        `hold release denied: only the holder or someone above their ${hold.standing} standing can release it`,
      );
    await db.query(`UPDATE corner_merge_holds SET released_at=now(),released_by=$2 WHERE id=$1`, [
      input.releaseHoldId,
      agentId ?? actorId,
    ]);
    return { holdId: input.releaseHoldId, roomId: input.cornerId };
  }
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO corner_merge_holds(corner_id,actor_id,standing,set_by_agent_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(corner_id,(COALESCE(set_by_agent_id,actor_id))) WHERE released_at IS NULL DO UPDATE SET actor_id=EXCLUDED.actor_id RETURNING id`,
      [input.cornerId, actorId, actor.role, agentId ?? null],
    )
  ).rows[0]!;
  await writeHoldMessage(db, input.cornerId, row.id, agentId ?? actorId);
  return { holdId: row.id, roomId: input.cornerId };
}

async function writeHoldMessage(
  db: SqlDatabase,
  cornerId: string,
  holdId: string,
  actorId: string,
) {
  const actor = (
    await db.query<{ name: string; kind: string }>('SELECT name,kind FROM identities WHERE id=$1', [actorId])
  ).rows[0];
  await systemLine(db, {
    id: createHash('sha256').update(`corner-hold:${holdId}`).digest('hex'),
    roomId: cornerId,
    authorId: actorId,
    subject: { kind: actor?.kind === 'agent' ? 'agent' : 'person', id: actorId, name: actor?.name ?? actorId },
    verb: 'set a merge hold',
  });
}

/** Existing active holds need the same source target as newly set holds. */
export async function backfillCornerHoldMessages(db: SqlDatabase): Promise<void> {
  const rows = (
    await db.query<{ corner_id: string; id: string; actor_id: string }>(
      `SELECT hold.corner_id,hold.id,COALESCE(hold.set_by_agent_id,hold.actor_id) actor_id FROM corner_merge_holds hold
     JOIN rooms room ON room.id=hold.corner_id WHERE hold.released_at IS NULL AND room.archived_at IS NULL`,
    )
  ).rows;
  for (const row of rows) await writeHoldMessage(db, row.corner_id, row.id, row.actor_id);
}
