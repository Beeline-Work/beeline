/** After a failure, at most these retries; then only the next open or discovery wake. */
export const ROOM_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];

/**
 * Keeps Room and corner intakes, and the discovery reconcile, alive across
 * failed reads without turning recovery into polling. A failure retries a
 * bounded number of times; after that the loop parks until the live socket
 * opens again or discovery is woken, both of which arrive from the server.
 */
export class RoomSupervisor {
  readonly #parked = new Set<() => void>();
  #wakes = 0;

  constructor(private readonly delaysMs: readonly number[] = ROOM_RETRY_DELAYS_MS) {}

  /** The live socket opened or discovery was woken: every waiting loop retries now. */
  wake(): void {
    this.#wakes += 1;
    for (const resume of [...this.#parked]) resume();
  }

  /** Wakes so far; a wait that started from an older count does not wait. */
  get wakes(): number {
    return this.#wakes;
  }

  /** How many timed retries follow one failure before a loop parks. */
  get retries(): number {
    return this.delaysMs.length;
  }

  /**
   * Wait before retrying failure number `failures` (1-based). Within the
   * bound the fixed delay applies, and a wake may cut it short; past the bound
   * only a wake (or the abort) ends the wait. A wake that already arrived
   * after `since` (a `wakes` count) ends it at once, so none is lost.
   */
  retryDelay(failures: number, signal?: AbortSignal, since = this.#wakes): Promise<void> {
    const delay = this.delaysMs[failures - 1];
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        this.#parked.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.#parked.add(done);
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted || this.#wakes !== since) {
        done();
        return;
      }
      if (delay !== undefined) {
        timer = setTimeout(done, delay);
        timer.unref?.();
      }
    });
  }

  /**
   * Run one Room or corner intake under supervision: a failed read never ends
   * it. `run` resolves only when the intake itself is finished (aborted or
   * closed); it calls `progress` once its reads succeed again, which restores
   * the full retry budget. The intake rejects only after its active turn has
   * settled, so re-entering cannot claim the same command twice.
   */
  async supervise(
    label: string,
    signal: AbortSignal | undefined,
    run: (progress: () => void) => Promise<void>,
  ): Promise<void> {
    let failures = 0;
    for (;;) {
      const since = this.#wakes;
      try {
        await run(() => {
          failures = 0;
        });
        return;
      } catch (error) {
        if (signal?.aborted) return;
        failures += 1;
        const parked = failures > this.delaysMs.length;
        console.error(
          `[thin-core] ${label} intake failed; ${
            parked
              ? 'waiting for the next live open or discovery wake'
              : `retry ${failures} of ${this.delaysMs.length} in ${this.delaysMs[failures - 1]}ms`
          }:`,
          error,
        );
        await this.retryDelay(failures, signal, since);
        if (signal?.aborted) return;
        if (parked) failures = 0;
      }
    }
  }
}
