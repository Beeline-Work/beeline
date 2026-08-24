import React from 'react';
import Svg, { Rect } from 'react-native-svg';
import brand from '@/buzz/brand.json';

export const ROOM_GLYPH_STROKE_WIDTH = 1.25;

/** The shared Room type mark: a plain, thin-stroke square outline. */
export function RoomGlyph({
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
      <Rect
        fill="none"
        height="15"
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={ROOM_GLYPH_STROKE_WIDTH}
        width="15"
        x="4.5"
        y="4.5"
      />
    </Svg>
  );
}
