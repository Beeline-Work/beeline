import * as React from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/** More bars than the widest field holds; the oldest clip off the left edge. */
export const WAVEFORM_BAR_COUNT = 80;
/** One bar per sample, so the line moves at a steady pace even in silence. */
const WAVEFORM_SAMPLE_MS = 120;
const BAR_MIN_HEIGHT = 2;
const BAR_RANGE = 16;
const BAR_WIDTH = 2;
const BAR_GAP = 4;
const FIELD_HEIGHT = 26;
/** One bar and its gap: how far the line travels per sample. */
const WAVEFORM_STEP = BAR_WIDTH + BAR_GAP;
/** The glide is one linear run this long; a take never outlasts it. */
const GLIDE_SAMPLES = 30_000;

type Bar = { index: number; value: number };

/**
 * The dictation field: a level line that glides in from the right, newest
 * bar last, each bar as tall as the voice was loud. Frozen, it keeps its last
 * shape in grey while the take is transcribed.
 *
 * Bar k sits at a fixed place on a strip, and the strip slides left at one
 * step per sample on the native driver, so the line moves every frame rather
 * than jumping a step per sample. The live bar at the visible right edge follows
 * volume events directly, without waiting for history sampling or offscreen travel.
 */
export function DictationWaveform({
  level,
  live,
  testID,
  flat = false,
}: {
  level: number;
  live: boolean;
  testID?: string;
  flat?: boolean;
}) {
  const levelRef = React.useRef(level);
  if (live) levelRef.current = Math.max(0, Math.min(1, level));
  const [bars, setBars] = React.useState<readonly Bar[]>([]);
  const nextIndexRef = React.useRef(0);
  const offset = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    if (!live) return;
    // Bar k is due k samples after the glide began; a late timer catches up.
    const startedAt = Date.now() - nextIndexRef.current * WAVEFORM_SAMPLE_MS;
    const glide = Animated.timing(offset, {
      toValue: -WAVEFORM_STEP * (nextIndexRef.current + GLIDE_SAMPLES),
      duration: WAVEFORM_SAMPLE_MS * GLIDE_SAMPLES,
      easing: Easing.linear,
      useNativeDriver: Platform.OS !== 'web',
    });
    glide.start();
    const timer = setInterval(() => {
      const due = Math.floor((Date.now() - startedAt) / WAVEFORM_SAMPLE_MS) + 1;
      if (due <= nextIndexRef.current) return;
      const added: Bar[] = [];
      for (let index = nextIndexRef.current; index < due; index += 1) {
        added.push({ index, value: levelRef.current });
      }
      nextIndexRef.current = due;
      setBars((current) => [...current, ...added].slice(-WAVEFORM_BAR_COUNT));
    }, WAVEFORM_SAMPLE_MS);
    return () => {
      clearInterval(timer);
      glide.stop();
    };
  }, [live, offset]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.waveform}
    >
      {!flat && <View testID={`${testID ?? 'waveform'}-live-level`}
        style={[styles.bar, styles.liveLevel, live ? styles.barLive : styles.barFrozen,
          { height: BAR_MIN_HEIGHT + levelRef.current * BAR_RANGE,
            top: (FIELD_HEIGHT - BAR_MIN_HEIGHT - levelRef.current * BAR_RANGE) / 2 }]} />}
      {flat ? <View style={styles.flat}>{Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) =>
        <View key={index} style={[styles.barLive, styles.flatDot]} />)}</View> : <Animated.View style={[styles.strip, { transform: [{ translateX: offset }] }]} testID={testID}>
        {bars.map((bar) => (
          <View
            key={bar.index}
            style={[
              styles.bar,
              live ? styles.barLive : styles.barFrozen,
              barPlace(bar),
            ]}
          />
        ))}
      </Animated.View>}
    </View>
  );
}

function barPlace(bar: Bar) {
  const height = BAR_MIN_HEIGHT + Math.max(0, Math.min(1, bar.value)) * BAR_RANGE;
  return { left: (bar.index + 1) * WAVEFORM_STEP, top: (FIELD_HEIGHT - height) / 2, height };
}

const styles = StyleSheet.create((theme) => ({
  waveform: {
    flex: 1,
    minWidth: 0,
    height: FIELD_HEIGHT,
    overflow: 'hidden',
  },
  // The strip starts at the field's right edge; bars are placed along it.
  strip: { position: 'absolute', top: 0, bottom: 0, left: '100%', width: 0 },
  bar: { position: 'absolute', width: BAR_WIDTH, borderRadius: 999 },
  liveLevel: { right: 0 },
  flat: { flexDirection: 'row', alignItems: 'center', height: FIELD_HEIGHT, gap: BAR_GAP },
  flatDot: { width: BAR_WIDTH, height: BAR_MIN_HEIGHT, borderRadius: 999 },
  barLive: { backgroundColor: theme.buzz.accent },
  barFrozen: { backgroundColor: theme.buzz.textMuted },
}));
