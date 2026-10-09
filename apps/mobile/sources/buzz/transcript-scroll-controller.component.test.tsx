import React, { useEffect, useLayoutEffect } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { useScrollFollowOnArrival } from './room-scroll-follow';
import {
  useTranscriptScrollController,
  type TranscriptScrollController,
  type TranscriptScrollList,
} from './transcript-scroll-controller';

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

type Row = { id: string };

/** An inverted list over `rows`: index 0 is the newest row. It only records moves. */
function recordingList(moves: string[]): TranscriptScrollList {
  return {
    toNewest: () => moves.push('newest'),
    toRow: (index, rowId, align) => {
      moves.push(`row:${rowId}:${align}`);
      return true;
    },
    toEstimatedRow: (index) => moves.push(`estimate:${index}`),
    toOffset: (offset) => moves.push(`offset:${offset}`),
    shiftBy: (delta) => moves.push(`shift:${delta}`),
  };
}

type Props = {
  rows: Row[];
  firstUnreadId?: string;
  notificationId?: string;
  moves: string[];
  flashes: string[];
  frames: (() => void)[];
  onController(controller: TranscriptScrollController<Row>): void;
};

/**
 * The transcript features as the chat surface wires them: arrival follow,
 * the newest disc, unread landing and notification landing all ask the one
 * controller; the list's drag and viewability events report to it.
 */
function Transcript({
  rows,
  firstUnreadId,
  notificationId,
  moves,
  flashes,
  frames,
  onController,
}: Props) {
  const [list] = React.useState(() => recordingList(moves));
  const controller = useTranscriptScrollController<Row>({
    list: () => list,
    rows: () => rows,
    rowIndex: (destination, candidates) =>
      candidates.findIndex((row) => row.id === destination.messageId),
    onScrolled: (destination, rowId) => {
      if (destination.kind === 'message' && destination.jump) flashes.push(`source:${rowId}`);
    },
    onLanded: (destination, rowId) => {
      if (destination.kind === 'firstUnread') flashes.push(`arrival:${rowId}`);
    },
    schedule: (callback) => frames.push(callback),
  });
  onController(controller);

  const newestId = rows[0]?.id ?? null;
  const arrivalFollow = useScrollFollowOnArrival({
    newestId,
    isPinnedToTail: controller.isPinnedToTail(),
    isUserDragging: controller.isUserDragging(),
  });
  useLayoutEffect(() => {
    if (arrivalFollow === 'hold') return;
    controller.follow();
  }, [newestId, controller]);
  useEffect(() => {
    if (firstUnreadId) controller.request({ kind: 'firstUnread', messageId: firstUnreadId });
  }, [firstUnreadId, controller]);
  useEffect(() => {
    if (notificationId)
      controller.request({ kind: 'message', messageId: notificationId, align: 'top', jump: true });
  }, [notificationId, controller]);

  return React.createElement(
    'List',
    {
      onScrollBeginDrag: () => controller.dragStarted(),
      onMomentumScrollEnd: () => controller.momentumEnded(),
      onViewable: (ids: string[]) => controller.observeVisibleRows(ids.map((id) => ({ id }))),
      onTailOffset: (offset: number) => controller.observeTailPinned(offset <= 50),
    },
    React.createElement('Disc', { onPress: () => controller.request({ kind: 'newest' }) }),
  );
}

const ids = (...names: string[]) => names.map((id) => ({ id }));

function mount(props: Partial<Props> & { rows: Row[] }) {
  const moves: string[] = [];
  const flashes: string[] = [];
  const frames: (() => void)[] = [];
  let controller!: TranscriptScrollController<Row>;
  let renderer!: ReactTestRenderer;
  const element = (next: Partial<Props>) =>
    React.createElement(Transcript, {
      moves,
      flashes,
      frames,
      onController: (value) => {
        controller = value;
      },
      ...props,
      ...next,
    } as Props);
  act(() => {
    renderer = create(element({}));
  });
  const flush = () =>
    act(() => {
      while (frames.length) frames.shift()!();
    });
  const list = () => renderer.root.findByType('List' as never).props;
  return {
    moves,
    flashes,
    flush,
    controller: () => controller,
    update: (next: Partial<Props>) =>
      act(() => {
        renderer.update(element(next));
      }),
    viewable: (...visible: string[]) => act(() => list().onViewable(visible)),
    scrollTo: (offset: number) => act(() => list().onTailOffset(offset)),
    drag: () => act(() => list().onScrollBeginDrag()),
    release: () => act(() => list().onMomentumScrollEnd()),
    pressDisc: () => act(() => renderer.root.findByType('Disc' as never).props.onPress()),
  };
}

describe('transcript features on the scroll controller', () => {
  it('follows each new message while the reader is at the newest end', () => {
    const view = mount({ rows: ids('m2', 'm1') });
    view.flush();
    expect(view.moves).toEqual([]);
    view.update({ rows: ids('m3', 'm2', 'm1') });
    view.flush();
    view.update({ rows: ids('m4', 'm3', 'm2', 'm1') });
    view.flush();
    expect(view.moves).toEqual(['newest', 'newest']);
  });

  it('keeps a reader in history in place, and the disc takes them to the newest message', () => {
    const view = mount({ rows: ids('m2', 'm1') });
    view.scrollTo(900);
    view.update({ rows: ids('m3', 'm2', 'm1') });
    view.flush();
    expect(view.moves).toEqual([]);
    view.pressDisc();
    view.flush();
    expect(view.moves).toEqual(['newest']);
    expect(view.controller().isPinnedToTail()).toBe(true);
  });

  it('lands on the first unread message and flashes it once it is on screen', () => {
    const view = mount({ rows: ids('m5', 'm4', 'm3', 'm2', 'm1'), firstUnreadId: 'm2' });
    view.flush();
    expect(view.moves).toEqual(['row:m2:center']);
    expect(view.flashes).toEqual([]);
    // An arrival during the landing does not pull the list to the tail.
    view.update({ rows: ids('m6', 'm5', 'm4', 'm3', 'm2', 'm1'), firstUnreadId: 'm2' });
    view.flush();
    expect(view.moves).toEqual(['row:m2:center']);
    view.viewable('m3', 'm2');
    expect(view.flashes).toEqual(['arrival:m2']);
    expect(view.controller().active()).toBeNull();
  });

  it('lets a drag stop an automatic scroll, and follow waits until the drag ends', () => {
    const view = mount({ rows: ids('m5', 'm4', 'm3', 'm2', 'm1'), firstUnreadId: 'm1' });
    view.drag();
    view.flush();
    view.viewable('m5', 'm4');
    expect(view.moves).toEqual([]);
    expect(view.controller().active()).toBeNull();
    // Mid-drag, an arrival at the tail does not scroll either.
    view.update({ rows: ids('m6', 'm5', 'm4', 'm3', 'm2', 'm1'), firstUnreadId: 'm1' });
    view.flush();
    expect(view.moves).toEqual([]);
    view.release();
    view.update({ rows: ids('m7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1'), firstUnreadId: 'm1' });
    view.flush();
    expect(view.moves).toEqual(['newest']);
  });

  it('drops a jump to the newest message when the reader drags before it runs', () => {
    const view = mount({ rows: ids('m2', 'm1') });
    view.scrollTo(900);
    view.pressDisc();
    view.drag();
    view.flush();
    expect(view.moves).toEqual([]);
  });

  it('lands a notification target at the top of the screen and flashes it', () => {
    const view = mount({ rows: ids('m5', 'm4', 'm3', 'm2', 'm1'), notificationId: 'm3' });
    view.flush();
    expect(view.moves).toEqual(['row:m3:top']);
    expect(view.flashes).toEqual(['source:m3']);
    // The list has not shown it yet: the next pass aligns it again.
    view.viewable('m5', 'm4');
    expect(view.moves).toEqual(['row:m3:top', 'row:m3:top']);
    view.viewable('m3', 'm2');
    expect(view.controller().active()).toBeNull();
    expect(view.flashes).toEqual(['source:m3']);
  });

  it('lets a notification replace an unread landing in progress', () => {
    const view = mount({ rows: ids('m5', 'm4', 'm3', 'm2', 'm1'), firstUnreadId: 'm1' });
    view.update({
      rows: ids('m5', 'm4', 'm3', 'm2', 'm1'),
      firstUnreadId: 'm1',
      notificationId: 'm4',
    });
    view.flush();
    expect(view.moves).toEqual(['row:m4:top']);
    view.viewable('m1');
    expect(view.flashes).toEqual(['source:m4']);
  });
});
