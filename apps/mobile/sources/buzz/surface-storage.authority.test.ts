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
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
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
function event(key: string, newValue: string | null) {
  for (const listener of fixture.events) listener({ key, newValue, storageArea: fixture.storage } as StorageEvent);
}
beforeEach(() => { vi.resetModules(); fixture.disk.clear(); fixture.native.clear(); fixture.events.clear(); fixture.tails.clear(); fixture.request.mockClear(); });
afterEach(() => vi.unstubAllGlobals());
describe('durable authority floors distinct from denials', () => {
  it('floor equality remains authorized; strictly older groups and later stale writes are rejected', async () => {
    const { routerLaneStorage } = await load(); const store = routerLaneStorage(origin, principal);
    await store.write('old', envelope(room, '1')); await store.write('equal', envelope(room, '2'));
    await store.floor(room, '2'); expect(groups()).toHaveLength(1);
    await expect(store.write('late', envelope(room, '1'))).rejects.toThrow('durable fence');
    await store.write('equal', envelope(room, '2')); await store.fence(room, '2'); expect(groups()).toHaveLength(0);
    await expect(store.write('denied', envelope(room, '2'))).rejects.toThrow('durable fence');
    await store.write('new-grant', envelope(room, '3')); expect(groups()).toHaveLength(1);
  });
  it('an older denial cannot purge a newer installed grant, and floors scrub only the affected group', async () => {
    const { routerLaneStorage } = await load(); const store = routerLaneStorage(origin, principal);
    await store.write('new', envelope(room, '3')); await store.write('other', envelope('room:other', '1'));
    await store.fence(room, '1'); expect(groups()).toHaveLength(2);
    await store.floor(room, '4'); expect(groups()).toHaveLength(1);
    expect(fixture.native.get('buzz-surface-responses')!.get(groups()[0]!)).toContain('room:other');
  });
  it('replays monotone numeric floors separately from inclusive denial after restart and data clear', async () => {
    const { routerLaneStorage, clearMobileSurfaceStorage } = await load(); const first = routerLaneStorage(origin, principal);
    await first.floor(room, '9'); await first.floor(room, '10'); await first.floor(room, '2'); await first.fence(room, '8');
    await first.write('new', envelope(room, '10')); clearMobileSurfaceStorage(); expect(groups()).toHaveLength(0);
    const reopened = routerLaneStorage(origin, principal); const floors = vi.fn(), denials = vi.fn();
    const stopFloor = reopened.subscribeFloors(floors), stopDeny = reopened.subscribeFences(denials);
    expect(floors.mock.calls).toEqual([[room, '10']]); expect(denials.mock.calls).toEqual([[room, '8']]);
    await expect(reopened.write('old', envelope(room, '9'))).rejects.toThrow('durable fence');
    await reopened.write('current', envelope(room, '10')); stopFloor(); stopDeny();
  });
  it('origin/principal partitions cannot retire each other and malformed groups cannot bypass authority checks', async () => {
    const { routerLaneStorage } = await load(); const store = routerLaneStorage(origin, principal);
    await store.floor(room, '4');
    const other = routerLaneStorage(origin, 'other'); await other.write('other', envelope(room, '1', 'other'));
    const relay = routerLaneStorage('https://other.test', principal); await relay.write('relay', envelope(room, '1', principal, 'https://other.test'));
    expect(groups()).toHaveLength(2);
    await expect(store.write('foreign', envelope(room, '5', 'other'))).rejects.toThrow('Invalid router');
    await expect(store.write('malformed', '{"entries":[]}')).rejects.toThrow('Invalid router');
    await expect(store.floor(room, 'not-an-epoch')).rejects.toThrow('Invalid authority floor');
  });
  it('authority metadata survives actual response LRU pressure', async () => {
    const { routerLaneStorage } = await load(); const store = routerLaneStorage(origin, principal);
    await store.floor(room, '2'); await store.fence(room, '1');
    const payload = 'x'.repeat(1_000_000);
    for (let i = 0; i < 35; i++) await store.write(`group-${i}`, envelope(room, '2', principal, origin, payload));
    expect(groups().length).toBeLessThan(35);
    const reopened = routerLaneStorage(origin, principal); const floor = vi.fn(), denial = vi.fn();
    reopened.subscribeFloors(floor)(); reopened.subscribeFences(denial)();
    expect(floor.mock.calls).toEqual([[room, '2']]); expect(denial.mock.calls).toEqual([[room, '1']]);
  }, 30_000);
  it('requires exact browser critical-section support while leaving native MMKV available', async () => {
    const native = await load(); expect(native.routerAuthorityStorageReady()).toBe(true);
    vi.resetModules(); fixture.events.clear();
    const web = await load(true, false); expect(web.routerAuthorityStorageReady()).toBe(false);
    const store = web.routerLaneStorage(origin, principal);
    await expect(store.floor(room, '2')).rejects.toThrow('Cross-tab authority storage');
    await expect(store.write('blocked', envelope(room, '2'))).rejects.toThrow('Cross-tab authority storage');
    await expect(store.fence(room, '2')).rejects.toThrow('Cross-tab authority storage');
    expect(fixture.disk.size).toBe(0);
    const address = web.surfaceAddress(origin, principal, '/legacy-check');
    const guard = (value: unknown): value is { marker: string } => !!value && typeof value === 'object' && 'marker' in value;
    await web.mobileSurfaceCache.write(address, { marker: 'legacy remains available' }, guard);
    await expect(web.mobileSurfaceCache.read(address, guard)).resolves.toEqual({ marker: 'legacy remains available' });
  });
  it('a queued old web write cannot cross a floor committed by another tab under the same Reader lock', async () => {
    const { routerLaneStorage, routerAuthorityStorageReady } = await load(true); expect(routerAuthorityStorageReady()).toBe(true);
    const writer = routerLaneStorage(origin, principal), otherTab = routerLaneStorage(origin, principal);
    await writer.floor(room, '1'); const name = fixture.request.mock.calls[0]![0];
    let release!: () => void;
    const held = fixture.request(name, {}, () => new Promise<void>(done => { release = done; })); await drain();
    const advance = otherTab.floor(room, '3'); const late = writer.write('late', envelope(room, '2')).catch(error => error);
    await drain(); expect(webGroups()).toHaveLength(0); release(); await held; await advance;
    expect(await late).toBeInstanceOf(Error); expect(webGroups()).toHaveLength(0);
    await writer.write('current', envelope(room, '3')); expect(webGroups()).toHaveLength(1);
  });
  it('cross-tab floors replay only minima and never become denial or delete an equal-epoch group', async () => {
    const { routerLaneStorage } = await load(true); const first = routerLaneStorage(origin, principal), other = routerLaneStorage(origin, principal);
    const floors = vi.fn(), denies = vi.fn(); const stopFloor = first.subscribeFloors(floors), stopDeny = first.subscribeFences(denies);
    await other.floor(room, '3'); const key = [...fixture.disk.keys()].find(key => key.includes('router.floor.') && key.endsWith('.3'))!;
    event(key, '3'); await drain(); expect(floors).toHaveBeenLastCalledWith(room, '3'); expect(denies).not.toHaveBeenCalled();
    await first.write('equal', envelope(room, '3'));
    event(key.slice(0, -1) + '2', '2'); await drain(); expect(floors).toHaveBeenLastCalledWith(room, '3'); expect(webGroups()).toHaveLength(1);
    const fresh = routerLaneStorage(origin, principal); const replay = vi.fn(); fresh.subscribeFloors(replay)();
    expect(replay.mock.calls).toEqual([[room, '3']]); stopFloor(); stopDeny();
  });
  it('a delayed lower tab metadata write cannot lower a durable maximum', async () => {
    const { routerLaneStorage } = await load(true); const first = routerLaneStorage(origin, principal), second = routerLaneStorage(origin, principal);
    await Promise.all([first.floor(room, '10'), second.floor(room, '3')]);
    await expect(second.write('older', envelope(room, '9'))).rejects.toThrow('durable fence');
    await Promise.all([first.fence(room, '8'), second.fence(room, '2')]);
    const replay = routerLaneStorage(origin, principal); const floor = vi.fn(), denial = vi.fn(); replay.subscribeFloors(floor)(); replay.subscribeFences(denial)();
    expect(floor.mock.calls).toEqual([[room, '10']]); expect(denial.mock.calls).toEqual([[room, '8']]);
  });
});
