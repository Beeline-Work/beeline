import type { SqlDatabase } from './database.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

/** A new leader re-announces expiries this far back; a repeat is harmless. */
const TAKEOVER_LOOKBACK_MS = 5 * 60_000;

/**
 * An owed item that expires changes its corner's row in the parent's corner
 * list without any write, so no trigger fires. The background leader runs
 * this job and announces each expiry through the live channel, which every
 * server machine listens on.
 */
export class CornerOwedExpiry {
  #sweptAt: Date | undefined;

  constructor(private readonly database: SqlDatabase) {}

  /** Announce every expiry since the previous run. Returns how many corners. */
  async runOnce(now = new Date(), newLeader = false): Promise<number> {
    if (newLeader || !this.#sweptAt)
      this.#sweptAt = new Date(now.getTime() - TAKEOVER_LOOKBACK_MS);
    const since = this.#sweptAt;
    if (now <= since) return 0;
    const result = await this.database.query<{ notified: number }>(
      `SELECT count(pg_notify($3, jsonb_build_object(
         'table', 'corner_owed', 'operation', 'UPDATE',
         'roomId', due.corner_id, 'cornerParentId', due.parent_id)::text))::int notified
       FROM (SELECT DISTINCT owed.corner_id::text corner_id, room.parent_id::text parent_id
             FROM corner_owed owed JOIN rooms room ON room.id=owed.corner_id
             WHERE owed.expires_at>$1 AND owed.expires_at<=$2
               AND room.parent_id IS NOT NULL) due`,
      [since, now, POSTGRES_LIVE_CHANNEL],
    );
    this.#sweptAt = now;
    return result.rows[0]?.notified ?? 0;
  }

  /** The next stored expiry after `after`, or null when none is pending. */
  async nextDueAt(after = new Date()): Promise<Date | null> {
    const result = await this.database.query<{ next_at: Date | null }>(
      `SELECT min(expires_at) next_at FROM corner_owed WHERE expires_at>$1`,
      [after],
    );
    return result.rows[0]?.next_at ?? null;
  }
}
