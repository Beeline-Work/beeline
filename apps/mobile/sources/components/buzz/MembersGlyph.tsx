import React from 'react';
import Svg, { Circle, Polygon } from 'react-native-svg';
import brand from '@/buzz/brand.json';

/**
 * Header chrome shares a 24 viewBox with RoomGlyph. 1.75 is the FAB chrome
 * stroke in that viewBox; at the 16px header size it paints ~1.17px, in the
 * same band as the Ionicons header peers.
 */
export const MEMBERS_GLYPH_STROKE_WIDTH = 1.75;

const HEAD_CX = 12;
const HEAD_CY = 7.85;
const HEAD_R = 5.45;
/** Apex sits on the head circle at the bottom centre. */
const APEX_X = HEAD_CX;
const APEX_Y = HEAD_CY + HEAD_R;
/**
 * Right-isosceles body: equal legs from the apex, 90° at the apex, horizontal
 * base. The vertical drop equals the half-width so the legs are perpendicular.
 */
const LEG = 7.6;
const BODY_POINTS = `${APEX_X} ${APEX_Y} ${APEX_X + LEG} ${APEX_Y + LEG} ${APEX_X - LEG} ${APEX_Y + LEG}`;

/**
 * The shared Members type mark: an open head circle on a right-isosceles
 * body triangle. Stroke-only, no fill, no second person.
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
        cx={HEAD_CX}
        cy={HEAD_CY}
        fill="none"
        r={HEAD_R}
        stroke={color}
        strokeWidth={MEMBERS_GLYPH_STROKE_WIDTH}
      />
      <Polygon
        fill="none"
        points={BODY_POINTS}
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={MEMBERS_GLYPH_STROKE_WIDTH}
      />
    </Svg>
  );
}
