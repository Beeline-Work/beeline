import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { G, Line, Polygon, Rect } from 'react-native-svg';
import { agentAvatarGeometry } from '@/buzz/agent-avatar';
import { groknight } from '@/buzz/groknight';

type AgentAvatarProps = {
  pubkey: string;
  avatarSeed?: string;
  avatarUrl?: string;
  name?: string;
  size?: number;
};

export function AgentAvatar({
  pubkey,
  avatarSeed,
  avatarUrl,
  name = 'Agent',
  size = 52,
}: AgentAvatarProps) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showRelayAvatar = Boolean(avatarUrl && failedAvatar !== avatarUrl);
  const geometry = agentAvatarGeometry(avatarSeed || pubkey);
  const inset = geometry.inset;
  const far = 100 - inset;
  const points = `${50},${inset} ${far},${geometry.cut} ${far},${100 - geometry.cut} ${50},${far} ${inset},${100 - geometry.cut} ${inset},${geometry.cut}`;

  useEffect(() => {
    setFailedAvatar(null);
  }, [avatarUrl]);

  return (
    <View
      accessibilityLabel={`${name} soul`}
      style={[styles.frame, { width: size, height: size, borderRadius: Math.round(size * 0.22) }]}
    >
      {showRelayAvatar ? (
        <Image
          onError={() => setFailedAvatar(avatarUrl ?? null)}
          resizeMode="cover"
          source={{ uri: avatarUrl! }}
          style={styles.image}
        />
      ) : (
        <Svg width="100%" height="100%" viewBox="0 0 100 100">
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
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.bgHighlight,
  },
  image: { width: '100%', height: '100%' },
});
