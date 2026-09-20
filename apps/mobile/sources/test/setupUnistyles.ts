import React from 'react';
import { vi } from 'vitest';
import { beelineThemes } from '../buzz/groknight';

(globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;

vi.mock('expo-modules-core', () => ({
  CodedError: class CodedError extends Error {},
  EventEmitter: class EventEmitter {},
  requireOptionalNativeModule: () => null,
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { app: {} } } },
}));
vi.mock('react-native-device-info', () => ({
  getDeviceType: () => 'Handset',
}));
vi.mock('@expo/vector-icons', () => ({
  FontAwesome: 'FontAwesome',
  Ionicons: 'Ionicons',
}));

// Glyph primitives (chevrons, the corner sigil, the members mark) are drawn
// shapes now, so any component tree can contain one. Node tests never load
// react-native-svg's native entrypoint; render its elements as plain hosts.
vi.mock('react-native-svg', () => {
  const host = (name: string) => (props: Record<string, unknown>) =>
    React.createElement(name, props, props.children as React.ReactNode);
  return {
    default: host('Svg'),
    Svg: host('Svg'),
    Circle: host('Circle'),
    Ellipse: host('Ellipse'),
    G: host('G'),
    Line: host('Line'),
    Path: host('Path'),
    Polygon: host('Polygon'),
    Polyline: host('Polyline'),
    Rect: host('Rect'),
  };
});

const animationBuilder = {
  duration: () => animationBuilder,
  easing: () => animationBuilder,
  reduceMotion: () => animationBuilder,
  withInitialValues: () => animationBuilder,
};
vi.mock('react-native-reanimated', () => ({
  default: {
    Text: (props: Record<string, unknown>) => React.createElement('Text', props),
    View: (props: Record<string, unknown>) => React.createElement('View', props),
    createAnimatedComponent: (component: unknown) => component,
  },
  Easing: { cubic: 'cubic', inOut: (value: unknown) => value, out: (value: unknown) => value },
  FadeOut: animationBuilder,
  ReduceMotion: { System: 'system' },
  cancelAnimation: vi.fn(),
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[output.length - 1] : output[0],
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedProps: (factory: () => unknown) => factory(),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useReducedMotion: () => false,
  useSharedValue: (value: unknown) => ({ value }),
  withDelay: (_delay: number, value: unknown) => value,
  withRepeat: (value: unknown) => value,
  withSequence: (...steps: unknown[]) => steps[0],
  withTiming: (value: unknown) => value,
}));

const theme = { buzz: beelineThemes.obsidian };

// Production configures Unistyles before rendering. Unit tests run in Node and
// intentionally do not load React Native's Flow entrypoint, so give style-only
// modules the deterministic default theme they would receive in the app.
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    configure: vi.fn(),
    create: (definition: unknown) =>
      typeof definition === 'function'
        ? (definition as (value: typeof theme) => unknown)(theme)
        : definition,
  },
  UnistylesRuntime: {
    setTheme: vi.fn(),
    setAdaptiveThemes: vi.fn(),
    setRootViewBackgroundColor: vi.fn(),
  },
  useUnistyles: () => ({ theme }),
}));
