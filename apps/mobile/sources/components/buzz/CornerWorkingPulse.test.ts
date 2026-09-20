import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const motion = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

// MonoHull (the source of the shared motion tokens) pulls in expo-haptics,
// which reaches expo-modules-core and its React-Native-only `__DEV__` global.
vi.mock('expo-haptics', () => ({
  impactAsync: () => undefined,
  notificationAsync: () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('@/buzz/room-indicators', () => ({
  isPinnedCornerLive: (status: string) => status === 'working',
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: { View: (props: any) => ReactModule.createElement('AnimatedView', props) },
    Easing: { linear: 'linear', out: (fn: unknown) => fn, poly: (n: number) => n },
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => motion.reducedMotion,
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: number) => value,
    withSequence: (value: unknown) => value,
    FadeInDown: { duration: () => ({}) },
  };
});

import { CornerWorkingPulse } from './CornerWorkingPulse';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  motion.reducedMotion = false;
});

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

/** The breathing wrapper, present only while something is genuinely live. */
function pulses(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('AnimatedView');
}

describe('the corner working pulse', () => {
  it('gives every surface the same canonical working-only pulse', () => {
    // The Room's pinned corner line is retired; the Room-list row is what
    // still breathes, and only for a corner that is genuinely working.
    const label = React.createElement('Text', null, 'WORKING');
    expect(
      pulses(render(React.createElement(CornerWorkingPulse, { state: 'working' }, label))),
    ).toHaveLength(1);
    for (const state of ['waiting', 'review', 'archived'] as const) {
      expect(
        pulses(render(React.createElement(CornerWorkingPulse, { state }, label))),
      ).toHaveLength(0);
    }
  });

  it('settles the working breath under reduced motion', () => {
    motion.reducedMotion = true;
    const pulse = pulses(
      render(
        React.createElement(
          CornerWorkingPulse,
          { state: 'working' },
          React.createElement('Text', null, 'WORKING'),
        ),
      ),
    )[0];
    expect(pulse?.props.style.flat().at(-1)).toEqual({ opacity: 1 });
  });
});
