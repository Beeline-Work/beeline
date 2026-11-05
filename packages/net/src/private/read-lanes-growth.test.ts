import { describe, expect, it, vi } from 'vitest';
import { AdmissionOwner } from './admission.js';
import { MediaDemandOwner } from './media-demand-owner.js';
import { NavigationOwner, type NavigationState } from './navigation-owner.js';
import { ReadLanes } from './read-lanes.js';
const identity = { origin: 'https://example.test', principal: 'reader', sessionEpoch: 1 };
const count = (workspaceId: string) => ({ route: 'phone.readRouterSnapshot' as const,
  input: { family: 'needs-you-count' as const, workspaceId } });
const drain = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
describe('large Workspace phone growth', () => {
  it('renders 1,895 Rooms in a group over 1 MiB even with denied cache writes', async () => {
    const request = { family: 'room-list' as const, workspaceId: 'w' };
    const value = { rooms: Array.from({ length: 1895 }, (_, i) => ({ id: String(i), preview: 'x'.repeat(800) })) };
    const lanes = new ReadLanes(identity, () => true, { write: async () => { throw new Error('quota denied'); },
      fence: async () => {}, remove: async () => {} });
    lanes.connected(1, ['room-list'], async () => ({ kind: 'snapshot', value, atomicGroup: 'room-list:w:reader',
      cut: { protocol: 1, stream: 'workspace:w', epoch: '1', through: 1 },
      authority: { digest: 'verified', scopes: [{ authorityScope: 'reader:reader:workspace:w', epoch: '1' }] } }));
    lanes.demand(request, {}, { isCurrent: () => true }); await drain();
    expect(lanes.peek(request).state).toBe('LIVE');
    expect((lanes.peek(request).value as typeof value).rooms).toHaveLength(1895);
    expect((lanes.peek(request).value as typeof value).rooms[1894]).toEqual(value.rooms[1894]);
    await lanes.revoke('reader:reader:workspace:w', '1');
    expect(lanes.peek(request)).toMatchObject({ state: 'REVOKED', value: null });
  });
  it('automatically retries a safe read with bounded backoff and stops on revocation', async () => {
    vi.useFakeTimers();
    const request = { family: 'needs-you-count' as const, workspaceId: 'w' };
    const snapshot = { kind: 'snapshot' as const, value: { count: 1895 }, atomicGroup: 'needs:w:reader',
      cut: { protocol: 1 as const, stream: 'workspace:w', epoch: '1', through: 1 },
      authority: { digest: 'verified', scopes: [{ authorityScope: 'reader:reader:workspace:w', epoch: '1' }] } };
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot);
    const lanes = new ReadLanes(identity, () => true);
    try {
      lanes.connected(1, [request.family], read); lanes.demand(request, {}, { isCurrent: () => true }); await drain();
      expect(lanes.peek(request).state).toBe('PARKED');
      await vi.advanceTimersByTimeAsync(499); expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2);
      expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', value: { count: 1895 } });
      await lanes.revoke('reader:reader:workspace:w', '1');
      await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(2);
      expect(lanes.peek(request).value).toBeNull();
    } finally { lanes.reset(); vi.useRealTimers(); }
  });
  it('queues 1,895 current reads behind eight flights and drains the tail', async () => {
    const lanes = new ReadLanes(identity, () => true);
    let active = 0, maximum = 0, reads = 0;
    const releases: Array<() => void> = [];
    lanes.connected(1, ['room-head'], async request => {
      active++; reads++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve)); active--;
      return { kind: 'snapshot', value: request.roomId, atomicGroup: `room-head:${request.roomId}:reader`,
        cut: { protocol: 1, stream: 'workspace:w', epoch: '1', through: 1 },
        authority: { digest: 'verified', scopes: [{ authorityScope: `room:${request.roomId}`, epoch: '1' }] } };
    });
    for (let i = 0; i < 1895; i++) lanes.demand({ family: 'room-head', roomId: String(i) }, {}, { isCurrent: () => true });
    await drain(); expect(reads).toBe(8);
    while (reads < 1895 || releases.length) { releases.splice(0).forEach(resolve => resolve()); await drain(); }
    await drain();
    expect(maximum).toBe(8);
    expect(lanes.peek({ family: 'room-head', roomId: '1894' })).toMatchObject({ state: 'LIVE', value: '1894' });
    lanes.reset();
  });
  it('rejoins an evicted Room with the same observation token and reads a fresh authorized baseline', async () => {
    const lanes = new ReadLanes(identity, () => true); let reads = 0;
    lanes.connected(1, ['room-head'], async request => ({ kind: 'snapshot', value: ++reads, atomicGroup: `room-head:${request.roomId}:reader`,
      cut: { protocol: 1, stream: 'workspace:w', epoch: '1', through: 1 },
      authority: { digest: 'verified', scopes: [{ authorityScope: `room:${request.roomId}`, epoch: '1' }] } }), { roomHeadContinuityV1: true });
    const request = { family: 'room-head' as const, roomId: 'original' }, token = {}, permit = { isCurrent: () => true };
    const release = lanes.demand(request, token, permit); await drain(); release();
    for (let i = 0; i < 8; i++) {
      const close = lanes.demand({ family: 'room-head', roomId: String(i) }, {}, permit); await drain(); close();
    }
    expect(lanes.peek(request).state).toBe('ABSENT');
    lanes.demand(request, token, permit); await drain();
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', value: 10 }); lanes.reset();
  });
  it('does not wait for a stalled cache to render later live replacements', async () => {
    const request = { family: 'needs-you-count' as const, workspaceId: 'w' };
    const authority = { digest: 'verified', scopes: [{ authorityScope: 'reader:reader:workspace:w', epoch: '1' }] };
    const cut = (through: number) => ({ protocol: 1 as const, stream: 'workspace:w', epoch: '1', through });
    let writes = 0;
    const lanes = new ReadLanes(identity, () => true, { write: async () => { writes++; await new Promise(() => {}); },
      fence: async () => {}, remove: async () => {} });
    lanes.connected(1, [request.family], async () => ({ kind: 'snapshot', value: { count: 1 }, atomicGroup: 'needs:w:reader', cut: cut(1), authority }));
    lanes.demand(request, {}, { isCurrent: () => true }); await drain();
    await lanes.accept({ from: cut(1), to: cut(2), facts: [{ atomicGroup: 'needs:w:reader', authority,
      payload: { kind: 'scope-replace', family: request.family, scope: 'w', value: { count: 1895 } } }] });
    expect(lanes.peek(request)).toMatchObject({ state: 'LIVE', value: { count: 1895 }, cut: { through: 2 } });
    expect(writes).toBe(1); lanes.reset();
  });
  it('admits 1,895 keys and more than sixteen concurrent local owners', () => {
    const admission = new AdmissionOwner(identity);
    const requests = Array.from({ length: 1895 }, (_, i) => count(String(i)));
    expect(admission.focusOwner('shell', 1, 'AppShell', requests)).toHaveLength(1895);
    for (let i = 0; i < 32; i++) expect(admission.focusOwner(`pane-${i}`, 1, 'AppShell', [count(String(i))])).toHaveLength(1);
    expect(admission.focusOwner('shell', 1, 'AppShell', [count('changed')])).toHaveLength(1);
  });
  it('reaches the focused Room through navigation nesting beyond sixteen levels', () => {
    let state: NavigationState = { routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: 'room' } }] };
    for (let i = 0; i < 32; i++) state = { routes: [{ key: `layout-${i}`, name: 'layout', state }] };
    const navigation = new NavigationOwner(); navigation.observe(state);
    expect(navigation.current()).toMatchObject({ screen: 'Room', roomId: 'room' });
  });
  it('scrolls past 1,895 file previews and revisits an evicted preview', async () => {
    const admission = new AdmissionOwner(identity);
    const owner = new MediaDemandOwner(admission, () => ({ screen: 'Room', generation: 1, roomId: 'room' }));
    owner.connected(1);
    for (let i = 0; i < 1895; i++) {
      const objectId = String(i); owner.viewport('room', [objectId]);
      expect(await owner.dispatch('readMediaMetadata', objectId, async () => objectId)).toBe(objectId);
    }
    owner.viewport('room', ['0']);
    expect(await owner.dispatch('readMediaMetadata', '0', async () => 'revisited')).toBe('revisited');
  });
});
