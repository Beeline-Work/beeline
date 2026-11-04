export type ImmutableByteAddress = Readonly<{ origin: string; principal: string; objectId: string; version: string }>;
export type ImmutableByteStore = {
  get(key: string, signal?: AbortSignal): Promise<Uint8Array | null>;
  set(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
};
export type ByteDemand = Readonly<{
  signal?: AbortSignal;
  /** A fresh server authority certificate, not elapsed cache age, permits cold restore. */
  restoreAuthorized?: boolean;
  /** Unsupported legacy servers may only coalesce flights; every later
   * demand must obtain a freshly authorized response. */
  reuseAuthorized?: boolean;
  isCurrent(): boolean;
  maxBytes?: number;
}>;
type Consumer = { resolve(bytes: Uint8Array): void; reject(reason: Error): void;
  demand: ByteDemand; stop(): void };
type Flight = { key: string; address: ImmutableByteAddress; epoch: number; ticket: number; controller: AbortController;
  consumers: Set<Consumer>; started: boolean; load(signal: AbortSignal): Promise<Uint8Array> };
const OBJECT_LIMIT = 25 * 1024 * 1024;
const MEMORY_LIMIT = 32 * 1024 * 1024;
const DOWNLOAD_LIMIT = 4;
const QUEUE_LIMIT = 64;
function aborted(): Error { const error = new Error('The file is no longer visible.'); error.name = 'AbortError'; return error; }

/** One immutable object flight for preview/open/view/save/native. No clock,
 * retry loop, network or native import. Only real demand can enter the queue.
 * Disk restore is inert until current server authority has been established.
 */
export class ImmutableByteCache {
  private readonly memory = new Map<string, Uint8Array>();
  private readonly flights = new Map<string, Flight>();
  private readonly listeners = new Set<(keys: readonly string[] | null) => void>();
  private readonly queue: Flight[] = [];
  private active = 0;
  private memoryBytes = 0;
  private epoch = 0;
  private sequence = 0;
  private readonly committedWrites = new Map<string, number>();

  constructor(private readonly store?: ImmutableByteStore,
    private readonly validate: (address: ImmutableByteAddress, bytes: Uint8Array, signal: AbortSignal) => boolean | Promise<boolean> = () => true) {}
  key(address: ImmutableByteAddress): string {
    if (!address.principal || !address.objectId || !address.version) throw new Error('File identity is incomplete.');
    return JSON.stringify([new URL(address.origin).origin, address.principal, address.objectId, address.version]);
  }
  subscribePurge(listener: (keys: readonly string[] | null) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  get(address: ImmutableByteAddress, load: (signal: AbortSignal) => Promise<Uint8Array>, demand: ByteDemand): Promise<Uint8Array> {
    if (demand.signal?.aborted || !demand.isCurrent()) return Promise.reject(aborted());
    const key = this.key(address);
    const cached = this.memory.get(key);
    if (cached && demand.reuseAuthorized) {
      this.memory.delete(key); this.memory.set(key, cached);
      if (cached.byteLength > Math.min(OBJECT_LIMIT, demand.maxBytes ?? OBJECT_LIMIT)) return Promise.reject(new Error('The file exceeds its byte limit.'));
      return Promise.resolve().then(() => {
        if (demand.signal?.aborted || !demand.isCurrent()) throw aborted();
        return cached.slice();
      });
    }
    let flight = this.flights.get(key);
    if (flight?.controller.signal.aborted) { this.flights.delete(key); flight = undefined; }
    if (!flight) {
      if (this.flights.size >= QUEUE_LIMIT + DOWNLOAD_LIMIT) return Promise.reject(new Error('Too many files are opening.'));
      flight = { key, address: Object.freeze({ ...address }), epoch: this.epoch, ticket: ++this.sequence, controller: new AbortController(),
        consumers: new Set(), started: false, load };
      this.flights.set(key, flight); this.queue.push(flight);
    }
    const held = flight;
    const result = new Promise<Uint8Array>((resolve, reject) => {
      const release = () => {
        held.consumers.delete(consumer);
        if (!held.consumers.size) {
          held.controller.abort();
          // Remove a queued flight before a native transport can start it.
          if (!held.started) { this.flights.delete(key); const index = this.queue.indexOf(held); if (index >= 0) this.queue.splice(index, 1); }
        }
      };
      const onAbort = () => { consumer.stop(); release(); reject(aborted()); };
      const consumer: Consumer = { resolve, reject, demand, stop: () => demand.signal?.removeEventListener('abort', onAbort) };
      held.consumers.add(consumer);
      demand.signal?.addEventListener('abort', onAbort, { once: true });
      if (demand.signal?.aborted) onAbort();
    });
    this.drain();
    return result;
  }

  /** Revoke/logout/interruption fences replies and disk writes before any UI
   * observer hears the purge. Never schedules a replacement observation.
   */
  async purge(): Promise<void> { this.suspend(); await this.store?.clear(); }
  suspend(): void {
    this.epoch += 1;
    this.memory.clear(); this.memoryBytes = 0; this.committedWrites.clear();
    for (const flight of this.flights.values()) {
      flight.controller.abort();
      for (const consumer of flight.consumers) { consumer.stop(); consumer.reject(aborted()); }
      flight.consumers.clear();
    }
    this.flights.clear(); this.queue.length = 0;
    for (const listener of this.listeners) listener(null);
  }
  async purgeKeys(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.committedWrites.delete(key);
      const bytes = this.memory.get(key); this.memoryBytes -= bytes?.byteLength ?? 0; this.memory.delete(key);
      const flight = this.flights.get(key);
      if (flight) {
        flight.controller.abort();
        for (const consumer of flight.consumers) { consumer.stop(); consumer.reject(aborted()); }
        flight.consumers.clear(); this.flights.delete(key);
      }
      const index = this.queue.findIndex(flight => flight.key === key); if (index >= 0) this.queue.splice(index, 1);
    }
    for (const listener of this.listeners) listener(keys);
    for (const key of keys) await this.store?.remove(key);
  }

  diagnostics(): Readonly<{ active: number; queued: number; memoryBytes: number }> {
    return { active: this.active, queued: this.queue.length, memoryBytes: this.memoryBytes };
  }
  hasFlight(key: string): boolean { return this.flights.has(key); }

  private drain(): void {
    while (this.active < DOWNLOAD_LIMIT && this.queue.length) {
      const flight = this.queue.shift()!;
      if (!this.current(flight)) { this.finish(flight, undefined, aborted()); continue; }
      flight.started = true; this.active += 1;
      void this.run(flight).finally(() => { this.active -= 1; this.drain(); });
    }
  }
  private current(flight: Flight): boolean {
    return flight.epoch === this.epoch && !flight.controller.signal.aborted &&
      [...flight.consumers].some(consumer => !consumer.demand.signal?.aborted && consumer.demand.isCurrent());
  }
  private async run(flight: Flight): Promise<void> {
    try {
      const restore = [...flight.consumers].some(consumer => consumer.demand.restoreAuthorized && consumer.demand.reuseAuthorized && consumer.demand.isCurrent());
      let bytes: Uint8Array | null = null;
      if (restore) { try { bytes = await this.store?.get(flight.key, flight.controller.signal) ?? null; } catch { /* A denied disk falls through to authorized download. */ } }
      if (!this.current(flight)) throw aborted();
      if (!bytes) bytes = await flight.load(flight.controller.signal);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > OBJECT_LIMIT) throw new Error('The file exceeds 25 MiB.');
      const valid = await this.validate(flight.address, bytes, flight.controller.signal);
      if (!this.current(flight)) throw aborted();
      if (!valid) { await this.store?.remove(flight.key); throw new Error('The file failed its immutable integrity check.'); }
      // Persist first; a failed/partial disk write never creates a cache hit.
      // A usable current download can still display if the local disk is full.
      try { await this.store?.set(flight.key, bytes, flight.controller.signal); } catch { /* Keep this authorized runtime copy only. */ }
      if (!this.current(flight)) {
        const replacement = this.flights.get(flight.key);
        // Immutable key bytes may already serve a newer admitted flight. An
        // old cancellation cannot delete that flight's same-version disk data.
        if ((this.committedWrites.get(flight.key) ?? -1) <= flight.ticket &&
            (!replacement || replacement === flight || !this.current(replacement))) await this.store?.remove(flight.key);
        throw aborted();
      }
      this.committedWrites.set(flight.key, Math.max(this.committedWrites.get(flight.key) ?? -1, flight.ticket));
      for (const key of this.committedWrites.keys()) {
        if (this.committedWrites.size <= 512) break;
        if (!this.flights.has(key)) this.committedWrites.delete(key);
      }
      this.remember(flight.key, bytes);
      this.finish(flight, bytes);
    } catch (reason) {
      this.finish(flight, undefined, reason instanceof Error ? reason : new Error('The file could not be loaded.'));
    }
  }
  private remember(key: string, bytes: Uint8Array): void {
    const before = this.memory.get(key);
    this.memoryBytes -= before?.byteLength ?? 0;
    this.memory.delete(key); this.memory.set(key, bytes); this.memoryBytes += bytes.byteLength;
    for (const [oldest, value] of this.memory) {
      if (this.memoryBytes <= MEMORY_LIMIT && this.memory.size <= 128) break;
      this.memory.delete(oldest); this.memoryBytes -= value.byteLength;
    }
  }
  private finish(flight: Flight, bytes?: Uint8Array, reason?: Error): void {
    if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
    for (const consumer of flight.consumers) {
      consumer.stop();
      if (reason || !bytes || consumer.demand.signal?.aborted || !consumer.demand.isCurrent()) consumer.reject(reason ?? aborted());
      else if (bytes.byteLength > Math.min(OBJECT_LIMIT, consumer.demand.maxBytes ?? OBJECT_LIMIT)) consumer.reject(new Error('The file exceeds its byte limit.'));
      else consumer.resolve(bytes.slice());
    }
    flight.consumers.clear();
  }
}
