import type { SqlDatabase } from './database.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

/** A new leader re-announces expiries this far back; a repeat is harmless. */
const TAKEOVER_LOOKBACK_MS = 5 * 60_000;

/**
 * An owed item that expires changes its corner's row in the parent's corner
 * list without any write, so no trigger fires. The background leader runs
 * this job and announces each expiry through the live channel, which every
 * server machine listens on.
 *
 * Readers hide an expired item by the database's `now()`, so the sweep
 * decides "due" by the same clock. An app clock that runs ahead must not
 * announce an expiry before readers see it.
 */
export class CornerOwedExpiry {
  #sweptAt: Date | undefined;

  constructor(private readonly database: SqlDatabase) {}

  /** Announce every expiry since the previous run. Returns how many corners. */
  async runOnce(newLeader = false): Promise<number> {
    const since = newLeader ? undefined : this.#sweptAt;
    const result = await this.database.query<{ notified: number; swept_at: Date }>(
      `WITH bound AS (
         SELECT COALESCE($1::timestamptz, now()-$2*interval '1 millisecond') since, now() until)
       SELECT (SELECT count(pg_notify($3, jsonb_build_object(
           'table', 'corner_owed', 'operation', 'UPDATE',
           'roomId', due.corner_id, 'cornerParentId', due.parent_id)::text))::int
         FROM (SELECT DISTINCT owed.corner_id::text corner_id, room.parent_id::text parent_id
               FROM corner_owed owed JOIN rooms room ON room.id=owed.corner_id, bound
               WHERE owed.expires_at>bound.since AND owed.expires_at<=bound.until
                 AND room.parent_id IS NOT NULL) due) notified,
         GREATEST(since, until) swept_at
       FROM bound`,
      [since ?? null, TAKEOVER_LOOKBACK_MS, POSTGRES_LIVE_CHANNEL],
    );
    const row = result.rows[0];
    if (row) this.#sweptAt = row.swept_at;
    return row?.notified ?? 0;
  }

  /** Milliseconds until the next stored expiry, or null when none is pending. */
  async msUntilNextDue(): Promise<number | null> {
    const result = await this.database.query<{ ms: number | null }>(
      `SELECT (extract(epoch FROM min(expires_at)-now())*1000)::float8 ms
       FROM corner_owed WHERE expires_at>now()`,
    );
    return result.rows[0]?.ms ?? null;
  }
}
