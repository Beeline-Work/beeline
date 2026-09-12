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

function pressableStyle(node: { props: { style?: unknown } }, pressed = false) {
  const style = node.props.style;
  const resolved =
    typeof style === 'function'
      ? (style as (state: { pressed: boolean }) => unknown)({ pressed })
      : style;
  return (Array.isArray(resolved) ? resolved : [resolved]).filter(Boolean);
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

  it('offers the requester one stop, and everyone else the line unchanged', () => {
    // No `onStop` is the ordinary case — a spectator's line is byte-for-byte
    // what it was before the control existed.
    const watching = render(
      React.createElement(TurnProgressLine, {
        label: 'beebee Thinking\u2026',
        startedAt: 10,
        testID: 'turn-progress-line',
      }),
    );
    expect(watching.root.findAllByType('Pressable')).toHaveLength(0);

    const onStop = vi.fn();
    const asking = render(
      React.createElement(TurnProgressLine, {
        label: 'beebee Thinking\u2026',
        startedAt: 10,
        onStop,
        testID: 'turn-progress-line',
      }),
    );
    // Exactly one control, and it is the stop: the LINE still goes nowhere.
    const [stop] = asking.root.findAllByType('Pressable');
    expect(asking.root.findAllByType('Pressable')).toHaveLength(1);
    expect(stop.props.testID).toBe('turn-progress-line-stop');
    expect(stop.props.accessibilityRole).toBe('button');
    expect(stop.props.accessibilityLabel).toBe('Stop this turn');
    expect(stop.props.hitSlop).toBe(17);
    expect(stop.props.disabled).toBe(false);
    expect(pressableStyle(stop)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          width: 10,
          height: 10,
          borderRadius: groknight.radius,
          backgroundColor: groknight.accent,
        }),
      ]),
    );
    expect(pressableStyle(stop, true)).toEqual(
      expect.arrayContaining([expect.objectContaining({ opacity: 0.6 })]),
    );
    expect(stop.findAllByType('Text')).toHaveLength(0);
    act(() => stop.props.onPress());
    expect(onStop).toHaveBeenCalledTimes(1);

    // It sits at the right, after the elapsed counter, so the label's own
    // left edge and the counter's place never move for anybody.
    const row = stop.parent;
    expect(row?.children.indexOf(stop)).toBe((row?.children.length ?? 0) - 1);
  });

  it('empties the square and says stopping the moment the asker has pressed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_500);
    const onStop = vi.fn();
    const renderer = render(
      React.createElement(TurnProgressLine, {
        label: 'beebee Thinking\u2026',
        startedAt: 10,
        onStop,
        stopping: true,
        testID: 'turn-progress-line',
      }),
    );
    const [stop] = renderer.root.findAllByType('Pressable');
    expect(stop.props.disabled).toBe(true);
    expect(stop.props.accessibilityLabel).toBe('Stopping this turn');
    expect(stop.props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(renderer.root.findByProps({ testID: 'turn-progress-line-elapsed' }).props.children).toBe(
      '2s \u00b7 stopping',
    );
    expect(renderer.root.findAllByType('View')[0].props.accessibilityLabel).toBe(
      'beebee Thinking\u2026 (2s \u00b7 stopping)',
    );
    expect(pressableStyle(stop)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backgroundColor: 'transparent',
          borderWidth: 1,
          borderColor: groknight.accent,
        }),
      ]),
    );
    // Pressed must not layer on top of stopping: the empty square is the state.
    expect(pressableStyle(stop, true)).toEqual(pressableStyle(stop, false));
    expect(stop.props.onPress).toBeUndefined();
    expect(onStop).not.toHaveBeenCalled();
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
    expect(counter()).toBe('2s');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(counter()).toBe('3s');
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(counter()).toBe('12s');
  });

  it('shows and announces the server-backed received state beside the running turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_500);
    const renderer = render(
      React.createElement(TurnProgressLine, {
        label: 'Sol Brewing…',
        startedAt: 10,
        received: true,
        testID: 'turn-progress-line',
      }),
    );

    expect(
      renderer.root.findByProps({ testID: 'turn-progress-line-received' }).props.children,
    ).toBe('· received');
    expect(renderer.root.findAllByType('View')[0].props.accessibilityLabel).toBe(
      'Sol Brewing… (2s · received)',
    );
    expect(renderer.root.findAllByType('View')[0].props.accessibilityLiveRegion).toBe('polite');
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
