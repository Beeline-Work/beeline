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

import { TurnBandSlot, TurnProgressLine } from '@/components/buzz/TurnProgressLine';
import { beelineThemes, groknight } from './groknight';
import { ROOM_OPEN_LIST_TAIL_PADDING } from './room-open-geometry';
import { phoneTranscriptTailPadding } from './room-scroll-follow';
import {
  COMPOSER_TOP_GAP,
  TURN_LINE_BAR_MARGIN_BOTTOM,
  TURN_LINE_BOX_HEIGHT,
  TURN_LINE_INK_AIR,
  TURN_LINE_ROW_MIN_HEIGHT,
  TURN_LABEL_LINE_HEIGHT,
  roomBottomChromeStyles,
} from './room-bottom-chrome';

/**
 * The Room's bottom edge, measured rather than read.
 *
 * Every number here comes from the style objects the app itself mounts — the
 * screen assigns `bottomChrome.stack` / `.hangingTurnChrome` / `.composerRow`
 * straight into its StyleSheet, and the turn line's own box and the newest
 * message row's own padding are read off rendered components. So this fails on
 * a stray overlay or a hidden reserve the way the reader's last message would,
 * not on a renamed symbol.
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const layout = roomBottomChromeStyles(beelineThemes.obsidian);

const px = (value: unknown): number => Number(value ?? 0);

const flattenStyle = (style: unknown): ViewStyle[] =>
  ([] as unknown[]).concat(style ?? []).filter(Boolean) as ViewStyle[];

const hostByTestID = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll(
    (node: { type: unknown; props: Record<string, unknown> }) =>
      typeof node.type === 'string' && node.props.testID === testID,
  )[0];

/** The turn line's own layout box, measured off a rendered line. */
function measureTurnLine(): { height: number; bottomMargin: number; box: number } {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(TurnProgressLine, { label: 'nerd thinking…', testID: 'turn-line' }),
    );
  });
  const bar = renderer.root.findAll(
    (node: { type: unknown; props: { testID?: string } }) =>
      node.type === 'View' && node.props.testID === 'turn-line',
  )[0];
  expect(bar, 'the turn line must render its own outer box').toBeTruthy();
  const row = bar
    .findAll(() => true)
    .flatMap((node: { props: { style?: unknown } }) => flattenStyle(node.props.style))
    .find((style: ViewStyle) => style.flexDirection === 'row' && style.minHeight != null);
  expect(row, "the turn line's row must declare its own height").toBeTruthy();
  const height = px(row!.minHeight);
  const bottomMargin = flattenStyle(bar.props.style).reduce(
    (total: number, style: ViewStyle) => total + px(style.marginBottom),
    0,
  );
  act(() => renderer.unmount());
  return { height, bottomMargin, box: height + bottomMargin };
}

/**
 * How much of the list's viewport the turn line's slot takes away this state.
 *
 * The defect this file exists for is a slot that grows with its content: the
 * list's height then depends on whether a line is showing, so the newest row
 * moves when an agent starts. An absolute slot contributes nothing in either
 * state; an in-flow one contributes the rendered line's own box.
 */
function slotInFlowHeight({ lineShown }: { lineShown: boolean }): number {
  let renderer!: ReactTestRenderer;
  const tree = (show: boolean) =>
    React.createElement(
      TurnBandSlot,
      { testID: 'slot' },
      show
        ? React.createElement(TurnProgressLine, { label: 'nerd thinking…', testID: 'band' })
        : null,
    );
  act(() => {
    renderer = create(tree(lineShown));
  });
  const style = flattenStyle(hostByTestID(renderer, 'slot').props.style).reduce(
    (total: ViewStyle, next: ViewStyle) => Object.assign(total, next),
    {} as ViewStyle,
  );
  act(() => renderer.unmount());
  if (style.position === 'absolute') return 0;
  return lineShown ? measureTurnLine().box : 0;
}

/**
 * The gap from the newest message's own text box bottom to the composer's top
 * border, in the state where a turn line is (`lineShown`) or is not showing.
 *
 * The inverted list's tail is `messageListContent.paddingTop` (its visual
 * tail), the newest row contributes its own `entry.paddingBottom`, and the
 * turn line's slot sits between the list and the composer. That sum is the
 * whole gap; the composer's top border is anchored to the bottom of the screen
 * and never moves, so it is the fixed end of the measurement.
 */
function newestMessageToComposerGap({ lineShown }: { lineShown: boolean }): number {
  const tail = phoneTranscriptTailPadding({
    turnChromeVisible: lineShown,
    pushedChromeVisible: false,
  });
  const newestRowBottomPadding = groknight.messagePaddingVertical;
  return slotInFlowHeight({ lineShown }) + tail + newestRowBottomPadding;
}

describe('the Room turn line paints the transcript margin', () => {
  it('sits on the transcript surface, unfenced, above the fixed composer gap', () => {
    const styles = roomBottomChromeStyles({ bgTerminal: '#111', border: '#333' });
    // No rule and no second surface: the line is painted into space the
    // transcript already owns, so fencing it off would read as a new panel.
    expect(styles.hangingTurnChrome).not.toHaveProperty('borderTopWidth');
    expect(styles.hangingTurnChrome).not.toHaveProperty('borderTopColor');
    expect(styles.hangingTurnChrome).not.toHaveProperty('backgroundColor');
    // The composer keeps its own border; that one separates two real surfaces.
    expect(styles.composerRow.borderTopWidth).toBe(1);
  });

  it('takes no in-flow height, so the newest message does not move', () => {
    // The regression this file exists for: an in-flow band took its own height
    // out of the list every time an agent started working, and a slot held
    // open to prevent it left an empty strip in every Room. The line is
    // absolute instead, anchored to the composer's top edge.
    expect(layout.hangingTurnChrome.position).toBe('absolute');
    expect(layout.hangingTurnChrome).not.toHaveProperty('height');
    expect(layout.hangingTurnChrome).not.toHaveProperty('minHeight');
    expect(slotInFlowHeight({ lineShown: false })).toBe(0);
    expect(slotInFlowHeight({ lineShown: true })).toBe(0);
  });

  it('leaves the newest-message-to-composer gap equal with and without the line', () => {
    const idle = newestMessageToComposerGap({ lineShown: false });
    const working = newestMessageToComposerGap({ lineShown: true });
    // The whole bug: the gap changed when the line appeared. It must not.
    expect(working).toBe(idle);
  });

  it('adds the authored fixed gap above the composer', () => {
    const gap = newestMessageToComposerGap({ lineShown: true });
    // One speaker-change margin (24px) plus exactly one label line box (18px):
    // 42px, in both idle and working states. The composer-top gap IS the label
    // line box, which is what makes the rule state itself.
    const speakerChangeMargin = groknight.messagePaddingVertical * 4;
    expect(speakerChangeMargin).toBe(TURN_LINE_ROW_MIN_HEIGHT);
    expect(COMPOSER_TOP_GAP).toBe(TURN_LABEL_LINE_HEIGHT);
    expect(gap).toBe(42);
    expect(gap).toBe(speakerChangeMargin + COMPOSER_TOP_GAP);
    expect(ROOM_OPEN_LIST_TAIL_PADDING + groknight.messagePaddingVertical).toBe(gap);
  });

  it('leaves exactly equal air above and below the thinking label', () => {
    // The captain's rule (2026-09-22). The line hangs on the composer, so its
    // box height plus the slab above it is the whole gap; measure the ink, not
    // the box, because the ink is the only thing the reader sees.
    const gap = newestMessageToComposerGap({ lineShown: true });
    const inkInsetInRow = (TURN_LINE_ROW_MIN_HEIGHT - TURN_LABEL_LINE_HEIGHT) / 2;
    const belowInk = inkInsetInRow + TURN_LINE_BAR_MARGIN_BOTTOM;
    const aboveInk = gap - TURN_LINE_BOX_HEIGHT + inkInsetInRow;
    expect(aboveInk).toBe(belowInk);
    expect(aboveInk).toBe(TURN_LINE_INK_AIR);
    expect(TURN_LINE_INK_AIR).toBe(12);
    // The gap is the ink with that air on both sides, and nothing else.
    expect(gap).toBe(TURN_LABEL_LINE_HEIGHT + TURN_LINE_INK_AIR * 2);
    // The regression that made this necessary: tying the bar margin to the
    // composer-top gap pinned the ink low, at 3px above against 15px below.
    expect(TURN_LINE_BAR_MARGIN_BOTTOM).not.toBe(COMPOSER_TOP_GAP);
  });

  it('fits the line inside the margin so it cannot paint over the message', () => {
    const { box } = measureTurnLine();
    const gap = newestMessageToComposerGap({ lineShown: true });
    // The line's box fits INSIDE the gap with slab left above it, so the ink
    // can never reach the message's own text box bottom.
    expect(box).toBeLessThan(gap);
    expect(box).toBe(TURN_LINE_ROW_MIN_HEIGHT + TURN_LINE_BAR_MARGIN_BOTTOM);
    expect(TURN_LABEL_LINE_HEIGHT).toBeLessThanOrEqual(TURN_LINE_ROW_MIN_HEIGHT);
    // The ink clears the message within its 24px row, then keeps the rest of
    // its equal air before the composer.
    expect((TURN_LINE_ROW_MIN_HEIGHT - TURN_LABEL_LINE_HEIGHT) / 2).toBeGreaterThan(0);
    expect(TURN_LINE_BAR_MARGIN_BOTTOM).toBeGreaterThan(0);
  });
});
