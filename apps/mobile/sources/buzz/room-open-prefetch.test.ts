import { describe, expect, it, vi } from 'vitest';

import { dispatchRoomOpenTap } from './room-open-prefetch';

describe('room-open tap', () => {
  it('dispatches navigation without evaluating a chrome import on the tap', () => {
    const navigate = vi.fn();
    const started = Date.now();
    dispatchRoomOpenTap('room-b', { navigate });
    expect(Date.now() - started).toBeLessThan(40);
    expect(navigate).toHaveBeenCalledWith('room-b');
  });
});
