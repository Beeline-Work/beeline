import React from 'react';
// @ts-expect-error React renderer declarations are absent in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  read: vi.fn(async () => ({ roomName: 'Room', agentNames: [], schedules: [], subscriptions: [] })),
  watches: [] as { callback: (event: any) => void; stopped: boolean }[],
  focus: new Map<string, () => void>(), blur: new Map<string, () => void>(), current: '',
}));
vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => () => void) => {
  const id = fixture.current;
  React.useEffect(() => { fixture.focus.set(id, effect); const blur = effect(); fixture.blur.set(id, blur); return blur; }, [effect]);
} }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'ada' }), getEffectiveRelayUrl: async () => 'https://example.test' }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: (...args: unknown[]) => fixture.read(...args as []), MonolithPhoneOperationError: class extends Error {} }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: async (_filters: unknown, callback: (event: unknown) => void) => {
  const watch = { callback, stopped: false }; fixture.watches.push(watch); return () => { watch.stopped = true; };
} }) }));
vi.mock('./surface-storage', () => ({
  surfaceAddress: () => ({}), mobileSurfaceCache: { fetch: async (_address: unknown, _guard: unknown, read: () => Promise<unknown>) => read() },
}));
vi.mock('./use-shared-surface', () => ({ useSharedSurface: (_endpoint: string, params: { roomId?: string } | undefined, _guard: unknown,
  request: () => Promise<unknown>, enabled: boolean) => {
  const address = React.useMemo(() => enabled && params?.roomId ? { relayOrigin: 'https://example.test', viewerPubkey: 'ada' } : null, [enabled, params?.roomId]);
  const refresh = React.useCallback(() => request(), [request]);
  return { value: null, address, loading: false, error: null, setError: () => {}, refresh };
} }));
import { useScheduledWork } from './scheduled-work';
import { resetClientState } from '@/sync/client-reset';
let tree: any;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; resetClientState(); fixture.read.mockClear(); fixture.watches = []; });
afterEach(async () => { if (tree) await act(async () => tree.unmount()); tree = undefined; });
function Reader({ id }: { id: string }) { fixture.current = id; useScheduledWork(id); return null; }

it('unmounted schedules leave no retained observer and zero reads on later changes', async () => {
  await act(async () => { tree = create(<Reader id="room-a" />); });
  expect(fixture.read).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount()); tree = undefined;
  expect(fixture.watches.every(watch => watch.stopped)).toBe(true);
  for (const watch of fixture.watches) watch.callback({ monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'postgres:agent_schedules' } });
  expect(fixture.read).toHaveBeenCalledTimes(1);
});
it('a retained hidden schedule releases its observer and reads once on return focus', async () => {
  await act(async () => { tree = create(<Reader id="room-a" />); });
  await act(async () => fixture.blur.get('room-a')!());
  for (const watch of fixture.watches) watch.callback({ monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'postgres:agent_schedules' } });
  expect(fixture.read).toHaveBeenCalledTimes(1);
  await act(async () => { fixture.focus.get('room-a')!(); });
  expect(fixture.read).toHaveBeenCalledTimes(2);
});

it('sixteen unmounted Rooms ignore later schedule changes and return with one read per key', async () => {
  for (let n = 0; n < 16; n++) {
    await act(async () => { tree = create(<Reader id={`room-${n}`} />); });
    await act(async () => tree.unmount()); tree = undefined;
  }
  expect(fixture.read).toHaveBeenCalledTimes(16);
  expect(fixture.watches.every(watch => watch.stopped)).toBe(true);
  for (let n = 0; n < 16; n++) for (const watch of fixture.watches)
    watch.callback({ monolithLive: { type: 'invalidate', roomId: `room-${n}`, reason: 'postgres:agent_schedules' } });
  expect(fixture.read).toHaveBeenCalledTimes(16);
  await act(async () => { tree = create(<Reader id="room-0" />); });
  expect(fixture.read).toHaveBeenCalledTimes(17);
});
