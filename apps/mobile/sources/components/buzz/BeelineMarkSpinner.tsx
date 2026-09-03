import React, { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import beelineMark from '@/buzz/beeline-mark.json';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** The square the mark sits in: as tall as the 12px mono label's 18px line. */
export const MARK_CELL = 18;
/** One draw + one unwind. Ping-ponged, so the ribbon never jumps. */
export const RIBBON_CYCLE_MS = 2_000;
const RIBBON_STROKE = 7;
const RIBBON_TRAIL_DELAY_MS = 140;
const RIBBON_TRAIL_OPACITY = 0.3;
/** Fraction of the cell the mark's height takes — the optical size of the label's glyphs. */
const MARK_CELL_FILL = 13 / 18;

/**
 * The shipped mark (`sources/assets/images/mark.svg`) is one closed polyline —
 * the outline of a continuous ribbon. Its length in path units is the dash the
 * drawing loop slides; its tight box is the view, so the mark, not the padded
 * 240-unit canvas, fills the cell.
 */
export const ribbon = (() => {
  const points = Array.from(
    beelineMark.path.matchAll(/[ML]\s*([\d.]+)\s+([\d.]+)/g),
    ([, x, y]) => [Number(x), Number(y)] as const,
  );
  let length = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  points.forEach(([x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length]!;
    length += Math.hypot(nextX - x, nextY - y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  const side = Math.max(maxX - minX, maxY - minY) / MARK_CELL_FILL;
  const originX = (minX + maxX - side) / 2;
  const originY = (minY + maxY - side) / 2;
  return {
    path: beelineMark.path,
    length,
    viewBox: `${originX.toFixed(3)} ${originY.toFixed(3)} ${side.toFixed(3)} ${side.toFixed(3)}`,
  };
})();

/**
 * The Beeline mark as the thinking line's glyph. Live, one brass stroke draws
 * the ribbon's outline from nothing, completes the shape, unwinds and redraws,
 * with a fainter pass trailing it; the loop reads as a ribbon swirling into the
 * mark, and because it returns to nothing every cycle it claims no finish.
 * Settled, reduced-motion, or backgrounded, it is the completed static outline
 * — the same mark, so the live and settled rows share one vocabulary.
 *
 * Stroke only, in the one accent: no fill, no glow, no second colour.
 */
export const BeelineMarkSpinner = React.memo(function BeelineMarkSpinner({
  live = false,
  testID,
}: {
  live?: boolean;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotion();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const progress = useSharedValue(1);
  const trail = useSharedValue(1);
  const animating = live && appActive && !reducedMotion;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!animating) {
      progress.value = 1;
      trail.value = 1;
      return;
    }
    // Ease-out on the draw, so the reversed unwind is ease-in: the stroke
    // lingers on the completed mark and passes quickly through empty — the
    // cell must never read as blank. One animation object per shared value:
    // reanimated mutates it per frame.
    const leg = () =>
      withRepeat(
        withTiming(1, {
          duration: RIBBON_CYCLE_MS / 2,
          easing: Easing.out(Easing.cubic),
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        true,
      );
    progress.value = 0;
    trail.value = 0;
    progress.value = leg();
    trail.value = withDelay(RIBBON_TRAIL_DELAY_MS, leg());
  }, [animating, progress, trail]);

  const strokeProps = useAnimatedProps(() => ({
    strokeDashoffset: ribbon.length * (1 - progress.value),
  }));
  const trailProps = useAnimatedProps(() => ({
    strokeDashoffset: ribbon.length * (1 - trail.value),
  }));

  const stroke = {
    d: ribbon.path,
    fill: 'none',
    stroke: theme.buzz.accent,
    strokeWidth: RIBBON_STROKE,
    strokeLinejoin: 'round',
    strokeLinecap: 'round',
  } as const;

  return (
    <Svg
      accessibilityLabel="Beeline mark"
      height={MARK_CELL}
      testID={testID}
      viewBox={ribbon.viewBox}
      width={MARK_CELL}
    >
      {animating ? (
        <>
          <AnimatedPath
            {...stroke}
            animatedProps={trailProps}
            opacity={RIBBON_TRAIL_OPACITY}
            strokeDasharray={[ribbon.length, ribbon.length]}
          />
          <AnimatedPath
            {...stroke}
            animatedProps={strokeProps}
            strokeDasharray={[ribbon.length, ribbon.length]}
          />
        </>
      ) : (
        <Path {...stroke} />
      )}
    </Svg>
  );
});
