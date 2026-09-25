import React, { useEffect } from 'react';
import Svg, { G, Path } from 'react-native-svg';
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
// do not redesign). The group transform places the path on its 240-unit canvas.
const MARK_PATH = beelineMark.path;
const MARK_VIEWBOX = beelineMark.viewBox;
const MARK_TRANSFORM = beelineMark.transform;
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
      <G transform={MARK_TRANSFORM}>
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
      </G>
    </Svg>
  );
}
