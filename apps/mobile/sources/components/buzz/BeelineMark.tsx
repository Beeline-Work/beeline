import React, { useEffect } from 'react';
import Svg, { Path } from 'react-native-svg';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import beelineMark from '@/buzz/beeline-mark.json';
import { useUnistyles } from 'react-native-unistyles';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const MARK_PATH = beelineMark.path;

export function BeelineMark({ size = 112, shimmer = false }: { size?: number; shimmer?: boolean }) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotion();
  const highlight = useSharedValue(0);

  useEffect(() => {
    if (!shimmer || reducedMotion) return;
    highlight.value = withSequence(
      withTiming(0.33, {
        duration: 650,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
      withTiming(0, {
        duration: 650,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [highlight, reducedMotion, shimmer]);

  const highlightProps = useAnimatedProps(() => ({ opacity: highlight.value }));

  return (
    <Svg
      accessible
      accessibilityLabel="Beeline logo"
      width={size}
      height={size}
      viewBox="0 0 240 240"
    >
      <Path
        d={MARK_PATH}
        fill={theme.buzz.brandMark}
      />
      <AnimatedPath
        d={MARK_PATH}
        fill={theme.buzz.textPrimary}
        animatedProps={highlightProps}
      />
    </Svg>
  );
}
