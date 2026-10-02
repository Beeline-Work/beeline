import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import {
  continueScrubLanding,
  SCRUB_LANDING_STALLS,
  scrollBarPosition,
  scrubDate,
  scrubOffset,
} from './transcript-scrubber';

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = originalTz;
});

const at = (iso: string) => Date.parse(iso) / 1_000;
const row = (id: string, timestamp: number): ChatDisplayMessage => ({
  id,
  text: id,
  isUser: false,
  timestamp,
});

describe('transcript scroll bar', () => {
  it('places the thumb by the list offset over the loaded rows', () => {
    const metrics = { offset: 0, contentHeight: 5_600, viewportHeight: 600 };
    expect(scrollBarPosition(metrics)).toBe(0);
    expect(scrollBarPosition({ ...metrics, offset: 2_500 })).toBe(0.5);
    // Scrolled to the oldest loaded row: the thumb is at the top.
    expect(scrollBarPosition({ ...metrics, offset: 5_000 })).toBe(1);
    // Native overscroll stays on the rail.
    expect(scrollBarPosition({ ...metrics, offset: -40 })).toBe(0);
    expect(scrollBarPosition({ ...metrics, offset: 5_100 })).toBe(1);
  });

  it('has no thumb when the loaded rows fit on screen', () => {
    expect(scrollBarPosition({ offset: 0, contentHeight: 400, viewportHeight: 600 })).toBeNull();
  });

  it('maps a dragged thumb back to a list offset', () => {
    const metrics = { offset: 0, contentHeight: 5_600, viewportHeight: 600 };
    expect(scrubOffset(metrics, 0)).toBe(0);
    expect(scrubOffset(metrics, 0.25)).toBe(1_250);
    expect(scrubOffset(metrics, 1)).toBe(5_000);
    expect(scrubOffset(metrics, 1.4)).toBe(5_000);
  });

  it('names the day of the oldest message on screen', () => {
    expect(
      scrubDate([
        row('b', at('2026-09-02T09:00:00Z')),
        row('a', at('2026-08-30T23:10:00Z')),
        row('c', at('2026-09-02T10:00:00Z')),
      ]),
    ).toBe('SUN 30 AUG');
    expect(scrubDate([])).toBeNull();
  });

  it('keeps landing on a distant scrubbed row while each attempt measures further', () => {
    // As recorded on the Android emulator: the scrubbed row is index 330 and
    // native measures about ten rows further per attempt, sometimes none.
    const target = 330;
    let highest = 85;
    const landing = { messageId: 'm1', highestMeasured: -1, stalls: 0, failures: 0 };
    let attempt = 0;
    while (highest < target) {
      expect(continueScrubLanding(landing, highest)).toBe(true);
      attempt += 1;
      if (attempt % 3 !== 0) highest += 10;
    }
    expect(landing.failures).toBeGreaterThan(30);
  });

  it('gives a scrubbed landing up once attempts stop measuring further', () => {
    const landing = { messageId: 'm1', highestMeasured: -1, stalls: 0, failures: 0 };
    expect(continueScrubLanding(landing, 40)).toBe(true);
    for (let stall = 1; stall <= SCRUB_LANDING_STALLS; stall += 1) {
      expect(continueScrubLanding(landing, 40)).toBe(true);
    }
    expect(continueScrubLanding(landing, 40)).toBe(false);
  });
});
