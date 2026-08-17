import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { G, Polygon } from 'react-native-svg';
import { personAvatarGeometry } from '@/buzz/person-avatar';
import { groknight } from '@/buzz/groknight';

type PersonAvatarProps = {
  pubkey: string;
  avatarUrl?: string;
  name?: string;
  size?: number;
};

/** Twelve-sided plate frame — more faceted than the Agent's octagon, still all straight edges. */
const FRAME_POINTS =
  '37.8,4.6 62.2,4.6 83.2,16.8 95.4,37.8 95.4,62.2 83.2,83.2 62.2,95.4 37.8,95.4 16.8,83.2 4.6,62.2 4.6,37.8 16.8,16.8';

/** Faceted hex core the shards radiate around. */
function corePoints(radius: number): string {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = ((-90 + 60 * index) * Math.PI) / 180;
    const x = 50 + radius * Math.cos(angle);
    const y = 50 + radius * Math.sin(angle);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

/** Angular shard standing in for a petal: a tapered kite, all straight edges. */
function shardPoints(cy: number, halfWidth: number, halfLength: number): string {
  const tip = cy - halfLength;
  const base = cy + halfLength;
  const wide = cy - halfLength * 0.2;
  return `50,${tip.toFixed(1)} ${(50 + halfWidth).toFixed(1)},${wide.toFixed(1)} 50,${base.toFixed(1)} ${(50 - halfWidth).toFixed(1)},${wide.toFixed(1)}`;
}

export function PersonAvatar({ pubkey, avatarUrl, name = 'Person', size = 52 }: PersonAvatarProps) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showRelayAvatar = Boolean(avatarUrl && failedAvatar !== avatarUrl);
  const geometry = personAvatarGeometry(pubkey);
  const shards = Array.from({ length: geometry.petalCount }, (_, index) => index);
  const shardTone = [groknight.avatarInk, groknight.avatarSoft][geometry.petalTone]!;

  useEffect(() => setFailedAvatar(null), [avatarUrl]);

  return (
    <View
      accessibilityLabel={`${name}, person`}
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
            points={FRAME_POINTS}
            fill={groknight.avatarGround}
            stroke={groknight.avatarDim}
            strokeWidth="3"
          />
          {shards.map((index) => {
            const alternateScale = geometry.arrangement === 1 && index % 2 === 1 ? 0.84 : 1;
            const petalLength = geometry.petalLength * alternateScale;
            const petalWidth = geometry.petalWidth * alternateScale;
            const petalCenter = 50 - geometry.centerRadius - petalLength * 0.34;
            return (
              <G
                key={index}
                rotation={geometry.rotation + (360 / geometry.petalCount) * index}
                origin="50, 50"
              >
                <Polygon
                  points={shardPoints(petalCenter, petalWidth / 2, petalLength / 2)}
                  fill={shardTone}
                  stroke={groknight.avatarInk}
                  strokeWidth="2"
                  strokeLinejoin="miter"
                />
              </G>
            );
          })}
          <Polygon
            points={corePoints(geometry.centerRadius)}
            fill={geometry.petalTone === 0 ? groknight.avatarSoft : groknight.avatarDim}
            stroke={groknight.avatarInk}
            strokeWidth="2.5"
            strokeLinejoin="miter"
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
    backgroundColor: groknight.avatarGround,
  },
  image: { width: '100%', height: '100%' },
});
