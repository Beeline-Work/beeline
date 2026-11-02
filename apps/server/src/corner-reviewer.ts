import type { SqlDatabase } from './database.js';
import { CommandRefusalError } from './command-refusal.js';
import { cornerImplementerSql } from './corner-worker.js';
import { systemLine } from './system-line.js';

/** A corner's reviewer: its override, else the parent Room's reviewer. */
export function cornerReviewerSql(corner = 'corner', parent = 'parent'): string {
  return `COALESCE((SELECT reviewer_agent_id FROM corner_facts WHERE corner_id=${corner}.id),${parent}.reviewer_agent_id)`;
}

export async function assertIndependentCornerReviewer(
  db: SqlDatabase, cornerId: string, agentId: string,
  checkAuthors: (cornerId: string, agentId: string) => Promise<void>,
): Promise<void> {
  const worker = (await db.query<{ implementer: string | null }>(
    `SELECT ${cornerImplementerSql('fact', 'corner')} implementer FROM rooms corner
     JOIN corner_facts fact ON fact.corner_id=corner.id WHERE corner.id=$1`, [cornerId],
  )).rows[0];
  if (worker?.implementer === agentId)
    throw new CommandRefusalError('reviewer must be independent: the corner implementer cannot review its own work', 409);
  await checkAuthors(cornerId, agentId);
}

/** Caller holds the lifecycle lock and has checked membership and command authority. */
export async function setCornerReviewer(
  db: SqlDatabase, cornerId: string, handle: string, actorId: string,
  checkAuthors: (cornerId: string, agentId: string) => Promise<void>,
): Promise<void> {
  const reviewer = (await db.query<{ id: string; name: string }>(
    `SELECT identity.id,identity.name FROM rooms corner
     JOIN room_access member ON member.room_id=corner.parent_id AND member.removed_at IS NULL
     JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
     WHERE corner.id=$1 AND identity.handle=$2`, [cornerId, handle],
  )).rows[0];
  if (!reviewer) throw new CommandRefusalError('reviewer must be an agent member of the parent Room', 409);
  await assertIndependentCornerReviewer(db, cornerId, reviewer.id, checkAuthors);
  const changed = await db.query(
    `UPDATE corner_facts SET reviewer_agent_id=$2,updated_at=now()
     WHERE corner_id=$1 AND reviewer_agent_id IS DISTINCT FROM $2 RETURNING corner_id`, [cornerId, reviewer.id],
  );
  if (!changed.rowCount) return;
  // A changed assignment must never inherit an earlier agent's PASS.
  await db.query(`DELETE FROM corner_merge_approvals approval USING identities identity
    WHERE approval.corner_id=$1 AND identity.id=approval.approved_by AND identity.kind='agent'`, [cornerId]);
  const actor = (await db.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [actorId])).rows[0]!;
  await systemLine(db, {
    roomId: cornerId, subject: { kind: 'agent', id: actorId, name: actor.name },
    verb: 'set the corner reviewer', object: { id: reviewer.id, text: reviewer.name },
  });
}
