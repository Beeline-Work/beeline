import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CORNER_DRAG_TYPE,
  readDesktopCornerDrag,
  selectDesktopWorkCorner,
  subscribeDesktopWorkCorner,
  writeDesktopCornerDrag,
} from './desktop-work-pane';

describe('desktop work pane selection', () => {
  it('delivers a selected corner without changing the Room route', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDesktopWorkCorner(listener);
    selectDesktopWorkCorner({ roomId: 'room-1', cornerId: 'corner-1' });
    expect(listener).toHaveBeenCalledWith({ roomId: 'room-1', cornerId: 'corner-1' });
    unsubscribe();
  });

  it('round-trips a corner drag payload and rejects malformed drops', () => {
    const payloads = new Map<string, string>();
    const transfer = {
      effectAllowed: 'none',
      setData: (type: string, value: string) => payloads.set(type, value),
      getData: (type: string) => payloads.get(type) ?? '',
    };
    writeDesktopCornerDrag(transfer, { roomId: 'room-1', cornerId: 'corner-1' });
    expect(transfer.effectAllowed).toBe('move');
    expect(readDesktopCornerDrag(transfer)).toEqual({ roomId: 'room-1', cornerId: 'corner-1' });
    payloads.set(DESKTOP_CORNER_DRAG_TYPE, '{broken');
    expect(readDesktopCornerDrag(transfer)).toBeNull();
  });
});
