import React from 'react';
import Svg, { Polygon } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';
import { chromeStrokeWidth } from './MembersGlyph';

const BOX = 24;
const CENTRE = BOX / 2;
const LEFT = 6.25;
const RIGHT = 17.75;
const TOP = 3.25;
const BOTTOM = 20.75;
/** Where the notch's apex sits, measured from the top of the box. */
const NOTCH_APEX = 16.65;

/**
 * The notch cuts ink out of the bottom of the silhouette, so a bookmark whose
 * BOX is centred reads high: its ink is not. The consumer used to pay for that
 * with a 1px downward nudge on the mark's container, tuned by eye. The same
 * correction belongs to the drawing, and it is not a guess — the ink's
 * centroid is the rectangle's less the triangle the notch removes, and the
 * shape is placed so that centroid lands on the box centre.
 */
const WIDTH = RIGHT - LEFT;
const RECT_AREA = WIDTH * (BOTTOM - TOP);
const RECT_CENTROID_Y = (TOP + BOTTOM) / 2;
const NOTCH_AREA = (WIDTH * (BOTTOM - NOTCH_APEX)) / 2;
const NOTCH_CENTROID_Y = (BOTTOM + BOTTOM + NOTCH_APEX) / 3;
const INK_CENTROID_Y =
  (RECT_AREA * RECT_CENTROID_Y - NOTCH_AREA * NOTCH_CENTROID_Y) / (RECT_AREA - NOTCH_AREA);
const BALANCE = CENTRE - INK_CENTROID_Y;

const POINTS = [
  `${LEFT} ${TOP + BALANCE}`,
  `${RIGHT} ${TOP + BALANCE}`,
  `${RIGHT} ${BOTTOM + BALANCE}`,
  `${CENTRE} ${NOTCH_APEX + BALANCE}`,
  `${LEFT} ${BOTTOM + BALANCE}`,
].join(' ');

/**
 * The Room-list bookmarks mark, sized and stroked as chrome next to MembersGlyph.
 */
export function BookmarksGlyph({
  color = brand.mark,
  size = 24,
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
      viewBox={`0 0 ${BOX} ${BOX}`}
      width={size}
    >
      <Polygon
        fill="none"
        points={POINTS}
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={chromeStrokeWidth(size)}
      />
    </Svg>
  );
}
