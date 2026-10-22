import React, { useId } from 'react';
import Svg, { Circle, Defs, Line, Mask, Rect } from 'react-native-svg';
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
          <Rect
            x={2.9}
            y={8.9}
            width={12.5}
            height={10.1}
            rx={2.2}
            fill="black"
            stroke="black"
            strokeWidth={2.2}
          />
          <Line
            x1={9.1}
            y1={8.9}
            x2={9.1}
            y2={7.2}
            stroke="black"
            strokeWidth={strokeWidth + 2.2}
          />
          <Circle cx={9.1} cy={6.9} r={2.1} fill="black" stroke="none" />
        </Mask>
      </Defs>
      <Circle cx={15.8} cy={9.1} r={5} mask={`url(#${maskId})`} />
      <Line x1={9.1} y1={8.9} x2={9.1} y2={7.2} />
      <Circle cx={9.1} cy={6.9} r={1} fill={color} stroke="none" />
      <Rect x={2.9} y={8.9} width={12.5} height={10.1} rx={2.2} />
      <Circle cx={6.5} cy={13.9} r={0.85} fill={color} stroke="none" />
      <Circle cx={11.7} cy={13.9} r={0.85} fill={color} stroke="none" />
    </Svg>
  );
}
