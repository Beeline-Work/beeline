import { createHash } from 'node:crypto';
import { resolveCornerBriefApproval } from './corner-brief.js';
import { CommandRefusalError } from './command-refusal.js';
import { systemLine, restateSystemLine, ensureSystemIdentity } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
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
       (SELECT name FROM identities WHERE identities.id=COALESCE(set_by_agent_id,actor_id)) "holderName",standing,set_at::text "setAt",
       source_message_id "sourceMessageId",source_author_id "sourceAuthorId",source_text "sourceText",
       (SELECT name FROM identities WHERE identities.id=source_author_id) "sourceAuthorName"
     FROM corner_merge_holds WHERE corner_id=$1 AND released_at IS NULL ORDER BY set_at,id`,
      [cornerId],
    )
  ).rows;
}

/**
 * An archived corner has no merge left to hold, so archival releases its
 * holds in the same transaction. Without corner ids it repairs every archived
 * corner that still has one.
 */
export async function releaseArchivedCornerHolds(db: SqlDatabase, cornerIds?: readonly string[]): Promise<void> {
  if (cornerIds?.length === 0) return;
  await ensureSystemIdentity(db);
  await db.query(
    `UPDATE corner_merge_holds hold SET released_at=now(),released_by=$2
     FROM rooms corner
     WHERE corner.id=hold.corner_id AND corner.archived_at IS NOT NULL AND hold.released_at IS NULL
       AND ($1::uuid[] IS NULL OR hold.corner_id=ANY($1::uuid[]))`,
    [cornerIds ?? null, SYSTEM_IDENTITY_ID],
  );
}

/** Called in the caller's transaction, including corner creation. */
export async function setCornerHold(db: SqlDatabase, input: CornerHoldInput, actorId: string, agentId?: string) {
  const citation = agentId && input.releaseHoldId === undefined
    ? (await resolveCornerBriefApproval(db, [], { spec: 'Merge hold',
        approval: { sourceMessageId: input.sourceMessageId ?? '' } }, [], undefined, undefined, undefined,
        { agentId })).approvalBasis : undefined;
  if (citation) actorId = citation.approvedBy;
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
  if (!actor) {
    if (citation) throw new CommandRefusalError("cited person is not a current human Room member; cite the person's message that asks for the hold, or close the PR to stop it.", 403);
    throw new Error('hold access denied: current human Room membership required');
  }
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
      `INSERT INTO corner_merge_holds(corner_id,actor_id,standing,set_by_agent_id,source_message_id,source_author_id,source_text)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(corner_id,(COALESCE(set_by_agent_id,actor_id))) WHERE released_at IS NULL DO UPDATE SET actor_id=EXCLUDED.actor_id,
       source_message_id=EXCLUDED.source_message_id,source_author_id=EXCLUDED.source_author_id,
       source_text=EXCLUDED.source_text RETURNING id`,
      [input.cornerId, actorId, actor.role, agentId ?? null, citation?.sourceMessageId ?? null, citation?.approvedBy ?? null, citation?.snapshot.slice(0, 500) ?? null],
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
  const citation = (await db.query<{ source_text: string | null; source_name: string | null }>(
    `SELECT hold.source_text,person.name source_name FROM corner_merge_holds hold
     LEFT JOIN identities person ON person.id=hold.source_author_id WHERE hold.id=$1`, [holdId],
  )).rows[0];
  const id = createHash('sha256').update(`corner-hold:${holdId}`).digest('hex');
  const phrase = {
    subject: { kind: actor?.kind === 'agent' ? 'agent' as const : 'person' as const,
      id: actorId, name: actor?.name ?? actorId },
    verb: 'set a merge hold',
    ...(citation?.source_text !== null && citation?.source_text !== undefined
      ? { consequence: `${citation.source_name}: “${citation.source_text}”` } : {}),
  };
  await systemLine(db, { id, roomId: cornerId, authorId: actorId, ...phrase });
  // A repeated set may cite a newer request; keep the existing hold line and
  // the status list on the same citation without creating another hold.
  if (citation?.source_text != null) await restateSystemLine(db, id, phrase);
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
