import { useEffect } from 'react';
import type { TextStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

export const STREAMING_TAIL_FADE_MS = 160;

/** One shared native animation for every text span touched by the tail. */
export function useStreamingTailAnimation({
  active,
  ground,
  tone,
  windowKey,
}: {
  active: boolean;
  ground: string;
  tone: string;
  windowKey: number;
}) {
  const progress = useSharedValue(active ? 0 : 1);

  useEffect(() => {
    cancelAnimation(progress);
    if (!active) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withTiming(1, { duration: STREAMING_TAIL_FADE_MS });
  }, [active, progress, windowKey]);

  const style = useAnimatedStyle(
    () => ({
      color: interpolateColor(progress.value, [0, 1], [ground, tone]),
    }),
    [ground, tone],
  ) as TextStyle;

  return { component: Animated.Text, style };
}
