import React, { useId } from 'react';
import Svg, { Circle, Defs, Mask, Rect } from 'react-native-svg';
import brand from '@/buzz/brand.json';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import { chromeStrokeWidth } from './MembersGlyph';

/** A person behind an agent, with transparent separation at their overlap. */
export function MembersAgentsGlyph({
  color = brand.mark,
  size = 24,
  testID,
}: {
  color?: string;
  size?: number;
  testID?: string;
}) {
  const maskId = `members-heads-${useId().replace(/:/g, '')}`;
  const strokeWidth = chromeStrokeWidth(size);
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      height={size}
      width={size}
      viewBox="0 0 24 24"
      testID={testID}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      <Defs>
        <Mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={24} height={24}>
          <Rect x={0} y={0} width={24} height={24} fill="white" stroke="none" />
          <Rect x={2.2} y={8.6} width={12.2} height={11.2} rx={3.5}
            fill="black" stroke="black" strokeWidth={strokeWidth + 2.6} />
        </Mask>
      </Defs>
      <Circle cx={16.9} cy={8.6} r={4.9 + strokeWidth / 2}
        fill={color} stroke="none" mask={`url(#${maskId})`} />
      <Rect x={2.2} y={8.6} width={12.2} height={11.2} rx={3.5} />
      <Rect x={5.65} y={11.9} width={1.8} height={3.9} rx={0.9} fill={color} stroke="none" />
      <Rect x={9.15} y={11.9} width={1.8} height={3.9} rx={0.9} fill={color} stroke="none" />
    </Svg>
  );
}
