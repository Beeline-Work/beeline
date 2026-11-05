import { ROOM_VIEW_TOOL_ROW_LIMIT } from '@beeline/api-contract/phone';
import { cleanupUnfinishedAppSignIns } from './unfinished-app-sign-ins.js';
import { captureServerError } from './sentry.js';
import { retryMcpMemberRoutes } from './rooms-mcp-members.js';
import { DatabaseTransactionStartError, type SqlDatabase } from './database.js';
import { ARTIFACT_TTL_HOURS, MEDIA_SWEEP_INTERVAL_MS, mediaTtlHours } from './media-ttl.js';
import type { ObjectStorage } from './object-storage.js';
import type { ObjectService } from './object-service.js';



/**
 * The hourly object sweep. Attachment bytes are the one row class large enough
 * that keeping them forever is a storage decision rather than a bookkeeping
 * one, so they get a TTL (`media-ttl.ts`) and nothing else does: the messages
 * that reference them are untouched and keep their attachment metadata.
 *
 * It rides the one-second background cycle like every other job and throttles
 * itself, because a TTL measured in hours does not need a per-second DELETE.
 * The interval is in memory only: a restart re-sweeps at most one extra time,
 * and the sweep is idempotent.
 */
export class MediaExpiryLoop {
  #lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: SqlDatabase,
    private readonly ttlHours = mediaTtlHours(),
    private readonly intervalMs = MEDIA_SWEEP_INTERVAL_MS,
    private readonly objects?: {
      storage: ObjectStorage;
      /** Read-side facts (`readMediaObject`/`mediaLink`) need storage too; the
       *  sweep only uses `deleteObject`, batched and idempotent. */
      service: ObjectService;
    },
    private readonly artifactTtlHours = ARTIFACT_TTL_HOURS,
  ) {}

  /** Objects deleted by this call; 0 when the sweep was throttled or found nothing. */
  async runOnce(now = Date.now()): Promise<number> {
    if (now - this.#lastSweep < this.intervalMs) return 0;
    this.#lastSweep = now;
    return this.sweepObjects();
  }

  /** Exact deadline owner bypasses the former hourly observation throttle. */
  async runDeadline(): Promise<void> { await this.sweepObjects(); }

  async nextDelayMs(admittedAt?:string): Promise<number | undefined> {
    if (!this.objects) return;
    return (await import('./background-deadline-clock.js')).backgroundNextDelay(this.database,
      `SELECT LEAST(expires_at,CASE WHEN state='pending' THEN created_at+interval '1 hour' END) due_at FROM objects
       WHERE NOT EXISTS(SELECT 1 FROM corner_brief_revisions brief JOIN rooms corner ON corner.id=brief.corner_id AND corner.archived_at IS NULL
         CROSS JOIN LATERAL jsonb_array_elements(brief.attachments) file WHERE file->>'objectId'=objects.id::text)`,admittedAt);
  }

  /**
   * The object half of the sweep. Storage is deleted first, then the row and
   * the tombstone land together, so a crashed sweep at worst leaves a row
   * whose object is already gone — the next pass re-deletes (a 404 is
   * success) and finishes the row. Pending orphans older than an hour are
   * reaped the same way; a tombstone is only written for objects that were
   * once readable.
   */
  private async sweepObjects(): Promise<number> {
    if (!this.objects) return 0;
    const candidates = await this.database.query<{
      id: string;
      key: string;
      kind: 'media' | 'artifact';
      state: string;
    }>(
      `SELECT id::text id,key,kind,state FROM objects
       WHERE (expires_at < now()
          OR (state='pending' AND created_at < now() - interval '1 hour')
         ) AND NOT EXISTS (
           SELECT 1 FROM corner_brief_revisions brief
           JOIN rooms corner ON corner.id=brief.corner_id AND corner.archived_at IS NULL
           CROSS JOIN LATERAL jsonb_array_elements(brief.attachments) file
           WHERE file->>'objectId'=objects.id::text
         )
       LIMIT 100`,
    );
    let deleted = 0;
    for (const object of candidates.rows) {
      try {
        const removed = await this.database.transaction(async (db) => {
          // A brief's attachment validation takes a share lock on this same
          // object. Recheck after taking the write lock so an assignment that
          // committed since the candidate scan keeps its bytes.
          const current = (
            await db.query<{ key: string; kind: 'media' | 'artifact'; state: string }>(
              `SELECT key,kind,state FROM objects WHERE id=$1 FOR UPDATE`,
              [object.id],
            )
          ).rows[0];
          if (!current) return false;
          const pinned = await db.query(
            `SELECT 1 FROM corner_brief_revisions brief
             JOIN rooms corner ON corner.id=brief.corner_id AND corner.archived_at IS NULL
             CROSS JOIN LATERAL jsonb_array_elements(brief.attachments) file
             WHERE file->>'objectId'=$1 LIMIT 1`,
            [object.id],
          );
          if (pinned.rowCount) return false;
          await this.objects!.storage.deleteObject(current.key);
          if (current.state === 'ready')
            await db.query(
              `INSERT INTO object_expirations(id,retention_hours) VALUES ($1,$2)
               ON CONFLICT(id) DO NOTHING`,
              [object.id, current.kind === 'artifact' ? this.artifactTtlHours : this.ttlHours],
            );
          await db.query(`DELETE FROM objects WHERE id=$1`, [object.id]);
          return true;
        });
        if (removed) deleted += 1;
      } catch (error) {
        console.warn(
          '[media-ttl] object delete failed, will retry next sweep',
          object.id,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
    }
    return deleted;
  }
}


// Ephemeral scan cursor: restart/leader changes only revisit already-clean corners.
export let archivedToolCursor: string | null = null;

/** Keep the same tool/output window the phone reads; prose and durable facts survive. */
export async function pruneArchivedToolActivity(database: SqlDatabase): Promise<void> {
  const corners = (await database.query<{ id: string }>(`SELECT id FROM rooms
    WHERE parent_id IS NOT NULL AND archived_at IS NOT NULL
      AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 20`, [archivedToolCursor])).rows;
  if (!corners.length) { archivedToolCursor = null; return; }
  const deleted = await database.query(`DELETE FROM messages WHERE id IN (
    SELECT old.id FROM rooms corner CROSS JOIN LATERAL (
      SELECT message.id FROM messages message
      WHERE message.room_id=corner.id AND message.presentation='activity'
        AND message.durable_fact IS NULL AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(message.activity) item
          WHERE item->>'kind' IN ('tool','output'))
      ORDER BY message.created_at DESC,message.id DESC
      OFFSET ${ROOM_VIEW_TOOL_ROW_LIMIT} LIMIT 1000
    ) old WHERE corner.id=ANY($1::uuid[]) AND corner.archived_at IS NOT NULL
    LIMIT 1000
  ) RETURNING id`, [corners.map(corner => corner.id)]);
  // Drain this slice before advancing, so a large corner does not wait a full scan.
  if (deleted.rows.length < 1000) archivedToolCursor = corners.at(-1)!.id;
}


export async function runMaintenance(database: SqlDatabase): Promise<void> {
  await pruneArchivedToolActivity(database);
  await cleanupUnfinishedAppSignIns(database, true);
  // Legacy routing repair remains separate from committed delivery ownership.
  try { await retryMcpMemberRoutes(database); } catch (error) { captureServerError(error); }
  // Each autocommitted batch fits the jobs pool budget; later cycles finish backlogs.
  const expired = [
    ['agent_turn_traces', "created_at<now()-interval '30 days'"],
    ['room_push_views', 'expires_at<now()'],
    ['workspace_join_notification_devices', "notification_id IN (SELECT id FROM workspace_join_notifications WHERE created_at<now()-interval '1 hour')"],
    ['workspace_join_notifications', "created_at<now()-interval '1 hour'"],
    // A corner's assignment commands are its worker, owner and opening provenance
    // (corner-worker.ts): they stay for the corner's life.
    ['agent_commands', "state IN ('complete','cancelled') AND completed_at<now()-interval '30 days' AND NOT (reason IN ('corner_objective','human_tag') AND room_id IN (SELECT id FROM rooms WHERE parent_id IS NOT NULL))"],
    ['phone_access_tokens', 'expires_at<now()'],
    ['rooms_mcp_event_deliveries', "delivered_at<now()-interval '7 days'"],
    ['rooms_mcp_event_subscriptions', "expires_at<now()-interval '7 days'"],
    ['rooms_mcp_flows', 'expires_at<now()'],
    ['rooms_mcp_codes', 'expires_at<now()'],
    ['rooms_mcp_handoffs', 'expires_at<now()'],
    ['rooms_mcp_tokens', 'expires_at<now()'],
    ['rooms_mcp_families', "revoked_at<now()-interval '30 days'"],
    ['rooms_mcp_connections', "revoked_at<now()-interval '30 days'"],
    ['rooms_mcp_audit', "created_at<now()-interval '30 days'"],
    ['rooms_mcp_pending_routes', "created_at<now()-interval '7 days'"],
    ['rooms_mcp_admission', "window_at<now()-interval '1 day'"],
    ['rooms_mcp_clients', "created_at<now()-interval '30 days' AND NOT preregistered AND NOT EXISTS(SELECT 1 FROM rooms_mcp_connections WHERE client_id=rooms_mcp_clients.id) AND NOT EXISTS(SELECT 1 FROM rooms_mcp_tokens WHERE client_id=rooms_mcp_clients.id) AND NOT EXISTS(SELECT 1 FROM rooms_mcp_flows WHERE client_id=rooms_mcp_clients.id) AND NOT EXISTS(SELECT 1 FROM rooms_mcp_codes WHERE client_id=rooms_mcp_clients.id)"],
    ['live_outputs', "updated_at<now()-interval '2 hours' AND kind<>'presence'"],
    ['github_auth_flows', "expires_at<now()-interval '1 day'"],
    ['daemon_token_exchanges', "expires_at<now()-interval '1 day'"],
  ] as const;
  for (const [table, predicate] of expired) {
    await database.query(`DELETE FROM ${table} WHERE ctid IN (
      SELECT ctid FROM ${table} WHERE ${predicate} LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
  }
}


export interface BackgroundJobHealth {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
}


/** One advisory leader, independent failure boundaries for each job class. */
export class BackgroundJobRunner {
  readonly #health = new Map<string, BackgroundJobHealth>();

  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): Record<string, BackgroundJobHealth> {
    return Object.fromEntries([...this.#health].map(([name, health]) => [name, { ...health }]));
  }

  async run<T>(
    name: string,
    work: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const health = this.#health.get(name) ?? {
      lastSuccessAt: null,
      lastErrorAt: null,
      lastDurationMs: null,
      consecutiveFailures: 0,
    };
    this.#health.set(name, health);
    const startedAt = this.now();
    try {
      const value = await work();
      health.lastSuccessAt = this.now();
      health.consecutiveFailures = 0;
      return { ok: true, value };
    } catch (error) {
      health.lastErrorAt = this.now();
      health.consecutiveFailures++;
      // Operator deliveries stay pending when BEGIN/checkout fails. The next
      // committed delivery or real recovery may resume them; keep a
      // continuing outage at error level without creating a retry timer.
      if (name === 'operator-system-dms' && error instanceof DatabaseTransactionStartError &&
          health.consecutiveFailures === 1) {
        console.warn(`[background] ${name} deferred until committed delivery or recovery`, error);
        return { ok: false };
      }
      captureServerError(error, { background_job: name });
      console.error(`[background] ${name} failed`, error);
      return { ok: false };
    } finally {
      health.lastDurationMs = Math.max(0, this.now() - startedAt);
    }
  }
}
