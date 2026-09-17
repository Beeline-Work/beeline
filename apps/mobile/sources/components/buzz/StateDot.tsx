import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * StateDot — the ONE instrument dot (board revision 2's `.gind`): an 8px
 * circle beside a state word that makes the state scannable down a list.
 * The word is the signal; the dot is never the only carrier:
 *
 *   - `'live'`    filled with the theme's success token — a settled, good state;
 *   - `'pulse'`   filled brass, gently pulsing — work in flight;
 *   - `'failed'`  filled with the dialog-danger token — a broken state.
 *
 * The pulse honors reduced motion the way `PulsingText` does: a still,
 * fully visible dot is the fallback.
 */
export type StateDotKind = 'live' | 'pulse' | 'failed';

export function StateDot({ kind, testID }: { kind: StateDotKind; testID?: string }) {
  if (kind !== 'pulse') {
    return (
      <View
        style={[styles.dot, kind === 'live' ? styles.live : styles.failed]}
        testID={testID ? `${testID}-${kind}` : undefined}
      />
    );
  }
  return <PulsingDot testID={testID ? `${testID}-pulse` : undefined} />;
}

function PulsingDot({ testID }: { testID?: string }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return <Animated.View style={[styles.dot, styles.pulse, { opacity: pulse }]} testID={testID} />;
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
    live: { backgroundColor: hull.success },
    pulse: { backgroundColor: hull.accent },
    failed: { backgroundColor: hull.dialogDanger },
  };
});
