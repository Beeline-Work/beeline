import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import {
  GLYPH_STROKE,
  RELEASE_PAINT_MS,
  RELEASE_REST_MS,
  RELEASE_UNWIND_MS,
  SPLASH_PAINT_MS,
  glyphPaintInk,
  glyphViewBox,
  ribbon,
  type GlyphPaintFraming,
} from '@/buzz/beeline-glyph';

const AnimatedPath = Animated.createAnimatedComponent(Path);

type BeelineGlyphPaintLoop = 'once' | 'release';

/**
 * The app icon's loop, painting itself. Two loops, one geometry:
 *
 * - `once` is the splash. The stroke paints to the filled mark and holds,
 *   because loading genuinely ends.
 * - `release` is the thinking line. The stroke paints, then immediately
 *   unwinds to empty and rests there before redrawing. It never holds the
 *   completed stroke, so it cannot read as progress toward an unknown finish.
 *
 * Reduced motion, a backgrounded app, and a settled (non-live) mark are the
 * same completed filled glyph — never a frozen half-draw.
 */
export function BeelineGlyphPaint({
  loop,
  size,
  framing,
  live = true,
  onPainted,
  testID,
}: {
  loop: BeelineGlyphPaintLoop;
  size: number;
  framing: GlyphPaintFraming;
  live?: boolean;
  onPainted?: () => void;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotion();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const progress = useSharedValue(loop === 'once' ? 0 : 1);
  const painted = useRef(false);
  const [complete, setComplete] = useState(false);
  const finish = useCallback(() => {
    if (painted.current) return;
    painted.current = true;
    setComplete(true);
    onPainted?.();
  }, [onPainted]);
  const animating = live && appActive && !reducedMotion;
  const showFill = !animating || complete;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!animating) {
      cancelAnimation(progress);
      progress.value = 1;
      if (loop === 'once') finish();
      return;
    }
    progress.value = 0;
    if (loop === 'once') {
      progress.value = withTiming(
        1,
        {
          duration: SPLASH_PAINT_MS,
          easing: Easing.out(Easing.cubic),
          reduceMotion: ReduceMotion.System,
        },
        (done) => {
          if (done) runOnJS(finish)();
        },
      );
      return () => cancelAnimation(progress);
    }
    // Paint, then release. `withRepeat(..., true)` would linger on the
    // completed stroke every other leg and read as "almost done".
    progress.value = withRepeat(
      withSequence(
        withTiming(1, {
          duration: RELEASE_PAINT_MS,
          easing: Easing.inOut(Easing.cubic),
          reduceMotion: ReduceMotion.System,
        }),
        withTiming(0, {
          duration: RELEASE_UNWIND_MS,
          easing: Easing.inOut(Easing.cubic),
          reduceMotion: ReduceMotion.System,
        }),
        withDelay(
          RELEASE_REST_MS,
          withTiming(0, {
            duration: 1,
            reduceMotion: ReduceMotion.System,
          }),
        ),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [animating, finish, loop, progress]);

  const strokeProps = useAnimatedProps(() => ({
    strokeDashoffset: ribbon.length * (1 - progress.value),
  }));
  const ink = glyphPaintInk(theme.buzz.dark);
  const content = showFill ? (
    <Path d={ribbon.path} fill={ink} fillRule={ribbon.fillRule as 'evenodd' | 'nonzero'} />
  ) : (
    <AnimatedPath
      animatedProps={strokeProps}
      d={ribbon.path}
      fill="none"
      stroke={ink}
      strokeDasharray={[ribbon.length, ribbon.length]}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={GLYPH_STROKE}
    />
  );

  return (
    <Svg
      accessibilityLabel="Beeline mark"
      height={size}
      testID={testID}
      viewBox={glyphViewBox(framing)}
      width={size}
    >
      {framing === 'icon' ? <G transform={ribbon.transform}>{content}</G> : content}
    </Svg>
  );
}
