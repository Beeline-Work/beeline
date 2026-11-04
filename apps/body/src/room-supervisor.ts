import { isStandingRuntimeFault, retryNotBefore } from './retry-barrier.js';

/** Safe intake/read recovery is bounded per independent wake. Standing
 * configuration faults retain their existing configuration-change boundary. */
export class RoomSupervisor {
  readonly #parked = new Set<() => void>();
  readonly #configurationWaits = new Set<() => void>();
  #wakes = 0;
  #configurationChanges = 0;
  constructor(private readonly delaysMs: readonly number[] = [250, 1000, 3000]) {}
  wake(): void { this.#wakes++; for (const resume of [...this.#parked]) resume(); }
  configurationChanged(): void {
    this.#configurationChanges++; for (const resume of [...this.#configurationWaits]) resume(); this.wake();
  }
  get wakes(): number { return this.#wakes; }
  get retries(): number { return this.delaysMs.length; }
  retryDelay(failures: number, signal?: AbortSignal, since = this.#wakes, notBefore = 0): Promise<void> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { clearTimeout(timer); this.#parked.delete(inspect); signal?.removeEventListener('abort', inspect); resolve(); };
      const inspect = () => {
        if (signal?.aborted || this.#wakes !== since && Date.now() >= notBefore) finish();
      };
      this.#parked.add(inspect); signal?.addEventListener('abort', inspect, { once: true });
      if (failures > 0 && failures <= this.retries) {
        timer = setTimeout(finish, Math.max(this.delaysMs[failures - 1]!, notBefore - Date.now()));
      }
      inspect();
    });
  }
  async supervise(label: string, signal: AbortSignal | undefined, run: (progress: () => void) => Promise<void>): Promise<void> {
    let failures = 0, previousWake = this.#wakes;
    for (;;) {
      const since = this.#wakes, configuration = this.#configurationChanges;
      if (previousWake !== since) failures = 0;
      previousWake = since;
      try { await run(() => { failures = 0; }); return; }
      catch (error) {
        if (signal?.aborted) return;
        const standing = isStandingRuntimeFault(error), notBefore = retryNotBefore(error) ?? 0;
        console.error(`[thin-core] ${label} intake failed; ${standing ? 'waiting for a configuration change' : 'recovering safe intake'}:`, error);
        if (standing) {
          await new Promise<void>(resolve => {
            const inspect = () => {
              if (!signal?.aborted && configuration === this.#configurationChanges) return;
              this.#configurationWaits.delete(inspect); signal?.removeEventListener('abort', inspect); resolve();
            };
            this.#configurationWaits.add(inspect); signal?.addEventListener('abort', inspect, { once: true }); inspect();
          });
        } else await this.retryDelay(++failures, signal, since, notBefore);
        if (signal?.aborted) return;
      }
    }
  }
}
