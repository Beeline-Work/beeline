import React, { useEffect, useRef } from 'react';
import { Text, type TextProps } from 'react-native';

export const STREAMING_TAIL_FADE_MS = 160;

/** React Native Web has no independent Reanimated UI runtime. */
const WebAnimatedTailText = React.memo(function WebAnimatedTailText(props: TextProps) {
  const ref = useRef<React.ElementRef<typeof Text>>(null);
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node?.animate) return;
    const animation = node.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: STREAMING_TAIL_FADE_MS,
      easing: 'linear',
      fill: 'forwards',
    });
    return () => animation.cancel();
  }, []);
  return <Text {...props} ref={ref} />;
});

export function useStreamingTailAnimation({ active }: { active: boolean }) {
  return {
    component: active ? WebAnimatedTailText : Text,
    style: undefined,
  };
}
