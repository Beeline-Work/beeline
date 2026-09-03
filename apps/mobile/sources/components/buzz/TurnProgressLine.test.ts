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

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Path: host('Path') };
});

const motion = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props),
      // The animated path renders under its own host name so a test can tell
      // the drawing ribbon from the static completed mark.
      createAnimatedComponent: () => (props: any) =>
        ReactModule.createElement('AnimatedPath', props),
    },
    Easing: {
      cubic: 'cubic',
      inOut: (fn: unknown) => fn,
      linear: 'linear',
      out: (fn: unknown) => fn,
      poly: (n: number) => n,
    },
    ReduceMotion: { System: 'system' },
    useAnimatedProps: (factory: () => unknown) => factory(),
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => motion.reducedMotion,
    useSharedValue: (value: number) => ({ value }),
    withDelay: (_ms: number, value: unknown) => value,
    withRepeat: (value: unknown) => value,
    withTiming: (value: number) => value,
    withSequence: (value: unknown) => value,
    FadeInDown: { duration: () => ({}) },
  };
});

import { groknight } from '@/buzz/groknight';
import { MARK_CELL, ribbon } from './BeelineMarkSpinner';
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
  afterEach(() => {
    vi.useRealTimers();
    motion.reducedMotion = false;
  });

  it('says the agent is thinking, and nothing about any corner', () => {
    const renderer = render(
      React.createElement(TurnProgressLine, { label: 'beebee thinking\u2026' }),
    );
    const label = renderer.root.findAllByType('Text')[0];
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

  it('draws the Beeline mark as a brass ribbon, not a cycling text glyph', () => {
    const renderer = render(
      React.createElement(TurnProgressLine, {
        label: 'beebee Thinking\u2026',
        startedAt: 1_000,
        testID: 'turn-progress-line',
      }),
    );
    const cell = renderer.root.findByProps({ testID: 'turn-progress-line-glyph' });
    // The mark is vector, in the cell; no Text carries a glyph before the label.
    expect(cell.findAllByType('Text')).toHaveLength(0);
    expect(cell.findAllByType('Svg')).toHaveLength(1);
    const ribbons = cell.findAllByType('AnimatedPath');
    expect(ribbons.length).toBeGreaterThanOrEqual(1);
    for (const path of ribbons) {
      // The authoritative geometry, stroked in the one accent: no fill, no
      // second colour, and a dash as long as the outline so it can draw itself.
      expect(path.props.d).toBe(ribbon.path);
      expect(path.props.stroke).toBe(groknight.accent);
      expect(path.props.fill).toBe('none');
      expect(path.props.strokeDasharray).toEqual([ribbon.length, ribbon.length]);
    }
    // Live means drawing: the static completed outline is not what is shown.
    expect(cell.findAllByType('Path')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text')[0].props.children).toBe('beebee Thinking\u2026');
  });

  it('holds the mark in a fixed square so the label never jitters', () => {
    const renderer = render(
      React.createElement(TurnProgressLine, {
        label: 'beebee Thinking\u2026',
        startedAt: 1_000,
        testID: 'turn-progress-line',
      }),
    );
    const cell = renderer.root.findByProps({ testID: 'turn-progress-line-glyph' });
    expect(cell.findAllByType('Text')).toHaveLength(0);
    expect(cell.props.style).toMatchObject({
      width: MARK_CELL,
      height: MARK_CELL,
      flexShrink: 0,
      alignItems: 'center',
    });
    expect(MARK_CELL).toBe(18);
  });

  it('shows the completed static mark under reduced motion', () => {
    motion.reducedMotion = true;
    const renderer = render(
      React.createElement(TurnProgressLine, {
        label: 'beebee Thinking\u2026',
        startedAt: 1_000,
        testID: 'turn-progress-line',
      }),
    );
    const cell = renderer.root.findByProps({ testID: 'turn-progress-line-glyph' });
    expect(cell.findAllByType('AnimatedPath')).toHaveLength(0);
    const [mark] = cell.findAllByType('Path');
    expect(mark.props.d).toBe(ribbon.path);
    expect(mark.props.stroke).toBe(groknight.accent);
    expect(mark.props.strokeDasharray).toBeUndefined();
  });

  it('settles to a static past-tense summary, with no counter', () => {
    const renderer = render(
      React.createElement(TurnSettledLine, {
        line: 'Brewed for 14s \u00b7 done 7:10 PM',
        testID: 'turn-settled-line',
      }),
    );
    const texts = renderer.root.findAllByType('Text');
    expect(texts.map((text) => text.props.children)).toEqual([
      'Brewed for 14s \u00b7 done 7:10 PM',
    ]);
    expect(renderer.root.findAllByType('AnimatedView')).toHaveLength(0);
    // The settled row shares the live row's vocabulary: the same mark, in the
    // same fixed cell, completed and still.
    const cell = renderer.root.findByProps({ testID: 'turn-settled-line-glyph' });
    expect(cell.props.style).toMatchObject({ width: MARK_CELL, height: MARK_CELL, flexShrink: 0 });
    expect(cell.findAllByType('AnimatedPath')).toHaveLength(0);
    const [mark] = cell.findAllByType('Path');
    expect(mark.props.d).toBe(ribbon.path);
    expect(mark.props.stroke).toBe(groknight.accent);
    expect(mark.props.fill).toBe('none');
  });
});
