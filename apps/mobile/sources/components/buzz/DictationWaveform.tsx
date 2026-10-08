import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/** More bars than the widest field holds; the oldest clip off the left edge. */
export const WAVEFORM_BAR_COUNT = 80;
/** One bar per sample, so the line moves at a steady pace even in silence. */
export const WAVEFORM_SAMPLE_MS = 120;
const BAR_MIN_HEIGHT = 2;
const BAR_RANGE = 16;

/**
 * The dictation field: a level line that scrolls in from the right, newest
 * bar last, each bar as tall as the voice was loud. Frozen, it keeps its last
 * shape in grey while the take is transcribed.
 */
export function DictationWaveform({
  level,
  live,
  testID,
}: {
  level: number;
  live: boolean;
  testID?: string;
}) {
  const levelRef = React.useRef(level);
  levelRef.current = level;
  const [bars, setBars] = React.useState<readonly number[]>([]);
  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      setBars((current) => [...current.slice(1 - WAVEFORM_BAR_COUNT), levelRef.current]);
    }, WAVEFORM_SAMPLE_MS);
    return () => clearInterval(timer);
  }, [live]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.waveform}
      testID={testID}
    >
      {bars.map((value, index) => (
        <View
          key={index}
          style={[
            styles.bar,
            live ? styles.barLive : styles.barFrozen,
            { height: BAR_MIN_HEIGHT + Math.max(0, Math.min(1, value)) * BAR_RANGE },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  waveform: {
    flex: 1,
    minWidth: 0,
    height: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.buzz.space.xs,
    overflow: 'hidden',
  },
  bar: { width: 2, flexShrink: 0, borderRadius: 999 },
  barLive: { backgroundColor: theme.buzz.accent },
  barFrozen: { backgroundColor: theme.buzz.textMuted },
}));
