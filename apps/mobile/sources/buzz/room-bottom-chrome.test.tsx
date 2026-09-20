import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ViewStyle } from 'react-native';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('expo-haptics', () => ({
  impactAsync: () => undefined,
  notificationAsync: () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return { default: host('Svg'), Path: host('Path'), G: host('G') };
});

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: Record<string, unknown>) => ReactModule.createElement('AnimatedView', props),
      createAnimatedComponent: () => (props: Record<string, unknown>) =>
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
    cancelAnimation: vi.fn(),
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedProps: (factory: () => unknown) => factory(),
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ value }),
    withDelay: (_delay: number, value: unknown) => value,
    withRepeat: (value: unknown) => value,
    withSequence: (...steps: unknown[]) => steps[0],
    withTiming: (value: unknown) => value,
  };
});

import { TurnProgressLine } from '@/components/buzz/TurnProgressLine';
import { beelineThemes } from './groknight';
import { phoneTranscriptTailPadding } from './room-scroll-follow';
import { roomBottomChromeStyles } from './room-bottom-chrome';

/**
 * The Room's bottom edge, measured rather than read.
 *
 * Every number here comes from the style objects the app itself mounts — the
 * screen assigns `bottomChrome.stack` / `.hangingTurnChrome` / `.composerRow`
 * straight into its StyleSheet, and the turn line's own box is read off a
 * rendered `TurnProgressLine`. So this fails on a stray margin the way the
 * reader's eye would, not on a renamed symbol.
 *
 * The rule: with the pinned corner line gone there is nothing left between
 * the hanging turn line and the composer, so their edges meet at one y and
 * the transcript reserves the line's height and not a pixel more.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const layout = roomBottomChromeStyles(beelineThemes.obsidian);

const px = (value: unknown): number => Number(value ?? 0);
/** Read a style's box-model fields by name: a regression ADDS one of these. */
const box = (style: unknown): Record<string, unknown> => (style ?? {}) as Record<string, unknown>;

/**
 * Distance in px between the bottom edge of the absolutely-placed turn line
 * and the top edge of the stack's first in-flow row. `bottom: '100%'` puts
 * the child's bottom edge exactly on the parent's top edge; a bottom margin
 * on the line, top padding on the stack, or a top margin on the row each open
 * a band of dead slab between them.
 */
function turnLineToRowGap(row: ViewStyle): number {
  const hanging = layout.hangingTurnChrome;
  expect(hanging.position, 'the turn line must hang, not sit in flow').toBe('absolute');
  expect(hanging.bottom, "the turn line's bottom edge is the stack's top edge").toBe('100%');
  return (
    px(box(hanging).marginBottom) +
    px(box(layout.stack).paddingTop) +
    px(box(layout.stack).rowGap ?? box(layout.stack).gap) +
    px(box(row).marginTop)
  );
}

/** The turn line's own layout box, measured off a rendered line. */
function measureTurnLine(): { height: number; bottomMargin: number } {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(TurnProgressLine, { label: 'nerd thinking…', testID: 'turn-line' }),
    );
  });
  const flatten = (style: unknown): ViewStyle[] =>
    ([] as unknown[]).concat(style ?? []).filter(Boolean) as ViewStyle[];
  const bar = renderer.root.findAll(
    (node: { type: unknown; props: { testID?: string } }) =>
      node.type === 'View' && node.props.testID === 'turn-line',
  )[0];
  expect(bar, 'the turn line must render its own outer box').toBeTruthy();
  // The line's single row owns its height; the outer bar owns the margin that
  // parts it from the composer below.
  const row = bar
    .findAll(() => true)
    .flatMap((node: { props: { style?: unknown } }) => flatten(node.props.style))
    .find((style: ViewStyle) => style.flexDirection === 'row' && style.minHeight != null);
  expect(row, "the turn line's row must declare its own height").toBeTruthy();
  const measured = {
    height: px(row!.minHeight),
    bottomMargin: flatten(bar.props.style).reduce(
      (total: number, style: ViewStyle) => total + px(style.marginBottom),
      0,
    ),
  };
  act(() => renderer.unmount());
  return measured;
}

describe('the Room turn line sits on the composer', () => {
  it('leaves no gap between the hanging turn line and the composer', () => {
    expect(turnLineToRowGap(layout.composerRow)).toBe(0);
  });

  it('adds no in-flow height of its own, so the stack starts at the composer', () => {
    // An absolute line cannot push the composer down; the transcript reserves
    // its height instead. A line that went in flow would move the field under
    // the reader's thumb every time an agent started answering.
    expect(layout.hangingTurnChrome.left).toBe(0);
    expect(layout.hangingTurnChrome.right).toBe(0);
    expect(px(box(layout.stack).paddingBottom)).toBe(0);
    expect(px(box(layout.stack).gap)).toBe(0);
  });

  it('reserves exactly the rendered line at the transcript tail, and nothing more', () => {
    // The reserve keeps the hanging line off the newest row. It is spent on
    // the line alone, so no dead band survives where the pinned corner line
    // used to absorb it.
    const line = measureTurnLine();
    const idle = phoneTranscriptTailPadding({
      turnChromeVisible: false,
      pushedChromeVisible: false,
    });
    const thinking = phoneTranscriptTailPadding({
      turnChromeVisible: true,
      pushedChromeVisible: false,
    });

    expect(line.height).toBeGreaterThan(0);
    expect(thinking - idle).toBe(line.height + line.bottomMargin);
  });
});
