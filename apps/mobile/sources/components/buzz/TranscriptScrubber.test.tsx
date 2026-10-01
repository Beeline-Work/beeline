import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const haptics = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn() }));

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
  selectionAsync: haptics.selection,
  impactAsync: haptics.impact,
  ImpactFeedbackStyle: { Light: 'light' },
}));

import type { RoomHistoryOutline } from '@beeline/api-contract/phone';
import { scrubberHistory } from '@/buzz/transcript-scrubber';
import { SCRUBBER_HOLD_MS, TranscriptScrubber } from './TranscriptScrubber';

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

const id = (n: number) => n.toString(16).padStart(64, '0');
const at = (iso: string) => Date.parse(iso) / 1_000;
const outline: RoomHistoryOutline = {
  roomId: '00000000-0000-4000-8000-000000000001',
  total: 100,
  newest: { id: id(100), createdAt: at('2026-09-02T12:30:00Z') },
  buckets: [
    {
      start: at('2026-08-30T08:00:00Z'),
      count: 40,
      first: {
        id: id(1),
        createdAt: at('2026-08-30T08:05:00Z'),
        authorName: 'Ann',
        authorHandle: 'ann',
      },
    },
    {
      start: at('2026-09-01T09:00:00Z'),
      count: 30,
      first: {
        id: id(41),
        createdAt: at('2026-09-01T09:10:00Z'),
        authorName: 'Niglet',
        authorHandle: 'niglet',
      },
    },
    {
      start: at('2026-09-02T12:00:00Z'),
      count: 30,
      first: {
        id: id(71),
        createdAt: at('2026-09-02T12:00:00Z'),
        authorName: 'Bo',
        authorHandle: 'bo',
      },
    },
  ],
};
const history = scrubberHistory(
  outline,
  Array.from({ length: 30 }, (_, index) => id(71 + index)),
);

function render(props: Partial<React.ComponentProps<typeof TranscriptScrubber>> = {}) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <TranscriptScrubber
        history={history}
        position={0.1}
        visible
        onScrub={() => undefined}
        onScrubEnd={() => undefined}
        {...props}
      />,
    );
  });
  const strip = () => renderer.root.findByProps({ testID: 'transcript-scrubber' });
  act(() => strip().props.onLayout({ nativeEvent: { layout: { height: 600 } } }));
  return { renderer, strip };
}

const words = (node: any) =>
  node.findAllByType('Text').map((text: any) => [text.props.children].flat().join(''));

describe('TranscriptScrubber', () => {
  it('shows a thin bar placed by the whole history while the list scrolls, and nothing to grab otherwise', () => {
    const { renderer, strip } = render();
    const bar = renderer.root.findByProps({ testID: 'transcript-scrubber-bar' });
    // Position 0.1 from the newest end of a 600pt rail, centred on a 36pt bar.
    expect(bar.props.style[1].top).toBe(0.9 * 600 - 18);
    expect(strip().props.pointerEvents).toBe('auto');
    expect(strip().props.style.width).toBe(44);
    act(() =>
      renderer.update(
        <TranscriptScrubber
          history={history}
          position={0.1}
          visible={false}
          onScrub={() => undefined}
          onScrubEnd={() => undefined}
        />,
      ),
    );
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-bar' })).toHaveLength(0);
    expect(strip().props.pointerEvents).toBe('none');
  });

  it('turns a press and hold into a handle that snaps to day markers and lands on release', () => {
    const onScrub = vi.fn();
    const onScrubEnd = vi.fn();
    const { renderer, strip } = render({ onScrub, onScrubEnd });
    // Press near the top of the rail (the oldest day) and hold.
    act(() => strip().props.onPanResponderGrant({ nativeEvent: { locationY: 10 } }));
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-rail' })).toHaveLength(0);
    act(() => vi.advanceTimersByTime(SCRUBBER_HOLD_MS));
    expect(haptics.impact).toHaveBeenCalledTimes(1);
    const rail = renderer.root.findByProps({ testID: 'transcript-scrubber-rail' });
    expect(words(rail)).toEqual(['AUG', 'SEP']);
    const bubble = () => renderer.root.findByProps({ testID: 'transcript-scrubber-bubble' });
    expect(words(bubble())).toEqual(['SUN 30 AUG', '08:05 · @ann · 99 messages back']);
    expect(onScrub).toHaveBeenLastCalledWith(expect.objectContaining({ firstMessageId: id(1) }));

    // Drag down the rail: the handle snaps from day to day.
    act(() => strip().props.onPanResponderMove({}, { dy: 280 }));
    expect(words(bubble())).toEqual(['TUE 1 SEP', '09:10 · @niglet · 59 messages back']);
    act(() => strip().props.onPanResponderMove({}, { dy: 300 }));
    // Same day: no second tick.
    expect(onScrub).toHaveBeenCalledTimes(2);
    expect(haptics.selection).toHaveBeenCalledTimes(2);

    act(() => strip().props.onPanResponderRelease());
    expect(onScrubEnd).toHaveBeenCalledWith(expect.objectContaining({ firstMessageId: id(41) }));
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-bubble' })).toHaveLength(0);
  });

  it('lets a flick through without scrubbing', () => {
    const onScrub = vi.fn();
    const onScrubEnd = vi.fn();
    const { strip } = render({ onScrub, onScrubEnd });
    act(() => strip().props.onPanResponderGrant({ nativeEvent: { locationY: 300 } }));
    act(() => strip().props.onPanResponderMove({}, { dy: 40 }));
    act(() => vi.advanceTimersByTime(SCRUBBER_HOLD_MS * 2));
    act(() => strip().props.onPanResponderRelease());
    expect(onScrub).not.toHaveBeenCalled();
    expect(onScrubEnd).not.toHaveBeenCalled();
  });
});
