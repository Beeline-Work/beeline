import React from 'react';
// @ts-expect-error Renderer declarations are absent in the mobile workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
type View = { state: string; value: { workflows: any[] } | null; error: string | null; cut: null };
const fixture = vi.hoisted(() => ({ mode: 'router' as 'pending' | 'router' | 'legacy', focused: true,
  entries: new Map<string, { view: View; listeners: Set<() => void> }>(), acquire: vi.fn(), release: vi.fn(),
  retry: vi.fn(), read: vi.fn(async (..._args: unknown[]) => ({ workflows: [] })), register: vi.fn(async (..._args: unknown[]) => () => {}) }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('./use-surface-focus', () => ({ useSurfaceFocus: () => fixture.focused }));
vi.mock('./router-family', () => ({ useRouterFamily: () => fixture.mode }));
vi.mock('./router-owner', () => ({ acquireRouterLane: (...args: any[]) => fixture.acquire(...args), retryRouterLane: (...args: any[]) => fixture.retry(...args) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: (...args: any[]) => fixture.read(...args) }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: (...args: any[]) => fixture.register(...args) }) }));
import { useRoomWorkflowRun } from './use-room-workflow-run';
function entry(room: string) {
  let value = fixture.entries.get(room);
  if (!value) { value = { view: { state: 'LIVE', value: { workflows: [] }, error: null, cut: null }, listeners: new Set() }; fixture.entries.set(room, value); }
  return value;
}
let tree: any, current: ReturnType<typeof useRoomWorkflowRun>;
function Reader({ room = 'room' }: { room?: string }) { current = useRoomWorkflowRun(room); return null; }
beforeEach(() => {
  fixture.mode = 'router'; fixture.focused = true; fixture.entries.clear(); vi.clearAllMocks();
  fixture.acquire.mockImplementation((request: { roomId: string }) => {
    const held = entry(request.roomId);
    return { current: () => held.view, subscribe: (wake: () => void) => { held.listeners.add(wake); return () => held.listeners.delete(wake); },
      release: () => fixture.release(request.roomId) };
  });
});
afterEach(() => { if (tree) act(() => tree.unmount()); tree = undefined; });
describe('F05 actual workflow consumers on the negotiated family', () => {
  it('two consumers join their lane and paint a committed replacement without legacy watches or reads', async () => {
    await act(async () => { tree = create(<><Reader /><Reader /></>); });
    expect(fixture.acquire.mock.calls.map(([request]) => request)).toEqual([
      { family: 'room-workflows', roomId: 'room' }, { family: 'room-workflows', roomId: 'room' }]);
    const held = entry('room');
    await act(async () => { held.view = { ...held.view, value: { workflows: [{ runId: 'run', roomId: 'room', status: 'live', updatedAt: 1 }] } };
      for (const wake of held.listeners) wake(); });
    expect(current.workflow?.runId).toBe('run');
    expect(fixture.read).not.toHaveBeenCalled(); expect(fixture.register).not.toHaveBeenCalled();
  });
  it('sixteen unmounted Rooms release their observers, stay quiet on changes and return with one attachment per key', async () => {
    const rooms = Array.from({ length: 16 }, (_, n) => `room-${n}`);
    await act(async () => { tree = create(<>{rooms.map(room => <Reader key={room} room={room} />)}</>); });
    expect(fixture.acquire).toHaveBeenCalledTimes(16);
    await act(async () => tree.update(<></>));
    expect(fixture.release).toHaveBeenCalledTimes(16);
    for (const room of rooms) { const held = entry(room); expect(held.listeners.size).toBe(0); held.view = { ...held.view, value: { workflows: [] } }; }
    expect(fixture.acquire).toHaveBeenCalledTimes(16); expect(fixture.read).not.toHaveBeenCalled();
    await act(async () => tree.update(<Reader room={rooms[0]} />));
    expect(fixture.acquire).toHaveBeenCalledTimes(17); expect(fixture.read).not.toHaveBeenCalled();
  });
  it('pending negotiation and blur hide prior private workflow data and admit no legacy fallback', async () => {
    fixture.mode = 'pending';
    await act(async () => { tree = create(<Reader />); });
    expect(fixture.acquire).not.toHaveBeenCalled(); expect(fixture.read).not.toHaveBeenCalled();
    fixture.mode = 'router'; await act(async () => tree.update(<Reader />));
    fixture.focused = false; await act(async () => tree.update(<Reader />));
    expect(current.workflow).toBeUndefined(); expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.register).not.toHaveBeenCalled(); expect(fixture.read).not.toHaveBeenCalled();
  });
});
