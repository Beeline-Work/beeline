import { surfaceCacheKey, type SurfaceCacheAddress, type SurfaceResponseCache } from '@beeline/buzz-client';

type Guard<T> = (value: unknown) => value is T;
const MAX_HOT_SURFACES = 128;

/** Validated projections shared by mounted routes and restored from durable storage on a miss. */
export class SurfaceRegistry {
  private readonly values = new Map<string, unknown>();
  private readonly reads = new Map<string, Promise<unknown | null>>();
  private readonly fetches = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly revisions = new Map<string, number>();
  private epoch = 0;

  constructor(
    private readonly durable: SurfaceResponseCache,
    private readonly normalize: (value: unknown) => unknown = (value) => value,
  ) {}

  peek<T>(address: SurfaceCacheAddress, guard: Guard<T>): T | null {
    const key = surfaceCacheKey(address);
    const value = this.values.get(key);
    if (value === undefined) return null;
    if (guard(value)) {
      this.values.delete(key);
      this.values.set(key, value);
      return value;
    }
    this.values.delete(key);
    return null;
  }

  subscribe(address: SurfaceCacheAddress, listener: () => void): () => void {
    const key = surfaceCacheKey(address);
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private remember(key: string, value: unknown): void {
    this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size <= MAX_HOT_SURFACES) return;
    for (const oldest of this.values.keys()) {
      if (this.listeners.has(oldest)) continue;
      this.values.delete(oldest);
      if (!this.reads.has(oldest) && !this.fetches.has(oldest)) this.revisions.delete(oldest);
      if (this.values.size <= MAX_HOT_SURFACES) break;
    }
  }

  async read<T>(address: SurfaceCacheAddress, guard: Guard<T>): Promise<T | null> {
    const cached = this.peek(address, guard);
    if (cached) return cached;
    const key = surfaceCacheKey(address);
    const revision = this.revisions.get(key) ?? 0;
    const epoch = this.epoch;
    let pending = this.reads.get(key);
    if (!pending) {
      pending = this.durable.read(address, guard);
      this.reads.set(key, pending);
      void pending.then(() => {
        if (this.reads.get(key) === pending) this.reads.delete(key);
      }, () => {
        if (this.reads.get(key) === pending) this.reads.delete(key);
      });
    }
    const value = await pending;
    // A server response or eviction can overtake the storage read.
    const current = this.peek(address, guard);
    if (current) return current;
    if (this.epoch !== epoch || (this.revisions.get(key) ?? 0) !== revision) return null;
    if (!guard(value)) return null;
    this.remember(key, value);
    this.notify(key);
    return value;
  }

  async write<T>(address: SurfaceCacheAddress, value: T, guard: Guard<T>): Promise<void> {
    const normalized = this.publish(address, value, guard);
    await this.durable.write(address, normalized, guard);
  }

  /** Share an already validated live projection without serializing it on every frame. */
  publish<T>(address: SurfaceCacheAddress, value: T, guard: Guard<T>): T {
    const normalized = this.normalize(value);
    if (!guard(normalized)) throw new Error('refusing to cache an invalid surface response');
    const key = surfaceCacheKey(address);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.remember(key, normalized);
    this.notify(key);
    return normalized;
  }

  /** Coalesce simultaneous route reads of the same authorized projection. */
  fetch<T>(address: SurfaceCacheAddress, guard: Guard<T>, request: () => Promise<T>): Promise<T> {
    const key = surfaceCacheKey(address);
    const existing = this.fetches.get(key);
    if (existing) return existing as Promise<T>;
    const epoch = this.epoch;
    const revision = this.revisions.get(key) ?? 0;
    const pending = request().then(async (value) => {
      // A live publish or removal after the request started is newer than this response.
      if (this.epoch !== epoch || (this.revisions.get(key) ?? 0) !== revision) {
        return this.peek(address, guard) ?? value;
      }
      await this.write(address, value, guard);
      return value;
    });
    this.fetches.set(key, pending);
    void pending.then(() => {
      if (this.fetches.get(key) === pending) this.fetches.delete(key);
    }, () => {
      if (this.fetches.get(key) === pending) this.fetches.delete(key);
    });
    return pending;
  }

  async remove(address: SurfaceCacheAddress): Promise<void> {
    const key = surfaceCacheKey(address);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.values.delete(key);
    this.notify(key);
    await this.durable.remove(address);
  }

  async evictViewer(relayOrigin: string, viewerPubkey: string): Promise<void> {
    const origin = new URL(relayOrigin).origin;
    this.epoch += 1;
    for (const key of new Set([...this.values.keys(), ...this.reads.keys(), ...this.fetches.keys()])) {
      const parts = JSON.parse(key) as unknown[];
      if (parts[1] === origin && parts[2] === viewerPubkey) {
        this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
        this.values.delete(key);
        this.notify(key);
      }
    }
    await this.durable.evictViewer(relayOrigin, viewerPubkey);
  }

  clear(): void {
    this.epoch += 1;
    for (const key of this.values.keys()) {
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      this.values.delete(key);
      this.notify(key);
    }
    this.revisions.clear();
  }
}
