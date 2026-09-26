/**
 * Where a first-sight spotlight draws, in window coordinates: the cutout
 * around the real target (padded, clamped to the window) and the tip card
 * beside it — below when it fits, otherwise above, otherwise pinned to the
 * bottom safe edge. Pure, so the whole placement is tested without a device.
 */
export type TourRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};
export type TourInsets = {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
};

export const TOUR_CUTOUT_PADDING = 6;
export const TOUR_GUTTER = 16;
export const TOUR_TIP_MAX_WIDTH = 320;
export const TOUR_TIP_GAP = 12;

export type SpotlightLayout = {
  readonly cutout: TourRect;
  readonly tip: { readonly left: number; readonly top: number; readonly width: number };
  readonly placement: 'below' | 'above' | 'pinned';
};

export function hasArea(rect: TourRect | null | undefined): rect is TourRect {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

export function spotlightLayout(
  target: TourRect,
  window: { readonly width: number; readonly height: number },
  tipHeight: number,
  insets: TourInsets,
): SpotlightLayout {
  const left = Math.max(0, target.x - TOUR_CUTOUT_PADDING);
  const top = Math.max(0, target.y - TOUR_CUTOUT_PADDING);
  const right = Math.min(window.width, target.x + target.width + TOUR_CUTOUT_PADDING);
  const bottom = Math.min(window.height, target.y + target.height + TOUR_CUTOUT_PADDING);
  const cutout = {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };

  const minLeft = insets.left + TOUR_GUTTER;
  const maxRight = window.width - insets.right - TOUR_GUTTER;
  const width = Math.max(0, Math.min(TOUR_TIP_MAX_WIDTH, maxRight - minLeft));
  const centered = cutout.x + cutout.width / 2 - width / 2;
  const tipLeft = Math.min(Math.max(centered, minLeft), Math.max(minLeft, maxRight - width));

  const safeTop = insets.top + TOUR_GUTTER;
  const safeBottom = window.height - insets.bottom - TOUR_GUTTER;
  const below = cutout.y + cutout.height + TOUR_TIP_GAP;
  if (below + tipHeight <= safeBottom)
    return { cutout, tip: { left: tipLeft, top: below, width }, placement: 'below' };
  const above = cutout.y - TOUR_TIP_GAP - tipHeight;
  if (above >= safeTop)
    return { cutout, tip: { left: tipLeft, top: above, width }, placement: 'above' };
  return {
    cutout,
    tip: { left: tipLeft, top: Math.max(safeTop, safeBottom - tipHeight), width },
    placement: 'pinned',
  };
}
