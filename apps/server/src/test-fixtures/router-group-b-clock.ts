import type { WorkTimers } from '../background-work.js';

/** Drives only explicitly injected business-owner deadlines. pg, ws and Node
 * retain their real timers. Callers fake Date alone when checking wall time. */
export class GroupBClock implements WorkTimers {
  private elapsed = 0;
  private readonly pending = new Map<ReturnType<typeof setTimeout>, { due: number; run: () => void }>();
  setTimeout(run: () => void, delay: number): ReturnType<typeof setTimeout> {
    const handle = { unref() { return this; } } as ReturnType<typeof setTimeout>;
    this.pending.set(handle, { due: this.elapsed + delay, run }); return handle;
  }
  clearTimeout(handle: ReturnType<typeof setTimeout> | undefined): void { if (handle) this.pending.delete(handle); }
  advanceBy(delay: number): void {
    const through = this.elapsed + delay;
    for (let steps = 0; ; steps++) {
      const next = [...this.pending].filter(([, value]) => value.due <= through)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      if (steps >= 10_000) throw new Error('Business deadline loop');
      this.elapsed = next[1].due; this.pending.delete(next[0]); next[1].run();
    }
    this.elapsed = through;
  }
  get size(): number { return this.pending.size; }
}
