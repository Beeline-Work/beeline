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
import { TurnProgressLine } from './TurnProgressLine';

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
  it('says the agent is thinking, and nothing about any corner', () => {
    const renderer = render(
      React.createElement(TurnProgressLine, { label: 'beebee thinking\u2026' }),
    );
    const label = renderer.root.findAllByType('Text')[0];
    expect(label.props.children).toBe('beebee thinking\u2026');
    // No `view \u2192`: there is nowhere for a turn in progress to go.
    expect(renderer.root.findAllByType('Text')).toHaveLength(1);
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

  it('a quiet tone holds still and drops the reserved gold, never claiming the agent is alive', () => {
    const renderer = render(
      React.createElement(TurnProgressLine, { label: 'still waiting\u2026', tone: 'quiet' }),
    );
    // Style arrays resolve last-wins: the quiet override must be the final
    // word on color, not merely present alongside the base gold.
    const style = renderer.root.findAllByType('Text')[0].props.style as Array<{ color?: string }>;
    expect(style.at(-1)?.color).toBe(groknight.textMuted);
    // `active={false}` on HullLivePulse holds it still rather than breathing.
    expect(renderer.root.findAllByType('AnimatedView')).toHaveLength(1);
  });
});
