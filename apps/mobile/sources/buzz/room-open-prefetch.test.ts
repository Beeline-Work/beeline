import { describe, expect, it, vi } from 'vitest';
import type { RoomView } from '@beeline/buzz-client';

import { beginRoomOpenPrefetch, dispatchRoomOpenTap } from './room-open-prefetch';

describe('room-open prefetch', () => {
  it('overlaps one cache-warming GET with navigation', async () => {
    const view = { room: { id: 'room-a' } } as RoomView;
    let settle: (() => void) | undefined;
    const written = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const fetchRoom = vi.fn(async () => view);
    const writeCache = vi.fn(async () => {
      settle?.();
    });
    beginRoomOpenPrefetch('room-a', fetchRoom, writeCache);
    beginRoomOpenPrefetch('room-a', fetchRoom, writeCache);
    expect(fetchRoom).toHaveBeenCalledOnce();
    await written;
    expect(writeCache).toHaveBeenCalledWith(view);
  });

  it('warms the cache again on a later open of the same Room', async () => {
    const view = { room: { id: 'room-a' } } as RoomView;
    const fetchRoom = vi.fn(async () => view);
    const writeCache = vi.fn(async () => undefined);
    beginRoomOpenPrefetch('room-a', fetchRoom, writeCache);
    await vi.waitFor(() => expect(writeCache).toHaveBeenCalledTimes(1));
    beginRoomOpenPrefetch('room-a', fetchRoom, writeCache);
    await vi.waitFor(() => expect(writeCache).toHaveBeenCalledTimes(2));
    expect(fetchRoom).toHaveBeenCalledTimes(2);
  });

  it('dispatches navigation without evaluating a chrome import on the tap', () => {
    const prefetch = vi.fn();
    const navigate = vi.fn();
    const started = Date.now();
    dispatchRoomOpenTap('room-b', {
      prefetch,
      navigate,
    });
    expect(Date.now() - started).toBeLessThan(40);
    expect(prefetch).toHaveBeenCalledWith('room-b');
    expect(navigate).toHaveBeenCalledWith('room-b');
  });
});
