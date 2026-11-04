import type { BackgroundJobRunner } from './background.js';
import type { SqlDatabase } from './database.js';

const FLUSH_DELAY_MS = 5 * 60_000;
const MAX_KEYS = 2000;
const BATCH_SIZE = 100;
type Outcome = { hour: string; op: string; status: number; code: string; count: number };

/**
 * The fix loop's daily read (through the read-only database route): each
 * operation refused in the last 24 complete hours, per release, with successes
 * as the denominator and the median of the previous seven daily totals for the
 * same release. A day without calls is not a baseline day.
 */
export const OPERATION_REFUSALS_SQL = `WITH bounds AS (SELECT date_trunc('hour', now()) AS cur),
buckets AS (
  SELECT o.op, o.release, floor(extract(epoch FROM (b.cur - o.hour)) / 86400)::int AS day,
         sum(o.count) AS calls, coalesce(sum(o.count) FILTER (WHERE o.status >= 400), 0) AS refused
  FROM operation_outcomes_hourly o, bounds b
  WHERE o.hour < b.cur AND o.hour >= b.cur - interval '8 days' AND o.op <> '(other)'
  GROUP BY 1, 2, 3),
history AS (
  SELECT op, release, count(*)::int AS baseline_days,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY refused) AS median_daily_refused,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY refused::float8 / calls::float8) AS median_refusal_rate
  FROM buckets WHERE day BETWEEN 1 AND 7 GROUP BY 1, 2)
SELECT t.op, t.release, t.calls, t.refused, t.refused::float8 / t.calls::float8 AS refusal_rate,
       coalesce(h.baseline_days, 0) AS baseline_days, h.median_daily_refused, h.median_refusal_rate
FROM buckets t LEFT JOIN history h USING (op, release)
WHERE t.day = 0 AND t.refused > 0
ORDER BY t.refused DESC, t.op, t.release
LIMIT 50`;

/** Process-local telemetry only: a crash may lose everything since the last flush. */
export class OperationOutcomes {
  private readonly counts = new Map<string, Outcome>();
  private flushing?: Promise<void>;
  private readonly listeners = new Set<() => void>();
  hasPending(): boolean { return this.counts.size > 0; }
  subscribePending(listener: () => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }

  constructor(private readonly release = process.env.BEELINE_RELEASE_SHA ?? '',
    private readonly now: () => number = Date.now) {}

  record(op: string, status: number, code: string): void {
    const hour = new Date(Math.floor(this.now() / 3_600_000) * 3_600_000).toISOString();
    op = op.slice(0, 128);
    code = code === '' || /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(code) ? code : 'Error';
    let key = JSON.stringify([hour, op, status, code]);
    // Reserve one slot per HTTP status so overflow keeps the success denominator.
    // Each bucket retains its first observed hour until flushed, even during an outage.
    if (!this.counts.has(key) && this.counts.size >= MAX_KEYS - 500) {
      status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
      key = `(other):${status}`; op = '(other)'; code = 'overflow';
    }
    const existing = this.counts.get(key);
    if (existing) existing.count++;
    else this.counts.set(key, { hour, op, status, code, count: 1 });
    for (const listener of this.listeners) listener();
  }

  flush(database: SqlDatabase): Promise<void> {
    return this.flushing ??= this.persist(database).finally(() => { this.flushing = undefined; });
  }

  private async persist(database: SqlDatabase): Promise<void> {
    const snapshot = [...this.counts].map(([key, value]) => ({ key, ...value }));
    for (let offset = 0; offset < snapshot.length; offset += BATCH_SIZE) {
      const batch = snapshot.slice(offset, offset + BATCH_SIZE);
      await database.query(
        `INSERT INTO operation_outcomes_hourly(hour,op,status,code,release,count)
         SELECT hour,op,status,code,$2,count FROM jsonb_to_recordset($1::jsonb)
           AS outcome(hour timestamptz,op text,status int,code text,count bigint)
         ON CONFLICT(hour,op,status,code,release) DO UPDATE
           SET count=operation_outcomes_hourly.count+excluded.count`,
        [JSON.stringify(batch), this.release],
      );
      // Subtract only committed counts; requests arriving during the write survive.
      for (const row of batch) {
        const current = this.counts.get(row.key)!;
        current.count -= row.count;
        if (!current.count) this.counts.delete(row.key);
      }
    }
    await database.query(`DELETE FROM operation_outcomes_hourly WHERE ctid IN (
      SELECT ctid FROM operation_outcomes_hourly WHERE hour<now()-interval '14 days'
      ORDER BY hour LIMIT 2000 FOR UPDATE SKIP LOCKED)`);
  }
}

/** Every instance owns its actual pending counts. A batch has one deadline;
 * retention has the oldest durable row's expiry. Empty time creates no work. */
export function startOperationOutcomeFlush(database: SqlDatabase, outcomes: OperationOutcomes,
  runner: BackgroundJobRunner, subscribeRecovery?: (wake: () => void) => () => void): () => Promise<void> {
  let stopped = false;
  let flushAt: number | undefined;
  let retentionAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const nextRetention = async (): Promise<number | undefined> => {
    const row = (await database.query<{ next_at: Date | string }>(
      `SELECT hour + interval '14 days' + interval '1 millisecond' AS next_at
       FROM operation_outcomes_hourly ORDER BY hour LIMIT 1`)).rows[0];
    if (!row) return;
    const at = new Date(row.next_at).getTime();
    if (!Number.isFinite(at)) throw new Error('Invalid outcome retention deadline');
    return at;
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (stopped || running) return;
    const at = Math.min(flushAt ?? Infinity, retentionAt ?? Infinity);
    if (!Number.isFinite(at)) return;
    timer = setTimeout(() => { timer = undefined; run(true); }, Math.max(0, at - Date.now()));
    timer.unref();
  };
  const run = (flush: boolean) => {
    if (stopped || running) return;
    if (flush) { flushAt = undefined; retentionAt = undefined; }
    running = (async () => {
      const result = await runner.run('operation-outcomes', async () => {
        if (flush) await outcomes.flush(database);
        return nextRetention();
      });
      // A failed attempt parks. Only a new outcome or real DB recovery can
      // re-admit it; there is no recurring flush or failure backoff.
      if (!stopped && result.ok) retentionAt = result.value;
    })().finally(() => { running = undefined; arm(); });
  };
  const pending = () => {
    if (stopped) return;
    flushAt ??= Date.now() + FLUSH_DELAY_MS;
    arm();
  };
  const stopPending = outcomes.subscribePending(pending);
  const stopRecovery = subscribeRecovery?.(() => {
    if (stopped) return;
    flushAt = Date.now(); arm();
  });
  if (outcomes.hasPending()) pending();
  run(false); // One startup read of durable expiry evidence, then park if empty.
  return async () => {
    stopped = true; stopPending(); stopRecovery?.();
    if (timer) clearTimeout(timer);
    await running;
  };
}
