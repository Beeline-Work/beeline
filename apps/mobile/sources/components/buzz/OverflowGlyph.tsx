import React from 'react';
import Svg, { Circle } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';
import { CHROME_STROKE_REF_SIZE } from './MembersGlyph';

/**
 * The overflow mark, drawn rather than typed. `•••` sat its ink below its own
 * line-box centre, which is what the corner sigil beside it used to be nudged
 * down to meet. Three circles on the box's centre line need no such deal:
 * both marks are now centred on their own fixed boxes, so they are level with
 * each other because of where they are drawn, not because of a constant.
 */
const DOT_RADIUS = 1.9;
const DOT_PITCH = 6.4;
const CENTRE = 12;

/** The Room header's overflow control: a wide short row of three dots. */
export function OverflowGlyph({
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
      {[-DOT_PITCH, 0, DOT_PITCH].map((offset) => (
        <Circle
          cx={CENTRE + offset}
          cy={CENTRE}
          fill={color}
          key={offset}
          r={DOT_RADIUS * (CHROME_STROKE_REF_SIZE / size)}
        />
      ))}
    </Svg>
  );
}
