import React from 'react';
import Svg, { Line, Path, Rect } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';

export const MIC_GLYPH_STROKE_WIDTH = 1.6;

/** Conversation entry uses the same stroke and canvas as the microphone. */
export function WaveformGlyph({ color }: { color: string }) {
  return <Svg {...DECORATIVE_GLYPH_PROPS} width={20} height={20} viewBox="0 0 20 20">
    <Path d="M2 9v2M6 5v10M10 2v16M14 5v10M18 9v2" fill="none"
      stroke={color} strokeWidth={MIC_GLYPH_STROKE_WIDTH} strokeLinecap="round" />
  </Svg>;
}

/**
 * A microphone: capsule, pickup arc and stand. It stays still in every
 * state; while dictating, the composer's waveform shows that the take is live.
 */
export function MicGlyph({
  color,
  size = 18,
  testID,
}: {
  color: string;
  size?: number;
  testID?: string;
}) {
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      height={size}
      testID={testID}
      viewBox="0 0 20 20"
      width={size}
    >
      <Rect
        fill="none"
        height="9.5"
        rx="2.5"
        stroke={color}
        strokeWidth={MIC_GLYPH_STROKE_WIDTH}
        width="5"
        x="7.5"
        y="2"
      />
      <Path
        d="M4.5 9.5a5.5 5.5 0 0 0 11 0"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={MIC_GLYPH_STROKE_WIDTH}
      />
      <Line
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth={MIC_GLYPH_STROKE_WIDTH}
        x1="10"
        x2="10"
        y1="15"
        y2="18"
      />
    </Svg>
  );
}
