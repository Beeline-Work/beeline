import { surfaceCacheKey, type SurfaceCacheAddress, type SurfaceResponseCache } from '@beeline/buzz-client';

type Guard<T> = (value: unknown) => value is T;
/** The projection a surface reads, selected from the stored value and the time it was stored. */
type Select = (address: SurfaceCacheAddress, value: unknown, stamp: number) => unknown;
type Observer = (address: SurfaceCacheAddress, value: unknown, stamp: number) => void;
const MAX_HOT_SURFACES = 128;

/** Validated projections shared by mounted routes and restored from durable storage on a miss. */
export class SurfaceRegistry {
  private readonly values = new Map<string, unknown>();
  private readonly reads = new Map<string, Promise<unknown | null>>();
  private readonly fetches = new Map<string, Promise<unknown | null>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly revisions = new Map<string, number>();
  /** When each hot value was stored; a value restored from storage is older than any. */
  private readonly stamps = new Map<string, number>();
  private readonly selected = new Map<string, { value: unknown; projection: unknown }>();
  private readonly observers = new Map<string, Set<Observer>>();
  private clock = 0;
  private epoch = 0;

  constructor(
    private readonly durable: SurfaceResponseCache,
    private readonly normalize: (value: unknown) => unknown = (value) => value,
    private readonly select: Select = (_address, value) => value,
  ) {}

  peek<T>(address: SurfaceCacheAddress, guard: Guard<T>): T | null {
    const key = surfaceCacheKey(address);
    const value = this.values.get(key);
    if (value === undefined) return null;
    if (guard(value)) {
      this.values.delete(key);
      this.values.set(key, value);
      return this.projection(key, address, value) as T;
    }
    this.values.delete(key);
    return null;
  }

  private projection(key: string, address: SurfaceCacheAddress, value: unknown): unknown {
    const memo = this.selected.get(key);
    if (memo && memo.value === value) return memo.projection;
    const projection = this.select(address, value, this.stamps.get(key) ?? 0);
    this.selected.set(key, { value, projection });
    return projection;
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

  /** Hear every value stored for one endpoint, from a server answer or from storage. */
  observe(endpoint: string, observer: Observer): () => void {
    const observers = this.observers.get(endpoint) ?? new Set<Observer>();
    observers.add(observer);
    this.observers.set(endpoint, observers);
    return () => {
      observers.delete(observer);
    };
  }

  /** The current stamp: a value read from a server after this is newer than every change before it. */
  now(): number {
    return this.clock;
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private remember(key: string, address: SurfaceCacheAddress, value: unknown, stamp: number): void {
    this.values.delete(key);
    this.values.set(key, value);
    this.stamps.set(key, stamp);
    this.selected.delete(key);
    for (const observer of this.observers.get(address.endpoint) ?? []) observer(address, value, stamp);
    if (this.values.size <= MAX_HOT_SURFACES) return;
    for (const oldest of this.values.keys()) {
      if (this.listeners.has(oldest)) continue;
      this.values.delete(oldest);
      this.stamps.delete(oldest);
      this.selected.delete(oldest);
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
    this.remember(key, address, value, 0);
    this.notify(key);
    return this.peek(address, guard);
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
    this.remember(key, address, normalized, ++this.clock);
    this.notify(key);
    return normalized;
  }

  /**
   * Coalesce simultaneous route reads of the same authorized projection.
   * Resolves null when a publish or removal overtook the response and no
   * current value is held: the caller must not paint.
   */
  fetch<T>(address: SurfaceCacheAddress, guard: Guard<T>, request: () => Promise<T>): Promise<T | null> {
    const key = surfaceCacheKey(address);
    const existing = this.fetches.get(key);
    if (existing) return existing as Promise<T | null>;
    const epoch = this.epoch;
    const revision = this.revisions.get(key) ?? 0;
    const pending = request().then(async (value): Promise<T | null> => {
      // A live publish or removal after the request started is newer than this response.
      if (this.epoch !== epoch || (this.revisions.get(key) ?? 0) !== revision) {
        return this.peek(address, guard);
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

  /**
   * Apply a change that every projection of one viewer selects (an identity
   * or Workspace header record). `record` receives the change's stamp, so
   * only values stored before it select the change. A fetch of that viewer
   * already in flight is fenced, the same way a publish fences it; every
   * mounted reader repaints.
   */
  fenceViewer(relayOrigin: string, viewerPubkey: string, record: (stamp: number) => void): void {
    for (const key of this.fence(relayOrigin, viewerPubkey, undefined, record)) {
      if (!this.values.has(key)) continue;
      this.selected.delete(key);
      this.notify(key);
    }
  }

  /**
   * Fence the in-flight fetches of one endpoint of one viewer, for a write
   * kept outside this registry (a roster removal) that their responses
   * predate. Returns the write's stamp.
   */
  fenceEndpoint(relayOrigin: string, viewerPubkey: string, endpoint: string): number {
    let stamp = 0;
    this.fence(relayOrigin, viewerPubkey, endpoint, (next) => { stamp = next; });
    return stamp;
  }

  private fence(
    relayOrigin: string,
    viewerPubkey: string,
    endpoint: string | undefined,
    record: (stamp: number) => void,
  ): string[] {
    const origin = new URL(relayOrigin).origin;
    record(++this.clock);
    const keys: string[] = [];
    for (const key of new Set([...this.values.keys(), ...this.fetches.keys()])) {
      const parts = JSON.parse(key) as unknown[];
      if (parts[1] !== origin || parts[2] !== viewerPubkey) continue;
      if (endpoint !== undefined && parts[3] !== endpoint) continue;
      if (this.fetches.has(key)) this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      keys.push(key);
    }
    return keys;
  }

  async remove(address: SurfaceCacheAddress): Promise<void> {
    const key = surfaceCacheKey(address);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.values.delete(key);
    this.stamps.delete(key);
    this.selected.delete(key);
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
        this.stamps.delete(key);
        this.selected.delete(key);
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
    this.stamps.clear();
    this.selected.clear();
  }
}
