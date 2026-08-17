import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { G, Polygon } from 'react-native-svg';
import { agentAvatarGeometry } from '@/buzz/agent-avatar';
import { groknight } from '@/buzz/groknight';

type AgentAvatarProps = {
  pubkey: string;
  avatarSeed?: string;
  avatarUrl?: string;
  name?: string;
  size?: number;
};

/**
 * Memoized: rendered once per transcript row inside FlatList's renderItem,
 * which is recreated on every presence tick (room-enter and live updates) —
 * without this, every row's SVG mark gets rebuilt on updates unrelated to
 * that row's own identity. Props are all primitives, so a shallow compare
 * correctly bails when nothing about this row's avatar changed.
 */
export const AgentAvatar = React.memo(function AgentAvatar({
  pubkey,
  avatarSeed,
  avatarUrl,
  name = 'Agent',
  size = 52,
}: AgentAvatarProps) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showRelayAvatar =
    groknight.photoIdentityMarksEnabled && Boolean(avatarUrl && failedAvatar !== avatarUrl);
  const geometry = agentAvatarGeometry(avatarSeed || pubkey);

  const bodyPoints = [
    '50,9 77,26 77,69 50,91 23,69 23,26',
    '39,8 61,8 80,31 73,73 50,92 27,73 20,31',
    '50,7 81,33 74,72 50,93 26,72 19,33',
  ][geometry.bodyVariant]!;
  const bodyTones = [groknight.avatarDim, groknight.avatarSoft, groknight.avatarInk] as const;
  const bodyTone = bodyTones[geometry.bodyTone]!;
  const stripePositions =
    geometry.stripeCount === 2
      ? [40, 61]
      : geometry.stripeCount === 3
        ? [35, 51, 67]
        : [32, 44, 57, 69];

  const wings = [
    ['8,25 37,29 40,49 12,43', '92,25 63,29 60,49 88,43'],
    ['7,39 31,18 43,43 19,57', '93,39 69,18 57,43 81,57'],
    ['10,22 37,31 39,47 13,39', '90,22 63,31 61,47 87,39'],
  ][geometry.wingVariant]!;
  const lowerWings =
    geometry.wingVariant === 2
      ? ['13,56 39,52 36,70 9,74', '87,56 61,52 64,70 91,74']
      : null;

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
            points="18,3 82,3 97,18 97,82 82,97 18,97 3,82 3,18"
            fill={groknight.avatarGround}
            stroke={groknight.avatarDim}
            strokeWidth="3"
          />
          <G rotation={geometry.rotation} origin="50, 50">
            {wings.map((points) => (
              <Polygon
                key={points}
                points={points}
                fill={groknight.avatarDim}
                stroke={groknight.agentAccent}
                strokeWidth="3"
                strokeLinejoin="miter"
              />
            ))}
            {lowerWings?.map((points) => (
              <Polygon
                key={points}
                points={points}
                fill={groknight.avatarSoft}
                stroke={groknight.agentAccent}
                strokeWidth="3"
                strokeLinejoin="miter"
              />
            ))}
            <Polygon
              points={bodyPoints}
              fill={bodyTone}
              stroke={groknight.avatarInk}
              strokeWidth="3"
              strokeLinejoin="miter"
            />
            {stripePositions.map((y) => (
              <Polygon
                key={y}
                points={`24,${y - 4 + geometry.stripeSkew} 76,${y - 4 - geometry.stripeSkew} 76,${y + 4 - geometry.stripeSkew} 24,${y + 4 + geometry.stripeSkew}`}
                fill={groknight.agentAccent}
              />
            ))}
            <Polygon
              points="50,9 61,16 50,24 39,16"
              fill={groknight.agentAccent}
              stroke={groknight.avatarInk}
              strokeWidth="2"
              strokeLinejoin="miter"
            />
          </G>
        </Svg>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.avatarGround,
  },
  image: { width: '100%', height: '100%' },
});
