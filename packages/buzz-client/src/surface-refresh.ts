export type SurfaceRefreshOptions<T> = {
  readonly fetch: () => Promise<T>;
  readonly apply: (value: T) => void;
  readonly minimumIntervalMs?: number;
  readonly maximumWaitMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onError?: (error: unknown) => void;
};

/**
 * One deliberately small liveness scheduler per visible surface. Relay events
 * carry no durable state: they only set the dirty bit. There is never more
 * than one authenticated GET in flight.
 */
export class SurfaceRefreshScheduler<T> {
  private readonly minimumIntervalMs: number;
  private readonly maximumWaitMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<SurfaceRefreshOptions<T>['setTimer']>;
  private readonly clearTimer: NonNullable<SurfaceRefreshOptions<T>['clearTimer']>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private dirty = false;
  private firstDirtyAt: number | undefined;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private generation = 0;
  private disposed = false;
  private ready = false;

  constructor(private readonly options: SurfaceRefreshOptions<T>) {
    this.minimumIntervalMs = options.minimumIntervalMs ?? 500;
    this.maximumWaitMs = options.maximumWaitMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** Install/confirm relay filters first, then close the gap with the first GET. */
  async startAfter(listenReady: Promise<unknown>): Promise<void> {
    await listenReady;
    this.ready = true;
    this.force();
  }

  signal(): void {
    if (this.disposed) return;
    // A signal observed while a GET is in flight may describe a commit that
    // raced that GET's database snapshot. Reject that completion and let the
    // dirty follow-up become the only paint for this generation.
    if (this.inFlight) this.generation += 1;
    this.dirty = true;
    this.firstDirtyAt ??= this.now();
    this.schedule(false);
  }

  /** Reconnect and focus are recovery boundaries, so they do not wait for quiet. */
  force(): void {
    if (this.disposed) return;
    if (this.inFlight) this.generation += 1;
    this.dirty = true;
    this.firstDirtyAt ??= this.now();
    this.schedule(true);
  }

  /** Makes every completion from the previous screen generation a no-op. */
  advanceGeneration(): void {
    this.generation += 1;
    this.dirty = false;
    this.firstDirtyAt = undefined;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.advanceGeneration();
  }

  private schedule(forced: boolean): void {
    if (!this.ready || this.inFlight || this.timer || !this.dirty) return;
    const now = this.now();
    const minimumAt = forced ? now : this.lastStartedAt + this.minimumIntervalMs;
    const maximumAt = (this.firstDirtyAt ?? now) + this.maximumWaitMs;
    const dueAt = Math.max(now, Math.min(minimumAt, maximumAt));
    this.timer = this.setTimer(
      () => {
        this.timer = undefined;
        void this.run();
      },
      Math.max(0, dueAt - now),
    );
  }

  private async run(): Promise<void> {
    if (this.disposed || this.inFlight || !this.dirty) return;
    this.dirty = false;
    this.firstDirtyAt = undefined;
    this.inFlight = true;
    this.lastStartedAt = this.now();
    const generation = this.generation;
    try {
      const value = await this.options.fetch();
      if (!this.disposed && generation === this.generation) this.options.apply(value);
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.options.onError?.(error);
    } finally {
      this.inFlight = false;
      if (this.dirty) this.schedule(false);
    }
  }
}
