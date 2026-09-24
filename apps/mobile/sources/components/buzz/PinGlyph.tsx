import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';

export function PinGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <Svg {...DECORATIVE_GLYPH_PROPS} width={size} height={size} viewBox="0 0 24 24">
      <Path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8" fill="none" stroke={color} strokeWidth={1.6} />
    </Svg>
  );
}
