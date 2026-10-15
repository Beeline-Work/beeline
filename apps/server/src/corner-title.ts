import type { SqlDatabase } from './database.js';

/**
 * The one corner-title write, shared by a person renaming a corner and by the
 * corner's agent retitling it once the topic is set.
 */
export async function writeCornerTitle(
  database: SqlDatabase,
  cornerId: string,
  title: string,
) {
  await database.query(`UPDATE rooms SET name=$2,updated_at=now() WHERE id=$1`, [cornerId, title]);
  await database.query(`UPDATE corner_facts SET title_generated=false WHERE corner_id=$1`, [
    cornerId,
  ]);
  // Opening markers render the current title from rooms; their stored cards stay untouched.
}
