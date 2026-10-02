import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const haptics = vi.hoisted(() => ({ impact: vi.fn() }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    // The handlers are the config, so a test can drive the gesture directly.
    PanResponder: { create: (config: any) => ({ panHandlers: config }) },
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  return {
    StyleSheet: {
      create: (factory: (theme: { buzz: typeof beelineThemes.obsidian }) => unknown) =>
        factory({ buzz: beelineThemes.obsidian }),
    },
  };
});
vi.mock('expo-haptics', () => ({
  impactAsync: haptics.impact,
  ImpactFeedbackStyle: { Light: 'light' },
}));

import { createTranscriptScrubberStore, SCRUBBER_LINGER_MS } from '@/buzz/use-transcript-scrubber';
import { TranscriptScrubber } from './TranscriptScrubber';

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  process.env.TZ = originalTz;
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const RAIL = 600;
const at = (iso: string) => Date.parse(iso) / 1_000;
const scroll = (y: number, contentHeight: number) => ({
  contentOffset: { y },
  contentSize: { height: contentHeight },
  layoutMeasurement: { height: RAIL },
});

function render(contentHeight = 5_600, offset = 0) {
  const store = createTranscriptScrubberStore();
  const onScrubTo = vi.fn((y: number) => store.observeScroll(scroll(y, contentHeight)));
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TranscriptScrubber scrubber={store} onScrubTo={onScrubTo} />);
  });
  const strip = () => renderer.root.findByProps({ testID: 'transcript-scrubber' });
  act(() => strip().props.onLayout({ nativeEvent: { layout: { height: RAIL } } }));
  act(() => store.observeScroll(scroll(offset, contentHeight)));
  const grab = () => renderer.root.findByProps({ testID: 'transcript-scrubber-grab' });
  return { renderer, store, onScrubTo, strip, grab };
}

describe('TranscriptScrubber', () => {
  it('places the bar by the list offset over the loaded rows while the list scrolls', () => {
    const { renderer, store, grab } = render(5_600, 2_500);
    // Halfway through 5000pt of scroll: halfway down the 564pt track.
    expect(grab().props.style[1].top).toBe(0.5 * (RAIL - 36) - 14);
    act(() => store.observeScroll(scroll(5_000, 5_600)));
    expect(grab().props.style[1].top).toBe(-14);
    act(() => vi.advanceTimersByTime(SCRUBBER_LINGER_MS));
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
  });

  it('passes touches off the bar to the list', () => {
    const { strip, grab } = render();
    expect(strip().props.pointerEvents).toBe('box-none');
    expect(strip().props.onPanResponderGrant).toBeUndefined();
    expect(grab().props.onPanResponderGrant).toBeTypeOf('function');
  });

  it('has no bar when the loaded rows fit on screen', () => {
    const { renderer } = render(400);
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
  });

  it('scrolls the list with the finger as soon as the bar is pressed', () => {
    const { renderer, store, onScrubTo, grab } = render(5_600, 0);
    act(() =>
      store.observeVisibleRows([
        { id: 'a', text: 'a', isUser: false, timestamp: at('2026-09-01T09:10:00Z') },
      ]),
    );
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    expect(haptics.impact).toHaveBeenCalledTimes(1);
    // A quarter of the track up is a quarter of the way into the loaded rows.
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 4 }));
    expect(onScrubTo).toHaveBeenLastCalledWith(1_250);
    expect(grab().props.style[1].top).toBe(0.75 * (RAIL - 36) - 14);
    expect(
      renderer.root.findByProps({ testID: 'transcript-scrubber-bubble' }).findByType('Text').props
        .children,
    ).toBe('TUE 1 SEP');
    // Past the top: the list goes to its oldest loaded row and no further.
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    expect(onScrubTo).toHaveBeenLastCalledWith(5_000);
    act(() => grab().props.onPanResponderRelease());
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-bubble' })).toHaveLength(0);
    // The bar stays long enough to grab again.
    act(() => vi.advanceTimersByTime(SCRUBBER_LINGER_MS - 1));
    expect(grab().props.style[1].top).toBe(-14);
  });

  it('keeps scrolling into older rows as they load under the finger', () => {
    const { store, onScrubTo, grab } = render(5_600, 5_000);
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    // An older page lands: the content grows and the list's offset holds.
    act(() => store.observeScroll(scroll(5_000, 8_600)));
    act(() => grab().props.onPanResponderMove({}, { dy: -2 }));
    expect(onScrubTo).toHaveBeenLastCalledWith(8_000);
  });
});
