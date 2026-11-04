import type { SqlDatabase } from './database.js';

/** Drop queue metadata only; objects retain their existing media TTL and tombstones. */
export async function sweepPendingAttachments(database: SqlDatabase): Promise<number> {
  const result = await database.query(
    `WITH abandoned AS (
       SELECT attachment.id FROM agent_pending_attachments attachment
       JOIN rooms room ON room.id=attachment.room_id
       WHERE room.archived_at IS NOT NULL OR (
         attachment.created_at <= now() - interval '24 hours'
         AND NOT EXISTS (
           SELECT 1 FROM agent_commands command
           WHERE command.room_id=attachment.room_id AND command.agent_id=attachment.agent_id
             AND command.turn_request_id=attachment.request_id
             AND command.action IN ('input','resume','restart') AND command.state IN ('pending','claimed')
         )
         AND NOT EXISTS (
           SELECT 1 FROM agent_turns turn
           WHERE turn.room_id=attachment.room_id AND turn.agent_id=attachment.agent_id
             AND turn.request_id=attachment.request_id AND turn.status='working'
         )
       )
       ORDER BY attachment.created_at,attachment.id LIMIT 1000
       FOR UPDATE OF attachment SKIP LOCKED
     ) DELETE FROM agent_pending_attachments attachment USING abandoned
       WHERE attachment.id=abandoned.id`,
  );
  return result.rowCount ?? 0;
}

export class PendingAttachmentCleanupLoop {
  constructor(private readonly database: SqlDatabase) {}
  runOnce(): Promise<number> { return sweepPendingAttachments(this.database); }

  /** Only a retained, eligible row can arm another deadline. Wait for its writer
   * rather than spinning on a locked due row or losing it on writer rollback. */
  async nextDelayMs(): Promise<number | undefined> {
    const result = await this.database.query<{ delay_ms: number }>(
      `WITH archived AS (
         SELECT attachment.id FROM rooms room
         CROSS JOIN LATERAL (
           SELECT id FROM agent_pending_attachments WHERE room_id=room.id
           ORDER BY created_at,id LIMIT 1 FOR UPDATE
         ) attachment WHERE room.archived_at IS NOT NULL LIMIT 1
       ), retained AS (
         SELECT attachment.created_at FROM agent_pending_attachments attachment
         JOIN rooms room ON room.id=attachment.room_id
         WHERE NOT EXISTS(SELECT 1 FROM archived) AND room.archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM agent_commands command
             WHERE command.room_id=attachment.room_id AND command.agent_id=attachment.agent_id
               AND command.turn_request_id=attachment.request_id
               AND command.action IN ('input','resume','restart') AND command.state IN ('pending','claimed'))
           AND NOT EXISTS (SELECT 1 FROM agent_turns turn
             WHERE turn.room_id=attachment.room_id AND turn.agent_id=attachment.agent_id
               AND turn.request_id=attachment.request_id AND turn.status='working')
         ORDER BY attachment.created_at,attachment.id LIMIT 1 FOR UPDATE OF attachment
       )
       SELECT 0::float8 delay_ms FROM archived
       UNION ALL
       SELECT greatest(0,ceil(extract(epoch FROM (
         created_at + interval '24 hours' - clock_timestamp()
       ))*1000))::float8 delay_ms FROM retained`,
    );
    return result.rows[0]?.delay_ms;
  }
}
