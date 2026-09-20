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
import { ROOM_OPEN_LIST_TAIL_PADDING } from './room-open-geometry';
import { phoneTranscriptTailPadding } from './room-scroll-follow';
import { roomBottomChromeStyles, turnLineOverlayCoverPx } from './room-bottom-chrome';

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

/** The turn line's own layout box, measured off a rendered line. */
function measureTurnLine(): { height: number; bottomMargin: number; box: number } {
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

describe('the Room turn line is a band above the composer', () => {
  it('sits in flow with a hairline, flush on the composer, not over the transcript', () => {
    const hanging = layout.hangingTurnChrome;
    // Overlay used position/bottom to paint over the list. The in-flow band
    // is only a hairline fill — no overlay fields, no extra air that would
    // shove the composer row.
    expect(Object.keys(hanging).sort()).toEqual([
      'backgroundColor',
      'borderTopColor',
      'borderTopWidth',
    ]);
    expect(hanging.borderTopWidth).toBe(1);
    expect(hanging.borderTopColor).toBe(beelineThemes.obsidian.border);
    expect(hanging.backgroundColor).toBe(beelineThemes.obsidian.bgTerminal);
    expect(Object.keys(layout.stack)).toEqual(['position']);
    expect(Object.keys(layout.stack)).not.toContain('gap');
    expect(Object.keys(layout.stack)).not.toContain('paddingTop');
    expect(Object.keys(hanging)).not.toContain('marginBottom');
    expect(Object.keys(layout.composerRow)).not.toContain('marginTop');
    expect(layout.composerRow.paddingTop).toBe(8);
  });

  it('would cover the last row if it overlaid the ordinary tail, so it must not overlay', () => {
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
    expect(thinking).toBe(idle);
    expect(thinking).toBe(ROOM_OPEN_LIST_TAIL_PADDING);
    expect(line.box).toBeGreaterThan(thinking);

    const overlayCover = turnLineOverlayCoverPx(line.box, thinking);
    expect(overlayCover).toBe(line.box - thinking);
    expect(overlayCover).toBeGreaterThan(0);

    // In-flow band: no overlay fields, so none of the 30px line box is taken
    // from the 12px tail. The last row keeps the ordinary margin.
    expect(Object.keys(layout.hangingTurnChrome)).not.toContain('position');
    expect(Object.keys(layout.hangingTurnChrome)).not.toContain('bottom');
    expect(turnLineOverlayCoverPx(0, thinking)).toBe(0);
  });
});
