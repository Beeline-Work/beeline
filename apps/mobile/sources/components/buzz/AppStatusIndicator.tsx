import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Polyline } from 'react-native-svg';
import { useReducedMotion } from 'react-native-reanimated';
import { appInstrument, type WorkbenchApp } from '@/buzz/workbench';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';

/**
 * The one mark a Workbench app's state draws, beside the state word:
 *
 *   - `connected`  a green check;
 *   - `connecting` an amber spinner, whose soft amber glow breathes as it
 *                  turns;
 *   - `error`      the red failed indicator.
 *
 * The word is the signal; the mark is never the only carrier (`appInstrument`
 * supplies both). The spinner honors reduced motion with a still ring, and its
 * loops are stopped when connecting ends or the mark unmounts.
 */
const CHECK_SIZE = 16;
const CHECK_STROKE_WIDTH = 2;
const CHECK_POINTS = '3.5 8.5 6.5 11.5 12.5 5';
const SPINNER_SIZE = 14;
const SPINNER_BORDER = 2;
const GLOW_SIZE = 24;
const SPIN_CYCLE_MS = 1000;
const GLOW_CYCLE_MS = 700;

export function AppStatusIndicator({
  status,
  label,
  textStyle,
  testID,
}: {
  status: WorkbenchApp['status'];
  label: string;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
}) {
  const mark = appInstrument(status).glyph;
  return (
    <View style={styles.indicator} testID={testID}>
      {mark === 'check' ? (
        <CheckMark testID={testID ? `${testID}-check` : undefined} />
      ) : mark === 'spinner' ? (
        <SpinnerMark testID={testID ? `${testID}-spinner` : undefined} />
      ) : (
        <FailedMark testID={testID ? `${testID}-failed` : undefined} />
      )}
      <Text
        numberOfLines={1}
        style={[
          textStyle,
          mark === 'check'
            ? styles.connectedLabel
            : mark === 'spinner'
              ? styles.connectingLabel
              : styles.errorLabel,
        ]}
        testID={testID ? `${testID}-label` : undefined}
      >
        {label}
      </Text>
    </View>
  );
}

function CheckMark({ testID }: { testID?: string }) {
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      height={CHECK_SIZE}
      testID={testID}
      viewBox="0 0 16 16"
      width={CHECK_SIZE}
    >
      <Polyline
        fill="none"
        points={CHECK_POINTS}
        stroke={styles.checkMark.color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={CHECK_STROKE_WIDTH}
      />
    </Svg>
  );
}

/** The red failed dot, the same instrument a broken key row carries. */
function FailedMark({ testID }: { testID?: string }) {
  return <View style={styles.failedDot} testID={testID} />;
}

function SpinnerMark({ testID }: { testID?: string }) {
  const reducedMotion = useReducedMotion();
  const spin = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reducedMotion) return;
    const rotation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: SPIN_CYCLE_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const breathing = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 0.35, duration: GLOW_CYCLE_MS, useNativeDriver: false }),
        Animated.timing(glow, { toValue: 1, duration: GLOW_CYCLE_MS, useNativeDriver: false }),
      ]),
    );
    rotation.start();
    breathing.start();
    return () => {
      rotation.stop();
      breathing.stop();
    };
  }, [glow, reducedMotion, spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const shadowOpacity = glow.interpolate({ inputRange: [0.35, 1], outputRange: [0.16, 0.5] });
  const shadowRadius = glow.interpolate({ inputRange: [0.35, 1], outputRange: [3, 6] });

  return (
    <View style={styles.spinnerBox}>
      <Animated.View
        style={[styles.halo, { opacity: glow, shadowOpacity, shadowRadius }]}
        testID={testID ? `${testID}-glow` : undefined}
      />
      <Animated.View style={[styles.spinner, { transform: [{ rotate }] }]}>
        <View style={styles.spinnerRing} testID={testID} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    indicator: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm, flexShrink: 0 },
    checkMark: { color: hull.diffAdded },
    failedDot: {
      width: 8,
      height: 8,
      borderRadius: 8 / 2,
      flexShrink: 0,
      backgroundColor: hull.dialogDanger,
    },
    // The spinner's amber halo and its soft glow. The glow is the second
    // licensed shadow in the app (DESIGN.md), a live signal rather than
    // elevation; the halo keeps it visible where a shadow does not render.
    // The ring stays steady while the halo breathes behind it.
    spinnerBox: {
      width: GLOW_SIZE,
      height: GLOW_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    halo: {
      position: 'absolute',
      width: GLOW_SIZE,
      height: GLOW_SIZE,
      borderRadius: GLOW_SIZE / 2,
      backgroundColor: hull.brassWash,
      shadowColor: hull.accent,
      shadowOffset: { width: 0, height: 0 },
    },
    spinner: {
      width: SPINNER_SIZE,
      height: SPINNER_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    spinnerRing: {
      width: SPINNER_SIZE,
      height: SPINNER_SIZE,
      borderRadius: SPINNER_SIZE / 2,
      borderWidth: SPINNER_BORDER,
      borderColor: hull.accent,
      borderTopColor: 'transparent',
    },
    connectedLabel: { color: hull.diffAdded },
    connectingLabel: { color: hull.accent },
    errorLabel: { color: hull.dialogDanger },
  };
});
