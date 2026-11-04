/** Private owner timers can be driven without replacing Node's transport clocks. */
export interface WorkTimers {
  setTimeout(run: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout> | undefined): void;
}

/** Independent deadlines keep a notification from advancing unrelated repair work. */
export class BackgroundWork {
  private readonly jobs = new Map<string, {
    intervalMs: number;
    nextAt: number;
    pending: boolean;
    run: (newLeader: boolean) => Promise<number | void>;
  }>();
  private windowAt: number;
  private cycles = 0;
  private readonly wakes: Record<string, number> = {};
  private readonly runs: Record<string, number> = {};

  constructor(
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = console.log,
  ) { this.windowAt = now(); }

  add(name: string, intervalMs: number, run: (newLeader: boolean) => Promise<number | void>): void {
    this.jobs.set(name, { intervalMs, nextAt: -Infinity, pending: false, run });
  }

  /** Initial/feed acquisition inspects once. Only an actual due record returned
   * by the owner or a committed wake admits the next execution. */
  addDeadline(name: string, run: (newLeader: boolean) => Promise<number | void>): void {
    this.add(name, Number.POSITIVE_INFINITY, run);
  }

  wake(name: string, source = name): void {
    const job = this.jobs.get(name);
    if (!job) return;
    job.pending = true;
    this.wakes[source] = (this.wakes[source] ?? 0) + 1;
  }

  /** A completed detached business flight publishes its next stored deadline.
   * This does not admit an observation or mark the family pending. */
  schedule(name: string, delay: number | undefined): void {
    const job = this.jobs.get(name);
    if (job) job.nextAt = delay === undefined ? Infinity : this.now() + Math.max(0,delay);
  }

  async run(newLeader: boolean, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return Infinity;
    this.cycles++;
    if (newLeader) for (const job of this.jobs.values()) job.nextAt = -Infinity;
    for (const [name, job] of this.jobs) {
      // Loss ends admission immediately. The active job drains, but cannot
      // hand the retired generation to another family after its await.
      if (signal?.aborted) return Infinity;
      if (!job.pending && this.now() < job.nextAt) continue;
      // Consume before awaiting so a notification during work survives.
      job.pending = false;
      this.runs[name] = (this.runs[name] ?? 0) + 1;
      job.nextAt = this.now() + job.intervalMs;
      const delay = await job.run(newLeader);
      if (typeof delay === 'number') job.nextAt = Math.min(job.nextAt, this.now() + Math.max(0, delay));
    }
    const now = this.now();
    if (now - this.windowAt >= 60_000) {
      this.log(`[background] ${JSON.stringify({ windowMs: now - this.windowAt,
        cycles: this.cycles, wakes: this.wakes, jobs: this.runs })}`);
      this.windowAt = now;
      this.cycles = 0;
      for (const counts of [this.wakes, this.runs]) for (const key of Object.keys(counts)) delete counts[key];
    }
    return Math.max(0, Math.min(...[...this.jobs.values()].map(job => job.pending ? 0 : job.nextAt - now)));
  }
}

/** A timeout chain tied to one live owner. Closing that owner cancels its next tick.
 * Arm before calling work so a close inside the callback also clears the chain. */
export function startConnectionWork(run: () => void, intervalMs: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      arm();
      run();
    }, intervalMs);
    timer.unref?.();
  };
  arm();
  return () => { stopped = true; clearTimeout(timer); };
}

/** Drive instance-local jobs from their queue's next deadline, including startup.
 * Instances must retain their own memory flushes and local channel cleanup. */
export function startBackgroundWork(
  work: BackgroundWork,
  subscribe?: (wake: () => void) => () => void,
): () => Promise<void> {
  let stopped = false, pending = false, failed = false;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped) return;
    clearTimeout(timer); timer = undefined;
    if (running) { pending = true; return; }
    pending = false; failed = false; failure = undefined;
    running = work.run(false).then(delay => {
      running = undefined;
      if (stopped) return;
      if (pending) { tick(); return; }
      if (Number.isFinite(delay)) {
        timer = setTimeout(tick, Math.max(0, delay));
        timer.unref?.();
      }
    }, error => {
      running = undefined; failed = true; failure = error;
      if (pending && !stopped) tick();
    });
  };
  const unsubscribe = subscribe?.(tick);
  tick();
  return async () => {
    if (!stopped) { stopped = true; unsubscribe?.(); clearTimeout(timer); }
    await running;
    if (failed) throw failure;
  };
}
