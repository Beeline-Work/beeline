import React from 'react';
import Svg, { Circle, Polygon } from 'react-native-svg';
import brand from '@/buzz/brand.json';

export const MEMBERS_GLYPH_STROKE_WIDTH = 1.25;

/**
 * The shared Members type mark: an open head circle on a wide body triangle.
 * The apex sits on the circle, slightly left of centre, so the right edge is
 * the long one — the captain's sketch, not a generic user icon.
 */
export function MembersGlyph({
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
      accessibilityElementsHidden
      focusable={false}
      height={size}
      testID={testID}
      viewBox="0 0 24 24"
      width={size}
    >
      <Circle
        cx="12"
        cy="7.85"
        fill="none"
        r="5.45"
        stroke={color}
        strokeWidth={MEMBERS_GLYPH_STROKE_WIDTH}
      />
      <Polygon
        fill="none"
        points="10.75 13.14 21.8 20.9 3.5 20.9"
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={MEMBERS_GLYPH_STROKE_WIDTH}
      />
    </Svg>
  );
}
