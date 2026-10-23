import { describe, expect, it, vi } from 'vitest';
import { SurfaceResponseCache, surfaceCacheKey, type SurfaceCacheAddress } from '@beeline/buzz-client';
import { SurfaceRegistry } from './surface-registry';

const address: SurfaceCacheAddress = {
  relayOrigin: 'https://usebeeline.app',
  viewerPubkey: 'viewer',
  endpoint: '/workspaces',
};
const isCount = (value: unknown): value is { count: number } =>
  typeof value === 'object' && value !== null &&
  typeof (value as { count?: unknown }).count === 'number';

function registry() {
  const rows = new Map<string, string>();
  let reads = 0;
  const durable = new SurfaceResponseCache({
    get: async (key) => { reads += 1; return rows.get(key) ?? null; },
    set: async (key, value) => { rows.set(key, value); },
    remove: async (key) => { rows.delete(key); },
  });
  return { rows, cache: new SurfaceRegistry(durable), reads: () => reads };
}

describe('shared mobile surface registry', () => {
  it.each(['write', 'persist'] as const)('does not resurrect a removed Room through deferred %s', async (method) => {
    const writes = vi.fn(async () => {});
    let release!: () => Promise<void>;
    const cache = new SurfaceRegistry(new SurfaceResponseCache({
      get: async () => null, set: writes, remove: async () => {},
    }), undefined, undefined, (_key, work) => new Promise<void>((resolve, reject) => {
      release = () => work().then(resolve, reject);
    }));
    const saved = cache[method](address, { count: 1 }, isCount);
    await cache.remove(address);
    await release();
    await saved;
    expect(writes).not.toHaveBeenCalled();
    expect(cache.peek(address, isCount)).toBeNull();
  });

  it('defers Room validation, conversion and serialization until navigation completes', async () => {
    const normalize = vi.fn((value: unknown) => value);
    const guard = vi.fn(isCount);
    const storage = { get: async () => null, set: vi.fn(async () => {}), remove: async () => {} };
    const pending: Array<() => Promise<void>> = [];
    const cache = new SurfaceRegistry(new SurfaceResponseCache(storage), normalize, undefined,
      (_key: string, write: () => Promise<void>) => new Promise<void>((resolve, reject) => {
        pending.push(() => write().then(resolve, reject));
      }));
    const room = { ...address, endpoint: '/room/busy' };
    const write = cache.write(room, { count: 1 }, guard);
    expect(normalize).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    // The native transition-end callback, not elapsed time, releases the work.
    await pending[0]!();
    await write;
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(storage.set).toHaveBeenCalledTimes(1);
  });

  it('keeps only the three most recently used inactive Room responses hot', async () => {
    const { cache } = registry();
    const rooms = Array.from({ length: 4 }, (_, n) => ({ ...address, endpoint: `/room/${n}` }));
    const first = { count: 0 };
    await cache.write(rooms[0]!, first, isCount);
    await cache.write(rooms[1]!, { count: 1 }, isCount);
    await cache.write(rooms[2]!, { count: 2 }, isCount);
    expect(cache.peek(rooms[0]!, isCount)).toBe(first);
    await cache.write(rooms[3]!, { count: 3 }, isCount);
    expect(cache.peek(rooms[0]!, isCount)).toBe(first);
    expect(cache.peek(rooms[1]!, isCount)).toBeNull();
    expect(cache.peek(rooms[2]!, isCount)).toEqual({ count: 2 });
    expect(cache.peek(rooms[3]!, isCount)).toEqual({ count: 3 });
  });

  it('hydrates once, paints from memory on route return, and shares the fetched result', async () => {
    const { cache, rows, reads } = registry();
    rows.set(surfaceCacheKey(address), JSON.stringify({ count: 1 }));
    expect(await cache.read(address, isCount)).toEqual({ count: 1 });
    expect(cache.peek(address, isCount)).toEqual({ count: 1 });
    expect(await cache.read(address, isCount)).toEqual({ count: 1 });
    expect(reads()).toBe(1);

    let requests = 0;
    const request = async () => { requests += 1; return { count: 2 }; };
    const [first, second] = await Promise.all([
      cache.fetch(address, isCount, request),
      cache.fetch(address, isCount, request),
    ]);
    expect([first, second]).toEqual([{ count: 2 }, { count: 2 }]);
    expect(requests).toBe(1);
    expect(cache.peek(address, isCount)).toEqual({ count: 2 });
  });

  it('publishes live state to mounted routes without writing a durable frame', async () => {
    const { cache, rows } = registry();
    let notices = 0;
    const stop = cache.subscribe(address, () => { notices += 1; });
    cache.publish(address, { count: 3 }, isCount);
    expect(cache.peek(address, isCount)).toEqual({ count: 3 });
    expect(rows.size).toBe(0);
    expect(notices).toBe(1);
    cache.clear();
    expect(cache.peek(address, isCount)).toBeNull();
    expect(notices).toBe(2);
    stop();
  });

  it('does not restore a stale storage read after a clear', async () => {
    let release!: (value: string) => void;
    const durable = new SurfaceResponseCache({
      get: () => new Promise<string>((resolve) => { release = resolve; }),
      set: async () => undefined,
      remove: async () => undefined,
    });
    const cache = new SurfaceRegistry(durable);
    const pending = cache.read(address, isCount);
    cache.clear();
    release(JSON.stringify({ count: 9 }));
    expect(await pending).toBeNull();
    expect(cache.peek(address, isCount)).toBeNull();
  });

  it('keeps a live publish when an older fetch resolves after it', async () => {
    const { cache, rows } = registry();
    let respond!: (value: { count: number }) => void;
    const pending = cache.fetch(address, isCount, () => new Promise((resolve) => { respond = resolve; }));
    cache.publish(address, { count: 5 }, isCount);
    respond({ count: 4 });
    expect(await pending).toEqual({ count: 5 });
    expect(cache.peek(address, isCount)).toEqual({ count: 5 });
    expect(rows.size).toBe(0);
  });

  it('keeps an address evicted when a fetch started before the eviction resolves', async () => {
    const { cache, rows } = registry();
    cache.publish(address, { count: 1 }, isCount);
    let respond!: (value: { count: number }) => void;
    const pending = cache.fetch(address, isCount, () => new Promise((resolve) => { respond = resolve; }));
    await cache.remove(address);
    respond({ count: 2 });
    // The stale response is not handed to the caller to paint.
    expect(await pending).toBeNull();
    expect(cache.peek(address, isCount)).toBeNull();
    expect(rows.size).toBe(0);
  });

  it('takes another tab\'s write or removal of a projection it holds', () => {
    const { cache } = registry();
    const other = { ...address, endpoint: '/workspace/:id', params: { workspaceId: 'ws' } };
    cache.publish(address, { count: 1 }, isCount);
    cache.publish(other, { count: 7 }, isCount);
    let notices = 0;
    const stop = cache.subscribe(address, () => { notices += 1; });
    cache.adoptStored(surfaceCacheKey(address), { count: 2 });
    expect(cache.peek(address, isCount)).toEqual({ count: 2 });
    expect(cache.peek(other, isCount)).toEqual({ count: 7 });
    cache.adoptStored(surfaceCacheKey(address), undefined);
    expect(cache.peek(address, isCount)).toBeNull();
    expect(cache.peek(other, isCount)).toEqual({ count: 7 });
    expect(notices).toBe(2);
    stop();
  });

  it('keeps another tab\'s write out of a projection this tab never held', () => {
    const { cache } = registry();
    cache.adoptStored(surfaceCacheKey(address), { count: 2 });
    expect(cache.peek(address, isCount)).toBeNull();
  });
});
