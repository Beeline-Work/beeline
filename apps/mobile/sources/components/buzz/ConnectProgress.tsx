import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Text, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Polyline } from 'react-native-svg';
import { InlineRow } from './IndexRow';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';

/** Pieces of the connect flow (Trusty Squire mock v3): spinner, step dots and bars. */

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (live) setReduced(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { live = false; subscription.remove(); };
  }, []);
  return reduced;
}

function useLoop(duration: number, easing: (value: number) => number = Easing.linear) {
  const value = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.timing(value, { toValue: 1, duration, easing, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [duration, easing, reduced, value]);
  return value;
}

/** A turning ring: a quiet track with one brass quarter. Still when motion is reduced. */
export function RingSpinner({ size, testID, accessibilityLabel }: {
  size: number; testID?: string; accessibilityLabel?: string;
}) {
  const turn = useLoop(800);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const width = size >= 32 ? 3 : size >= 28 ? 2.5 : size >= 16 ? 2 : 1.5;
  return (
    <Animated.View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'progressbar' : undefined}
      style={[styles.ring, { width: size, height: size, borderRadius: size / 2, borderWidth: width, transform: [{ rotate }] }]}
      testID={testID}
    />
  );
}

export type ConnectStepState = 'done' | 'current' | 'waiting' | 'todo' | 'failed';

/** The 28 pt step mark: brass check, spinner, brass number, quiet number or red "!". */
export function ConnectStepDot({ state, number, testID }: { state: ConnectStepState; number: number; testID?: string }) {
  if (state === 'current') return <View style={styles.dotBox} testID={testID}><RingSpinner size={DOT} /></View>;
  if (state === 'done') {
    return (
      <View style={[styles.dot, styles.dotDone]} testID={testID}>
        <Svg {...DECORATIVE_GLYPH_PROPS} height={14} viewBox="0 0 24 24" width={14}>
          <Polyline fill="none" points="5 12.5 10 17 19 7.5" stroke={styles.dotDoneMark.color}
            strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} />
        </Svg>
      </View>
    );
  }
  return (
    <View style={[styles.dot, state === 'failed' ? styles.dotFailed : state === 'waiting' ? styles.dotWaiting : styles.dotTodo]} testID={testID}>
      <Text style={[styles.dotText, state === 'failed' ? styles.dotFailedText : state === 'waiting' ? styles.dotWaitingText : styles.dotTodoText]}>
        {state === 'failed' ? '!' : String(number)}
      </Text>
    </View>
  );
}

export type ConnectBarPart = 'filled' | 'active' | 'failed' | 'empty';

/** The 4-part step bar; the running part sweeps brass across itself. */
export function ConnectStepBar({ parts, testID }: { parts: readonly ConnectBarPart[]; testID?: string }) {
  return (
    <InlineRow style={styles.bar} testID={testID}>
      {parts.map((part, index) => part === 'active'
        ? <SweepTrack key={index} style={styles.barPart} fraction={0.4} duration={1400} testID={testID ? `${testID}-${index}-active` : undefined} />
        : <View key={index} style={[styles.barPart, part === 'filled' && styles.barFilled, part === 'failed' && styles.barFailed]}
          testID={testID ? `${testID}-${index}-${part}` : undefined} />)}
    </InlineRow>
  );
}

/** A thin loading bar: a brass block crossing the track. */
export function LoadingBar({ testID }: { testID?: string }) {
  return <SweepTrack style={styles.loadingBar} fraction={0.35} duration={1300} testID={testID} />;
}

function SweepTrack({ style, fraction, duration, testID }: {
  style: object; fraction: number; duration: number; testID?: string;
}) {
  const [width, setWidth] = useState(0);
  const sweep = useLoop(duration, Easing.inOut(Easing.ease));
  const block = width * fraction;
  const translateX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-block, width] });
  return (
    <View onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={[style, styles.track]} testID={testID}>
      {width ? <Animated.View style={[styles.sweep, { width: block, transform: [{ translateX }] }]} /> : null}
    </View>
  );
}

const DOT = 28;

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    ring: { borderColor: hull.appBorder, borderTopColor: hull.accent },
    dotBox: { width: DOT, height: DOT, alignItems: 'center', justifyContent: 'center' },
    dot: { width: DOT, height: DOT, borderRadius: DOT / 2, alignItems: 'center', justifyContent: 'center' },
    dotDone: { backgroundColor: hull.accent },
    dotDoneMark: { color: hull.appCanvas },
    dotWaiting: { borderWidth: 2, borderColor: hull.accent },
    dotTodo: { borderWidth: 1.5, borderColor: hull.borderStrong },
    dotFailed: { backgroundColor: hull.dialogDanger },
    dotText: { fontFamily: 'SpaceGrotesk-Medium', fontSize: 13, lineHeight: 19 },
    dotWaitingText: { color: hull.accent },
    dotTodoText: { fontFamily: 'SpaceGrotesk-Regular', color: hull.textMuted },
    dotFailedText: { color: hull.appCanvas },
    bar: { flexDirection: 'row', gap: hull.squireConnect.dotGap },
    barPart: { flex: 1, height: 4, borderRadius: hull.squireConnect.barRadius, backgroundColor: hull.appBorder },
    barFilled: { backgroundColor: hull.accent },
    barFailed: { backgroundColor: hull.dialogDanger },
    track: { overflow: 'hidden', backgroundColor: hull.appBorder },
    sweep: { height: '100%', backgroundColor: hull.accent },
    loadingBar: { height: 3 },
  };
});
