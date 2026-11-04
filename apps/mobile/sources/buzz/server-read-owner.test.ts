import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ mode: 'router', view: null as any,
  acquire: vi.fn(), release: vi.fn(), wire: vi.fn(), listener: () => {} }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => null, getEffectiveRelayUrl: async () => 'https://server.test' }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('./router-owner', () => ({
  subscribeRouterOwner: () => () => {}, routerFamilyMode: () => fixture.mode,
  acquireRouterForwardList: (_workspace: string, _visible: unknown, listener: () => void) => {
    fixture.acquire(_workspace); fixture.listener = listener;
    return { current: () => fixture.view, release: fixture.release };
  },
}));
vi.mock('./surface-storage', () => ({ mobileSurfaceCache: {}, surfaceAddress: () => ({}) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: fixture.wire, readServerSurface: fixture.wire }));
vi.mock('@/sync/transport/room-view-client', () => ({ RoomViewClient: class {} }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: fixture.wire }));
import { readChatList } from './server-read-owner';
const key = { relayUrl: 'https://server.test', viewerPubkey: 'a'.repeat(64), workspaceId: '11111111-1111-4111-8111-111111111111' };
const value = { workspace: { id: key.workspaceId, name: 'Workspace', role: 'member', updatedAt: 1 }, chats: [],
  viewer: { pubkey: key.viewerPubkey, name: 'Reader', kind: 'human' }, watchFilters: [], truncated: false };
beforeEach(() => {
  fixture.mode = 'router'; fixture.acquire.mockClear(); fixture.release.mockClear(); fixture.wire.mockClear();
  fixture.view = { state: 'OPENING', value: null, error: null };
});
it('Forward opens the existing lane and paints its validated DTO without a raw read', async () => {
  const result = readChatList(key);
  expect(fixture.acquire).toHaveBeenCalledExactlyOnceWith(key.workspaceId);
  fixture.view = { state: 'LIVE', value, error: null }; fixture.listener();
  await expect(result).resolves.toEqual(value);
  expect(fixture.wire).not.toHaveBeenCalled(); expect(fixture.release).toHaveBeenCalledOnce();
});
it('Forward shows a parked lane refusal and never falls through to the wire adapter', async () => {
  fixture.view = { state: 'PARKED', value: null, error: 'Access changed' };
  await expect(readChatList(key)).rejects.toThrow('Access changed');
  expect(fixture.release).toHaveBeenCalledOnce(); expect(fixture.wire).not.toHaveBeenCalled();
});
it('Forward cannot create a legacy read while negotiation is pending', async () => {
  fixture.mode = 'pending';
  await expect(readChatList(key)).rejects.toThrow('unavailable');
  expect(fixture.acquire).not.toHaveBeenCalled(); expect(fixture.wire).not.toHaveBeenCalled();
});
