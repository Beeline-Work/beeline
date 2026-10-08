import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import {
  createTranscriptScrollController,
  type TranscriptScrollList,
} from '@/buzz/transcript-scroll-controller';
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

/** A scroll controller over a list that records each offset it is moved to. */
function controllerOver(toOffset: (offset: number) => void, cancelled: string[] = []) {
  const list: TranscriptScrollList = {
    toNewest: () => {},
    toRow: () => true,
    toEstimatedRow: () => {},
    toOffset,
    shiftBy: () => {},
  };
  return createTranscriptScrollController<{ id: string }>({
    list: () => list,
    rows: () => [],
    rowIndex: () => -1,
    onCancelled: (destination, reason) => cancelled.push(`${destination.kind}:${reason}`),
    schedule: () => {},
  });
}

function render(contentHeight = 5_600, offset = 0) {
  const store = createTranscriptScrubberStore();
  const listToOffset = vi.fn((y: number) =>
    store.observeScroll(scroll(y, store.getSnapshot().metrics?.contentHeight ?? contentHeight)),
  );
  const loadOlder = vi.fn();
  const cancelled: string[] = [];
  const controller = controllerOver(listToOffset, cancelled);
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <TranscriptScrubber positions={store} scrollController={controller} loadOlder={loadOlder} />,
    );
  });
  const strip = () => renderer.root.findByProps({ testID: 'transcript-scrubber' });
  act(() => strip().props.onLayout({ nativeEvent: { layout: { height: RAIL } } }));
  act(() => store.observeScroll(scroll(offset, contentHeight)));
  const grab = () => renderer.root.findByProps({ testID: 'transcript-scrubber-grab' });
  return { renderer, store, listToOffset, loadOlder, controller, cancelled, strip, grab };
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
    const { renderer, store, listToOffset, grab } = render(5_600, 0);
    act(() =>
      store.observeVisibleRows([
        { id: 'a', text: 'a', isUser: false, timestamp: at('2026-09-01T09:10:00Z') },
      ]),
    );
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    expect(haptics.impact).toHaveBeenCalledTimes(1);
    // A quarter of the track up is a quarter of the way into the loaded rows.
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 4 }));
    expect(listToOffset).toHaveBeenLastCalledWith(1_250);
    expect(grab().props.style[1].top).toBe(0.75 * (RAIL - 36) - 14);
    expect(
      renderer.root.findByProps({ testID: 'transcript-scrubber-bubble' }).findByType('Text').props
        .children,
    ).toBe('TUE 1 SEP');
    // Past the top: the list goes to its oldest loaded row and no further.
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    expect(listToOffset).toHaveBeenLastCalledWith(5_000);
    act(() => grab().props.onPanResponderRelease());
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-bubble' })).toHaveLength(0);
    // The bar stays long enough to grab again.
    act(() => vi.advanceTimersByTime(SCRUBBER_LINGER_MS - 1));
    expect(grab().props.style[1].top).toBe(-14);
  });

  it('asks the store for older rows only once the scrub reaches the oldest loaded ones', () => {
    const { loadOlder, grab } = render(5_600, 0);
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 2 }));
    expect(loadOlder).not.toHaveBeenCalled();
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it('keeps scrolling into older rows as they load under the finger', () => {
    const { store, listToOffset, grab } = render(5_600, 5_000);
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -2 }));
    expect(listToOffset).toHaveBeenLastCalledWith(5_000);
    // An older page lands: the content grows, the offset holds, and no scroll
    // event follows. The held finger goes on to the new oldest row.
    act(() => store.observeContentSize(8_600));
    expect(listToOffset).toHaveBeenLastCalledWith(8_000);
  });

  it('leaves the list alone under a finger held partway up', () => {
    const { store, listToOffset, grab } = render(5_600, 0);
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 2 }));
    expect(listToOffset).toHaveBeenCalledTimes(1);
    // Rows measure, a message arrives, the keyboard opens: the finger has
    // not moved, so the list must not either.
    act(() => store.observeContentSize(6_000));
    act(() =>
      store.observeScroll({
        contentOffset: { y: 2_500 },
        contentSize: { height: 6_000 },
        layoutMeasurement: { height: 300 },
      }),
    );
    expect(listToOffset).toHaveBeenCalledTimes(1);
  });

  it('lands where the finger lifts after a fling, once momentum ends', () => {
    const { listToOffset, controller, grab } = render(5_600, 0);
    // The reader flings the list, then grabs the bar while it still coasts.
    act(() => {
      controller.dragStarted();
      controller.dragEnded(true);
      controller.momentumStarted();
    });
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 4 }));
    act(() => grab().props.onPanResponderRelease());
    expect(listToOffset).toHaveBeenLastCalledWith(1_250);
    // Momentum carried the list past it; its end lands the scrub again.
    listToOffset.mockClear();
    act(() => controller.momentumEnded());
    expect(listToOffset).toHaveBeenCalledExactlyOnceWith(1_250);
    expect(controller.active()).toBeNull();
  });

  it('replaces a message jump in progress with the scrubbed offset', () => {
    const { listToOffset, controller, cancelled, grab } = render(5_600, 0);
    act(() => controller.request({ kind: 'message', messageId: 'm1', align: 'top', jump: true }));
    expect(controller.isLanding()).toBe(true);
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 2 }));
    expect(listToOffset).toHaveBeenLastCalledWith(2_500);
    expect(controller.isLanding()).toBe(false);
    // A later layout pass does not pull the list back to the jump.
    act(() => controller.observeLayout());
    expect(listToOffset).toHaveBeenCalledTimes(1);
    expect(cancelled).toEqual(['message:replaced']);
  });
});

/**
 * The Room screen's wiring around a stand-in inverted list: onScroll feeds
 * observeScroll, onContentSizeChange feeds observeContentSize, the scroll
 * controller calls scrollToOffset, and the bar asks a stand-in store for an
 * older page, which loads one page at a time. The list's own onEndReached
 * waits for a drag on the list, so it never loads here. Like iOS,
 * scrollToOffset to the offset the list already has does nothing and sends
 * no scroll event.
 */
describe('TranscriptScrubber on the Room transcript', () => {
  const PAGE = 3_000;

  function mountRoom() {
    const store = createTranscriptScrubberStore();
    const list = { offset: 0, contentHeight: 5_600, loads: 0, pending: 0 };
    const scrollEvent = () => ({
      contentOffset: { y: list.offset },
      contentSize: { height: list.contentHeight },
      layoutMeasurement: { height: RAIL },
    });
    const loadOlder = () => {
      if (list.pending) return;
      list.loads += 1;
      list.pending += 1;
    };
    // An older page renders on a later frame, at the top of the content.
    const landOlderPage = () => {
      expect(list.pending).toBeGreaterThan(0);
      list.pending -= 1;
      list.contentHeight += PAGE;
      store.observeContentSize(list.contentHeight);
    };
    const scrollToOffset = (offset: number) => {
      const next = Math.min(Math.max(0, offset), list.contentHeight - RAIL);
      if (next === list.offset) return;
      list.offset = next;
      store.observeScroll(scrollEvent());
    };
    const controller = controllerOver(scrollToOffset);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <TranscriptScrubber
          positions={store}
          scrollController={controller}
          loadOlder={loadOlder}
        />,
      );
    });
    act(() =>
      renderer.root
        .findByProps({ testID: 'transcript-scrubber' })
        .props.onLayout({ nativeEvent: { layout: { height: RAIL } } }),
    );
    act(() => store.observeScroll(scrollEvent()));
    const grab = () => renderer.root.findByProps({ testID: 'transcript-scrubber-grab' });
    return { list, grab, landOlderPage };
  }

  it('loads page after page while the reader holds the bar at the top', () => {
    const { list, grab, landOlderPage } = mountRoom();
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    expect(list).toMatchObject({ offset: 5_000, loads: 1 });
    act(landOlderPage);
    expect(list).toMatchObject({ contentHeight: 8_600, offset: 8_000, loads: 2 });
    act(landOlderPage);
    expect(list).toMatchObject({ contentHeight: 11_600, offset: 11_000, loads: 3 });
  });

  it('scrubs into the older rows after they load', () => {
    const { list, grab, landOlderPage } = mountRoom();
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    act(() => grab().props.onPanResponderRelease());
    act(landOlderPage);
    // Released before the page landed: the list stays where the reader left it.
    expect(list).toMatchObject({ contentHeight: 8_600, offset: 5_000, loads: 1 });
    // Grab again and drag up: the list follows into the new rows.
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    expect(list).toMatchObject({ offset: 8_000, loads: 2 });
  });

  it('feeds the transcript list size into the bar', () => {
    const surface = readFileSync(
      resolve(__dirname, '../../app/(app)/beeline/chat/_chat-surface.tsx'),
      'utf8',
    );
    expect(surface).toContain('positions: transcriptPositions,');
    expect(surface).toContain('transcriptPositions.observeScroll(event.nativeEvent);');
    expect(surface).toContain('transcriptPositions.observeContentSize(height);');
    expect(surface).toContain('positions={transcriptPositions}');
    expect(surface).toContain('loadOlder={loadOlderTranscriptMessages}');
    expect(surface).toContain('scrollController={scrollController}');
  });
});

/**
 * The bar over the real Room message store: it reads the store's
 * `positions` and pages older history through the store's `loadOlder`.
 */
describe('TranscriptScrubber on the Room message store', () => {
  const roomMessage = (id: string, createdAt: number): RoomViewMessage => ({
    id: id.repeat(64),
    createdAt,
    text: `message-${id}`,
    presentation: 'message',
    author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
  });

  function Room({
    roomId,
    history,
    onStore,
    toOffset,
  }: {
    roomId: string;
    history: (
      roomId: string,
      before?: { createdAt: number; id: string },
    ) => Promise<RoomHistoryView>;
    onStore: (store: ReturnType<typeof useRoomMessageStore>) => void;
    toOffset: (offset: number) => void;
  }) {
    const store = useRoomMessageStore({
      roomId,
      tailMessages: [roomMessage('b', 2), roomMessage('c', 3)],
      roomClient: { history },
      enabled: true,
      initialVisibleCount: 2,
    });
    onStore(store);
    const [controller] = React.useState(() => controllerOver(toOffset));
    return (
      <TranscriptScrubber
        positions={store.positions}
        loadOlder={() => store.loadOlder(2)}
        scrollController={controller}
      />
    );
  }

  it('reads positions and pages history through the store, and starts fresh in the next Room', async () => {
    const history = vi.fn(() => new Promise<RoomHistoryView>(() => {}));
    const toOffset = vi.fn();
    let store!: ReturnType<typeof useRoomMessageStore>;
    let renderer!: ReactTestRenderer;
    const element = (roomId: string) => (
      <Room
        roomId={roomId}
        history={history}
        toOffset={toOffset}
        onStore={(value) => (store = value)}
      />
    );
    act(() => {
      renderer = create(element('room-a'));
    });
    act(() =>
      renderer.root
        .findByProps({ testID: 'transcript-scrubber' })
        .props.onLayout({ nativeEvent: { layout: { height: RAIL } } }),
    );
    // The list reports where it is to the store; the bar draws from it.
    act(() => store.positions.observeScroll(scroll(0, 5_600)));
    const grab = () => renderer.root.findByProps({ testID: 'transcript-scrubber-grab' });
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    act(() => grab().props.onPanResponderRelease());
    expect(toOffset).toHaveBeenLastCalledWith(5_000);
    expect(history).toHaveBeenCalledExactlyOnceWith('room-a', { createdAt: 2, id: 'b'.repeat(64) });

    // Another Room: the store forgets the last Room's positions, so no bar.
    act(() => renderer.update(element('room-b')));
    expect(store.positions.getSnapshot().metrics).toBeNull();
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
    renderer.unmount();
  });
});
