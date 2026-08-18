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

/** The breathing wrapper, present only while something is genuinely live. */
function pulses(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('AnimatedView');
}

function labelOf(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('Text')[0];
}

describe('the corner-open indicator', () => {
  it('is one line naming who is working and what on', () => {
    const renderer = render(
      React.createElement(CornerLiveBar, { label: 'beebee active: feat/ux-fix-now', live: true }),
    );
    // One status line — never a band, a bar that fills, or a row of dashes.
    expect(labelOf(renderer).props.children).toBe('beebee active: feat/ux-fix-now');
  });

  it('spends the reserved gold accent, and only that', () => {
    const live = render(
      React.createElement(CornerLiveBar, { label: 'beebee active: feat/x', live: true }),
    );
    expect(labelOf(live).props.style.flat().at(-1).color).toBe(groknight.accent);

    // Gold is never the only signal, and it never attaches to a state that is
    // not live: an open-but-idle corner drops to the quiet tier and the copy
    // itself says which is which.
    const idle = render(
      React.createElement(CornerLiveBar, { label: 'beebee idle: feat/x', live: false }),
    );
    expect(labelOf(idle).props.style.flat().at(-1).color).toBe(groknight.ledgerQuiet);
  });

  it('breathes while the work is live and holds still when it is not', () => {
    // A calm heartbeat on the shared live clock, mounted only when something
    // is genuinely live — a quiet Room pays for no clock at all.
    expect(pulses(render(
      React.createElement(CornerLiveBar, { label: 'beebee active: feat/x', live: true }),
    ))).toHaveLength(1);
    expect(pulses(render(
      React.createElement(CornerLiveBar, { label: 'beebee idle: feat/x', live: false }),
    ))).toHaveLength(0);
  });

  it('is a status light, not a plate: no border, no fill, no radius', () => {
    const renderer = render(
      React.createElement(CornerLiveBar, { label: 'beebee idle: feat/x', live: false }),
    );
    const bar = renderer.root.findAllByType('View')[0];
    expect(bar.props.style).not.toHaveProperty('borderWidth');
    expect(bar.props.style).not.toHaveProperty('borderRadius');
    expect(bar.props.style).not.toHaveProperty('backgroundColor');
  });

  it('enters the corner on tap, and is inert when there is nowhere to go', () => {
    const onPress = vi.fn();
    const tappable = render(
      React.createElement(CornerLiveBar, { label: 'beebee active: feat/x', live: true, onPress }),
    );
    const pressable = tappable.root.findAllByType('Pressable')[0];
    expect(pressable.props.accessibilityLabel).toBe('beebee active: feat/x. Open the corner');
    act(() => pressable.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);

    // A Corner's own bar has no destination — you are already there — so it
    // renders as a plain status line rather than a dead button.
    const inert = render(
      React.createElement(CornerLiveBar, { label: 'beebee active: feat/x', live: true }),
    );
    expect(inert.root.findAllByType('Pressable')).toHaveLength(0);
  });
});
