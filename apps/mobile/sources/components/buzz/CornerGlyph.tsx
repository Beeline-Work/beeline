import React from 'react';
import Svg, { Line } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';
import { chromeStrokeWidth } from './MembersGlyph';

/**
 * The corner sigil, drawn rather than typed. Neither `◇` nor `└` is in Space
 * Grotesk, so a typed mark painted from whatever fallback face the device
 * happened to carry, at whatever height that face put it — which is what the
 * header's eyeballed vertical correction was paying for. A shape in a fixed
 * box is centred on the box by construction, so it sits level with the
 * overflow mark beside it with nothing to tune.
 *
 * The extent is 15 of the 24 viewBox, which at the 16px header size drew the
 * ~10px mark the character's ~0.6em drew: optically the same mark-size as the
 * overflow dots. The header now draws at 28; the same 15-of-24 fraction keeps
 * this mark optically the same size as the overflow mark beside it.
 *
 * Two strokes meeting at the bottom left: the box-drawing corner the Room
 * list already read as the kind mark, never a diamond.
 */
const CORNER_EXTENT = 15;
const CENTRE = 12;
const REACH = CORNER_EXTENT / 2;
const LEFT = CENTRE - REACH;
const RIGHT = CENTRE + REACH;
const TOP = CENTRE - REACH;
const BOTTOM = CENTRE + REACH;

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
        x1={LEFT}
        x2={LEFT}
        y1={TOP}
        y2={BOTTOM}
      />
      <Line
        stroke={color}
        strokeLinecap="butt"
        strokeWidth={chromeStrokeWidth(size)}
        x1={LEFT}
        x2={RIGHT}
        y1={BOTTOM}
        y2={BOTTOM}
      />
    </Svg>
  );
}
