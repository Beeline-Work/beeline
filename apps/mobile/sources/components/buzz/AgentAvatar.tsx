import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, Line, Polygon, Polyline, Rect } from 'react-native-svg';
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
  const left = 50 - geometry.sensorOffset;
  const right = 50 + geometry.sensorOffset;

  useEffect(() => setFailedAvatar(null), [avatarUrl]);

  return (
    <View
      accessibilityLabel={`${name}, agent`}
      style={[styles.frame, { width: size, height: size, borderRadius: Math.max(2, size * 0.08) }]}
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
          <Polygon
            points="20,2 80,2 98,20 98,80 80,98 20,98 2,80 2,20"
            fill={groknight.bgHighlight}
            stroke={groknight.borderStrong}
            strokeWidth="3"
          />
          <Polyline
            points={`18,${geometry.crown} 50,12 82,${geometry.crown}`}
            fill="none"
            stroke={groknight.signalDim}
            strokeWidth="3"
          />
          <Rect
            x="18"
            y="28"
            width="64"
            height="44"
            fill={groknight.bgCode}
            stroke={groknight.chrome}
            strokeWidth="3"
          />
          <Circle cx={left} cy="48" r={geometry.aperture} fill={groknight.signalBright} />
          <Circle cx={right} cy="48" r={geometry.aperture} fill={groknight.signalBright} />
          <Line x1="50" y1="30" x2="50" y2="70" stroke={groknight.steel} strokeWidth="3" />
          {geometry.struts.map((y) => (
            <Line
              key={y}
              x1="27"
              y1={y}
              x2="73"
              y2={y}
              stroke={groknight.signalDim}
              strokeWidth="2"
            />
          ))}
          <Polyline
            points="36,80 50,88 64,80"
            fill="none"
            stroke={groknight.chrome}
            strokeWidth="3"
          />
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
