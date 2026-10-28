import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import { chromeStrokeWidth } from './MembersGlyph';

/**
 * The shared "leaves Beeline" mark: an open box with an arrow out of its
 * corner, drawn as a shape. It replaces the typed `↗`, which came from
 * whatever fallback face the platform picked and sat off the label baseline.
 * In-app destinations use `ChevronGlyph` instead.
 */
export function ExternalGlyph({ color, size = 14, testID }: { color: string; size?: number; testID?: string }) {
  const strokeWidth = chromeStrokeWidth(size);
  const line = { fill: 'none', stroke: color, strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth } as const;
  return (
    <Svg {...DECORATIVE_GLYPH_PROPS} height={size} testID={testID} viewBox="0 0 24 24" width={size}>
      <Path d="M19 13.5V19H5V5h5.5" {...line} />
      <Path d="M14 4h6v6" {...line} />
      <Path d="M20 4l-9 9" {...line} />
    </Svg>
  );
}
