import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import {
  pinnedTailReadReport,
  ReadCursorAdvancer,
  READ_CURSOR_DEBOUNCE_MS,
} from './read-cursor-advance';
import {
  createTranscriptScrollController,
  type TranscriptRowDestination,
  type TranscriptScrollList,
} from './transcript-scroll-controller';

function row(id: string, extra: Partial<ChatDisplayMessage> = {}): ChatDisplayMessage {
  return { id, text: id, isUser: false, timestamp: 0, ...extra } as ChatDisplayMessage;
}

const inertList: TranscriptScrollList = {
  toNewest: () => {},
  toRow: () => true,
  toEstimatedRow: () => {},
  toOffset: () => {},
  shiftBy: () => {},
};

/**
 * The production pieces the chat surface composes for the pinned-tail re-ask:
 * the real scroll controller supplies the evidence, and the real advancer
 * writes the mark. `reask` mirrors `_chat-surface.tsx`'s effect.
 */
function harness(initialRows: ChatDisplayMessage[]) {
  let rows = initialRows;
  const frames: (() => void)[] = [];
  const controller = createTranscriptScrollController<ChatDisplayMessage>({
    list: () => inertList,
    rows: () => rows,
    rowIndex: (destination: TranscriptRowDestination, list: readonly ChatDisplayMessage[]) =>
      list.findIndex((candidate) => candidate.id === destination.messageId),
    schedule: (callback) => frames.push(callback),
  });
  const publish = vi.fn();
  const advancer = new ReadCursorAdvancer(publish);
  return {
    controller,
    publish,
    advancer,
    flushFrames: () => {
      while (frames.length) frames.shift()!();
    },
    setRows: (next: ChatDisplayMessage[]) => {
      rows = next;
    },
    reask: (hasObservedVisibility: boolean) => {
      const report = pinnedTailReadReport(rows, {
        pinnedToTail: controller.isPinnedToTail(),
        landing: controller.isLanding(),
        hasObservedVisibility,
      });
      if (report.length) advancer.observe(rows, report);
    },
  };
}

describe('the pinned-tail read re-ask needs the list’s own evidence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Reproduction COLD-OPEN-UNSEEN-TAIL. A cold open leaves the controller pin
  // true before any viewport report; the old, unguarded re-ask read the fetched
  // tail there, over messages the reader had not reached.
  it('delayed initial viewability: writes nothing until the list reports once', () => {
    const h = harness([row('older'), row('tail')]);
    h.reask(false);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS * 4);
    expect(h.publish).not.toHaveBeenCalled();

    // The first viewability pass establishes what is on screen.
    h.controller.observeVisibleRows([row('tail')]);
    h.reask(true);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    expect(h.publish).toHaveBeenCalledWith('tail');
  });

  // Reproduction FIRST-UNREAD-LANDING. Opening a Room with unread mail lands on
  // the first unread row, with newer messages below the fold. The re-ask must
  // never credit that unseen tail.
  it('a first-unread landing with newer messages below the fold is never read', () => {
    const h = harness([
      row('old'),
      row('first-new'),
      row('newer-below-fold'),
      row('newest-below-fold'),
    ]);
    h.controller.request({ kind: 'firstUnread', messageId: 'first-new' });
    h.flushFrames();
    expect(h.controller.isLanding()).toBe(true);

    // Visibility is established while the landing still owns the list.
    h.reask(true);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS * 4);
    expect(h.publish).not.toHaveBeenCalled();

    // The landing completes on the first unread row, which sits in history.
    h.controller.observeVisibleRows([row('first-new')]);
    h.controller.observeTailPinned(false);
    expect(h.controller.isLanding()).toBe(false);
    h.reask(true);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS * 4);
    expect(h.publish).not.toHaveBeenCalled();
  });

  // Reproduction TAIL-ARRIVAL-READ-DOT. The fix exists for this case: an agent
  // reply changes the newest row while the reader already rests at the tail and
  // the list runs no new viewability pass.
  it('still clears an actual tail arrival after the list has reported', () => {
    const h = harness([row('older'), row('reply')]);
    h.advancer.seed('reply');
    h.controller.observeVisibleRows([row('reply')]);
    h.reask(true);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS * 4);
    expect(h.publish).not.toHaveBeenCalled();

    h.setRows([row('older'), row('reply'), row('reply-2')]);
    h.reask(true);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    expect(h.publish).toHaveBeenCalledWith('reply-2');
  });
});
