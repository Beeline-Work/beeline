import React from 'react';
import Svg, { Polygon } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';

/**
 * "This message continues in a corner": the corner sigil's elbow, turned
 * into a drop-down. Where `CornerGlyph` is a closed slashed frame (a place),
 * this is a path out of the line above — a stem falling from the message,
 * turning at the same elbow and ending in an arrowhead that points into the
 * corner. One filled polygon, the stem's top cut on the diagonal the way the
 * corner mark's arms are cut, in brand.json mark gold like the corner mark,
 * so the two read as one family and never as the same mark.
 */
const VIEWBOX = 24;
/** Stem and arm thickness; lighter than the corner's 4.5 so the arrow leads. */
export const CORNER_BRANCH_THICKNESS = 3;
/** Stem x, arm y (its top edge), and arrow tip x, in viewBox units. */
const STEM = 5;
const ARM = 14.5;
const TIP = 19;
/** Arrowhead half-height beyond the arm's own edges. */
const BARB = 3;

const ARROW_BASE = TIP - 6;
export const CORNER_BRANCH_POINTS = [
  `${STEM} 3.5`,
  `${STEM + CORNER_BRANCH_THICKNESS} ${3.5 + CORNER_BRANCH_THICKNESS}`,
  `${STEM + CORNER_BRANCH_THICKNESS} ${ARM}`,
  `${ARROW_BASE} ${ARM}`,
  `${ARROW_BASE} ${ARM - BARB}`,
  `${TIP} ${ARM + CORNER_BRANCH_THICKNESS / 2}`,
  `${ARROW_BASE} ${ARM + CORNER_BRANCH_THICKNESS + BARB}`,
  `${ARROW_BASE} ${ARM + CORNER_BRANCH_THICKNESS}`,
  `${STEM} ${ARM + CORNER_BRANCH_THICKNESS}`,
].join(' ');

/** Inline beside `type.meta`: the corner mark's default box, so the arrow reads at a glance. */
export const CORNER_BRANCH_SIZE = 16;

export function CornerBranchGlyph({
  color = brand.mark,
  size = CORNER_BRANCH_SIZE,
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
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      width={size}
    >
      <Polygon fill={color} points={CORNER_BRANCH_POINTS} />
    </Svg>
  );
}
