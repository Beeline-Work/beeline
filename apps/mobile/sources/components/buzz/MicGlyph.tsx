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

/** The composer's other controls, drawn on the microphone's canvas and stroke. */
export const COMPOSER_GLYPH_SIZE = 20;

function StrokeGlyph({ color, testID, size = COMPOSER_GLYPH_SIZE, children }: { color: string; testID?: string; size?: number; children: React.ReactNode }) {
  return <Svg {...DECORATIVE_GLYPH_PROPS} width={size} height={size}
    viewBox="0 0 20 20" testID={testID} fill="none" stroke={color} strokeWidth={MIC_GLYPH_STROKE_WIDTH}
    strokeLinecap="round" strokeLinejoin="round">
    {children}
  </Svg>;
}

/** Viewer conversation, shared by the dock and message provenance. */
export function ConversationGlyph({ color, testID, size }: { color: string; testID?: string; size?: number }) {
  return <StrokeGlyph color={color} testID={testID} size={size}>
    <Path d="M4 3h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9.5L6 17v-3H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
  </StrokeGlyph>;
}

/** Attach. */
export function PlusGlyph({ color, testID }: { color: string; testID?: string }) {
  return <StrokeGlyph color={color} testID={testID}><Path d="M10 4v12M4 10h12" /></StrokeGlyph>;
}

/** Send. */
export function ArrowUpGlyph({ color, testID }: { color: string; testID?: string }) {
  return <StrokeGlyph color={color} testID={testID}><Path d="M10 16V4M5 9l5-5 5 5" /></StrokeGlyph>;
}

/** Stop a take: an outlined rounded square. */
export function StopGlyph({ color, testID, filled = false }: { color: string; testID?: string; filled?: boolean }) {
  return <StrokeGlyph color={color} testID={testID}><Rect x={filled ? 2 : 6} y={filled ? 2 : 6} width={filled ? 16 : 8} height={filled ? 16 : 8} rx="2" fill={filled ? color : 'none'} stroke={filled ? 'none' : color} /></StrokeGlyph>;
}

/**
 * A microphone: capsule, pickup arc and stand. It stays still in every
 * state; while dictating, the composer's waveform shows that the take is live.
 */
export function MicGlyph({
  color,
  size = 18,
  testID,
  muted = false,
}: {
  color: string;
  muted?: boolean;
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
      {muted && <Path d="M3 3l14 14" stroke={color} strokeWidth={MIC_GLYPH_STROKE_WIDTH} strokeLinecap="round" />}
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
