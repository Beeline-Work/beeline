import type { SqlDatabase } from './database.js';

/** The terminal corner state shared by helper completion and a human close request. */
export async function closeCornerState(database: SqlDatabase, cornerId: string) {
  const corner = (
    await database.query<{ parent_id: string }>(
      `SELECT parent_id FROM rooms
       WHERE id=$1 AND parent_id IS NOT NULL
       FOR UPDATE`,
      [cornerId],
    )
  ).rows[0];
  if (!corner) throw new Error('corner not found');
  await database.query(
    `UPDATE rooms SET archived_at=COALESCE(archived_at,now()),updated_at=now() WHERE id=$1`,
    [cornerId],
  );
  await database.query(
    `UPDATE corner_facts SET close_requested=true,
       lifecycle=lifecycle||'{"lifecycle":"done","checks":"unknown"}'::jsonb,
       updated_at=now() WHERE corner_id=$1`,
    [cornerId],
  );
  // The parent transcript owns one durable card for this corner. Settle that
  // card in the same transaction as the corner so the next parent repaint
  // cannot retain an actionable open state.
  await database.query(
    `UPDATE messages
     SET card=card||'{"type":"corner-complete","outcome":"abandoned"}'::jsonb
     WHERE room_id=$2 AND card_type='daemon-fact'
       AND card->>'type'='corner-open' AND card->>'cornerId'=$1`,
    [cornerId, corner.parent_id],
  );
  return { parentId: corner.parent_id };
}
