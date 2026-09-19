import { describe, expect, it, vi } from 'vitest';
import type { RoomView } from '@beeline/buzz-client';

import {
  beginRoomOpenPrefetch,
  dispatchRoomOpenTap,
  roomOpenPixelSeed,
  seedRoomOpenPixel,
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

  it('seeds the newest deck line for the first Room frame', () => {
    seedRoomOpenPixel('room-a', 'PIXEL-450 NEWEST ROW');
    expect(roomOpenPixelSeed('room-a')).toBe('PIXEL-450 NEWEST ROW');
    expect(roomOpenPixelSeed('room-b')).toBeNull();
  });

  it('dispatches navigation without evaluating the chrome module', () => {
    const prefetch = vi.fn();
    const navigate = vi.fn();
    dispatchRoomOpenTap('room-b', 'newest line', { prefetch, navigate });
    expect(roomOpenPixelSeed('room-b')).toBe('newest line');
    expect(prefetch).toHaveBeenCalledWith('room-b');
    expect(navigate).toHaveBeenCalledWith('room-b');
  });
});
