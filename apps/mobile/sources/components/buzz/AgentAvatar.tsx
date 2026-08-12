import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Polygon, Polyline, Rect } from 'react-native-svg';
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

  const hullPoints = [
    '20,3 80,3 97,20 97,80 80,97 20,97 3,80 3,20',
    '25,3 75,3 97,28 88,88 67,97 33,97 12,88 3,28',
    '14,3 86,3 97,18 90,72 50,97 10,72 3,18',
    '30,3 70,3 97,23 82,97 18,97 3,23',
    '7,14 27,3 73,3 93,14 97,72 76,97 24,97 3,72',
    '24,3 76,3 97,50 76,97 24,97 3,50',
  ][geometry.hullVariant]!;

  const renderSensors = () => {
    switch (geometry.sensorVariant) {
      case 0:
        return (
          <G>
            <Circle cx="50" cy="48" r="15" fill={groknight.signalDim} />
            <Circle cx="50" cy="48" r="7" fill={groknight.signalBright} />
          </G>
        );
      case 1:
        return (
          <G>
            <Circle cx="30" cy="48" r="10" fill={groknight.signalBright} />
            <Circle cx="70" cy="48" r="10" fill={groknight.signalBright} />
            <Line x1="40" y1="48" x2="60" y2="48" stroke={groknight.chrome} strokeWidth="4" />
          </G>
        );
      case 2:
        return (
          <G>
            {[34, 46, 58].map((y, index) => (
              <Rect
                key={y}
                x={index === 1 ? 20 : 28}
                y={y}
                width={index === 1 ? 60 : 44}
                height="6"
                fill={index === 1 ? groknight.signalBright : groknight.signalDim}
              />
            ))}
          </G>
        );
      case 3:
        return (
          <G>
            <Circle cx="50" cy="31" r="7" fill={groknight.signalDim} />
            <Circle cx="50" cy="49" r="11" fill={groknight.signalBright} />
            <Circle cx="50" cy="70" r="5" fill={groknight.signalDim} />
          </G>
        );
      case 4:
        return (
          <G>
            <Polygon points="50,28 68,48 50,68 32,48" fill={groknight.signalBright} />
            <Line x1="16" y1="48" x2="31" y2="48" stroke={groknight.signalDim} strokeWidth="7" />
            <Line x1="69" y1="48" x2="84" y2="48" stroke={groknight.signalDim} strokeWidth="7" />
          </G>
        );
      default:
        return (
          <G>
            {[31, 57].flatMap((x) =>
              [35, 57].map((y) => (
                <Rect
                  key={`${x}-${y}`}
                  x={x}
                  y={y}
                  width="12"
                  height="12"
                  fill={(x + y) % 4 === 0 ? groknight.signalBright : groknight.signalDim}
                />
              )),
            )}
          </G>
        );
    }
  };

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
            points={hullPoints}
            fill={groknight.bgHighlight}
            stroke={groknight.borderStrong}
            strokeWidth="4"
          />
          <Polyline
            points={`16,${geometry.crownDepth} 50,9 84,${geometry.crownDepth}`}
            fill="none"
            stroke={groknight.signalDim}
            strokeWidth="4"
          />
          <Path
            d={
              geometry.armorVariant === 0
                ? 'M16 76 L36 63 H64 L84 76'
                : geometry.armorVariant === 1
                  ? 'M12 68 H32 L50 84 L68 68 H88'
                  : geometry.armorVariant === 2
                    ? 'M18 78 L50 69 L82 78 M50 69 V91'
                    : 'M14 72 L42 72 L50 86 L58 72 L86 72'
            }
            fill="none"
            stroke={groknight.chrome}
            strokeWidth="4"
          />
          <G transform={`translate(${geometry.direction * 2} 0)`}>{renderSensors()}</G>
          <Line
            x1={geometry.direction === 1 ? 77 : 23}
            y1="23"
            x2={geometry.direction === 1 ? 88 : 12}
            y2="38"
            stroke={groknight.steel}
            strokeWidth="5"
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
