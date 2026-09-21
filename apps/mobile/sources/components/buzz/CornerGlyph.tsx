import React from 'react';
import Svg, { Line } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';
import { CHROME_STROKE_REF_SIZE, chromeStrokeWidth } from './MembersGlyph';

/**
 * The corner sigil, drawn rather than typed. Neither `◇` nor `└` is in Space
 * Grotesk, so a typed mark painted from whatever fallback face the device
 * happened to carry, at whatever height that face put it — which is what the
 * header's eyeballed vertical correction was paying for. A shape in a fixed
 * box is centred on the box by construction, so it sits level with the
 * overflow mark beside it with nothing to tune.
 *
 * The extent is 15 of the 24 viewBox at the 16px size that first matched the
 * overflow dots (~10px painted, the character's ~0.6em). The header now draws
 * at 28; the overflow holds its painted radius to that 16px weight, so this
 * mark holds the same ~10px painted extent instead of growing with the box.
 * Inline sizes (13, 11) stay on 15-of-24.
 *
 * Two strokes meeting at the bottom left: the box-drawing corner the Room
 * list already read as the kind mark, never a diamond.
 */
const CORNER_EXTENT_AT_16 = 15;

/** ViewBox extent that keeps the 16px painted arm at `size`, capped at 15. */
function cornerExtent(size: number): number {
  return Math.min(CORNER_EXTENT_AT_16, CORNER_EXTENT_AT_16 * (CHROME_STROKE_REF_SIZE / size));
}

/** Inline next to `type.meta` (bookmarks origin, Room-list tray). */
export const CORNER_META_SIZE = 13;
/** Inline next to the write-permission status line. */
export const CORNER_STATUS_SIZE = 11;

/** The shared corner mark: two strokes meeting at the bottom left. */
export function CornerGlyph({
  color = brand.mark,
  size = 16,
  testID,
}: {
  color?: string;
  size?: number;
  testID?: string;
}) {
  const extent = cornerExtent(size);
  const reach = extent / 2;
  const left = 12 - reach;
  const right = 12 + reach;
  const top = 12 - reach;
  const bottom = 12 + reach;
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      height={size}
      testID={testID}
      viewBox="0 0 24 24"
      width={size}
    >
      <Line
        stroke={color}
        strokeLinecap="butt"
        strokeWidth={chromeStrokeWidth(size)}
        x1={left}
        x2={left}
        y1={top}
        y2={bottom}
      />
      <Line
        stroke={color}
        strokeLinecap="butt"
        strokeWidth={chromeStrokeWidth(size)}
        x1={left}
        x2={right}
        y1={bottom}
        y2={bottom}
      />
    </Svg>
  );
}
