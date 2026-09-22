import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_FLASH_FADE_MS,
  ARRIVAL_FLASH_HOLD_MS,
  arrivalFlashTiming,
  landingFlashesArrival,
} from './room-arrival-flash';

describe('the arrival flash', () => {
  it('CHEV-17: holds then fades once, and still holds under reduce-motion', () => {
    expect(arrivalFlashTiming(false)).toEqual({
      holdMs: ARRIVAL_FLASH_HOLD_MS,
      fadeMs: ARRIVAL_FLASH_FADE_MS,
      totalMs: ARRIVAL_FLASH_HOLD_MS + ARRIVAL_FLASH_FADE_MS,
    });
    // Reduce-motion drops the fade and keeps the hold: degrading to no flash
    // at all would take the pointer from the readers most likely to need it.
    expect(arrivalFlashTiming(true)).toEqual({
      holdMs: ARRIVAL_FLASH_HOLD_MS,
      fadeMs: 0,
      totalMs: ARRIVAL_FLASH_HOLD_MS,
    });
    expect(arrivalFlashTiming(true).holdMs).toBeGreaterThan(0);
  });

  it('CHEV-18: flashes the explicit jump and nothing else', () => {
    // The notification's own target row.
    expect(
      landingFlashesArrival({ landedBoundaryId: 'msg-9', messageAnchorId: 'msg-9' }),
    ).toBe(true);

    // An ordinary first-unread landing has no anchor behind it. Flashing here
    // would put a highlight on every Room open, and the NEW MESSAGES divider
    // already says where the unread run starts.
    expect(landingFlashesArrival({ landedBoundaryId: 'msg-9', messageAnchorId: null })).toBe(false);
    // A landing on some other row while an anchor exists is not the arrival.
    expect(
      landingFlashesArrival({ landedBoundaryId: 'unread-1', messageAnchorId: 'msg-9' }),
    ).toBe(false);
    expect(landingFlashesArrival({ landedBoundaryId: null, messageAnchorId: 'msg-9' })).toBe(false);
    expect(landingFlashesArrival({ landedBoundaryId: null, messageAnchorId: null })).toBe(false);
  });
});
