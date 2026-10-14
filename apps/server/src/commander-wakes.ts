import type { SqlDatabase } from './database.js';
import { expiredWakeDigestSources, lockAgentCommandQueue, readAgentCommands } from './agent-command.js';

export async function lockCommanderWakes(db: SqlDatabase, roomId: string, agentId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`commander-wakes:${roomId}:${agentId}`]);
}

async function lockWakeConsumer(db: SqlDatabase, roomId: string, agentId: string) {
  // Readers/claimers take the Stop queue lock before the wake lock. Dispatch
  // takes only the wake lock so orders arriving during Stop can still commit.
  await lockAgentCommandQueue(db, roomId, agentId);
  await lockCommanderWakes(db, roomId, agentId);
}

/** Caller holds the recipient queue lock, shared with command dispatch. */
async function flushCommanderWakes(
  db: SqlDatabase, roomId: string, agentId: string, sourceIds?: readonly string[],
): Promise<boolean> {
  const queued = (await db.query<{ id: string; from_room: string | null }>(
    `SELECT command.id,command.private_payload->>'fromRoomId' from_room
     FROM agent_commands command
     WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='pending'
       AND command.wake_after IS NOT NULL
       AND command.wake_after<=now()
       AND ($3::text[] IS NULL OR command.id=ANY($3::text[]))
     ORDER BY command.inbox_sequence FOR UPDATE`, [roomId, agentId, sourceIds ?? null])).rows;
  if (!queued.length) return false;
  // Use the same renderer as ordinary delivery, including subscription actions,
  // workflow hints, cards, attachments and resume context. Expired workflow
  // attempts are cancelled individually before choosing the digest's head.
  const rendered = (await readAgentCommands(db, roomId, agentId, queued.map(item => item.id))).commands;
  const commands = new Map(rendered.map(command => [command.id, command]));
  const valid = queued.filter(item => commands.has(item.id));
  if (!valid.length) return false;
  const head = valid[0]!.id;
  const rest = valid.slice(1);
  const context = rest.map(item => {
    const command = commands.get(item.id)!;
    return JSON.stringify({ ...command, fromRoomId: item.from_room ?? roomId,
      authorId: command.source.authorId, body: command.source.body,
      attachments: command.source.attachments });
  }).join('\n');
  const attachments = valid.flatMap(item => commands.get(item.id)!.source.attachments);
  await db.query(
    `UPDATE agent_commands SET wake_after=NULL,
       coalesced_context=concat_ws(E'\n',NULLIF(coalesced_context,''),NULLIF($2,'')),
       coalesced_attachments=$3::jsonb
     WHERE id=$1 AND state='pending'`,
    [head, context, JSON.stringify(attachments)]);
  if (rest.length) await db.query(
    `UPDATE agent_commands SET state='cancelled',completed_at=now(),cancellation_reason=$2
     WHERE id=ANY($1::text[]) AND state='pending'`,
    [rest.map((item) => item.id), `coalesced_into:${head}`]);
  return true;
}

/** Rebuild only when a recorded workflow source is no longer actionable. */
export async function refreshWakeDigests(db: SqlDatabase, roomId: string, agentId: string): Promise<void> {
  await db.transaction(async tx => {
    await lockWakeConsumer(tx, roomId, agentId);
    const heads = (await tx.query<{ id: string }>(
      `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND coalesced_context IS NOT NULL
       AND (state='pending' OR (state='claimed' AND lease_expires_at<=now())
         OR (state='cancelled' AND cancellation_reason='workflow_attempt_expired'))
       ORDER BY inbox_sequence FOR UPDATE`, [roomId, agentId])).rows;
    for (const head of heads) {
      const ids = (await tx.query<{ id: string }>(
        `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2
         AND (id=$3 OR cancellation_reason='coalesced_into:'||$3)
         ORDER BY inbox_sequence FOR UPDATE`, [roomId, agentId, head.id])).rows.map(row => row.id);
      if (!(await expiredWakeDigestSources(tx, roomId, agentId, ids)).length) continue;
      // Restore the immutable original sources in this transaction, then apply
      // the normal expiry fence and digest just the surviving commands. A stale
      // cached head loses its claim; the replacement gets its own ordinary claim.
      await tx.query(
        `UPDATE agent_commands SET state='pending',completed_at=NULL,cancellation_reason=NULL,
          coalesced_context=NULL,coalesced_attachments=NULL,wake_after=now()
         WHERE id=ANY($1::text[])`, [ids]);
      await flushCommanderWakes(tx, roomId, agentId, ids);
    }
  });
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
    await lockWakeConsumer(tx, recipient.room_id, recipient.agent_id);
    const membership = await tx.query(
      `SELECT 1 FROM memberships member JOIN rooms room ON room.id=member.room_id
       WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
         AND room.archived_at IS NULL`, [recipient.room_id, recipient.agent_id]);
    if (!membership.rowCount) return;
    const windows = (await tx.query<{ ids: string[] }>(
      `SELECT array_agg(id ORDER BY inbox_sequence) ids FROM agent_commands
       WHERE room_id=$1 AND agent_id=$2 AND state='pending' AND wake_after<=now()
       GROUP BY wake_after ORDER BY wake_after`, [recipient.room_id, recipient.agent_id])).rows;
    for (const window of windows)
      if (await flushCommanderWakes(tx, recipient.room_id, recipient.agent_id, window.ids)) flushed++;
  });
  return flushed;
}
