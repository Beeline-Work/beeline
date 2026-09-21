import React from 'react';
import Svg, { Polygon } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';
import { MEMBERS_GLYPH_STROKE_WIDTH } from './MembersGlyph';

/**
 * The corner sigil, drawn rather than typed. `◇` is not in Space Grotesk, so
 * the character painted from whatever fallback face the device happened to
 * carry, at whatever height that face put it — which is what the header's
 * eyeballed vertical correction was paying for. A shape in a fixed box is
 * centred on the box by construction, so it sits level with the overflow mark
 * beside it with nothing to tune.
 *
 * The extent is 15 of the 24 viewBox, which at the 16px header size draws the
 * ~10px mark the character's ~0.6em drew: optically the same mark-size as the
 * overflow dots (captain, 2026-09-20).
 */
const DIAMOND_EXTENT = 15;
const CENTRE = 12;
const REACH = DIAMOND_EXTENT / 2;
const DIAMOND_POINTS = [
  `${CENTRE} ${CENTRE - REACH}`,
  `${CENTRE + REACH} ${CENTRE}`,
  `${CENTRE} ${CENTRE + REACH}`,
  `${CENTRE - REACH} ${CENTRE}`,
].join(' ');

/** The Room header's corners door: a hollow diamond, stroke only. */
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
      <Polygon
        fill="none"
        points={DIAMOND_POINTS}
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={MEMBERS_GLYPH_STROKE_WIDTH}
      />
    </Svg>
  );
}
