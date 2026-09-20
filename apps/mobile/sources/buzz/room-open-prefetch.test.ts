import { describe, expect, it, vi } from 'vitest';
import type { RoomView } from '@beeline/buzz-client';

import {
  beginRoomOpenPrefetch,
  dispatchRoomOpenTap,
  takeRoomOpenPrefetch,
} from './room-open-prefetch';

describe('room-open prefetch', () => {
  it('overlaps one GET with navigation and is consumed once', async () => {
    const view = { room: { id: 'room-a' } } as RoomView;
    const fetchRoom = vi.fn(async () => view);
    const writeCache = vi.fn(async () => undefined);
    beginRoomOpenPrefetch('room-a', fetchRoom, writeCache);
    beginRoomOpenPrefetch('room-a', fetchRoom, writeCache);
    expect(fetchRoom).toHaveBeenCalledOnce();
    const taken = takeRoomOpenPrefetch('room-a');
    expect(taken).not.toBeNull();
    await expect(taken).resolves.toBe(view);
    expect(writeCache).toHaveBeenCalledWith(view);
    expect(takeRoomOpenPrefetch('room-a')).toBeNull();
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
