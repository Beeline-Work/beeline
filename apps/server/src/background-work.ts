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

  wake(name: string, source = name): void {
    const job = this.jobs.get(name);
    if (!job) return;
    job.pending = true;
    this.wakes[source] = (this.wakes[source] ?? 0) + 1;
  }

  async run(newLeader: boolean): Promise<number> {
    this.cycles++;
    if (newLeader) for (const job of this.jobs.values()) job.nextAt = -Infinity;
    for (const [name, job] of this.jobs) {
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
