import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ listener: undefined as any, stop: vi.fn(), register: vi.fn() }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: wire.register.mockImplementation(async (_: unknown, listener: unknown) => { wire.listener = listener; return wire.stop; }) }) }));
vi.mock('@/buzz/workbench-source', () => ({ getWorkbenchSource: vi.fn() }));
import { useObservedResource, observeRoomResource } from './use-observed-resource';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: any[] = [];
afterEach(async () => { await act(async () => mounted.splice(0).forEach(tree => tree.unmount())); vi.useRealTimers(); vi.clearAllMocks(); });
function mount(element: React.ReactElement) { const tree = create(element); mounted.push(tree); return tree; }

it('a failed read stays visible and recovers automatically without another gesture', async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('recovered');
  let current: any;
  function Reader() { current = useObservedResource<string>('error', { load }); return <span>{current.error ?? current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  expect(current.error).toBe('Couldn’t reach Beeline');
  await act(async () => { await vi.advanceTimersByTimeAsync(499); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(load).toHaveBeenCalledTimes(2);
  expect(current.error).toBeNull();
  expect(current.data).toBe('recovered');
});
it('R9-OBS-02: changes during backoff coalesce with automatic recovery', async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('current');
  let current: any;
  function Reader() { current = useObservedResource<string>('live-error', { load, subscribe: observeRoomResource('room') }); return <span>{current.error ?? current.data}</span>; }
  await act(async () => { mount(<Reader />); });
  expect(current.error).toBe('Couldn’t reach Beeline');
  await act(async () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'room', reason: 'message' } }));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(load).toHaveBeenCalledTimes(2);
  expect(current.error).toBeNull();
  expect(current.data).toBe('current');
});
it('automatic recovery backs off to a bounded delay, coalesces pushes and resets after success', async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValue(new Error('offline'));
  let current: any;
  function Reader() {
    current = useObservedResource('backoff', { load, retryBackoffMs: { initial: 1000, max: 30000 }, subscribe: observeRoomResource('backoff') });
    return null;
  }
  const push = () => wire.listener({ monolithLive: { type: 'invalidate', roomId: 'backoff' } });
  await act(async () => { mount(<Reader />); });
  let reads = 1;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    await act(async () => { vi.advanceTimersByTime(delay - 1); push(); });
    expect(load).toHaveBeenCalledTimes(reads);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(load).toHaveBeenCalledTimes(++reads);
  }
  load.mockResolvedValue('recovered');
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(current.data).toBe('recovered');
  await act(async () => push());
  expect(load).toHaveBeenCalledTimes(reads + 2);
});
it('coalesces changes during a failure and automatically retries an owner read', async () => {
  vi.useFakeTimers();
  let reject!: (reason: Error) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
    .mockResolvedValue('ready');
  let current: ReturnType<typeof useObservedResource<string>>;
  function Reader() {
    current = useObservedResource('owner-failure', { load, retryOnChange: false, subscribe: observeRoomResource('room') });
    return null;
  }
  let tree: any;
  await act(async () => { tree = mount(<Reader />); });
  await act(async () => {
    wire.listener({ monolithLive: { type: 'message-delta', roomId: 'room', message: { presentation: 'card' } } });
    reject(new Error('offline'));
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    for (let n = 0; n < 1000; n++) wire.listener({ monolithLive: {
      type: 'message-delta', roomId: 'room', message: { presentation: 'card' },
    } });
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(current!.data).toBe('ready');
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount());
});
