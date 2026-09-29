import React from 'react';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import type { CornerState } from '@beeline/api-contract/phone';

/** One slow breath, slower than the live pulse's 1120 ms. */
export const WAITING_PULSE_CYCLE = 2400;

/** The dimmest a waiting label goes; it stays legible through the cycle. */
const WAITING_PULSE_FLOOR = 0.45;

/**
 * A waiting label's opacity at a frame time. Every label reads the same frame
 * clock, so all waiting labels on screen breathe in one phase, including one
 * that mounts mid-cycle.
 */
export function waitingPulseOpacity(timestamp: number): number {
  'worklet';
  const phase = (timestamp % WAITING_PULSE_CYCLE) / WAITING_PULSE_CYCLE;
  return WAITING_PULSE_FLOOR + (1 - WAITING_PULSE_FLOOR) * Math.cos(phase * Math.PI) ** 2;
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
  const pulsing = state === 'waiting' && !reducedMotion;
  const opacity = useSharedValue(1);
  const frame = useFrameCallback((info) => {
    opacity.value = waitingPulseOpacity(info.timestamp);
  }, false);
  React.useEffect(() => {
    frame.setActive(pulsing);
    if (!pulsing) opacity.value = 1;
  }, [frame, opacity, pulsing]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  if (state !== 'waiting') return children;
  return (
    <Animated.View style={style} testID="corner-waiting-pulse">
      {children}
    </Animated.View>
  );
}
