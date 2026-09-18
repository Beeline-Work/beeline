import React from 'react';
import Svg, { Line } from 'react-native-svg';

export const MIC_GLYPH_STROKE_WIDTH = 1.6;

/**
 * Glyph A — three vertical strokes, the middle taller.
 * Matches the Level icon from the spec (section 0).
 *
 * While listening, the three strokes form a small level meter driven by the
 * recognizer's volume events. This is state feedback rather than decoration:
 * a silent microphone stays still and speech moves the mark immediately.
 */
export function MicGlyph({
  color,
  size = 18,
  animating = false,
  level = 0,
  testID,
}: {
  color: string;
  size?: number;
  animating?: boolean;
  level?: number;
  testID?: string;
}) {
  const activity = animating ? Math.max(0, Math.min(1, level)) : 0;
  const leftHalfHeight = 2 + activity * 3;
  const middleHalfHeight = 5 + activity * 3;
  const rightHalfHeight = 2.5 + activity * 4;
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
        y1={10 - leftHalfHeight}
        y2={10 + leftHalfHeight}
      />
      <Line
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={MIC_GLYPH_STROKE_WIDTH}
        x1="10"
        x2="10"
        y1={10 - middleHalfHeight}
        y2={10 + middleHalfHeight}
      />
      <Line
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={MIC_GLYPH_STROKE_WIDTH}
        x1="15"
        x2="15"
        y1={10 - rightHalfHeight}
        y2={10 + rightHalfHeight}
      />
    </Svg>
  );
}
