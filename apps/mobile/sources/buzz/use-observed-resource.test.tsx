import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ listener: undefined as any, stop: vi.fn(), register: vi.fn() }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: wire.register.mockImplementation(async (_: unknown, listener: unknown) => { wire.listener = listener; return wire.stop; }) }) }));
vi.mock('@/buzz/workbench-source', () => ({ getWorkbenchSource: vi.fn() }));
import { useObservedResource, observeRoomResource } from './use-observed-resource';
import { resetClientState } from '@/sync/client-reset';
import { PhoneSocketDisconnectedError } from '@/sync/transport/phone-socket-error';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: any[] = [];
afterEach(async () => { await act(async () => mounted.splice(0).forEach(tree => tree.unmount())); vi.useRealTimers(); vi.clearAllMocks(); });
function mount(element: React.ReactElement) { const tree = create(element); mounted.push(tree); return tree; }

it('shares the displayed answer and directly reads each relevant push without a queue', async () => {
  const releases: Array<(value: string) => void> = [];
  const load = vi.fn(() => new Promise<string>(resolve => releases.push(resolve)));
  let current: any;
  function Reader() { current = useObservedResource('shared', { load, subscribe: observeRoomResource('room') }); return <span>{current.data}</span>; }
  let first: any; let second: any;
  await act(async () => { first = mount(<Reader />); second = mount(<Reader />); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => releases.shift()!('initial'));
  expect(current.data).toBe('initial');
  await act(async () => {
    for (let n = 0; n < 5; n++) wire.listener({ monolithLive: { type: 'message-delta', roomId: 'room', message: { presentation: 'card' } } });
  });
  expect(load).toHaveBeenCalledTimes(6);
  await act(async () => { while (releases.length) releases.shift()!('updated'); });
  expect(current.data).toBe('updated');
  await act(async () => first.unmount()); expect(wire.stop).not.toHaveBeenCalled();
  await act(async () => second.unmount()); expect(wire.stop).toHaveBeenCalledTimes(1);
});

it('a slow resource keeps waiting for its live socket request instead of adding a second timeout', async () => {
  vi.useFakeTimers();
  let resolve!: (value: string) => void;
  const load = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  let current: any;
  function Reader() { current = useObservedResource<string>('slow', { load }); return <span>{current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(current.loading).toBe(true); expect(current.error).toBeNull(); expect(load).toHaveBeenCalledOnce();
  await act(async () => resolve('answer'));
  expect(current.data).toBe('answer'); expect(current.loading).toBe(false);
});

it('a failed read stays visible, stops automatic reads, and retry recovers', async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('recovered');
  let current: any;
  function Reader() { current = useObservedResource<string>('error', { load }); return <span>{current.error ?? current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  expect(current.error).toBe('Could not complete request');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => current.retry());
  expect(current.error).toBeNull();
  expect(current.data).toBe('recovered');
});

it('R9-OBS-01: the reconnect invalidation calls the same failed read again', async () => {
  const load = vi.fn().mockResolvedValueOnce('initial').mockRejectedValueOnce(new Error('offline')).mockResolvedValue('current');
  let current: any;
  function Reader() { current = useObservedResource<string>('reconnect', { load, subscribe: observeRoomResource('room') }); return <span>{current.error ?? current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  await act(async () => wire.listener({ monolithLive: { type: 'subscribed', roomId: 'room' } }));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'message' } }));
  expect(current.error).toBe('Could not complete request');
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'reconnect' } }));
  expect(load).toHaveBeenCalledTimes(3);
  expect(current.error).toBeNull();
  expect(current.data).toBe('current');
});

it('R9-OBS-02: a room invalidation recovers after an error', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('current');
  let current: any;
  function Reader() { current = useObservedResource<string>('live-error', { load, subscribe: observeRoomResource('room') }); return <span>{current.error ?? current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  expect(current.error).toBe('Could not complete request');
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'message' } }));
  expect(load).toHaveBeenCalledTimes(2);
  expect(current.error).toBeNull();
  expect(current.data).toBe('current');
});

it('keeps cached data without local connection copy after a socket failure and recovers on invalidation', async () => {
  const load = vi.fn().mockResolvedValueOnce('cached')
    .mockRejectedValueOnce(new PhoneSocketDisconnectedError()).mockResolvedValueOnce('current');
  let current: any;
  function Reader() {
    current = useObservedResource<string>('socket-failure', { load, subscribe: observeRoomResource('room') });
    return <span>{current.data}</span>;
  }
  let tree: any;
  await act(async () => { tree = mount(<Reader />); });
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'message' } }));
  expect(current.data).toBe('cached');
  expect(current.error).toBe('');
  expect(tree.root.findByType('span').props.children).toBe('cached');
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'reconnect' } }));
  expect(current.data).toBe('current');
  expect(current.error).toBeNull();
  expect(load).toHaveBeenCalledTimes(3);
});

it('R9-OBS-03: Retry starts its own read immediately, without waiting on an existing flight', async () => {
  const releases: Array<(value: string) => void> = [];
  const load = vi.fn(() => new Promise<string>(resolve => releases.push(resolve)));
  let current: any;
  function Reader() { current = useObservedResource<string>('await-refresh', { load }); return <span>{current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  let settled = false;
  let refresh: Promise<void>;
  await act(async () => { refresh = Promise.resolve(current.retry()).then(() => { settled = true; }); });
  expect(settled).toBe(false);
  expect(load).toHaveBeenCalledTimes(2);
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

it('R12i: one delivery reads at most once, on its delta rather than its hint', async () => {
  const load = vi.fn(async () => 'current');
  function Reader() { useObservedResource('delivery', { load, subscribe: observeRoomResource('room') }); return null; }
  await act(async () => { mount(<Reader />); });
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'message', deliveryId: 'd1' } }));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => wire.listener({ monolithLive: { type: 'message-delta', roomId: 'room', reconcilesDelivery: 'd1', message: { presentation: 'card' } } }));
  expect(load).toHaveBeenCalledTimes(2);
});
it('R12j: Retry attaches a subscription that failed, then receives pushes', async () => {
  wire.register.mockRejectedValueOnce(new Error('subscription offline'));
  const load = vi.fn(async () => 'current');
  let current: any;
  function Reader() { current = useObservedResource('subscription-retry', { load, subscribe: observeRoomResource('room') }); return null; }
  await act(async () => { mount(<Reader />); });
  await act(async () => current.retry());
  expect(wire.register).toHaveBeenCalledTimes(2);
  const calls = load.mock.calls.length;
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'message' } }));
  expect(load).toHaveBeenCalledTimes(calls + 1);
});

it('reads again for a workflow line or a change no delta describes, never for prose or tool rows', async () => {
  const load = vi.fn().mockResolvedValue('runs');
  function Reader() { useObservedResource<string>('relevance', { load, subscribe: observeRoomResource('room') }); return null; }
  await act(async () => { mount(<Reader />); });
  await act(async () => wire.listener({ monolithLive: { type: 'subscribed', roomId: 'room' } }));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    wire.listener({ monolithLive: { type: 'message-delta', roomId: 'room', message: { presentation: 'message' } } });
    wire.listener({ monolithLive: { type: 'message-delta', roomId: 'room', message: { presentation: 'activity' } } });
    wire.listener({ monolithLive: { type: 'turn-delta', roomId: 'room', turn: { status: 'working' } } });
    wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'message', messageId: 'm', deliveryId: 'd' } });
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => wire.listener({ monolithLive: { type: 'message-delta', roomId: 'room', message: { presentation: 'system' } } }));
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'delta-fallback:message', reconcilesDelivery: 'd' } }));
  expect(load).toHaveBeenCalledTimes(3);
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'corner-status' } }));
  expect(load).toHaveBeenCalledTimes(4);
});

it('an account switch drops the old data and the old read, then shows the new account', async () => {
  const releases: Array<(value: string) => void> = [];
  const load = vi.fn(() => new Promise<string>(resolve => releases.push(resolve)));
  let current: any;
  function Reader() { current = useObservedResource('account', { load }); return <span>{current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  await act(async () => releases.shift()!('first account'));
  expect(current.data).toBe('first account');
  await act(async () => { void current.retry(); });
  await act(async () => resetClientState());
  expect(current.data).toBeUndefined();
  expect(current.loading).toBe(true);
  await act(async () => releases.shift()!('first account, late'));
  expect(current.data).toBeUndefined();
  await act(async () => releases.shift()!('second account'));
  expect(current.data).toBe('second account');
});
