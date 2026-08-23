import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The supervision deck's leading mark carries its state in three visual
 * languages — needs-you = solid brass (pulsing), working = motion (spinner),
 * idle = quiet steel. The load-bearing contract tested here is the REDUCED
 * MOTION path: with animation off, the three states must still be
 * distinguishable from shape and fill alone (hollow ring / solid brass dot /
 * small steel dot), and no animation clock may mount.
 */
const reanimated = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.default },
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
    useReducedMotion: () => reanimated.reducedMotion,
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: number) => value,
    withSequence: (value: unknown) => value,
    FadeInDown: { duration: () => ({}) },
  };
});

import { HullDeckMark } from './MonoHull';

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
  reanimated.reducedMotion = false;
});

function render(state: 'needs-you' | 'working' | 'idle'): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(HullDeckMark, { state }));
  });
  return renderer;
}

/** The innermost styled leaf of the mark. */
function markStyle(renderer: ReactTestRenderer): Record<string, unknown> {
  const leaves = renderer.root.findAll(
    (node: any) =>
      (node.type === 'View' || node.type === 'AnimatedView') &&
      node.props?.style !== undefined &&
      node !== renderer.root,
  );
  const last = leaves.at(-1)!;
  return Object.assign({}, ...( [last.props.style].flat().filter(Boolean) as object[] ));
}

/** The breathing wrapper `HullLivePulse` mounts, and only it. */
function pulses(renderer: ReactTestRenderer): number {
  return renderer.root.findAll((node: any) => node.type === 'AnimatedView').length;
}

describe('HullDeckMark — three states, three languages', () => {
  it('renders a spinning ring for working, a pulsing brass dot for needs-you, steel for idle', () => {
    // Working is motion: an animated ring whose top arc carries the accent.
    const working = render('working');
    expect(markStyle(working)).toMatchObject({ borderTopColor: '#b08a4a' });

    // Needs-you is the one solid brass dot, breathing on the live clock.
    const needsYou = render('needs-you');
    expect(markStyle(needsYou)).toMatchObject({
      backgroundColor: '#b08a4a',
      width: 9,
      height: 9,
    });
    expect(pulses(needsYou)).toBeGreaterThan(0);

    // Idle is a quiet steel dot — no animation clock at all.
    const idle = render('idle');
    expect(markStyle(idle)).toMatchObject({ backgroundColor: '#3b3048' });
    expect(pulses(idle)).toBe(0);
  });

  it('keeps the three states distinguishable under reduced motion, with no clocks mounted', () => {
    reanimated.reducedMotion = true;

    // Working falls back to a HOLLOW static ring — distinct by shape/fill
    // from both filled dots, without any rotation.
    const working = render('working');
    expect(markStyle(working)).toMatchObject({ borderColor: '#83838d' });
    expect(markStyle(working)).not.toHaveProperty('borderTopColor', '#b08a4a');
    expect(pulses(working)).toBe(0);

    // Needs-you holds the SOLID brass dot, pulse frozen (no breathing wrapper).
    const needsYou = render('needs-you');
    expect(markStyle(needsYou)).toMatchObject({ backgroundColor: '#b08a4a' });
    expect(pulses(needsYou)).toBe(0);

    // Idle stays the small steel dot.
    const idle = render('idle');
    expect(markStyle(idle)).toMatchObject({ backgroundColor: '#3b3048' });
    expect(pulses(idle)).toBe(0);

    // And the three reduced-motion marks really are three different shapes:
    const shapes = [
      JSON.stringify(markStyle(working)),
      JSON.stringify(markStyle(needsYou)),
      JSON.stringify(markStyle(idle)),
    ];
    expect(new Set(shapes).size).toBe(3);
  });
});
