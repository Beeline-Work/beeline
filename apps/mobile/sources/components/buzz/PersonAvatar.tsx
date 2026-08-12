import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, Ellipse, G } from 'react-native-svg';
import { personAvatarGeometry } from '@/buzz/person-avatar';
import { groknight } from '@/buzz/groknight';

type PersonAvatarProps = {
  pubkey: string;
  avatarUrl?: string;
  name?: string;
  size?: number;
};

export function PersonAvatar({ pubkey, avatarUrl, name = 'Person', size = 52 }: PersonAvatarProps) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showRelayAvatar = Boolean(avatarUrl && failedAvatar !== avatarUrl);
  const geometry = personAvatarGeometry(pubkey);
  const petals = Array.from({ length: geometry.petalCount }, (_, index) => index);
  const petalTone = [groknight.avatarInk, groknight.avatarSoft][geometry.petalTone]!;

  useEffect(() => setFailedAvatar(null), [avatarUrl]);

  return (
    <View
      accessibilityLabel={`${name}, person`}
      style={[styles.frame, { width: size, height: size, borderRadius: size / 2 }]}
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
          <Circle
            cx="50"
            cy="50"
            r="48"
            fill={groknight.avatarGround}
            stroke={groknight.avatarDim}
            strokeWidth="3"
          />
          {petals.map((index) => {
            const alternateScale = geometry.arrangement === 1 && index % 2 === 1 ? 0.84 : 1;
            const petalLength = geometry.petalLength * alternateScale;
            const petalCenter = 50 - geometry.centerRadius - petalLength * 0.34;
            return (
              <G
                key={index}
                rotation={geometry.rotation + (360 / geometry.petalCount) * index}
                origin="50, 50"
              >
                <Ellipse
                  cx="50"
                  cy={petalCenter}
                  rx={(geometry.petalWidth * alternateScale) / 2}
                  ry={petalLength / 2}
                  fill={petalTone}
                  stroke={groknight.avatarInk}
                  strokeWidth="2"
                />
              </G>
            );
          })}
          <Circle
            cx="50"
            cy="50"
            r={geometry.centerRadius}
            fill={geometry.petalTone === 0 ? groknight.avatarSoft : groknight.avatarDim}
            stroke={groknight.avatarInk}
            strokeWidth="2.5"
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
