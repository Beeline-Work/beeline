import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

// MonoHull pulls in expo-haptics, which reaches expo-modules-core and its
// React-Native-only `__DEV__` global.
vi.mock('expo-haptics', () => ({
  impactAsync: () => undefined,
  notificationAsync: () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: { View: (props: any) => ReactModule.createElement('AnimatedView', props) },
    Easing: { linear: 'linear', out: (fn: unknown) => fn, poly: (n: number) => n },
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: number) => value,
    withSequence: (value: unknown) => value,
    FadeInDown: {
      duration: () => ({
        easing: () => ({
          reduceMotion: () => ({ withInitialValues: () => ({}) }),
        }),
      }),
    },
  };
});

vi.mock('@/constants/Typography', () => ({
  Typography: Object.assign(() => ({}), {
    default: () => ({}),
    ledger: () => ({}),
    mono: () => ({}),
  }),
}));

import { NewMessageMaterialize } from './MonoHull';
import { resetMessageReveals } from '@/buzz/message-reveal';
import { Platform } from 'react-native';

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
afterEach(() => resetMessageReveals());

function materialize(messageId: string | undefined, enabled: boolean, body: string) {
  return React.createElement(NewMessageMaterialize, { enabled, messageId }, [
    React.createElement('Text', { key: 'body' }, body),
  ]);
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

/** The entrance wrapper `NewMessageMaterialize` mounts when animating. */
function animatedWrappers(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('AnimatedView');
}

function enteringConfig(renderer: ReactTestRenderer) {
  return animatedWrappers(renderer)[0]?.props.entering;
}

describe('NewMessageMaterialize', () => {
  it('keeps a new web picture and later text row in normal flow through settlement', () => {
    const previous = Platform.OS;
    (Platform as { OS: string }).OS = 'web';
    try {
      const renderer = render(materialize('picture-send', true, 'picture'));
      expect(animatedWrappers(renderer)).toHaveLength(0);
      expect(renderer.root.findByType('View')).toBeDefined();
      act(() => renderer.update(materialize('picture-send', true, 'picture')));
      expect(animatedWrappers(renderer)).toHaveLength(0);
      const text = render(materialize('text-after-picture', true, 'later text'));
      expect(animatedWrappers(text)).toHaveLength(0);
      expect(text.root.findByType('View')).toBeDefined();
    } finally {
      (Platform as { OS: string }).OS = previous;
    }
  });

  it('animates a genuinely new message exactly once', () => {
    const renderer = render(materialize('m1', true, 'hello'));
    expect(animatedWrappers(renderer)).toHaveLength(1);
  });

  it('never replays the entrance on re-render of the same mounted row', () => {
    const renderer = render(materialize('m1', true, 'hello'));
    expect(animatedWrappers(renderer)).toHaveLength(1);
    // Presence ticks / roster updates re-render the row constantly; the
    // decision must stay put for the instance's lifetime.
    renderer.update(materialize('m1', true, 'hello'));
    expect(animatedWrappers(renderer)).toHaveLength(1);
  });

  it('does not replay after the row unmounts and remounts (scroll-back, Room re-entry)', () => {
    const first = render(materialize('m1', true, 'hello'));
    expect(animatedWrappers(first)).toHaveLength(1);
    act(() => first.unmount());

    const second = render(materialize('m1', true, 'hello'));
    // Same id, already revealed this session: a plain static wrapper.
    expect(animatedWrappers(second)).toHaveLength(0);
    expect(second.root.findByType('View')).toBeDefined();
  });

  it('keeps the same entering config identity across a sibling-driven re-render, so Reanimated does not restart the animation mid-flight', () => {
    const renderer = render(materialize('m1', true, 'hello'));
    const first = enteringConfig(renderer);
    expect(first).toBeDefined();
    // A sibling re-render (presence tick, roster update) re-renders this row
    // too; the `entering` prop must be the same reference or Reanimated
    // treats it as a new animation and restarts it mid-flight.
    act(() => renderer.update(materialize('m1', true, 'hello')));
    const second = enteringConfig(renderer);
    expect(second).toBe(first);
  });

  it('still gives a different message its own entrance', () => {
    const first = render(materialize('m1', true, 'one'));
    act(() => first.unmount());
    const second = render(materialize('m2', true, 'two'));
    expect(animatedWrappers(second)).toHaveLength(1);
  });

  it('a disabled row neither animates nor spends its id', () => {
    const first = render(materialize('m1', false, 'old'));
    expect(animatedWrappers(first)).toHaveLength(0);
    act(() => first.unmount());
    const second = render(materialize('m1', false, 'old'));
    expect(animatedWrappers(second)).toHaveLength(0);
  });

  it('animates without an id (defensive legacy shape), once per instance', () => {
    const renderer = render(materialize(undefined, true, 'hello'));
    expect(animatedWrappers(renderer)).toHaveLength(1);
  });
});
