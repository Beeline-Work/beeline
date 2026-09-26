import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { beelineThemes } from '@/buzz/groknight';
import {
  GLYPH_PAINT,
  GLYPH_STROKE,
  MARK_CELL,
  RELEASE_PAINT_MS,
  RELEASE_UNWIND_MS,
  SPLASH_GLYPH_SIZE,
  SPLASH_PAINT_MS,
  glyphPaintGround,
  glyphPaintInk,
  ribbon,
} from '@/buzz/beeline-glyph';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    View: host('View'),
  };
});

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Path: host('Path'), G: host('G') };
});

const motion = vi.hoisted(() => ({
  reducedMotion: false,
  finishTiming: false,
  repeats: [] as Array<{ count: unknown; reverse: unknown }>,
  sequences: [] as unknown[],
  timings: [] as Array<{ to: number; duration?: number }>,
}));

const themeRef = vi.hoisted(() => ({
  current: { buzz: { dark: true } },
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: themeRef.current }),
  StyleSheet: {
    hairlineWidth: 1,
    create: (definition: unknown) =>
      typeof definition === 'function'
        ? (definition as (value: typeof themeRef.current) => unknown)(themeRef.current)
        : definition,
  },
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props),
      createAnimatedComponent: () => (props: any) =>
        ReactModule.createElement('AnimatedPath', props),
    },
    Easing: {
      cubic: 'cubic',
      inOut: (fn: unknown) => fn,
      linear: 'linear',
      out: (fn: unknown) => fn,
    },
    ReduceMotion: { System: 'system' },
    cancelAnimation: vi.fn(),
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedProps: (factory: () => unknown) => factory(),
    useReducedMotion: () => motion.reducedMotion,
    useSharedValue: (value: number) => ({ value }),
    withDelay: (ms: number, value: unknown) => ({ delay: ms, value }),
    withRepeat: (value: unknown, count: unknown, reverse: unknown) => {
      motion.repeats.push({ count, reverse });
      return value;
    },
    withSequence: (...steps: unknown[]) => {
      motion.sequences.push(steps);
      return steps;
    },
    withTiming: (
      value: number,
      config?: { duration?: number },
      callback?: (finished: boolean) => void,
    ) => {
      motion.timings.push({ to: value, duration: config?.duration });
      if (motion.finishTiming) callback?.(true);
      return value;
    },
  };
});

import { BeelineGlyphPaint } from './BeelineGlyphPaint';
import { BeelineMarkSpinner } from './BeelineMarkSpinner';

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
  themeRef.current = { buzz: beelineThemes.obsidian };
});

afterEach(() => {
  motion.reducedMotion = false;
  motion.finishTiming = false;
  motion.repeats = [];
  motion.sequences = [];
  motion.timings = [];
  themeRef.current = { buzz: beelineThemes.obsidian };
});

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function dots(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('View').filter((node) => {
    const style = node.props.style;
    const resolved = Array.isArray(style) ? Object.assign({}, ...style) : style;
    return resolved?.width === 5 || resolved?.width === 7;
  });
}

describe('BeelineGlyphPaint', () => {
  it('paints the splash once and does not reverse-loop', () => {
    const onPainted = vi.fn();
    const renderer = render(
      React.createElement(BeelineGlyphPaint, {
        framing: 'icon',
        loop: 'once',
        onPainted,
        size: SPLASH_GLYPH_SIZE,
        testID: 'glyph',
      }),
    );
    expect(motion.repeats).toHaveLength(0);
    expect(motion.timings.some((step) => step.to === 1 && step.duration === SPLASH_PAINT_MS)).toBe(
      true,
    );
    expect(onPainted).not.toHaveBeenCalled();
    const svg = renderer.root.findByType('Svg');
    expect(svg.props.width).toBe(SPLASH_GLYPH_SIZE);
    expect(svg.props.viewBox).toBe(ribbon.iconViewBox);
    expect(renderer.root.findAllByType('G')[0].props.transform).toBe(ribbon.transform);
    const stroke = renderer.root.findByType('AnimatedPath');
    expect(stroke.props.fill).toBe('none');
    expect(stroke.props.stroke).toBe(GLYPH_PAINT.darkInk);
    expect(stroke.props.strokeWidth).toBe(GLYPH_STROKE);
    expect(stroke.props.d).toBe(ribbon.path);
    expect(dots(renderer)).toHaveLength(0);
    expect(renderer.root.findAllByType('Text')).toHaveLength(0);
  });

  it('holds the filled icon when the splash stroke finishes', () => {
    motion.finishTiming = true;
    const onPainted = vi.fn();
    const renderer = render(
      React.createElement(BeelineGlyphPaint, {
        framing: 'icon',
        loop: 'once',
        onPainted,
        size: SPLASH_GLYPH_SIZE,
      }),
    );
    expect(onPainted).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType('AnimatedPath')).toHaveLength(0);
    const [mark] = renderer.root.findAllByType('Path');
    expect(mark.props.fill).toBe(GLYPH_PAINT.darkInk);
    expect(mark.props.d).toBe(ribbon.path);
  });

  it('releases the thinking stroke instead of lingering complete', () => {
    render(
      React.createElement(BeelineGlyphPaint, {
        framing: 'cell',
        live: true,
        loop: 'release',
        size: MARK_CELL,
      }),
    );
    expect(motion.repeats).toEqual([{ count: -1, reverse: false }]);
    expect(motion.sequences).toHaveLength(1);
    const legs = motion.timings.filter((step) => step.duration && step.duration > 1);
    expect(legs.map((step) => step.to)).toEqual([1, 0]);
    expect(legs[0]?.duration).toBe(RELEASE_PAINT_MS);
    expect(legs[1]?.duration).toBe(RELEASE_UNWIND_MS);
  });

  it('uses ink on cream and brass on aubergine, never the UI accent', () => {
    const dark = render(
      React.createElement(BeelineGlyphPaint, {
        framing: 'cell',
        live: true,
        loop: 'release',
        size: MARK_CELL,
      }),
    );
    expect(dark.root.findByType('AnimatedPath').props.stroke).toBe(glyphPaintInk(true));
    expect(dark.root.findByType('AnimatedPath').props.stroke).not.toBe(
      beelineThemes.obsidian.accent,
    );

    themeRef.current = { buzz: beelineThemes.bone };
    const light = render(
      React.createElement(BeelineGlyphPaint, {
        framing: 'cell',
        live: true,
        loop: 'release',
        size: MARK_CELL,
      }),
    );
    expect(light.root.findByType('AnimatedPath').props.stroke).toBe(glyphPaintInk(false));
    expect(light.root.findByType('AnimatedPath').props.stroke).toBe(GLYPH_PAINT.lightInk);
    expect(glyphPaintGround(false)).toBe(GLYPH_PAINT.lightGround);
    expect(glyphPaintGround(true)).toBe(GLYPH_PAINT.darkGround);
  });

  it('shows a still, complete glyph under reduced motion', () => {
    motion.reducedMotion = true;
    const onPainted = vi.fn();
    const renderer = render(
      React.createElement(BeelineGlyphPaint, {
        framing: 'icon',
        loop: 'once',
        onPainted,
        size: SPLASH_GLYPH_SIZE,
      }),
    );
    expect(onPainted).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType('AnimatedPath')).toHaveLength(0);
    const [mark] = renderer.root.findAllByType('Path');
    expect(mark.props.fill).toBe(GLYPH_PAINT.darkInk);
    expect(mark.props.strokeDasharray).toBeUndefined();
  });

  it('keeps the thinking spinner as a release paint, never dots', () => {
    const renderer = render(React.createElement(BeelineMarkSpinner, { live: true }));
    expect(renderer.root.findByType('Svg').props.width).toBe(MARK_CELL);
    expect(renderer.root.findByType('AnimatedPath').props.d).toBe(ribbon.path);
    expect(dots(renderer)).toHaveLength(0);
    expect(motion.repeats[0]?.reverse).toBe(false);
  });
});
