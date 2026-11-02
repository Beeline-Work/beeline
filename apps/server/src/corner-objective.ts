import type { SqlDatabase } from './database.js';

/** Navigation text belongs to the latest brief, or the opening order without a brief. */
export function cornerObjectiveSql(cornerAlias: string): string {
  return `COALESCE(
    (SELECT COALESCE(objective_brief.objective,'') FROM corner_brief_revisions objective_brief
     WHERE objective_brief.corner_id=${cornerAlias}.id ORDER BY objective_brief.revision DESC LIMIT 1),
    (SELECT opening.private_payload->>'objective' FROM agent_commands opening
     WHERE opening.room_id=${cornerAlias}.id AND opening.reason='corner_objective'
     ORDER BY opening.created_at,opening.id LIMIT 1),'')`;
}

export async function readCornerObjective(database: SqlDatabase, cornerId: string): Promise<string> {
  return (await database.query<{ objective: string }>(
    `SELECT ${cornerObjectiveSql('corner')} objective FROM rooms corner WHERE corner.id=$1`, [cornerId],
  )).rows[0]?.objective ?? '';
}

/** Objective edits are navigation only, not authority: preserve revision and review/brief fences. */
export async function writeCornerObjective(
  database: SqlDatabase, cornerId: string, objective: string, onlyMissing = false,
): Promise<void> {
  const revision = await database.query(
    `UPDATE corner_brief_revisions SET objective=$2
     WHERE corner_id=$1 AND revision=(SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$1)
       ${onlyMissing ? "AND COALESCE(objective,'')=''" : ''}
     RETURNING revision`, [cornerId, objective],
  );
  if (revision.rowCount || (await database.query(
    `SELECT 1 FROM corner_brief_revisions WHERE corner_id=$1 LIMIT 1`, [cornerId],
  )).rowCount) return;
  await database.query(
    `UPDATE agent_commands SET private_payload=jsonb_set(COALESCE(private_payload,'{}'::jsonb),'{objective}',to_jsonb($2::text))
     WHERE id=(SELECT id FROM agent_commands WHERE room_id=$1 AND reason='corner_objective'
       ORDER BY created_at,id LIMIT 1)
       ${onlyMissing ? "AND COALESCE(private_payload->>'objective','')=''" : ''}`,
    [cornerId, objective],
  );
}
