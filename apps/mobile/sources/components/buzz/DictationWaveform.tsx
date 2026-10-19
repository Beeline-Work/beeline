import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export const WAVEFORM_BAR_COUNT = 40;
const BAR_MIN_HEIGHT = 2;
const BAR_RANGE = 16;
const BAR_WIDTH = 2;
const BAR_GAP = 4;
const FIELD_HEIGHT = 26;

/** Fixed blocks follow the current microphone level in the same render. */
export function DictationWaveform({ level, live, testID, flat = false }: {
  level: number; live: boolean; testID?: string; flat?: boolean;
}) {
  const lastLevel = React.useRef(level);
  if (live) lastLevel.current = level;
  const value = flat ? 0 : Math.max(0, Math.min(1, lastLevel.current));
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    pointerEvents="none" style={styles.waveform}>
    <View style={styles.blocks} testID={testID}>
      {Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) =>
        <View key={index} style={[styles.bar, live ? styles.barLive : styles.barFrozen,
          { height: BAR_MIN_HEIGHT + value * BAR_RANGE * (0.6 + (index % 5) * 0.1) }]} />)}
    </View>
  </View>;
}

const styles = StyleSheet.create(theme => ({
  waveform: { flex: 1, minWidth: 0, height: FIELD_HEIGHT, overflow: 'hidden' },
  blocks: { flexDirection: 'row', alignItems: 'center', height: FIELD_HEIGHT, gap: BAR_GAP },
  bar: { width: BAR_WIDTH, borderRadius: 3, flexShrink: 0 },
  barLive: { backgroundColor: theme.buzz.accent },
  barFrozen: { backgroundColor: theme.buzz.textMuted },
}));
