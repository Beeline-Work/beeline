import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import brand from '@/buzz/brand.json';
import { chromeStrokeWidth } from './MembersGlyph';

/** The open box, then the tray's lip: a floor with a dip where things land. */
const BOX = 'M4.5 5.5h15v13h-15z';
const LIP = 'M4.5 14h4l2 3h3l2-3h4';

/**
 * The Room-list tray mark: the one way into Needs you and Saved, sized and
 * stroked as chrome next to MembersGlyph. Selected fills the box and cuts the
 * lip out of it in `cutColor`, the surface the mark sits on.
 */
export function TrayGlyph({
  color = brand.mark,
  cutColor,
  filled = false,
  size = 24,
  testID,
}: {
  color?: string;
  cutColor?: string;
  filled?: boolean;
  size?: number;
  testID?: string;
}) {
  const strokeWidth = chromeStrokeWidth(size);
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      height={size}
      testID={testID}
      viewBox="0 0 24 24"
      width={size}
    >
      <Path
        d={BOX}
        fill={filled && cutColor ? color : 'none'}
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
      <Path
        d={LIP}
        fill="none"
        stroke={filled && cutColor ? cutColor : color}
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </Svg>
  );
}
