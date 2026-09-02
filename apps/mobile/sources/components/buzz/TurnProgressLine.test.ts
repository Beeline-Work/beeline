import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
    FadeInDown: { duration: () => ({}) },
  };
});

import { groknight } from '@/buzz/groknight';
import { SPINNER_FRAMES, SPINNER_STEP_MS } from '@/buzz/turn-clock';
import { TurnProgressLine, TurnSettledLine } from './TurnProgressLine';

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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('the per-turn progress indicator', () => {
  afterEach(() => vi.useRealTimers());

  it('says the agent is thinking, and nothing about any corner', () => {
    const renderer = render(
      React.createElement(TurnProgressLine, { label: 'beebee thinking\u2026' }),
    );
    const label = renderer.root.findAllByType('Text')[1];
    expect(label.props.children).toBe('beebee thinking\u2026');
    // No `view \u2192`: there is nowhere for a turn in progress to go.
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
  });

  it('cannot be pressed', () => {
    const renderer = render(
      React.createElement(TurnProgressLine, { label: 'beebee thinking\u2026' }),
    );
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(renderer.root.findAllByType('View')[0].props.accessibilityRole).toBe('progressbar');
  });

  it('breathes on the same live clock, in the same reserved gold', () => {
    const renderer = render(
      React.createElement(TurnProgressLine, { label: 'beebee thinking\u2026' }),
    );
    expect(renderer.root.findAllByType('AnimatedView')).toHaveLength(1);
    expect(renderer.root.findAllByType('Text')[0].props.style.color).toBe(groknight.accent);
  });

  it('is a status light, not a plate: no border, no fill, no radius', () => {
    const renderer = render(
      React.createElement(TurnProgressLine, { label: 'beebee thinking\u2026' }),
    );
    const bar = renderer.root.findAllByType('View')[0];
    expect(bar.props.style).not.toHaveProperty('borderWidth');
    expect(bar.props.style).not.toHaveProperty('borderRadius');
    expect(bar.props.style).not.toHaveProperty('backgroundColor');
  });

  it('ticks the elapsed counter once per second from the receipt time', () => {
    vi.useFakeTimers();
    const startedAt = 10; // unix seconds
    vi.setSystemTime(12_500);
    const renderer = render(
      React.createElement(TurnProgressLine, {
        label: 'beebee Thinking\u2026',
        startedAt,
        testID: 'turn-progress-line',
      }),
    );
    const counter = () =>
      renderer.root.findByProps({ testID: 'turn-progress-line-elapsed' }).props.children;
    expect(counter()).toBe('2s \u00b7 thinking');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(counter()).toBe('3s \u00b7 thinking');
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(counter()).toBe('12s \u00b7 thinking');
  });

  it('cycles the spinner glyph forward and back while counting', () => {
    vi.useFakeTimers();
    const startedAt = 1_000;
    vi.setSystemTime(startedAt * 1_000);
    const renderer = render(
      React.createElement(TurnProgressLine, { label: 'beebee Thinking\u2026', startedAt }),
    );
    const glyph = () => renderer.root.findAllByType('Text')[0].props.children;
    expect(glyph()).toBe(SPINNER_FRAMES[0]);
    for (let step = 1; step <= 5; step += 1) {
      act(() => {
        vi.advanceTimersByTime(SPINNER_STEP_MS);
      });
      expect(glyph()).toBe(SPINNER_FRAMES[step]);
    }
    // Turnaround: the next step bounces back, never jumps.
    act(() => {
      vi.advanceTimersByTime(SPINNER_STEP_MS);
    });
    expect(glyph()).toBe(SPINNER_FRAMES[4]);
  });

  it('settles to a static past-tense summary, with no counter', () => {
    const renderer = render(
      React.createElement(TurnSettledLine, { line: 'Brewed for 14s \u00b7 done 7:10 PM' }),
    );
    const texts = renderer.root.findAllByType('Text');
    expect(texts.map((text) => text.props.children)).toEqual([
      SPINNER_FRAMES[SPINNER_FRAMES.length - 1],
      'Brewed for 14s \u00b7 done 7:10 PM',
    ]);
    expect(renderer.root.findAllByType('AnimatedView')).toHaveLength(0);
  });
});
