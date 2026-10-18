import type { VoiceBudget } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

const DAY_MS = 86_400_000;
export const DAILY_VOICE_MS = 60 * 60_000;
export const VOICE_WARNING_MS = 2 * 60_000;
export type AudioInterval = readonly [number, number];

/** No identity timezone is stored today. The explicit fallback is UTC. */
export function voiceBudgetDay(now: number) {
  const start = Math.floor(now / DAY_MS) * DAY_MS;
  return { start, resetAt: start + DAY_MS };
}

export class VoiceBudgetExceeded extends Error {
  constructor(readonly budget: VoiceBudget) {
    super('Calls resume at 12:00 AM');
  }
}

/** Union microphone intervals within each call. Concurrent calls add to the
 * workspace total; retrying a checkpoint never spends the same time twice. */
export class VoiceBudgetStore {
  constructor(private readonly db: SqlDatabase, readonly limitMs = DAILY_VOICE_MS,
    private readonly now = Date.now) {}

  async read(workspace: string, db = this.db): Promise<VoiceBudget> {
    const { start, resetAt } = voiceBudgetDay(this.now());
    const row = (await db.query<{ used: string }>(`SELECT COALESCE(sum((SELECT sum(upper(r)-lower(r)) FROM unnest(audio) r)),0)::text used
      FROM voice_workspace_usage WHERE workspace_id=$1 AND day_start=$2`,
      [workspace, start])).rows[0];
    return { remainingMs: Math.max(0, this.limitMs - Number(row?.used ?? 0)), resetAt, timeZone: 'UTC' };
  }

  async require(workspace: string, db = this.db) {
    const budget = await this.read(workspace, db);
    if (budget.remainingMs <= 0) throw new VoiceBudgetExceeded(budget);
    return budget;
  }

  async record(call: string, owner: string, workspace: string, intervals: readonly AudioInterval[]): Promise<VoiceBudget | null> {
    return this.db.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`voice-budget:${workspace}`]);
      // A stale runtime may neither spend nor remove a successor's participant.
      const lease = await db.query(`SELECT 1 FROM voice_calls c JOIN rooms r ON r.id=c.room_id
        WHERE c.id=$1 AND c.runtime_owner=$2 AND c.runtime_until>now()
        AND r.workspace_id=$3 FOR SHARE OF c`, [call, owner, workspace]);
      if (!lease.rowCount) return null;
      const now = this.now();
      const days = new Map<number, AudioInterval[]>();
      for (const [from, to] of intervals) {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to || to > now + 1000)
          throw new Error('Invalid voice audio interval');
        for (let at = from; at < to;) {
          const { start, resetAt } = voiceBudgetDay(at);
          const end = Math.min(resetAt, to);
          const slices = days.get(start) ?? [];
          slices.push([at, end]); days.set(start, slices); at = end;
        }
      }
      for (const [day, slices] of [...days].sort(([a], [b]) => a - b)) {
        const ranges = `{${slices.map(([a, b]) => `[${a},${b})`).join(',')}}`;
        await db.query(`INSERT INTO voice_workspace_usage(workspace_id,call_id,day_start,audio) VALUES($1,$2,$3,$4::int8multirange)
          ON CONFLICT(workspace_id,call_id,day_start) DO UPDATE SET audio=voice_workspace_usage.audio + excluded.audio`, [workspace, call, day, ranges]);
      }
      return this.read(workspace, db);
    });
  }
}

/** PCM forwarding performs only local arithmetic. The ordered checkpoint lane
 * retains failed batches for idempotent retry and bounds uncommitted audio to
 * one second per call. The durable daily budget is shared per workspace. */
export class VoiceAudioMeter {
  private pending: AudioInterval[] = [];
  private inFlight: AudioInterval[] = [];
  private lastEnd = 0;
  private budget: VoiceBudget;
  private flushing?: Promise<void>;
  private closed = false;
  private paused = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly store: VoiceBudgetStore, private readonly call: string,
    private readonly owner: string, private readonly workspace: string, initial: VoiceBudget,
    private readonly receipt: (budget: VoiceBudget | null) => void,
    private readonly log: (message: string) => void, private readonly now = Date.now) {
    this.budget = initial;
    this.timer = setInterval(() => { void this.flush().catch(() => {}); }, 250);
    this.timer.unref();
  }

  /** Returns the permitted PCM duration; zero means drop this frame, never queue
   * it behind storage. Audio with no frames (mute/reconnect) spends no time. */
  audio(milliseconds: number, capturedAt = this.now()): number {
    if (this.closed) return 0;
    const now = this.now();
    const today = voiceBudgetDay(now).start;
    if (now >= this.budget.resetAt)
      this.budget = { remainingMs: this.store.limitMs, resetAt: voiceBudgetDay(now).resetAt, timeZone: 'UTC' };
    const unsettled = [...this.inFlight, ...this.pending];
    const uncommitted = unsettled.reduce((sum, [a, b]) => sum + b - a, 0);
    const todayUncommitted = unsettled.reduce((sum, [a, b]) => sum + Math.max(0, b - Math.max(today, a)), 0);
    const end = capturedAt;
    const frameStart = end - Math.ceil(milliseconds);
    // Bridge scheduling jitter while the microphone stays live. This also
    // keeps a continuous call from accumulating thousands of tiny ranges.
    const start = this.lastEnd && frameStart - this.lastEnd < 100
      ? this.lastEnd : Math.max(this.lastEnd, frameStart);
    const elapsed = Math.max(0, end - start);
    const duration = Math.max(0, Math.min(elapsed, 1000 - uncommitted,
      this.budget.remainingMs - todayUncommitted));
    if (elapsed > duration && uncommitted >= 1000 && !this.paused) {
      this.paused = true; this.log('Voice input paused at the one-second accounting checkpoint bound');
    }
    // Simultaneous microphones may forward audio but never add time twice.
    if (!elapsed) return uncommitted < 1000 && this.budget.remainingMs > todayUncommitted ? milliseconds : 0;
    if (!duration) return 0;
    const acceptedEnd = start + duration;
    const tail = this.pending[this.pending.length - 1];
    if (tail && tail[1] === start) this.pending[this.pending.length - 1] = [tail[0], acceptedEnd];
    else this.pending.push([start, acceptedEnd]);
    this.lastEnd = acceptedEnd;
    return duration === elapsed ? milliseconds : Math.min(duration, milliseconds);
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.inFlight = this.pending; this.pending = [];
    this.flushing = (async () => {
      let budget: VoiceBudget | null;
      try {
        // Empty checkpoints observe spending by another call in this workspace.
        budget = await this.store.record(this.call, this.owner, this.workspace, this.inFlight);
      } catch (error) {
        this.pending = [...this.inFlight, ...this.pending]; this.inFlight = [];
        this.log('Voice accounting checkpoint failed; retrying');
        throw error;
      }
      this.inFlight = [];
      if (budget) this.budget = budget;
      if (this.paused) { this.paused = false; this.log('Voice input resumed after accounting checkpoint'); }
      // Receipt handlers must not be awaited: ending the call also closes meters.
      this.receipt(budget);
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  async close() {
    this.closed = true; clearInterval(this.timer);
    if (this.flushing) await this.flushing.catch(() => {});
    // A normal leave must retain the last batch just like an active meter.
    // A successor lease makes record return null and ends this retry lane.
    while (this.pending.length) {
      try { await this.flush(); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
  }
}
