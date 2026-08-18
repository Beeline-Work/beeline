import React, { useEffect, useMemo, useState } from 'react';
import { AppState, type AppStateStatus, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { motionTokens } from './MonoHull';

/**
 * The corner's living status light.
 *
 * A corner being open is *state*, not an event, so it does not belong in the
 * transcript scroll — a note inscribed at the moment the corner opened scrolls
 * away and then lies, saying "open" from ten minutes back while the corner has
 * since merged. This replaces it: one bar pinned directly above the composer,
 * always on screen for as long as the state it reports is true, and tapping it
 * enters the corner.
 *
 * It spends the reserved gold accent, which is exactly what gold is for here —
 * `DESIGN.md` already assigns it to live/online presence, and this is the
 * product's single most important live state. The accent is never the only
 * signal: the copy names the state, `◆` is the live-corner lifecycle glyph from
 * `buzz/corners.ts`, and the band's motion says "still going" a fourth time.
 *
 * The band flows while work is live and settles to a static rule when it is
 * not, so idle costs nothing and a glance at the bar answers "is it still
 * running" without reading a word. Reduced motion and a backgrounded app both
 * settle it — a continuous loop must never run unwatched.
 */
export function CornerLiveBar({
  label,
  live,
  onPress,
  testID,
}: {
  label: string;
  live: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const reducedMotion = useReducedMotion();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const progress = useSharedValue(0);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  const flowing = live && appActive && !reducedMotion;

  useEffect(() => {
    if (!flowing) {
      progress.value = 0;
      return;
    }
    progress.value = withRepeat(
      withTiming(1, {
        // Deliberately slower than the loader's live cycle: this is ambient
        // reassurance the reader keeps in peripheral vision for minutes, not a
        // spinner they watch. A fast shimmer here would be a nag.
        duration: motionTokens.liveCycle * 2,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      false,
    );
  }, [flowing, progress]);

  const segments = useMemo(() => Array.from({ length: 28 }, (_, index) => index), []);

  const body = (
    <>
      <View style={styles.band} testID={testID ? `${testID}-band` : undefined}>
        {segments.map((index) => (
          <FlowSegment
            key={index}
            index={index}
            count={segments.length}
            progress={progress}
            settled={!flowing}
          />
        ))}
      </View>
      <View style={styles.row}>
        <Text numberOfLines={1} style={styles.label}>
          ◆ {label}
        </Text>
        {onPress ? <Text style={styles.enter}>view →</Text> : null}
      </View>
    </>
  );

  if (!onPress) {
    return (
      <View accessibilityLabel={label} accessibilityRole="text" style={styles.bar} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityLabel={`${label}. Open the corner`}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.bar}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

/**
 * One cell of the flowing band. `sin²` so the crest is soft at both ends and
 * the loop closes on itself with no visible seam; the floor stays well above
 * zero so a settled bar is still a legible rule rather than a gap-toothed one.
 */
function FlowSegment({
  index,
  count,
  progress,
  settled,
}: {
  index: number;
  count: number;
  progress: SharedValue<number>;
  settled: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (settled) return { opacity: 0.28 };
    const phase = progress.value * Math.PI * 2 - (index / count) * Math.PI * 2;
    return { opacity: 0.22 + 0.78 * Math.sin(phase) ** 2 };
  });
  return <Animated.View style={[styles.segment, style]} />;
}

const styles = StyleSheet.create({
  /**
   * No border, no fill, no radius. A status light is not a control the reader
   * has to hunt for — it is always in the same place, so it needs no frame to
   * be found, and framing it would put a plate on the slab.
   */
  bar: {
    width: '100%',
    minWidth: 0,
    marginBottom: 6,
    paddingHorizontal: 8,
  },
  band: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 2 },
  segment: { flex: 1, height: 2, backgroundColor: groknight.accent },
  row: {
    minHeight: 26,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    color: groknight.accent,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.8,
  },
  enter: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.ledgerQuiet,
    fontSize: 9,
    lineHeight: 14,
  },
});
