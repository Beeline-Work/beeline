import * as React from 'react';
import { readFileSync } from 'node:fs';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { beelineThemes } from '@/buzz/groknight';
import { GLYPH_PAINT, SPLASH_GLYPH_SIZE, glyphPaintGround, ribbon } from '@/buzz/beeline-glyph';

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

const motion = vi.hoisted(() => ({ reducedMotion: false, repeats: [] as unknown[] }));
const themeRef = vi.hoisted(() => ({ current: { buzz: { dark: true } } }));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: themeRef.current }),
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      createAnimatedComponent: () => (props: any) =>
        ReactModule.createElement('AnimatedPath', props),
    },
    Easing: { cubic: 'cubic', inOut: (fn: unknown) => fn, out: (fn: unknown) => fn },
    ReduceMotion: { System: 'system' },
    cancelAnimation: vi.fn(),
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedProps: (factory: () => unknown) => factory(),
    useReducedMotion: () => motion.reducedMotion,
    useSharedValue: (value: number) => ({ value }),
    withDelay: (_ms: number, value: unknown) => value,
    withRepeat: (value: unknown, _count: unknown, reverse: unknown) => {
      motion.repeats.push(reverse);
      return value;
    },
    withSequence: (...steps: unknown[]) => steps,
    withTiming: (value: number) => value,
  };
});

import { BootPaint } from './BootPaint';

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
  motion.repeats = [];
  themeRef.current = { buzz: beelineThemes.obsidian };
});

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('BootPaint', () => {
  it('paints the glyph once on the dark splash ground, with no dots', () => {
    const onPainted = vi.fn();
    const onReady = vi.fn();
    const renderer = render(
      React.createElement(BootPaint, { onPainted, onReady, testID: 'boot-paint' }),
    );
    const screen = renderer.root.findByType('View');
    expect(screen.props.testID).toBe('boot-paint');
    expect(screen.props.style).toEqual(
      expect.objectContaining({ backgroundColor: GLYPH_PAINT.darkGround }),
    );
    expect(screen.props.accessibilityRole).toBe('progressbar');
    expect(glyphPaintGround(true)).toBe('#14091A');
    expect(renderer.root.findByType('Svg').props.width).toBe(SPLASH_GLYPH_SIZE);
    expect(renderer.root.findByType('G').props.transform).toBe(ribbon.transform);
    expect(renderer.root.findByType('AnimatedPath').props.d).toBe(ribbon.path);
    expect(motion.repeats).toHaveLength(0);
    expect(renderer.root.findAllByType('Text')).toHaveLength(0);
    const styles = renderer.root.findAllByType('View').flatMap((node) => {
      const style = node.props.style;
      return Array.isArray(style) ? style : [style];
    });
    expect(styles.some((style) => style?.width === 5 || style?.width === 7)).toBe(false);
    act(() => screen.props.onLayout());
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('matches the light splash ground so the OS handoff does not flash', () => {
    themeRef.current = { buzz: beelineThemes.bone };
    const renderer = render(React.createElement(BootPaint, { onPainted: () => undefined }));
    expect(renderer.root.findByType('View').props.style).toEqual(
      expect.objectContaining({ backgroundColor: GLYPH_PAINT.lightGround }),
    );
    expect(renderer.root.findByType('AnimatedPath').props.stroke).toBe(GLYPH_PAINT.lightInk);
  });

  it('shows the still filled glyph under reduced motion', () => {
    motion.reducedMotion = true;
    const onPainted = vi.fn();
    const renderer = render(React.createElement(BootPaint, { onPainted }));
    expect(onPainted).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType('AnimatedPath')).toHaveLength(0);
    expect(renderer.root.findByType('Path').props.fill).toBe(GLYPH_PAINT.darkInk);
  });

  it('uses the same grounds expo-splash-screen already ships', async () => {
    const appConfig = (await import('../../../app.config.js')).default.expo;
    const splashPlugin = appConfig.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
    );
    expect(splashPlugin?.[1].ios.backgroundColor).toBe(GLYPH_PAINT.lightGround);
    expect(splashPlugin?.[1].ios.dark.backgroundColor).toBe(GLYPH_PAINT.darkGround);
    expect(splashPlugin?.[1].android.backgroundColor).toBe(GLYPH_PAINT.lightGround);
    expect(splashPlugin?.[1].android.dark.backgroundColor).toBe(GLYPH_PAINT.darkGround);
  });
});

describe('root layout boot handoff', () => {
  it('paints BootPaint on the first screen instead of returning null or dots', () => {
    const source = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');
    expect(source).toContain("import { BootPaint } from '@/components/buzz/BootPaint'");
    expect(source).toContain('<BootPaint');
    expect(source).toContain('fade: false');
    expect(source).toContain('onReady={hideNativeSplash}');
    expect(source).not.toMatch(/if \(!initialized\) \{\s*return null;/);
    expect(source).not.toContain('PixelLoader');
    expect(source).not.toContain('fade: true');
  });
});
