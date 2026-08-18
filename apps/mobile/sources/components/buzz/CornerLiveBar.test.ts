import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { CornerLiveBar } from './CornerLiveBar';

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

function segments(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('AnimatedView')
    .map((node: any) => node.props.style.flat?.() ?? node.props.style);
}

describe('the corner-open indicator', () => {
  it('spends the reserved gold accent, and only that', () => {
    const renderer = render(
      React.createElement(CornerLiveBar, { label: 'CORNER OPEN', live: true }),
    );
    const [band] = segments(renderer);
    expect(band.some((style: any) => style?.backgroundColor === groknight.accent)).toBe(true);

    const label = renderer.root.findAllByType('Text')[0];
    expect(label.props.style.color).toBe(groknight.accent);
    // Gold is never the only signal: the copy names the state and `◆` is the
    // live-corner lifecycle glyph.
    expect(label.props.children.join('')).toBe('◆ CORNER OPEN');
  });

  it('flows while the work is live and settles when it is not', () => {
    const flowing = segments(render(
      React.createElement(CornerLiveBar, { label: 'WORKING IN CORNER', live: true }),
    ));
    const settled = segments(render(
      React.createElement(CornerLiveBar, { label: 'CORNER OPEN', live: false }),
    ));

    // A settled band is one flat rule; a flowing one carries a travelling
    // crest, so its cells do not share a single opacity.
    const opacity = (cells: any[]) => cells.map((style: any) => style.at(-1).opacity);
    expect(new Set(opacity(settled)).size).toBe(1);
    expect(new Set(opacity(flowing)).size).toBeGreaterThan(1);
  });

  it('is a status light, not a plate: no border, no fill, no radius', () => {
    const renderer = render(
      React.createElement(CornerLiveBar, { label: 'CORNER OPEN', live: false }),
    );
    const bar = renderer.root.findAllByType('View')[0];
    expect(bar.props.style).not.toHaveProperty('borderWidth');
    expect(bar.props.style).not.toHaveProperty('borderRadius');
    expect(bar.props.style).not.toHaveProperty('backgroundColor');
  });

  it('enters the corner on tap, and is inert when there is nowhere to go', () => {
    const onPress = vi.fn();
    const tappable = render(
      React.createElement(CornerLiveBar, { label: 'CORNER OPEN', live: true, onPress }),
    );
    const pressable = tappable.root.findAllByType('Pressable')[0];
    expect(pressable.props.accessibilityLabel).toBe('CORNER OPEN. Open the corner');
    act(() => pressable.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);

    // A Corner's own bar has no destination — you are already there — so it
    // renders as a plain status line rather than a dead button.
    const inert = render(React.createElement(CornerLiveBar, { label: 'LIVE', live: true }));
    expect(inert.root.findAllByType('Pressable')).toHaveLength(0);
  });
});
