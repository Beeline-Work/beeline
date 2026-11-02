import { describe, expect, it, vi } from 'vitest';
import { ImmutableByteCache, type ByteDemand } from './immutable-byte-cache';
const address = { origin: 'https://example.test', principal: 'ada', objectId: 'object-a', version: 'version-a' };
const authorized: ByteDemand = { isCurrent: () => true, reuseAuthorized: true, restoreAuthorized: true };
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('immutable shared file bytes', () => {
  it('shares preview, view and save flight, then reuses bytes only with held authority', async () => {
    const cache = new ImmutableByteCache(); let resolve!: (bytes: Uint8Array) => void;
    const load = vi.fn(() => new Promise<Uint8Array>(done => { resolve = done; }));
    const preview = cache.get(address, load, authorized);
    const view = cache.get(address, load, authorized);
    const save = cache.get(address, load, authorized);
    await drain(); expect(load).toHaveBeenCalledTimes(1);
    resolve(new Uint8Array([1, 2, 3]));
    const copies = await Promise.all([preview, view, save]);
    copies[0]![0] = 99;
    expect(copies[1]).toEqual(new Uint8Array([1, 2, 3]));
    expect(await cache.get(address, load, authorized)).toEqual(new Uint8Array([1, 2, 3]));
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('legacy unsupported authority shares in-flight work but never trusts a completed cache', async () => {
    const cache = new ImmutableByteCache(); const load = vi.fn(async () => new Uint8Array([1]));
    const legacy = { isCurrent: () => true };
    await Promise.all([cache.get(address, load, legacy), cache.get(address, load, legacy)]);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get(address, load, legacy);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('partitions origin, principal, object and immutable version', async () => {
    const cache = new ImmutableByteCache(); const load = vi.fn(async () => new Uint8Array([1]));
    for (const next of [address, { ...address, origin: 'https://other.test' }, { ...address, principal: 'grace' },
      { ...address, objectId: 'other' }, { ...address, version: 'next' }]) await cache.get(next, load, authorized);
    expect(load).toHaveBeenCalledTimes(5);
  });
  it('bounds active downloads to four and cancels queued hidden requests before dispatch', async () => {
    const cache = new ImmutableByteCache(); const resolve: (() => void)[] = [];
    const load = vi.fn(() => new Promise<Uint8Array>(done => { resolve.push(() => done(new Uint8Array([1]))); }));
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const requests = controllers.map((controller, index) => cache.get({ ...address, objectId: String(index) }, load,
      { ...authorized, signal: controller.signal }));
    const completed = Promise.allSettled(requests);
    await drain(); expect(load).toHaveBeenCalledTimes(4);
    for (const controller of controllers.slice(4)) controller.abort();
    resolve.forEach(done => done()); await completed;
    expect(load).toHaveBeenCalledTimes(4); expect(cache.diagnostics().queued).toBe(0);
  });
  it('one disappearing view does not cancel another visible owner; last owner cancels the flight', async () => {
    const cache = new ImmutableByteCache(); const first = new AbortController(); const second = new AbortController();
    let flightSignal!: AbortSignal;
    const load = vi.fn((signal: AbortSignal) => { flightSignal = signal; return new Promise<Uint8Array>(() => {}); });
    const a = cache.get(address, load, { ...authorized, signal: first.signal }).catch(error => error);
    const b = cache.get(address, load, { ...authorized, signal: second.signal }).catch(error => error);
    await drain(); first.abort(); expect(flightSignal.aborted).toBe(false);
    second.abort(); expect(flightSignal.aborted).toBe(true);
    expect((await a).name).toBe('AbortError'); expect((await b).name).toBe('AbortError');
  });
  it('cancels a native disk staging operation when its last admitted consumer disappears', async () => {
    let finishWrite!: () => void; let stagingSignal: AbortSignal | undefined;
    const store = { get: async () => null, set: async (_key: string, _bytes: Uint8Array, signal?: AbortSignal) => {
      stagingSignal = signal; await new Promise<void>(resolve => { finishWrite = resolve; });
    }, remove: vi.fn(async () => {}), clear: async () => {} };
    const cache = new ImmutableByteCache(store); const controller = new AbortController();
    const pending = cache.get(address, async () => new Uint8Array([1]), { ...authorized, signal: controller.signal }).catch(error => error);
    await drain(); expect(stagingSignal?.aborted).toBe(false);
    controller.abort(); expect(stagingSignal?.aborted).toBe(true);
    finishWrite(); await drain();
    expect((await pending).name).toBe('AbortError'); expect(cache.diagnostics().memoryBytes).toBe(0);
  });
  it('fences asynchronous integrity completion before publication or removal of a newer same-key flight', async () => {
    let finishOld!: (valid: boolean) => void; let oldSignal!: AbortSignal; let checks = 0;
    const store = { get: async () => null, set: vi.fn(async () => {}), remove: vi.fn(async () => {}), clear: async () => {} };
    const cache = new ImmutableByteCache(store, async (_address, _bytes, signal) => {
      if (++checks > 1) return true;
      oldSignal = signal; return new Promise<boolean>(resolve => { finishOld = resolve; });
    });
    const controller = new AbortController(); const load = async () => new Uint8Array([1]);
    const old = cache.get(address, load, { ...authorized, signal: controller.signal }).catch(error => error);
    await drain(); controller.abort(); expect(oldSignal.aborted).toBe(true);
    await cache.get(address, load, authorized); finishOld(false); await drain();
    expect((await old).name).toBe('AbortError'); expect(store.remove).not.toHaveBeenCalled();
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(await cache.get(address, load, authorized)).toEqual(new Uint8Array([1]));
  });
  it('cold disk bytes remain unread until a current authority certificate exists', async () => {
    const store = { get: vi.fn(async () => new Uint8Array([2])), set: vi.fn(async () => {}), remove: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    const cache = new ImmutableByteCache(store); const load = vi.fn(async () => new Uint8Array([1]));
    await cache.get(address, load, { isCurrent: () => true });
    expect(store.get).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledTimes(1);
    cache.suspend();
    expect(await cache.get(address, load, authorized)).toEqual(new Uint8Array([2]));
    expect(store.get).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1);
  });
  it('purge fences an old download and clears visible sources without a replacement read', async () => {
    const cache = new ImmutableByteCache(); let resolve!: (bytes: Uint8Array) => void;
    const load = vi.fn(() => new Promise<Uint8Array>(done => { resolve = done; }));
    const purged = vi.fn(); cache.subscribePurge(purged);
    const pending = cache.get(address, load, authorized).catch(error => error);
    await drain(); await cache.purge(); resolve(new Uint8Array([1])); await drain();
    expect((await pending).name).toBe('AbortError'); expect(cache.diagnostics().memoryBytes).toBe(0);
    expect(purged).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1);
  });
  it('an older canceled disk write cannot remove a newer completed same-key write', async () => {
    let finishOldWrite!: () => void; let writes = 0;
    const store = { get: async () => null, set: vi.fn(async () => { if (++writes === 1) await new Promise<void>(done => { finishOldWrite = done; }); }),
      remove: vi.fn(async () => {}), clear: async () => {} };
    const cache = new ImmutableByteCache(store); const controller = new AbortController();
    const load = vi.fn(async () => new Uint8Array([1]));
    const old = cache.get(address, load, { ...authorized, signal: controller.signal }).catch(error => error);
    await drain(); controller.abort();
    await cache.get(address, load, authorized); finishOldWrite(); await drain();
    expect((await old).name).toBe('AbortError'); expect(store.remove).not.toHaveBeenCalled();
    expect(await cache.get(address, load, authorized)).toEqual(new Uint8Array([1]));
  });
  it('rejects a full object over 25MiB and never hands an oversized object to a bounded preview', async () => {
    const cache = new ImmutableByteCache();
    await expect(cache.get(address, async () => new Uint8Array(25 * 1024 * 1024 + 1), authorized)).rejects.toThrow('25 MiB');
    await cache.get(address, async () => new Uint8Array(32 * 1024), authorized);
    await expect(cache.get(address, async () => new Uint8Array(), { ...authorized, maxBytes: 16 * 1024 })).rejects.toThrow('byte limit');
  });
});
