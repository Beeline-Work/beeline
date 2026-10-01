import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { TranscriptScrubber } from './TranscriptScrubber';

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  process.env.TZ = originalTz;
});
beforeEach(() => {
  haptics.selection.mockClear();
  haptics.impact.mockClear();
});

const id = (n: number) => n.toString(16).padStart(64, '0');
const at = (iso: string) => Date.parse(iso) / 1_000;
const outline: RoomHistoryOutline = {
  roomId: '00000000-0000-4000-8000-000000000001',
  timeZone: 'UTC',
  total: 100,
  newest: { id: id(100), createdAt: at('2026-09-02T12:30:00Z') },
  days: [
    {
      day: '2026-08-30',
      count: 40,
      first: {
        id: id(1),
        createdAt: at('2026-08-30T08:05:00Z'),
        authorName: 'Ann',
        authorHandle: 'ann',
      },
    },
    {
      day: '2026-09-01',
      count: 30,
      first: {
        id: id(41),
        createdAt: at('2026-09-01T09:10:00Z'),
        authorName: 'Niglet',
        authorHandle: 'niglet',
      },
    },
    {
      day: '2026-09-02',
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
        onScrub={() => undefined}
        onScrubEnd={() => undefined}
        {...props}
      />,
    );
  });
  const strip = () => renderer.root.findByProps({ testID: 'transcript-scrubber' });
  const grab = () => renderer.root.findByProps({ testID: 'transcript-scrubber-grab' });
  act(() => strip().props.onLayout({ nativeEvent: { layout: { height: 600 } } }));
  return { renderer, strip, grab };
}

const words = (node: any) =>
  node.findAllByType('Text').map((text: any) => [text.props.children].flat().join(''));

describe('TranscriptScrubber', () => {
  it('shows a thin bar placed by the whole history, ready to grab without scrolling first', () => {
    const { renderer, strip, grab } = render();
    const bar = renderer.root.findByProps({ testID: 'transcript-scrubber-bar' });
    // Position 0.1 from the newest end of a 600pt rail, centred on a 36pt bar.
    expect(bar.props.style[1].top).toBe(0.9 * 600 - 18);
    expect(strip().props.style.width).toBe(44);
    // Only the bar, with 12pt to spare either side, takes the press.
    expect(grab().props.style[1].top).toBe(0.9 * 600 - 18 - 12);
    expect(grab().props.style[0].height).toBe(36 + 24);
    expect(grab().props.style[0].width).toBe(44);
    // Until the reader's place is known there is no bar to show or grab.
    act(() =>
      renderer.update(
        <TranscriptScrubber
          history={history}
          position={null}
          onScrub={() => undefined}
          onScrubEnd={() => undefined}
        />,
      ),
    );
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-bar' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
  });

  it('drags the bar at once into a handle that snaps to day markers and lands on release', () => {
    const onScrub = vi.fn();
    const onScrubEnd = vi.fn();
    const { renderer, grab } = render({ onScrub, onScrubEnd });
    // Press the middle of the bar, which sits 0.1 from the newest end.
    act(() => grab().props.onPanResponderGrant({ nativeEvent: { locationY: 30 } }));
    expect(haptics.impact).toHaveBeenCalledTimes(1);
    expect(onScrub).not.toHaveBeenCalled();
    // Drag straight up the rail, with no hold first, to the oldest day.
    act(() => grab().props.onPanResponderMove({}, { dy: -520 }));
    const rail = renderer.root.findByProps({ testID: 'transcript-scrubber-rail' });
    expect(words(rail)).toEqual(['AUG', 'SEP']);
    const bubble = () => renderer.root.findByProps({ testID: 'transcript-scrubber-bubble' });
    expect(words(bubble())).toEqual(['SUN 30 AUG', '08:05 · @ann · 99 messages back']);
    expect(onScrub).toHaveBeenLastCalledWith(expect.objectContaining({ firstMessageId: id(1) }));

    // Drag back down: the handle snaps from day to day.
    act(() => grab().props.onPanResponderMove({}, { dy: -240 }));
    expect(words(bubble())).toEqual(['TUE 1 SEP', '09:10 · @niglet · 59 messages back']);
    act(() => grab().props.onPanResponderMove({}, { dy: -220 }));
    // Same day: no second tick.
    expect(onScrub).toHaveBeenCalledTimes(2);
    expect(haptics.selection).toHaveBeenCalledTimes(2);
    expect(grab().props.onPanResponderTerminationRequest()).toBe(false);

    act(() => grab().props.onPanResponderRelease());
    expect(onScrubEnd).toHaveBeenCalledWith(expect.objectContaining({ firstMessageId: id(41) }));
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-bubble' })).toHaveLength(0);
  });

  it('keeps the bar held while the reader\'s place is unknown until the finger lifts', () => {
    const onScrubEnd = vi.fn();
    const { renderer, grab } = render({ onScrubEnd });
    act(() => grab().props.onPanResponderGrant({ nativeEvent: { locationY: 30 } }));
    act(() =>
      renderer.update(
        <TranscriptScrubber
          history={history}
          position={null}
          onScrub={() => undefined}
          onScrubEnd={onScrubEnd}
        />,
      ),
    );
    act(() => grab().props.onPanResponderMove({}, { dy: -520 }));
    act(() => grab().props.onPanResponderRelease());
    expect(onScrubEnd).toHaveBeenCalledWith(expect.objectContaining({ firstMessageId: id(1) }));
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
  });

  it('leaves the rest of the right edge to the list, so a flick there scrolls it', () => {
    const { strip, grab } = render();
    // `box-none`: the strip itself never becomes the touch target.
    expect(strip().props.pointerEvents).toBe('box-none');
    expect(strip().props.onStartShouldSetResponder).toBeUndefined();
    expect(strip().props.onPanResponderGrant).toBeUndefined();
    expect(grab().props.pointerEvents).toBeUndefined();
  });

  it('lifting the bar without a drag lands nowhere', () => {
    const onScrub = vi.fn();
    const onScrubEnd = vi.fn();
    const { grab } = render({ onScrub, onScrubEnd });
    act(() => grab().props.onPanResponderGrant({ nativeEvent: { locationY: 30 } }));
    act(() => grab().props.onPanResponderRelease());
    expect(onScrub).not.toHaveBeenCalled();
    expect(onScrubEnd).not.toHaveBeenCalled();
  });
});
