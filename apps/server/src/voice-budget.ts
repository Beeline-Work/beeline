import { randomUUID } from 'node:crypto';
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
    super(`0 minutes of call time remaining today. Resets at ${new Date(budget.resetAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}.`);
  }
}

/** Union server-observed audio intervals, so retries and overlapping devices never
 * spend the same wall-clock time twice. One identity/day row serializes writers. */
export class VoiceBudgetStore {
  constructor(private readonly db: SqlDatabase, readonly limitMs = DAILY_VOICE_MS,
    private readonly now = Date.now) {}

  async read(human: string, db = this.db): Promise<VoiceBudget> {
    const { start, resetAt } = voiceBudgetDay(this.now());
    const row = (await db.query<{ used: string }>(`SELECT COALESCE((SELECT sum(upper(r)-lower(r))
      FROM unnest(audio) r),0)::text used FROM voice_daily_usage WHERE identity_id=$1 AND day_start=$2`,
      [human, start])).rows[0];
    return { remainingMs: Math.max(0, this.limitMs - Number(row?.used ?? 0)), resetAt, timeZone: 'UTC' };
  }

  async require(human: string, db = this.db) {
    const budget = await this.read(human, db);
    if (budget.remainingMs <= 0) throw new VoiceBudgetExceeded(budget);
    return budget;
  }

  /** All runtimes advance one durable per-human window. A runtime acknowledges
   * a cursor only after committing every forwarded interval before it. Thus all
   * uncommitted intervals lie in the same 1,000 ms window, on every server. */
  async checkpoint(call: string, owner: string, human: string, meter: string,
    through: number, intervals: readonly AudioInterval[], closed: boolean) {
    return this.db.transaction(async db => {
      await db.query(`INSERT INTO voice_audio_windows(identity_id,through_ms) VALUES($1,$2)
        ON CONFLICT DO NOTHING`, [human, through]);
      const head = (await db.query<{ through_ms: string }>(`SELECT through_ms FROM voice_audio_windows
        WHERE identity_id=$1 FOR UPDATE`, [human])).rows[0]!;
      const budget = await this.recordWith(db, call, owner, human, intervals);
      if (!budget) return null;
      const lease = (await db.query<{ ttl: string }>(`SELECT
        GREATEST(0,EXTRACT(EPOCH FROM (runtime_until-clock_timestamp()))*1000)::text ttl
        FROM voice_calls WHERE id=$1`, [call])).rows[0]!;
      // Expired grants cannot forward again. A returning runtime must checkpoint
      // its retained intervals before acquiring a new window.
      await db.query(`DELETE FROM voice_audio_checkpoints WHERE identity_id=$1 AND expires_at<=clock_timestamp()`, [human]);
      const floor = Math.max(Number(head.through_ms), through);
      if (closed) await db.query(`DELETE FROM voice_audio_checkpoints WHERE meter_id=$1`, [meter]);
      else await db.query(`INSERT INTO voice_audio_checkpoints(meter_id,identity_id,through_ms,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+($4::double precision * interval '1 millisecond'))
        ON CONFLICT(meter_id) DO UPDATE SET through_ms=GREATEST(voice_audio_checkpoints.through_ms,excluded.through_ms),
          expires_at=excluded.expires_at`, [meter, human, floor, Number(lease.ttl)]);
      const frontier = (await db.query<{ through_ms: string }>(`UPDATE voice_audio_windows
        SET through_ms=GREATEST(through_ms,COALESCE((SELECT min(through_ms) FROM voice_audio_checkpoints
          WHERE identity_id=$1),$2)) WHERE identity_id=$1 RETURNING through_ms`, [human, floor])).rows[0]!;
      return { budget, floor, until: Number(frontier.through_ms) + 1000, ttl: Number(lease.ttl) };
    });
  }

  async record(call: string, owner: string, human: string, intervals: readonly AudioInterval[]): Promise<VoiceBudget | null> {
    return this.db.transaction(db => this.recordWith(db, call, owner, human, intervals));
  }

  private async recordWith(db: SqlDatabase, call: string, owner: string, human: string, intervals: readonly AudioInterval[]): Promise<VoiceBudget | null> {
    // A stale runtime may neither spend nor remove a successor's participant.
    const lease = await db.query(`SELECT 1 FROM voice_calls c JOIN voice_participants p ON p.call_id=c.id
      WHERE c.id=$1 AND c.runtime_owner=$2 AND c.runtime_until>now()
      AND p.identity_id=$3 FOR SHARE OF c,p`, [call, owner, human]);
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
      await db.query(`INSERT INTO voice_daily_usage(identity_id,day_start,audio) VALUES($1,$2,$3::int8multirange)
        ON CONFLICT(identity_id,day_start) DO UPDATE SET audio=voice_daily_usage.audio + excluded.audio`, [human, day, ranges]);
    }
    return this.read(human, db);
  }
}

/** PCM forwarding performs only local arithmetic. The ordered checkpoint lane
 * retains failed batches for idempotent retry and bounds uncommitted audio. */
export class VoiceAudioMeter {
  private pending: AudioInterval[] = [];
  private inFlight: AudioInterval[] = [];
  private lastEnd = 0;
  private readonly id = randomUUID();
  private through: number;
  private until = 0;
  private expires = 0;
  private activated = false;
  private budget: VoiceBudget;
  private flushing?: Promise<void>;
  private closed = false;
  private paused = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly store: VoiceBudgetStore, private readonly call: string,
    private readonly owner: string, private readonly human: string, initial: VoiceBudget,
    private readonly receipt: (budget: VoiceBudget | null) => void,
    private readonly log: (message: string) => void, private readonly now = Date.now, startAt = now()) {
    this.budget = initial;
    this.through = Math.floor(startAt);
    this.timer = setInterval(() => { if (this.activated) void this.flush().catch(() => {}); }, 250);
    this.timer.unref();
  }

  activate() { this.activated = true; }

  /** Returns the permitted PCM duration; zero means drop this frame, never queue
   * it behind storage. Audio with no frames (mute/reconnect) spends no time. */
  audio(milliseconds: number, capturedAt = this.now()): number {
    if (this.closed) return 0;
    if (performance.now() >= this.expires) return 0;
    const now = this.now();
    const today = voiceBudgetDay(now).start;
    if (now >= this.budget.resetAt)
      this.budget = { remainingMs: this.store.limitMs, resetAt: voiceBudgetDay(now).resetAt, timeZone: 'UTC' };
    const unsettled = [...this.inFlight, ...this.pending];
    const uncommitted = unsettled.reduce((sum, [a, b]) => sum + b - a, 0);
    const todayUncommitted = unsettled.reduce((sum, [a, b]) => sum + Math.max(0, b - Math.max(today, a)), 0);
    let duration = Math.max(0, Math.min(Math.ceil(milliseconds), 1000 - uncommitted,
      this.budget.remainingMs - todayUncommitted));
    // The durable grant is a shared timeline, not a separate second per device.
    const expected = this.lastEnd + duration;
    const desiredEnd = this.lastEnd && Math.abs(capturedAt - expected) < 100 ? expected : Math.max(capturedAt, expected);
    const start = Math.max(this.through, this.lastEnd, desiredEnd - duration);
    const end = Math.min(desiredEnd, this.until);
    duration = Math.max(0, end - start);
    if (duration < milliseconds && !this.paused) {
      this.paused = true; this.log('Voice input paused at the one-second accounting checkpoint bound');
    }
    if (!duration) return 0;
    if (this.paused && duration >= milliseconds) {
      this.paused = false; this.log('Voice input resumed after accounting checkpoint');
    }
    const tail = this.pending[this.pending.length - 1];
    if (tail && tail[1] === start) this.pending[this.pending.length - 1] = [tail[0], end];
    else this.pending.push([start, end]);
    this.lastEnd = end;
    return Math.min(duration, milliseconds);
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.inFlight = this.pending; this.pending = [];
    // Set the local floor before starting I/O: concurrent frames cannot appear
    // behind a cursor this transaction is about to acknowledge.
    if (this.activated) this.through = Math.max(this.through, this.lastEnd, this.now() - 100);
    const requestedAt = performance.now();
    this.flushing = (async () => {
      let budget: VoiceBudget | null;
      try {
        // Empty checkpoints observe spending by another device of this identity.
        const grant = await this.store.checkpoint(this.call, this.owner, this.human, this.id,
          this.through, this.inFlight, this.closed);
        budget = grant?.budget ?? null;
        if (grant) {
          this.until = grant.until; this.through = Math.max(this.through, grant.floor);
          this.expires = requestedAt + grant.ttl;
        } else { this.until = 0; this.expires = 0; }
      } catch (error) {
        this.pending = [...this.inFlight, ...this.pending]; this.inFlight = [];
        this.log('Voice accounting checkpoint failed; retrying');
        throw error;
      }
      this.inFlight = [];
      if (budget) this.budget = budget;
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
    do {
      try { await this.flush(); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
      break;
    } while (true);
  }
}
