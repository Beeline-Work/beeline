import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { queueMcpMentionEvents } from './rooms-mcp-events.js';
import { recordMcpMemberWebhook } from './rooms-mcp-members.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

export function mentionRouting(memberId: string, roomId: string, messageId: string) {
  return { roomId, messageId, memberId, replyRule: `answer in this Room with replyTo ${messageId}`,
    idempotencyKey: `mention:${memberId}:${messageId}` };
}

/** Retain cleared rows: a retry must keep the server key even after its answer committed. */
export async function mentionReplyKey(db: SqlDatabase, member: string, room: string, message?: string): Promise<string | undefined> {
  if (!message) return undefined;
  return (await db.query(`SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND room_id=$2 AND message_id=$3`,
    [member, room, message])).rowCount ? `mention:${member}:${message}` : undefined;
}
export function mentionReplyId(key: string): string {
  return createHash('sha256').update(`rooms-mcp-message:${key}`).digest('hex');
}

const serverMentionInputs = new WeakSet<object>();

/** Normalize transport metadata before the ordinary phone reply writer runs. */
export async function prepareMentionReplyInput(db: SqlDatabase, member: string,
  input: { roomId: string; parentMessageId: string; messageId?: string }): Promise<void> {
  const key = await mentionReplyKey(db, member, input.roomId, input.parentMessageId);
  if (!key) return;
  input.messageId = mentionReplyId(key);
  serverMentionInputs.add(input);
}

export function isMentionReplyInput(input: object): boolean {
  return serverMentionInputs.has(input);
}

/** Private, current membership-scoped reminder accompanying tool results. */
export async function owedMentions(db: SqlDatabase, member: string) {
  const rows = (await db.query<{room_id: string; message_id: string}>(`SELECT mention.room_id,mention.message_id
    FROM rooms_mcp_mentions mention JOIN messages m ON m.id=mention.message_id AND m.deleted_at IS NULL
    JOIN rooms r ON r.id=mention.room_id AND r.archived_at IS NULL
    WHERE mention.member_id=$1 AND mention.cleared_at IS NULL
      AND EXISTS(SELECT 1 FROM effective_memberships rm WHERE rm.room_id=r.id AND rm.identity_id=$1 AND rm.removed_at IS NULL)
      AND EXISTS(SELECT 1 FROM memberships wm WHERE wm.workspace_id=r.workspace_id AND wm.room_id IS NULL AND wm.identity_id=$1 AND wm.removed_at IS NULL)
    ORDER BY mention.seq LIMIT 100`, [member])).rows;
  return rows.map(row => mentionRouting(member, row.room_id, row.message_id));
}
export async function clearOwedMention(db: SqlDatabase, member: string, room: string, message: string): Promise<number> {
  return (await db.query(`UPDATE rooms_mcp_mentions SET cleared_at=now()
    WHERE member_id=$1 AND room_id=$2 AND message_id=$3 AND cleared_at IS NULL`, [member, room, message])).rowCount ?? 0;
}

/** The existing maintenance job drains durable mention deadlines. No client timer or new service. */
export async function retryOwedMentions(db: SqlDatabase, now = new Date()): Promise<number> {
  return db.transaction(async tx => {
    const due = (await tx.query<{member_id: string; room_id: string; message_id: string; rewakes: number; callback_url: string | null; text: string}>(`
      SELECT mention.member_id,mention.room_id,mention.message_id,mention.rewakes,
        COALESCE(member.callback_url,client.callback_url) callback_url,m.text
      FROM rooms_mcp_mentions mention
      JOIN messages m ON m.id=mention.message_id AND m.deleted_at IS NULL
      JOIN rooms r ON r.id=mention.room_id AND r.archived_at IS NULL
      LEFT JOIN rooms_mcp_members member ON member.member_id=mention.member_id
      LEFT JOIN rooms_mcp_clients client ON client.id=member.client_id
      WHERE mention.cleared_at IS NULL AND mention.rewakes<3
        AND mention.created_at + (CASE mention.rewakes WHEN 0 THEN 5 WHEN 1 THEN 15 ELSE 45 END)*interval '1 minute'<=$1
        AND EXISTS(SELECT 1 FROM effective_memberships rm WHERE rm.room_id=r.id AND rm.identity_id=mention.member_id AND rm.removed_at IS NULL)
        AND EXISTS(SELECT 1 FROM memberships wm WHERE wm.workspace_id=r.workspace_id AND wm.room_id IS NULL AND wm.identity_id=mention.member_id AND wm.removed_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM agent_commands c WHERE c.agent_id=mention.member_id AND c.source_message_id=mention.message_id
          AND c.state='claimed' AND c.lease_expires_at>now())
        AND NOT EXISTS(SELECT 1 FROM agent_turns t JOIN agent_commands c
          ON c.agent_id=t.agent_id AND c.room_id=t.room_id AND c.turn_request_id=t.request_id
          WHERE c.agent_id=mention.member_id AND c.source_message_id=mention.message_id
            AND t.status='working' AND t.created_at>now()-interval '90 seconds')
      ORDER BY mention.created_at,mention.seq LIMIT 100 FOR UPDATE OF mention SKIP LOCKED`, [now])).rows;
    for (const row of due) {
      const attempt = row.rewakes + 1;
      await tx.query("UPDATE rooms_mcp_mentions SET rewakes=$3,seq=nextval(pg_get_serial_sequence('rooms_mcp_mentions','seq')) WHERE member_id=$1 AND message_id=$2", [row.member_id, row.message_id, attempt]);
      // Reuse the same ledger/outbox rows; event ids distinguish scheduled wakes from transport retries.
      await queueMcpMentionEvents(tx, row.member_id, row.room_id, row.message_id, attempt);
      if (row.callback_url) {
        await recordMcpMemberWebhook(tx, row.member_id, row.callback_url, row.room_id, row.message_id, row.text);
        await tx.query(`UPDATE rooms_mcp_webhook_outbox SET delivered_at=NULL,claimed_at=NULL,attempts=0
          WHERE member_id=$1 AND message_id=$2`, [row.member_id, row.message_id]);
      }
      // The command still names the original message and keeps its authority/provenance.
      await tx.query(`UPDATE agent_commands SET state='pending',completed_at=NULL,claimed_at=NULL,
        lease_expires_at=NULL,generation_id=NULL,result_message_id=NULL,turn_request_id=$3
        WHERE agent_id=$1 AND source_message_id=$2 AND action='input' AND state='complete'`,
      [row.member_id, row.message_id, createHash('sha256').update(`mention:${row.member_id}:${row.message_id}:retry:${attempt}`).digest('hex')]);
      await tx.query('SELECT pg_notify($1,$2)', [POSTGRES_LIVE_CHANNEL,
        JSON.stringify({ table: 'agent_commands', operation: 'UPDATE', roomId: row.room_id, agentId: row.member_id })]);
    }
    return due.length;
  });
}
