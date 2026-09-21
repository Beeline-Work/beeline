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
import { beelineThemes } from './groknight';
import { ROOM_OPEN_LIST_TAIL_PADDING } from './room-open-geometry';
import { phoneTranscriptTailPadding } from './room-scroll-follow';
import {
  TURN_LINE_BAR_MARGIN_BOTTOM,
  TURN_LINE_ROW_MIN_HEIGHT,
  roomBottomChromeStyles,
} from './room-bottom-chrome';

/**
 * The Room's bottom edge, measured rather than read.
 *
 * Every number here comes from the style objects the app itself mounts — the
 * screen assigns `bottomChrome.stack` / `.hangingTurnChrome` / `.composerRow`
 * straight into its StyleSheet, and the turn line's own box is read off a
 * rendered `TurnProgressLine`. So this fails on a stray overlay the way the
 * reader's last message would, not on a renamed symbol.
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const layout = roomBottomChromeStyles(beelineThemes.obsidian);

const px = (value: unknown): number => Number(value ?? 0);

const flattenStyle = (style: unknown): ViewStyle[] =>
  ([] as unknown[]).concat(style ?? []).filter(Boolean) as ViewStyle[];

type TestNode = { type: unknown; props: Record<string, unknown> };

const hostByTestID = (renderer: ReactTestRenderer, testID: string): TestNode =>
  renderer.root.findAll(
    (node: TestNode) => typeof node.type === 'string' && node.props.testID === testID,
  )[0];

/**
 * The slot as the screen mounts it, driven the way the phone drives it: the
 * hidden copy reports a layout, the band comes, the band goes. The height the
 * assertions read is the height the list's viewport loses.
 *
 * `bandFromTheStart` is the cold open: a Room entered while an agent is
 * already working, so the slot's first render is handed a band.
 */
function mountBandSlot({ bandFromTheStart = false }: { bandFromTheStart?: boolean } = {}) {
  let renderer!: ReactTestRenderer;
  const band = React.createElement(TurnProgressLine, {
    label: 'nerd thinking…',
    testID: 'band',
  });
  const tree = (showBand: boolean) =>
    React.createElement(TurnBandSlot, { testID: 'slot' }, showBand ? band : null);
  act(() => {
    renderer = create(tree(bandFromTheStart));
  });
  return {
    /** The exact height the slot takes out of the screen right now. */
    slotHeight(): number {
      const style = Object.assign({}, ...flattenStyle(hostByTestID(renderer, 'slot').props.style));
      return px((style as ViewStyle).height);
    },
    slotStyle(): ViewStyle {
      return Object.assign({}, ...flattenStyle(hostByTestID(renderer, 'slot').props.style));
    },
    measure(): TestNode {
      return hostByTestID(renderer, 'slot-measure');
    },
    /** The hidden copy reports the height it was laid out at. */
    reportMeasuredHeight(height: number) {
      const onLayout = this.measure().props.onLayout as (event: {
        nativeEvent: { layout: { height: number } };
      }) => void;
      act(() => onLayout({ nativeEvent: { layout: { height } } }));
    },
    showBand(showBand: boolean) {
      act(() => renderer.update(tree(showBand)));
    },
    bandIsMounted(): boolean {
      return hostByTestID(renderer, 'band') != null;
    },
    unmount() {
      act(() => renderer.unmount());
    },
  };
}

/** The turn line's own layout box, measured off a rendered line. */
function measureTurnLine(): { height: number; bottomMargin: number; box: number } {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(TurnProgressLine, { label: 'nerd thinking…', testID: 'turn-line' }),
    );
  });
  const flatten = flattenStyle;
  const bar = renderer.root.findAll(
    (node: { type: unknown; props: { testID?: string } }) =>
      node.type === 'View' && node.props.testID === 'turn-line',
  )[0];
  expect(bar, 'the turn line must render its own outer box').toBeTruthy();
  const row = bar
    .findAll(() => true)
    .flatMap((node: { props: { style?: unknown } }) => flatten(node.props.style))
    .find((style: ViewStyle) => style.flexDirection === 'row' && style.minHeight != null);
  expect(row, "the turn line's row must declare its own height").toBeTruthy();
  const height = px(row!.minHeight);
  const bottomMargin = flatten(bar.props.style).reduce(
    (total: number, style: ViewStyle) => total + px(style.marginBottom),
    0,
  );
  act(() => renderer.unmount());
  return { height, bottomMargin, box: height + bottomMargin };
}

/** Two message rows at 6px of padding each side: the gap a speaker change
 *  leaves between any two messages, and the room the line paints into. */
const SPEAKER_CHANGE_MARGIN = 24;

describe('the Room turn line paints the transcript margin', () => {
  it('sits on the transcript surface, unfenced, flush on the composer', () => {
    const styles = roomBottomChromeStyles({ bgTerminal: '#111', border: '#333' });
    // No rule and no second surface: the line is painted into space the
    // transcript already owns, so fencing it off would read as a new panel.
    expect(styles.hangingTurnChrome).not.toHaveProperty('borderTopWidth');
    expect(styles.hangingTurnChrome).not.toHaveProperty('borderTopColor');
    expect(styles.hangingTurnChrome.backgroundColor).toBe('#111');
    // The composer keeps its own border; that one separates two real surfaces.
    expect(styles.composerRow.borderTopWidth).toBe(1);
  });

  it('reserves nothing, so there is no height for the transcript to lose', () => {
    const styles = roomBottomChromeStyles({ bgTerminal: '#111', border: '#333' });
    // The regression this file exists for: a band with a height of its own
    // took that height out of the list every time an agent started working,
    // and a slot held open to prevent it left an empty strip in every Room.
    // Neither is possible while the line's own container claims no size.
    expect(styles.hangingTurnChrome).not.toHaveProperty('height');
    expect(styles.hangingTurnChrome).not.toHaveProperty('minHeight');
  });

  it('keeps the line to one row so it cannot paint over the message above', () => {
    // The margin it paints into is the ordinary speaker-change gap. One row
    // fits; a wrapped line would not, and would cover the newest message.
    expect(TURN_LINE_ROW_MIN_HEIGHT + TURN_LINE_BAR_MARGIN_BOTTOM).toBeLessThanOrEqual(
      SPEAKER_CHANGE_MARGIN,
    );
  });
});
