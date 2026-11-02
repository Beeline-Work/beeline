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
    const budget = await this.db.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`voice-budget:${workspace}`]);
      // A stale runtime may neither spend nor remove a successor's participant.
      const lease = await db.query(`SELECT 1 FROM voice_calls c JOIN rooms r ON r.id=c.room_id
        WHERE c.id=$1 AND c.runtime_owner=$2 AND c.runtime_until>clock_timestamp() AND c.ended_at IS NULL
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
    return budget;
  }

  /** Usage is durable before entering this second transaction. Retain the
   * exact owner row through synchronous enqueue, so takeover cannot fit
   * between a permission reply and a later PCM callback. */
  fence(call: string, owner: string, enqueue: () => void): Promise<boolean> {
    return this.db.transaction(async db => {
      const current = await db.query(`SELECT 1 FROM voice_calls
        WHERE id=$1 AND runtime_owner=$2 AND runtime_until>clock_timestamp() AND ended_at IS NULL FOR SHARE`, [call, owner]);
      if (!current.rowCount) return false;
      enqueue(); return true;
    });
  }
}

/** Captured PCM stays bounded until its exact usage interval is durable.
 * The multirange is the persistent watermark: duplicate/uncertain commits
 * cannot charge twice. A failed obligation parks until actual recovery. */
export class VoiceAudioMeter {
  private pending: AudioInterval[] = [];
  private inFlight: AudioInterval[] = [];
  private pendingFrames: Array<{ run(): void; release(): void }> = [];
  private inFlightFrames: Array<{ run(): void; release(): void }> = [];
  private lastEnd = 0;
  private budget: VoiceBudget;
  private flushing?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private parked = false;
  private fenced = false;
  private paused = false;
  private heldBytes = 0;
  private heldMilliseconds = 0;
  private readonly reservations = new Set<() => void>();
  private readonly reservationDetails = new WeakMap<() => void, { milliseconds: number; bytes: number; transferred: boolean }>();
  private recovery = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly store: VoiceBudgetStore, private readonly call: string,
    private readonly owner: string, private readonly workspace: string, initial: VoiceBudget,
    private readonly receipt: (budget: VoiceBudget | null) => void,
    private readonly log: (message: string) => void, private readonly now = Date.now) {
    this.budget = initial;
  }

  private armCheckpoint(): void {
    if (this.closed || this.parked || this.fenced || this.timer || this.flushing ||
      (!this.pending.length && !this.pendingFrames.length)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {});
    }, 250);
    this.timer.unref();
  }

  /** Shared across authorization buffering, pending and in-flight delivery.
   * 16kHz mono PCM16: at most32,000 retained bytes and one second per call,
   * including simultaneous microphones. Return no reservation when parked. */
  retain(milliseconds: number, bytes: number): (() => void) | undefined {
    if (this.closed || this.parked || this.fenced || !Number.isFinite(milliseconds) || milliseconds <= 0 ||
      !Number.isSafeInteger(bytes) || bytes <= 0 || this.heldBytes + bytes > 32_000 ||
      this.heldMilliseconds + milliseconds > 1000) return undefined;
    this.heldBytes += bytes; this.heldMilliseconds += milliseconds;
    let held = true;
    const release = () => { if (!held) return; held = false; this.reservations.delete(release); this.reservationDetails.delete(release);
      this.heldBytes -= bytes; this.heldMilliseconds -= milliseconds; };
    this.reservations.add(release); this.reservationDetails.set(release, { milliseconds, bytes, transferred: false }); return release;
  }

  /** The only runtime forwarding boundary. The owned copy is bounded before
   * allocation and delivered only after commit plus a current-owner recheck. */
  capture(data: Int16Array, capturedAt: number, deliver: (data: Int16Array) => void): void {
    const milliseconds = data.length / 16;
    const release = this.retain(milliseconds, data.byteLength);
    if (!release) return;
    const allowed = this.audio(milliseconds, capturedAt);
    if (!allowed) { release(); return; }
    this.reservationDetails.get(release)!.transferred = true;
    this.queueOwned(data.slice(0, Math.min(data.length, Math.floor(allowed * 16))), deliver, release);
  }

  /** Move an already-owned authorization buffer under the SAME live quota.
   * No second allocation or early quota release; shortened views keep their
   * entire backing buffer charged until delivery/cancel. */
  captureReserved(data: Int16Array, capturedAt: number, deliver: (data: Int16Array) => void, release: () => void): void {
    const reservation = this.reservationDetails.get(release);
    if (!reservation || reservation.transferred || reservation.bytes !== data.byteLength || data.byteOffset !== 0 ||
      data.buffer.byteLength !== data.byteLength ||
      reservation.milliseconds !== data.length / 16) return;
    reservation.transferred = true;
    const allowed = this.audio(reservation.milliseconds, capturedAt);
    if (!allowed) { release(); return; }
    this.queueOwned(data.subarray(0, Math.min(data.length, Math.floor(allowed * 16))), deliver, release);
  }

  private queueOwned(data: Int16Array, deliver: (data: Int16Array) => void, release: () => void): void {
    let copy: Int16Array | undefined = data;
    let live = true;
    this.pendingFrames.push({ run: () => { if (live && copy && !this.closed && !this.fenced) deliver(copy); },
      release: () => { live = false; copy = undefined; release(); } });
    this.armCheckpoint();
  }

  audio(milliseconds: number, capturedAt = this.now()): number {
    if (this.closed || this.parked || this.fenced || !Number.isFinite(milliseconds) || milliseconds <= 0 ||
      !Number.isSafeInteger(capturedAt) || capturedAt > this.now() + 1000) return 0;
    const now = this.now();
    const today = voiceBudgetDay(now).start;
    if (now >= this.budget.resetAt)
      this.budget = { remainingMs: this.store.limitMs, resetAt: voiceBudgetDay(now).resetAt, timeZone: 'UTC' };
    const unsettled = [...this.inFlight, ...this.pending];
    const uncommitted = unsettled.reduce((sum, [a, b]) => sum + b - a, 0);
    const todayUncommitted = unsettled.reduce((sum, [a, b]) => sum + Math.max(0, b - Math.max(today, a)), 0);
    const end = capturedAt;
    const frameStart = end - Math.ceil(milliseconds);
    const start = this.lastEnd && frameStart - this.lastEnd < 100
      ? this.lastEnd : Math.max(this.lastEnd, frameStart);
    const elapsed = Math.max(0, end - start);
    const duration = Math.max(0, Math.min(elapsed, 1000 - uncommitted,
      this.budget.remainingMs - todayUncommitted));
    if (elapsed > duration && uncommitted >= 1000 && !this.paused) {
      this.paused = true; this.log('Voice input paused at the one-second accounting checkpoint bound');
    }
    if (!elapsed) return uncommitted < 1000 && this.budget.remainingMs > todayUncommitted ? milliseconds : 0;
    if (!duration) return 0;
    const acceptedEnd = start + duration;
    const tail = this.pending[this.pending.length - 1];
    if (tail && tail[1] === start) this.pending[this.pending.length - 1] = [tail[0], acceptedEnd];
    else this.pending.push([start, acceptedEnd]);
    this.lastEnd = acceptedEnd;
    this.armCheckpoint();
    return duration === elapsed ? milliseconds : Math.min(duration, milliseconds);
  }

  /** A real successful database operation owns one recovery attempt. If it
   * races a failing commit, latch that source generation until the lane frees. */
  recover(): Promise<void> {
    if (this.closed || this.fenced) return Promise.resolve();
    this.recovery++;
    if (this.flushing) return this.flushing.catch(() => {});
    if (!this.parked) return Promise.resolve();
    this.parked = false;
    return this.flush();
  }

  flush(): Promise<void> { return this.commit(false); }
  private commit(terminal: boolean): Promise<void> {
    if (this.flushing) return this.flushing;
    clearTimeout(this.timer); this.timer = undefined;
    if (this.fenced || (!terminal && (this.closed || this.parked)) ||
      (!this.pending.length && !this.pendingFrames.length)) return Promise.resolve();
    const admittedRecovery = this.recovery;
    this.inFlight = this.pending; this.pending = [];
    this.inFlightFrames = this.pendingFrames; this.pendingFrames = [];
    this.flushing = (async () => {
      let budget: VoiceBudget | null;
      let enqueued = false;
      try {
        budget = await this.store.record(this.call, this.owner, this.workspace, this.inFlight);
        if (budget && !terminal && this.inFlightFrames.length) {
          const current = await this.store.fence(this.call, this.owner, () => {
            enqueued = true;
            for (const frame of this.inFlightFrames) {
              try { if (!this.closed) frame.run(); }
              catch { this.log('Voice PCM delivery failed after durable accounting admission'); }
              finally { frame.release(); }
            }
          });
          if (!current) budget = null;
        }
      }
      catch (error) {
        // A fence commit/ack can fail AFTER synchronous enqueue. Those exact
        // callbacks must never be restored or replayed; usage already committed.
        if (!enqueued) {
          this.pending = [...this.inFlight, ...this.pending];
          this.pendingFrames = [...this.inFlightFrames, ...this.pendingFrames];
        }
        this.inFlight = []; this.inFlightFrames = [];
        this.parked = true;
        this.log('Voice accounting checkpoint failed; awaiting database recovery');
        throw error;
      }
      this.inFlight = [];
      const frames = this.inFlightFrames; this.inFlightFrames = [];
      if (!budget) {
        this.fenced = true;
        for (const frame of this.pendingFrames) frame.release();
        this.pendingFrames = [];
      } else this.budget = budget;
      for (const frame of frames) frame.release();
      if (this.paused) { this.paused = false; this.log('Voice input resumed after accounting checkpoint'); }
      // Never await receipt: it may end the call and close this very meter.
      this.receipt(budget);
    })().finally(() => {
      this.flushing = undefined;
      if (this.parked && !this.closed && !this.fenced && this.recovery > admittedRecovery) {
        this.parked = false; void this.flush().catch(() => {});
      } else this.armCheckpoint();
    });
    return this.flushing;
  }

  diagnostics() {
    return { pendingMilliseconds: [...this.pending, ...this.inFlight].reduce((sum, [a, b]) => sum + b - a, 0),
      heldMilliseconds: this.heldMilliseconds, heldBytes: this.heldBytes,
      parked: this.parked, fenced: this.fenced, closed: this.closed };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Revoke delivery synchronously, before any database await can complete.
    this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    for (const frame of [...this.pendingFrames, ...this.inFlightFrames]) frame.release();
    for (const release of this.reservations) release();
    this.closing = (async () => {
      if (this.flushing) await this.flushing.catch(() => {});
      // One end-boundary attempt; a failure retains the exact interval evidence
      // and rejects. Those frames were never forwarded to a provider.
      await this.commit(true);
    })();
    return this.closing;
  }
}
