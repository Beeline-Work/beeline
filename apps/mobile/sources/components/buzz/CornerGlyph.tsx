import React from 'react';
import Svg, { Polygon } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';

/**
 * The corner sigil, drawn rather than typed. Neither `◇` nor `└` is in Space
 * Grotesk, so a typed mark painted from whatever fallback face the device
 * happened to carry, at whatever height that face put it — which is what the
 * header's eyeballed vertical correction was paying for. A shape in a fixed
 * box is centred on the box by construction, so it sits level with the
 * overflow mark beside it with nothing to tune.
 *
 * A square frame slashed corner to corner, bottom-left half kept: one filled
 * polygon whose cut ends land on the diagonal, so each arm is full thickness
 * at the elbow and tapers to a point. Extent is 15 of the 24 viewBox — the
 * same relationship the retired diamond used so the header mark stays
 * optically the same size as the overflow mark beside it. Thickness is a
 * named placeholder until the board pick lands; do not invent another number.
 */
const VIEWBOX = 24;
/** Outer painted square, same 15-of-24 as the retired `DIAMOND_EXTENT`. */
export const CORNER_EXTENT = 15;
/** Band thickness. Placeholder until the board pick lands. */
export const CORNER_THICKNESS = 4.5;

const OUTER = (VIEWBOX - CORNER_EXTENT) / 2;
const FAR = VIEWBOX - OUTER;
const CORNER_POINTS = [
  `${OUTER} ${OUTER}`,
  `${OUTER} ${FAR}`,
  `${FAR} ${FAR}`,
  `${FAR - CORNER_THICKNESS} ${FAR - CORNER_THICKNESS}`,
  `${OUTER + CORNER_THICKNESS} ${FAR - CORNER_THICKNESS}`,
  `${OUTER + CORNER_THICKNESS} ${OUTER + CORNER_THICKNESS}`,
].join(' ');

/** Inline next to `type.meta` (bookmarks origin, Room-list tray). */
export const CORNER_META_SIZE = 13;
/** Inline next to the write-permission status line. */
export const CORNER_STATUS_SIZE = 11;

/** The shared corner mark: a filled slashed-frame polygon. */
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
      <Polygon fill={color} points={CORNER_POINTS} />
    </Svg>
  );
}
