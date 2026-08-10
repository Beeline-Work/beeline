import React from 'react';
import Svg, { G, Line, Polygon, Rect } from 'react-native-svg';
import { agentAvatarGeometry } from '@/buzz/agent-avatar';
import { groknight } from '@/buzz/groknight';

export function AgentAvatar({ pubkey, size = 52 }: { pubkey: string; size?: number }) {
  const geometry = agentAvatarGeometry(pubkey);
  const inset = geometry.inset;
  const far = 100 - inset;
  const points = `${50},${inset} ${far},${geometry.cut} ${far},${100 - geometry.cut} ${50},${far} ${inset},${100 - geometry.cut} ${inset},${geometry.cut}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityLabel="Agent sigil">
      <Rect
        x="1"
        y="1"
        width="98"
        height="98"
        rx="18"
        fill={groknight.bgHighlight}
        stroke={groknight.border}
        strokeWidth="2"
      />
      <G rotation={geometry.rotation} origin="50, 50">
        <Polygon
          points={points}
          fill={groknight.bgCode}
          stroke={groknight.chrome}
          strokeWidth="4"
        />
        {geometry.bars.map((x, index) => (
          <Line
            key={x + index}
            x1={x}
            y1="32"
            x2={100 - x}
            y2="68"
            stroke={index === 1 ? groknight.signalBright : groknight.steel}
            strokeWidth="4"
            strokeLinecap="square"
          />
        ))}
      </G>
    </Svg>
  );
}
