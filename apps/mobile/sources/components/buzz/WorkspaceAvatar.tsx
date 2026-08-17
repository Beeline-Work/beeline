import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Polygon } from 'react-native-svg';
import type { Community } from '@beeline/buzz-client';
import { groknight } from '@/buzz/groknight';
import { workspaceAvatarGeometry } from '@/buzz/workspace-avatar';

type WorkspaceAvatarProps = {
  community?: Pick<Community, 'communityId' | 'name' | 'avatar'> | null;
  size?: number;
  active?: boolean;
  testID?: string;
};

const HEX_CENTERS: ReadonlyArray<readonly [number, number]> = [
  [50, 50],
  [50, 25],
  [72, 37.5],
  [72, 62.5],
  [50, 75],
  [28, 62.5],
  [28, 37.5],
];

function hexPoints(centerX: number, centerY: number, radius = 11): string {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index);
    return `${centerX + radius * Math.cos(angle)},${centerY + radius * Math.sin(angle)}`;
  }).join(' ');
}

export function WorkspaceAvatar({
  community,
  size = 42,
  active = false,
  testID,
}: WorkspaceAvatarProps) {
  const avatar = community?.avatar?.trim();
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showRelayAvatar =
    groknight.photoIdentityMarksEnabled && Boolean(avatar && failedAvatar !== avatar);
  const geometry = workspaceAvatarGeometry(community?.communityId ?? 'workspace-loading');
  const frameStyle = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.08),
    borderWidth: active ? 2 : 1,
    borderColor: active ? groknight.selectedBorder : groknight.border,
  };

  useEffect(() => {
    setFailedAvatar(null);
  }, [avatar]);

  return (
    <View
      accessibilityLabel={`${community?.name ?? 'Workspace'} avatar`}
      style={[styles.frame, frameStyle]}
      testID={testID}
    >
      {showRelayAvatar ? (
        <Image
          onError={() => setFailedAvatar(avatar ?? null)}
          resizeMode="cover"
          source={{ uri: avatar! }}
          style={styles.image}
        />
      ) : (
        <Svg width="100%" height="100%" viewBox="0 0 100 100">
          {HEX_CENTERS.map(([centerX, centerY], index) => {
            if ((geometry.filledMask & (1 << index)) === 0) return null;
            const heavy = index === geometry.heavyIndex;
            const chrome = (geometry.chromeMask & (1 << index)) !== 0;
            return (
              <Polygon
                key={index}
                origin="50, 50"
                points={hexPoints(centerX, centerY)}
                rotation={geometry.rotation}
                fill={heavy ? groknight.bgHover : groknight.bgRaised}
                stroke={heavy ? groknight.signalBright : chrome ? groknight.chrome : groknight.steel}
                strokeWidth={heavy ? 4 : 2.5}
              />
            );
          })}
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
