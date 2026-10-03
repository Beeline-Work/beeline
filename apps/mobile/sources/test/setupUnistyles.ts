import React from 'react';
import { beforeEach, vi } from 'vitest';
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
// Haptics talk to the device; `Button` fires one on every primary press.
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
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
  Easing: {
    cubic: 'cubic',
    linear: 'linear',
    poly: () => 'poly',
    inOut: (value: unknown) => value,
    out: (value: unknown) => value,
  },
  FadeInDown: animationBuilder,
  FadeOut: animationBuilder,
  ReduceMotion: { System: 'system' },
  cancelAnimation: vi.fn(),
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[output.length - 1] : output[0],
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedProps: (factory: () => unknown) => factory(),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useFrameCallback: () => ({ setActive: vi.fn(), isActive: false }),
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

// Draft component tests use public test addressing; identity-storage/session
// suites retain their own real modules and platform mocks.
vi.mock('@/buzz/draft-identity', () => ({
  useDraftIdentity: (explicit?: string | null) =>
    explicit === undefined ? 'test-viewer' : explicit,
}));
const draftTestValues = vi.hoisted(() => new Map<string, string>());
beforeEach(() => draftTestValues.clear());
vi.mock('@react-native-async-storage/async-storage', () => {
  const values = draftTestValues;
  return {
    default: {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    },
  };
});
