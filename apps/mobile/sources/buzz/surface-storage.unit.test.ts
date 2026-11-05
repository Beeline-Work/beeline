import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => {
  const disk = new Map<string, string>(); const native = new Map<string, Map<string, string>>();
  const events = new Set<(event: StorageEvent) => void>();
  const tails = new Map<string, Promise<unknown>>();
  const storage: Storage = {
    get length() { return disk.size; }, key: index => [...disk.keys()][index] ?? null,
    getItem: key => disk.get(key) ?? null, setItem: (key, value) => { disk.set(key, value); },
    removeItem: key => { disk.delete(key); }, clear: () => { disk.clear(); },
  };
  const request = vi.fn((name: string, _options: unknown, work: () => unknown) => {
    const next = (tails.get(name) ?? Promise.resolve()).then(work); tails.set(name, next.catch(() => {})); return next;
  });
  return { disk, native, events, tails, storage, request, web: false };
});
vi.mock('react-native-mmkv', () => ({ MMKV: class {
  private values: Map<string, string>;
  constructor({ id }: { id: string }) { this.values = fixture.native.get(id) ?? new Map(); fixture.native.set(id, this.values); }
  getString(key: string) { return this.values.get(key); }
  set(key: string, value: string) { this.values.set(key, value); }
  delete(key: string) { this.values.delete(key); }
  getAllKeys() { return [...this.values.keys()]; }
} }));
vi.mock('@/utils/web-storage', () => ({ webRuntimeStorage: () => fixture.web ? { storage: fixture.storage } : null }));
vi.mock('./message-outbox-storage', () => ({ clearMessageOutboxStorage: vi.fn(), configureMessageOutboxDelivery: vi.fn(), getMessageOutbox: vi.fn(), createRoomOutbox: vi.fn(), resetMessageOutboxes: vi.fn() }));
vi.mock('./room-transition-work', () => ({ deferRoomWrite: (_key: string, work: () => Promise<void>) => work() }));
vi.mock('./identity-records', () => ({ selectIdentities: (_address: unknown, value: unknown) => value }));
const origin = 'https://synthetic.test'; const principal = 'reader'; const room = 'room:11111111-1111-4111-8111-111111111111';
const envelope = (scope: string, epoch: string, reader = principal, relay = origin, data = 'current') => JSON.stringify({ schema: 1,
  identity: { origin: relay, principal: reader, sessionEpoch: 1 }, group: 'test', entries: [{ key: 'datum',
    snapshot: { kind: 'snapshot', value: data, cut: { stream: 'workspace:one', epoch: 'stream', through: 1, protocol: 1 }, atomicGroup: 'test',
      authority: { digest: 'a'.repeat(64), scopes: [{ authorityScope: scope, epoch }] } } }] });
async function load(web = false, locks = true) {
  fixture.web = web;
  vi.stubGlobal('window', { document: {}, addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
    if (type === 'storage') fixture.events.add(listener);
  } });
  vi.stubGlobal('navigator', locks ? { locks: { request: fixture.request } } : {});
  return import('./surface-storage');
}
function groups() { return [...fixture.native.get('buzz-surface-responses')!.keys()].filter(key => key.startsWith('router.group.')); }
function webGroups() { return [...fixture.disk.keys()].filter(key => key.includes('router.group.')); }
beforeEach(() => { vi.resetModules(); fixture.disk.clear(); fixture.native.clear(); fixture.events.clear(); fixture.tails.clear(); fixture.request.mockClear(); });
afterEach(() => vi.unstubAllGlobals());
describe('phone growth and recovery', () => {
  it('keeps live authority in memory without browser cache locks', async () => {
    const native = await load(); expect(native.routerAuthorityStorageReady()).toBe(true);
    vi.resetModules(); fixture.events.clear();
    const web = await load(true, false); expect(web.routerAuthorityStorageReady()).toBe(true);
    const store = web.routerLaneStorage(origin, principal);
    await store.floor(room, '2');
    await store.write('current-live', envelope(room, '2'));
    await expect(store.write('stale', envelope(room, '1'))).rejects.toThrow('durable fence');
    await store.fence(room, '2');
    await expect(store.write('revoked', envelope(room, '2'))).rejects.toThrow('durable fence');
    expect(fixture.disk.size).toBe(0);
    const address = web.surfaceAddress(origin, principal, '/legacy-check');
    const guard = (value: unknown): value is { marker: string } => !!value && typeof value === 'object' && 'marker' in value;
    await web.mobileSurfaceCache.write(address, { marker: 'legacy remains available' }, guard);
    await expect(web.mobileSurfaceCache.read(address, guard)).resolves.toEqual({ marker: 'legacy remains available' });
  });
  it('accepts a group over 1 MiB and evicts it when it exceeds the total cache budget', async () => {
    const { routerLaneStorage } = await load(); const store = routerLaneStorage(origin, principal);
    await store.write('large', envelope(room, '1', principal, origin, 'x'.repeat(2 * 1024 * 1024)));
    expect(groups()).toHaveLength(1);
    await store.write('larger-than-cache', envelope(room, '1', principal, origin, 'x'.repeat(33 * 1024 * 1024)));
    expect(groups()).toHaveLength(0);
  });
  it('denied browser storage leaves monotone in-memory authority and live support available', async () => {
    const { routerLaneStorage, routerAuthorityStorageReady } = await load(true);
    const store = routerLaneStorage(origin, principal);
    const write = vi.spyOn(fixture.storage, 'setItem').mockImplementation(() => { throw new Error('storage denied'); });
    try {
      await store.floor(room, '2'); await store.fence(room, '1');
      await store.write('current', envelope(room, '2'));
      await expect(store.write('stale', envelope(room, '1'))).rejects.toThrow('durable fence');
      expect(routerAuthorityStorageReady()).toBe(true);
      expect(webGroups()).toHaveLength(0);
    } finally { write.mockRestore(); }
  });
});
