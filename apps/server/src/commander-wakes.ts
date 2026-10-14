import type { SqlDatabase } from './database.js';

/** The first non-urgent wake opens a fixed window; later arrivals do not extend it. */
export const COMMANDER_WAKE_WINDOW_SECONDS = 60;

export async function lockCommanderWakes(db: SqlDatabase, roomId: string, agentId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`commander-wakes:${roomId}:${agentId}`]);
}

/** Caller holds the recipient queue lock, shared with command dispatch. */
export async function flushCommanderWakes(
  db: SqlDatabase, roomId: string, agentId: string, urgentId?: string,
): Promise<boolean> {
  const queued = (await db.query<{ id: string; text: string; author_id: string; from_room: string; attachments: unknown[] }>(
    `SELECT command.id,command.private_payload->>'text' text,
       command.private_payload->>'authorId' author_id,command.private_payload->>'fromRoomId' from_room,
       COALESCE(command.private_payload->'attachments','[]'::jsonb) attachments
     FROM agent_commands command
     WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='pending'
       AND command.wake_after IS NOT NULL
       AND ($3::text IS NOT NULL OR command.wake_after<=now())
     ORDER BY command.created_at,command.id FOR UPDATE`, [roomId, agentId, urgentId ?? null])).rows;
  if (!queued.length) return false;
  const head = urgentId ?? queued[0]!.id;
  const rest = queued.filter((item) => item.id !== head);
  const context = rest.map((item) => JSON.stringify({ id: item.id, authorId: item.author_id,
    fromRoomId: item.from_room, body: item.text, attachments: item.attachments })).join('\n');
  await db.query(
    `UPDATE agent_commands SET wake_after=NULL,
       coalesced_context=concat_ws(E'\n',NULLIF(coalesced_context,''),NULLIF($2,'')),
       private_payload=CASE WHEN private_payload IS NULL THEN NULL ELSE
         jsonb_set(private_payload,'{attachments}',COALESCE(private_payload->'attachments','[]'::jsonb)||$3::jsonb) END
     WHERE id=$1 AND state='pending'`,
    [head, context, JSON.stringify(rest.flatMap((item) => item.attachments))]);
  if (rest.length) await db.query(
    `UPDATE agent_commands SET state='cancelled',completed_at=now(),cancellation_reason=$2
     WHERE id=ANY($1::text[]) AND state='pending'`,
    [rest.map((item) => item.id), `coalesced_into:${head}`]);
  return true;
}

/** Durable deadlines are recovered on startup and serviced by the server's existing tick. */
export async function flushDueCommanderWakes(db: SqlDatabase): Promise<number> {
  const recipients = (await db.query<{ room_id: string; agent_id: string }>(
    `SELECT DISTINCT command.room_id,command.agent_id FROM agent_commands command
     JOIN memberships member ON member.room_id=command.room_id AND member.identity_id=command.agent_id
       AND member.removed_at IS NULL
     JOIN rooms room ON room.id=command.room_id AND room.archived_at IS NULL
     WHERE command.state='pending' AND command.wake_after<=now() LIMIT 100`)).rows;
  let flushed = 0;
  for (const recipient of recipients) await db.transaction(async (tx) => {
    await lockCommanderWakes(tx, recipient.room_id, recipient.agent_id);
    const membership = await tx.query(
      `SELECT 1 FROM memberships member JOIN rooms room ON room.id=member.room_id
       WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
         AND room.archived_at IS NULL`, [recipient.room_id, recipient.agent_id]);
    if (membership.rowCount && await flushCommanderWakes(tx, recipient.room_id, recipient.agent_id)) flushed++;
  });
  return flushed;
}
