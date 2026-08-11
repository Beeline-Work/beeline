import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, Ellipse, G, Path } from 'react-native-svg';
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
            fill={groknight.bgHighlight}
            stroke={groknight.borderStrong}
            strokeWidth="3"
          />
          <G rotation={geometry.orbitTilt} origin="50, 50">
            <Ellipse
              cx="50"
              cy="50"
              rx="43"
              ry={22 + geometry.orbitGap}
              fill="none"
              stroke={groknight.signalDim}
              strokeWidth="3"
              strokeDasharray="42 12"
            />
            <Ellipse
              cx="50"
              cy="50"
              rx={35 - geometry.orbitGap / 2}
              ry="43"
              fill="none"
              stroke={groknight.border}
              strokeWidth="2"
              strokeDasharray="18 15"
            />
          </G>
          <Ellipse
            cx="50"
            cy={43 - geometry.headLift}
            rx={geometry.headWidth / 2}
            ry="19"
            fill={groknight.bgCode}
            stroke={groknight.chrome}
            strokeWidth="3"
          />
          <Circle
            cx={50 - geometry.eyeOffset}
            cy={42 - geometry.headLift}
            r="2.8"
            fill={groknight.signalBright}
          />
          <Circle
            cx={50 + geometry.eyeOffset}
            cy={42 - geometry.headLift}
            r="2.8"
            fill={groknight.signalBright}
          />
          <Path
            d="M22 84 C27 65 39 59 50 59 C61 59 73 65 78 84"
            fill={groknight.bgCode}
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
