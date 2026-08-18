import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const motion = vi.hoisted(() => ({ sequence: vi.fn((...steps: unknown[]) => steps[0]) }));

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
    withSequence: motion.sequence,
    FadeInDown: { duration: () => ({}) },
  };
});

import { groknight } from '@/buzz/groknight';
import { HullMechanismRail, HullMechanismReveal, motionTokens } from './MonoHull';

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
beforeEach(() => motion.sequence.mockClear());

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function railStyle(renderer: ReactTestRenderer) {
  const rail = renderer.root.findAllByType('View').at(-1)!;
  return (rail.props.style as unknown[]).flat().filter(Boolean) as Record<string, unknown>[];
}

/** The breathing wrapper `HullLivePulse` mounts, and only it. */
function pulses(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('AnimatedView');
}

describe('the mechanism rail', () => {
  it('spends the reserved gold and breathes only while the work is live', () => {
    const live = render(React.createElement(HullMechanismRail, { live: true }));
    expect(railStyle(live).at(-1)!.backgroundColor).toBe(groknight.accent);
    expect(pulses(live)).toHaveLength(1);
  });

  it('demotes to the quiet gutter tone and stops moving once the work settles', () => {
    // grok drops its rail from `┃` to `❙` the moment a block stops being the
    // live one. The rail never disappears — a vanishing 2px column would
    // reflow the label beside it, which is a worse cost than a faint rule.
    const settled = render(React.createElement(HullMechanismRail, { live: false }));
    expect(railStyle(settled).at(-1)!.backgroundColor).toBe(groknight.borderQuiet);
    expect(pulses(settled)).toHaveLength(0);
  });

  it('keeps the rail in the margin at a fixed width, so status never moves the reading column', () => {
    const style = railStyle(render(React.createElement(HullMechanismRail, { live: true })));
    expect(style[0]!.width).toBe(2);
    expect(style[0]!.flexShrink).toBe(0);
  });
});

describe('the mechanism reveal', () => {
  const child = () => React.createElement('Text', null, '12 TOOL CALLS');

  it('pops a row that arrives while the work is live', () => {
    // Narration reaches the reader a phrase at a time; a tool rollup arrives
    // whole. That contrast is how a reader tells voice from receipt without
    // reading either, so the row enters from hidden rather than simply being
    // there.
    const renderer = render(
      React.createElement(HullMechanismReveal, { live: true }, child()),
    );
    expect(pulses(renderer)[0]!.props.style.at(-1).opacity).toBe(0);
  });

  it('does not replay the pop for a settled row scrolled back into view', () => {
    // The transcript's FlatList recycles rows constantly. A one-time arrival
    // signal that fires on every remount is a twitch, not a signal.
    const renderer = render(
      React.createElement(HullMechanismReveal, { live: false }, child()),
    );
    expect(pulses(renderer)[0]!.props.style.at(-1).opacity).toBe(1);
  });

  it('dips once when the row demotes out of its live form, and never on arrival', () => {
    const renderer = render(
      React.createElement(HullMechanismReveal, { live: true }, child()),
    );
    expect(motion.sequence).not.toHaveBeenCalled();

    act(() => {
      renderer.update(React.createElement(HullMechanismReveal, { live: false }, child()));
    });
    expect(motion.sequence).toHaveBeenCalledTimes(1);

    // Re-rendering a row that is already settled must not dip again.
    act(() => {
      renderer.update(React.createElement(HullMechanismReveal, { live: false }, child()));
    });
    expect(motion.sequence).toHaveBeenCalledTimes(1);
  });

  it('keeps the demote dip short enough to read as one beat', () => {
    // Measured against grok Build: its rollup swaps tense in 52-104ms. The dip
    // plus its recovery has to stay in that neighbourhood or the row reads as
    // reloading rather than as settling.
    expect(motionTokens.demoteDip).toBeLessThanOrEqual(120);
    expect(motionTokens.demoteDip + motionTokens.reveal).toBeLessThan(300);
  });
});
