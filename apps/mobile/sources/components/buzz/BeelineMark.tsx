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

// The original continuous-line loop — canonical geometry (see sources/assets/images/mark.svg,
// do not redesign). The path draws at its natural framing on the 240-unit canvas: the
// launcher inset in beeline-mark.json is a home-screen treatment, and the sign-in mark
// is not a home-screen icon, so it renders full-bleed like the favicon and splashes.
const MARK_PATH = beelineMark.path;
const MARK_VIEWBOX = beelineMark.viewBox;
const MARK_FILL_RULE = beelineMark.fillRule as 'evenodd' | 'nonzero';

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
      viewBox={MARK_VIEWBOX}
    >
      <Path
        d={MARK_PATH}
        fillRule={MARK_FILL_RULE}
        fill={theme.buzz.brandMark}
      />
      <AnimatedPath
        d={MARK_PATH}
        fillRule={MARK_FILL_RULE}
        fill={theme.buzz.textPrimary}
        animatedProps={highlightProps}
      />
    </Svg>
  );
}
