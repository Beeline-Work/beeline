import type { SqlDatabase } from './database.js';

/**
 * The one corner-title write, shared by a person renaming a corner and by the
 * corner's agent retitling it once the topic is set.
 */
export async function writeCornerTitle(
  database: SqlDatabase,
  cornerId: string,
  parentId: string,
  title: string,
) {
  await database.query(`UPDATE rooms SET name=$2,updated_at=now() WHERE id=$1`, [cornerId, title]);
  // The marker beneath a forwarded message names the corner it opened, so
  // it follows the corner's current name rather than the random one it was
  // opened under.
  await database.query(
    `UPDATE messages SET card=jsonb_set(card,'{name}',to_jsonb($3::text))
     WHERE room_id=$1 AND card_type='daemon-fact' AND card->>'cornerId'=$2
       AND card->>'sourceMessageId' IS NOT NULL`,
    [parentId, cornerId, title],
  );
}
