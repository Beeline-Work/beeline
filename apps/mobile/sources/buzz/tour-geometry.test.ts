import { describe, expect, it } from 'vitest';
import { hasArea, spotlightLayout, TOUR_TIP_MAX_WIDTH } from './tour-geometry';

const insets = { top: 47, bottom: 34, left: 0, right: 0 };
const phone = { width: 390, height: 844 };

describe('spotlight geometry', () => {
  it('pads the cutout around the real target and puts the tip below it', () => {
    const layout = spotlightLayout({ x: 16, y: 120, width: 358, height: 64 }, phone, 150, insets);
    expect(layout.cutout).toEqual({ x: 10, y: 114, width: 370, height: 76 });
    expect(layout.placement).toBe('below');
    expect(layout.tip.top).toBe(114 + 76 + 12);
    expect(layout.tip.width).toBe(TOUR_TIP_MAX_WIDTH);
    expect(layout.tip.left).toBeGreaterThanOrEqual(16);
    expect(layout.tip.left + layout.tip.width).toBeLessThanOrEqual(390 - 16);
  });

  it('flips above a target near the bottom and pins when neither side fits', () => {
    expect(
      spotlightLayout({ x: 16, y: 700, width: 100, height: 44 }, phone, 150, insets).placement,
    ).toBe('above');
    const pinned = spotlightLayout({ x: 0, y: 100, width: 390, height: 640 }, phone, 150, insets);
    expect(pinned.placement).toBe('pinned');
    expect(pinned.tip.top + 150).toBeLessThanOrEqual(844 - 34 - 16);
  });

  it('clamps a cutout to the window and a tip to the gutters on a narrow screen', () => {
    const layout = spotlightLayout(
      { x: -20, y: 10, width: 60, height: 40 },
      { width: 320, height: 640 },
      120,
      { top: 0, bottom: 0, left: 0, right: 0 },
    );
    expect(layout.cutout.x).toBe(0);
    expect(layout.tip.width).toBe(320 - 32);
    expect(layout.tip.left).toBe(16);
  });

  it('re-lays out for a desktop window after a resize', () => {
    const layout = spotlightLayout(
      { x: 76, y: 90, width: 260, height: 36 },
      { width: 1440, height: 900 },
      140,
      {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
      },
    );
    expect(layout.placement).toBe('below');
    expect(layout.tip.left).toBe(76 - 6 + (260 + 12) / 2 - TOUR_TIP_MAX_WIDTH / 2);
  });

  it('treats an unmounted or collapsed target as nothing to point at', () => {
    expect(hasArea(null)).toBe(false);
    expect(hasArea({ x: 0, y: 0, width: 0, height: 20 })).toBe(false);
    expect(hasArea({ x: 0, y: 0, width: 10, height: 20 })).toBe(true);
  });
});
