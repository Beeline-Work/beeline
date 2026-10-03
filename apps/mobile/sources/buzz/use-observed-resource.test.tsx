import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ listener: undefined as any, stop: vi.fn() }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: async (_: unknown, listener: unknown) => { wire.listener = listener; return wire.stop; } }) }));
vi.mock('@/buzz/workbench-source', () => ({ getWorkbenchSource: vi.fn() }));
import { useObservedResource, observeRoomResource } from './use-observed-resource';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: any[] = [];
afterEach(async () => { await act(async () => mounted.splice(0).forEach(tree => tree.unmount())); vi.useRealTimers(); vi.clearAllMocks(); });
function mount(element: React.ReactElement) { const tree = create(element); mounted.push(tree); return tree; }

it('shares a read, coalesces pushes during a flight, and detaches after the last reader', async () => {
  const releases: Array<(value: string) => void> = [];
  const load = vi.fn(() => new Promise<string>(resolve => releases.push(resolve)));
  let current: any;
  function Reader() { current = useObservedResource('shared', { load, subscribe: observeRoomResource('room') }); return <span>{current.data}</span>; }
  let first: any; let second: any;
  await act(async () => { first = mount(<Reader />); second = mount(<Reader />); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    wire.listener({ monolithLive: { type: 'subscribed', roomId: 'room' } });
    wire.listener({ monolithLive: { type: 'invalidate', roomId: 'other', reason: 'message' } });
    wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'poll' } });
  });
  await act(async () => releases.shift()!('initial'));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => wire.listener({ monolithLive: { type: 'subscribed', roomId: 'room' } }));
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => {
    for (let n = 0; n < 5; n++) wire.listener({ monolithLive: { type: 'message-delta', roomId: 'room', message: { cardType: 'corner-workflow-handoff' } } });
  });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => releases.shift()!('updated'));
  expect(load).toHaveBeenCalledTimes(3);
  await act(async () => first.unmount());
  expect(wire.stop).not.toHaveBeenCalled();
  await act(async () => second.unmount());
  expect(wire.stop).toHaveBeenCalledTimes(1);
  await act(async () => releases.shift()!('late'));
  expect(load).toHaveBeenCalledTimes(3);
});

it('a failed read stays visible, stops automatic reads, and retry recovers', async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('recovered');
  let current: any;
  function Reader() { current = useObservedResource<string>('error', { load, refreshAfter: () => 700 }); return <span>{current.error ?? current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  expect(current.error).toBe('offline');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => current.retry());
  expect(current.error).toBeNull();
  expect(current.data).toBe('recovered');
});

it('R9-OBS-01: reconnect recovers a failed room read', async () => {
  const load = vi.fn().mockResolvedValueOnce('initial').mockRejectedValueOnce(new Error('offline')).mockResolvedValue('current');
  let current: any;
  function Reader() { current = useObservedResource<string>('reconnect', { load, subscribe: observeRoomResource('room') }); return <span>{current.error ?? current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  await act(async () => wire.listener({ monolithLive: { type: 'subscribed', roomId: 'room' } }));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'message' } }));
  expect(current.error).toBe('offline');
  await act(async () => wire.listener({ monolithLive: { type: 'subscribed', roomId: 'room' } }));
  expect(load).toHaveBeenCalledTimes(3);
  expect(current.error).toBeNull();
  expect(current.data).toBe('current');
});

it('R9-OBS-02: a room invalidation recovers after an error', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('current');
  let current: any;
  function Reader() { current = useObservedResource<string>('live-error', { load, subscribe: observeRoomResource('room') }); return <span>{current.error ?? current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  expect(current.error).toBe('offline');
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'message' } }));
  expect(load).toHaveBeenCalledTimes(2);
  expect(current.error).toBeNull();
  expect(current.data).toBe('current');
});

it('R9-OBS-03: retry waits for the read queued after an existing flight', async () => {
  const releases: Array<(value: string) => void> = [];
  const load = vi.fn(() => new Promise<string>(resolve => releases.push(resolve)));
  let current: any;
  function Reader() { current = useObservedResource<string>('await-refresh', { load }); return <span>{current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  let settled = false;
  let refresh: Promise<void>;
  await act(async () => { refresh = Promise.resolve(current.retry()).then(() => { settled = true; }); });
  expect(settled).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => releases.shift()!('initial'));
  expect(settled).toBe(false);
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => { releases.shift()!('current'); await refresh!; });
  expect(settled).toBe(true);
  expect(current.data).toBe('current');
});

it('selection switches hide old values and late reads cannot overwrite the new selection', async () => {
  let release!: (value: string) => void;
  let current: any;
  const load = (key: string) => key === 'old' ? new Promise<string>(resolve => { release = resolve; }) : Promise.resolve('new detail');
  function Reader({ id }: { id: string }) { current = useObservedResource(id, { load: () => load(id) }); return <span>{current.data}</span>; }
  let tree: any;
  await act(async () => { tree = mount(<Reader id="old" />); });
  await act(async () => tree.update(<Reader id="new" />));
  expect(current.data).toBe('new detail');
  await act(async () => release('old detail'));
  expect(current.data).toBe('new detail');
});
