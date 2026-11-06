import beelineMark from './beeline-mark.json';
import brand from './brand.json';

/** The square the thinking mark sits in: as tall as the 12px mono label's 18px line. */
export const MARK_CELL = 18;
/** In-app load gates: larger than the thinking cell, smaller than the splash. */
export const SURFACE_GLYPH_SIZE = 48;
/** Fraction of the cell the mark's height takes — the optical size of the label's glyphs. */
const MARK_CELL_FILL = 13 / 18;
/** Stroke width in path units while the glyph is painting. */
export const GLYPH_STROKE = 7;

/** Splash paints once. Completion is honest: loading ends. */
export const SPLASH_PAINT_MS = 900;
/** Thinking paints, then immediately releases. It never holds the completed stroke. */
export const RELEASE_PAINT_MS = 720;
export const RELEASE_UNWIND_MS = 880;
/** Brief rest at empty so the loop returns to nothing instead of restarting at the finish. */
export const RELEASE_REST_MS = 280;

/**
 * Icon artwork colours, not the UI accent. Brass on aubergine is the dark icon;
 * ink on cream is the light icon, because brass on cream is weak.
 */
export const GLYPH_PAINT = {
  darkGround: '#14091A',
  lightGround: '#F3EEE4',
  darkInk: brand.mark,
  lightInk: '#171310',
} as const;

export function glyphPaintInk(dark: boolean): string {
  return dark ? GLYPH_PAINT.darkInk : GLYPH_PAINT.lightInk;
}

/**
 * The shipped mark is one closed polyline — the outline of a continuous ribbon.
 * `cell` crops to the mark so it fills the thinking line's 18px square.
 * `icon` keeps the 240-unit canvas and inset transform the launcher splash uses.
 */
export const ribbon = (() => {
  const points = Array.from(
    beelineMark.path.matchAll(/[ML]\s*([\d.]+)\s+([\d.]+)/g),
    ([, x, y]) => [Number(x), Number(y)] as const,
  );
  let length = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  points.forEach(([x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length]!;
    length += Math.hypot(nextX - x, nextY - y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  const side = Math.max(maxX - minX, maxY - minY) / MARK_CELL_FILL;
  const originX = (minX + maxX - side) / 2;
  const originY = (minY + maxY - side) / 2;
  return {
    path: beelineMark.path,
    length,
    fillRule: beelineMark.fillRule,
    transform: beelineMark.transform,
    iconViewBox: beelineMark.viewBox,
    cellInkInset: ((minX - originX) / side) * MARK_CELL,
    cellViewBox: `${originX.toFixed(3)} ${originY.toFixed(3)} ${side.toFixed(3)} ${side.toFixed(3)}`,
  };
})();

export type GlyphPaintFraming = 'icon' | 'cell';

export function glyphViewBox(framing: GlyphPaintFraming): string {
  return framing === 'icon' ? ribbon.iconViewBox : ribbon.cellViewBox;
}
