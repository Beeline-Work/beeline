import { describe, expect, it, vi } from 'vitest';
import { selectDesktopWorkCorner, subscribeDesktopWorkCorner } from './desktop-work-pane';

describe('desktop work pane selection', () => {
  it('delivers a selected corner without changing the Room route', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDesktopWorkCorner(listener);
    selectDesktopWorkCorner({ roomId: 'room-1', cornerId: 'corner-1' });
    expect(listener).toHaveBeenCalledWith({ roomId: 'room-1', cornerId: 'corner-1' });
    unsubscribe();
  });
});
