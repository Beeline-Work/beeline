import React from 'react';
import Svg, { Polygon } from 'react-native-svg';
import brand from '@/buzz/brand.json';
import { MEMBERS_GLYPH_STROKE_WIDTH } from './MembersGlyph';

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
      accessibilityElementsHidden
      focusable={false}
      height={size}
      testID={testID}
      viewBox="0 0 24 24"
      width={size}
    >
      <Polygon
        fill="none"
        points="6.25 3.25 17.75 3.25 17.75 20.75 12 16.65 6.25 20.75"
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={MEMBERS_GLYPH_STROKE_WIDTH}
      />
    </Svg>
  );
}
