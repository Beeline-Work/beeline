import React from 'react';
import Svg, { Polyline } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';

/**
 * Header chrome shares a 24 viewBox with RoomGlyph and MembersGlyph. At the
 * 16px chrome size this paints ~1.33px, the same band as its peers.
 */
export const CHEVRON_GLYPH_STROKE_WIDTH = 2;

export type ChevronDirection = 'left' | 'right' | 'up' | 'down';

/**
 * The one size every index/settings/sheet row's disclosure mark draws at.
 * These used to be set in whatever face and size their surface happened to
 * have to hand — 10 in one place, 16 in another — so the same mark read at a
 * different weight on every screen.
 */
export const CHEVRON_ROW_SIZE = 14;

/** The one size every screen's back control draws its chevron at. */
export const CHEVRON_BACK_SIZE = 22;

/**
 * Every chevron's drawn extent is centred on the box centre, so a chevron
 * needs no per-surface nudge to sit level with the mark beside it. The
 * characters these replace (`‹`, `›`, `⌃`, `⌄`) came from whatever face the
 * surface happened to set, which is why the same mark read at a different
 * weight on every screen.
 */
const SHORT = 6;
const LONG = 12;
const CENTRE = 12;
const NEAR = CENTRE - SHORT / 2;
const FAR = CENTRE + SHORT / 2;
const START = CENTRE - LONG / 2;
const END = CENTRE + LONG / 2;

const POINTS: Readonly<Record<ChevronDirection, string>> = {
  right: `${NEAR} ${START} ${FAR} ${CENTRE} ${NEAR} ${END}`,
  left: `${FAR} ${START} ${NEAR} ${CENTRE} ${FAR} ${END}`,
  down: `${START} ${NEAR} ${CENTRE} ${FAR} ${END} ${NEAR}`,
  up: `${START} ${FAR} ${CENTRE} ${NEAR} ${END} ${FAR}`,
};

/**
 * The shared back / disclosure mark: one open chevron, stroke only, drawn as a
 * shape in a fixed box rather than set as a text character.
 */
export function ChevronGlyph({
  color = brand.mark,
  direction = 'right',
  size = 16,
  testID,
}: {
  color?: string;
  direction?: ChevronDirection;
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
      <Polyline
        fill="none"
        points={POINTS[direction]}
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={CHEVRON_GLYPH_STROKE_WIDTH}
      />
    </Svg>
  );
}
