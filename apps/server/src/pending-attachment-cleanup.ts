import type { SqlDatabase } from './database.js';

/** Drop queue metadata only; objects retain their existing media TTL and tombstones. */
export async function sweepPendingAttachments(database: SqlDatabase): Promise<number> {
  const result = await database.query(
    `WITH abandoned AS (
       SELECT attachment.id FROM agent_pending_attachments attachment
       JOIN rooms room ON room.id=attachment.room_id
       WHERE room.archived_at IS NOT NULL OR (
         attachment.created_at < now() - interval '24 hours'
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
  #lastSweep = Number.NEGATIVE_INFINITY;
  constructor(private readonly database: SqlDatabase) {}
  async runOnce(now = Date.now()): Promise<number> {
    if (now - this.#lastSweep < 60 * 60 * 1000) return 0;
    const deleted = await sweepPendingAttachments(this.database);
    this.#lastSweep = now;
    return deleted;
  }
}
