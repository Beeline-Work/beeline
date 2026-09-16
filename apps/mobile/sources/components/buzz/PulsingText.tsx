import React, { useEffect, useRef } from 'react';
import { Animated, Text, TextProps } from 'react-native';

/**
 * A text whose opacity gently pulses in a loop — the "currently executing"
 * gold step marker on the connect screen. Reduced motion is honored through
 * the OS accessibility setting; a still, fully visible label is the fallback.
 */
export function PulsingText({ children, style, ...rest }: TextProps) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 750, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.Text accessibilityLiveRegion="polite" style={[style, { opacity: pulse }]} {...rest}>
      {children}
    </Animated.Text>
  );
}
