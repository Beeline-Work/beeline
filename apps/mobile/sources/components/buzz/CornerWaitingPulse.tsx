import React from 'react';
import { Animated, Easing } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import type { CornerState } from '@beeline/api-contract/phone';

/** One slow breath, slower than the live pulse's 1120 ms. */
export const WAITING_PULSE_CYCLE = 2400;

/** The dimmest a waiting label goes; it stays legible through the cycle. */
const WAITING_PULSE_FLOOR = 0.45;

/** A waiting label's opacity at a time on the shared pulse clock. */
export function waitingPulseOpacity(timestamp: number): number {
  const phase = (timestamp % WAITING_PULSE_CYCLE) / WAITING_PULSE_CYCLE;
  return WAITING_PULSE_FLOOR + (1 - WAITING_PULSE_FLOOR) * Math.cos(phase * Math.PI) ** 2;
}

const STEPS = 24;
const phases = Array.from({ length: STEPS + 1 }, (_, step) => step / STEPS);

/**
 * Every waiting label reads this one clock, so they all breathe in one phase,
 * including one that mounts mid-cycle. It runs on the native driver: the
 * opacity reaches each view directly. A per-frame Reanimated callback instead
 * committed a new shadow tree on Android every frame for as long as a corner
 * waited, interleaved with the Room list's own commits.
 */
let clock: { value: Animated.Value; opacity: Animated.AnimatedInterpolation<number> } | null = null;
let loop: Animated.CompositeAnimation | null = null;
let pulsing = 0;

function sharedClock() {
  if (!clock) {
    const value = new Animated.Value(0);
    clock = {
      value,
      opacity: value.interpolate({
        inputRange: phases,
        outputRange: phases.map((phase) => waitingPulseOpacity(phase * WAITING_PULSE_CYCLE)),
      }),
    };
  }
  return clock;
}

function holdClock() {
  pulsing += 1;
  if (loop) return;
  loop = Animated.loop(
    Animated.timing(sharedClock().value, {
      toValue: 1,
      duration: WAITING_PULSE_CYCLE,
      easing: Easing.linear,
      useNativeDriver: true,
    }),
  );
  loop.start();
}

function releaseClock() {
  pulsing -= 1;
  if (pulsing > 0 || !loop) return;
  loop.stop();
  loop = null;
  sharedClock().value.setValue(0);
}

/** Pulses a corner's `waiting` label; every other state, and reduced motion, holds still. */
export function CornerWaitingPulse({
  children,
  state,
}: {
  children: React.ReactNode;
  state: CornerState;
}) {
  const reducedMotion = useReducedMotion();
  const breathing = state === 'waiting' && !reducedMotion;
  React.useEffect(() => {
    if (!breathing) return;
    holdClock();
    return releaseClock;
  }, [breathing]);
  if (state !== 'waiting') return children;
  return (
    <Animated.View
      style={{ opacity: breathing ? sharedClock().opacity : 1 }}
      testID="corner-waiting-pulse"
    >
      {children}
    </Animated.View>
  );
}
