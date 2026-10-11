import { nextSurfaceStamp } from './surface-clock';

export type RecordMark = { readonly generation: number; readonly clock: number };

/** One account's ordered records. A reset fences every outstanding read. */
export class OrderedRecordStore<T> {
  private records = new Map<string, T>();
  private listeners = new Map<string, Set<() => void>>();
  private reads = new Map<string, { again: boolean; done: Promise<void> }>();
  private epoch = 0;

  get generation(): number { return this.epoch; }
  get(key: string): T | undefined { return this.records.get(key); }
  entries(): IterableIterator<[string, T]> { return this.records.entries(); }
  clock(): number { return nextSurfaceStamp(); }
  mark(): RecordMark { return { generation: this.epoch, clock: this.clock() }; }
  accepts(mark: RecordMark, heldAt = -Infinity): boolean {
    return mark.generation === this.epoch && mark.clock > heldAt;
  }

  set(key: string, value: T): void {
    this.records.set(key, value);
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener();
  }

  silent(key: string, value: T): void { this.records.set(key, value); }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  /** Join a GET for one account and record; a later force asks for one more. */
  coalesceRead(key: string, force: boolean, read: () => Promise<boolean>): Promise<void> {
    const running = this.reads.get(key);
    if (running) {
      if (force) running.again = true;
      return running.done;
    }
    const generation = this.epoch;
    const flight = { again: false, done: Promise.resolve() };
    flight.done = (async () => {
      try {
        let repeat: boolean;
        do {
          flight.again = false;
          // Start after the flight is registered, including when read throws synchronously.
          repeat = await Promise.resolve().then(read);
        } while (this.epoch === generation && (flight.again || repeat));
      } finally {
        if (this.reads.get(key) === flight) this.reads.delete(key);
      }
    })();
    this.reads.set(key, flight);
    return flight.done;
  }

  reset(): void {
    this.epoch += 1;
    const keys = [...this.records.keys()];
    this.records.clear();
    this.reads.clear();
    for (const key of keys)
      for (const listener of [...(this.listeners.get(key) ?? [])]) listener();
  }
}

/** Replay changes observed after a read began, in their arrival order. */
export function replayAfter<T, D>(
  base: T,
  mark: RecordMark,
  changes: readonly { readonly clock: number; readonly delta: D }[],
  fold: (value: T, delta: D) => T,
): T {
  return changes.reduce((value, change) =>
    change.clock > mark.clock ? fold(value, change.delta) : value, base);
}
