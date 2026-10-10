import { describe, expect, it } from 'vitest';
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
    keys: async () => [...rows.keys()],
  });
  return { rows, cache: new SurfaceRegistry(durable), reads: () => reads };
}

describe('shared mobile surface registry', () => {
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
    stop();
    await cache.evictViewer(address.relayOrigin, address.viewerPubkey);
    expect(cache.peek(address, isCount)).toBeNull();
  });

  it('does not restore a stale storage read after viewer eviction', async () => {
    let release!: (value: string) => void;
    const durable = new SurfaceResponseCache({
      get: () => new Promise<string>((resolve) => { release = resolve; }),
      set: async () => undefined,
      remove: async () => undefined,
      keys: async () => [surfaceCacheKey(address)],
    });
    const cache = new SurfaceRegistry(durable);
    const pending = cache.read(address, isCount);
    await cache.evictViewer(address.relayOrigin, address.viewerPubkey);
    release(JSON.stringify({ count: 9 }));
    expect(await pending).toBeNull();
    expect(cache.peek(address, isCount)).toBeNull();
  });
});
