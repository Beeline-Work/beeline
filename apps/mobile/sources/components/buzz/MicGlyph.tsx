import React from 'react';
import Svg, { Line } from 'react-native-svg';

export const MIC_GLYPH_STROKE_WIDTH = 1.6;

/**
 * Glyph A — three vertical strokes, the middle taller.
 * Matches the Level icon from the spec (section 0).
 *
 * When `animating` is true the caller applies a brass pulse to the
 * containing button (motif = working). The strokes themselves are static;
 * the pulse conveys "listening" without needing complex SVG animation.
 */
export function MicGlyph({
  color,
  size = 18,
  animating: _animating,
  testID,
}: {
  color: string;
  size?: number;
  animating?: boolean;
  testID?: string;
}) {
  return (
    <Svg
      accessibilityElementsHidden
      focusable={false}
      height={size}
      testID={testID}
      viewBox="0 0 20 20"
      width={size}
    >
      <Line
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={MIC_GLYPH_STROKE_WIDTH}
        x1="5"
        x2="5"
        y1="8"
        y2="12"
      />
      <Line
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={MIC_GLYPH_STROKE_WIDTH}
        x1="10"
        x2="10"
        y1="5"
        y2="15"
      />
      <Line
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={MIC_GLYPH_STROKE_WIDTH}
        x1="15"
        x2="15"
        y1="7.5"
        y2="12.5"
      />
    </Svg>
  );
}