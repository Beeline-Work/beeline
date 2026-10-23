type Pending = { work: () => Promise<void>; waiters: Array<{ resolve(): void; reject(error: unknown): void }> };

/** Coalesces storage work until native navigation and JS interactions finish. */
export class TransitionWork {
  private readonly pending = new Map<string, Pending>();
  private readonly transitions = new Set<object>();
  private cancel: (() => void) | undefined;

  constructor(private readonly schedule: (work: () => void) => () => void) {}

  begin(): () => void {
    const token = {};
    this.transitions.add(token);
    this.cancel?.();
    this.cancel = undefined;
    return () => { this.transitions.delete(token); this.arm(); };
  }

  enqueue(key: string, work: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const previous = this.pending.get(key);
      this.pending.set(key, { work, waiters: [...(previous?.waiters ?? []), { resolve, reject }] });
      this.arm();
    });
  }

  private arm(): void {
    if (this.transitions.size || this.cancel || !this.pending.size) return;
    this.cancel = this.schedule(() => { this.cancel = undefined; this.flush(); });
  }

  /** Backgrounding must flush even when an interrupted transition never ends. */
  flush(): void {
    this.cancel?.();
    this.cancel = undefined;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const { work, waiters } of batch) {
      void work().then(
        () => { for (const waiter of waiters) waiter.resolve(); },
        (error: unknown) => { for (const waiter of waiters) waiter.reject(error); },
      );
    }
  }
}
