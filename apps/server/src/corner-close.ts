import type { SqlDatabase } from './database.js';
import { randomBytes } from 'node:crypto';
import { createAgentCommand } from './agent-command.js';

/** The terminal corner state shared by helper completion and a human close request. */
export async function closeCornerState(database: SqlDatabase, cornerId: string) {
  const corner = (
    await database.query<{ parent_id: string; name: string }>(
      `SELECT parent_id,name FROM rooms
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
  await reportUnansweredCornerAsks(database, cornerId, corner.parent_id, corner.name);
  return { parentId: corner.parent_id };
}

/** Called within every terminal corner transaction, after its parent card is settled. */
export async function reportUnansweredCornerAsks(
  database: SqlDatabase,
  cornerId: string,
  parentId: string,
  cornerName: string,
) {
  const unanswered = await database.query<{ id: string; author_id: string; text: string }>(
    `SELECT question.id,question.author_id,question.text
     FROM messages question
     WHERE question.room_id=$1 AND question.card_type='relay'
       AND question.card->>'reply'='once'
       AND NOT EXISTS (
         SELECT 1 FROM messages report WHERE report.room_id=$2
           AND report.card_type='relay' AND report.card->>'direction'='up'
           AND report.card->>'unanswered' IS DISTINCT FROM 'true'
           AND report.card->>'askId'=question.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM messages report WHERE report.room_id=$2
           AND report.card_type='relay' AND report.card->>'unanswered'='true'
           AND report.card->>'askId'=question.id
       ) ORDER BY question.created_at,question.id`,
    [cornerId, parentId],
  );
  for (const ask of unanswered.rows) {
    const reportId = randomBytes(32).toString('hex');
    const anchor = (
      await database.query<{ id: string }>(
        `SELECT id FROM messages WHERE room_id=$1 AND card_type='daemon-fact'
         AND card->>'type' IN ('corner-open','corner-complete') AND card->>'cornerId'=$2
       ORDER BY created_at,id LIMIT 1`,
        [parentId, cornerId],
      )
    ).rows[0]?.id;
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,$4,'card','relay',$5::jsonb)`,
      [
        reportId,
        parentId,
        ask.author_id,
        `Corner closed without answering ask ${ask.id}: ${ask.text}`,
        JSON.stringify({
          fromRoomId: cornerId,
          toRoomId: parentId,
          direction: 'up',
          fromName: cornerName,
          cornerId,
          askId: ask.id,
          ...(anchor ? { anchorMessageId: anchor } : {}),
          received: true,
          unanswered: true,
        }),
      ],
    );
    await createAgentCommand(database, {
      roomId: parentId,
      agentId: ask.author_id,
      sourceMessageId: reportId,
      reason: 'relay_unanswered',
    });
  }
}
