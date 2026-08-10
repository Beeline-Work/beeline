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
import { groknight } from '@/buzz/groknight';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const MARK_PATH =
  'M 32 182 C 48 181, 58 180, 68 176 C 86 168, 60 143, 80 132 C 92 126, 104 138, 97 153 C 92 163, 77 164, 70 172 C 62 180, 82 185, 98 178 C 144 168, 176 148, 194 112 C 203 92, 208 66, 211 44';

export function BeelineMark({ size = 112, shimmer = false }: { size?: number; shimmer?: boolean }) {
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
        fill="none"
        stroke={groknight.brandMark}
        strokeWidth={8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <AnimatedPath
        d={MARK_PATH}
        fill="none"
        stroke={groknight.textPrimary}
        strokeWidth={8}
        strokeLinecap="round"
        strokeLinejoin="round"
        animatedProps={highlightProps}
      />
    </Svg>
  );
}
