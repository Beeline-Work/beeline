import { describe, expect, it, vi } from 'vitest';

import {
  createTranscriptScrollController,
  desktopTranscriptList,
  phoneTranscriptList,
  type TranscriptRowDestination,
  type TranscriptScrollControllerOptions,
  type TranscriptScrollList,
} from './transcript-scroll-controller';

type Row = { id: string };

/** A list that records each move. `unmeasured` rows fail like an unmeasured FlatList row. */
function fakeList(unmeasured = new Set<string>()) {
  const moves: string[] = [];
  const list: TranscriptScrollList = {
    toNewest: () => moves.push('newest'),
    toRow: (index, rowId, align) => {
      if (unmeasured.has(rowId)) {
        moves.push(`miss:${rowId}`);
        return false;
      }
      moves.push(`row:${rowId}@${index}:${align}`);
      return true;
    },
    toEstimatedRow: (index) => moves.push(`estimate:${index}`),
    toOffset: (offset) => moves.push(`offset:${offset}`),
    shiftBy: (delta) => moves.push(`shift:${delta}`),
  };
  return { list, moves, unmeasured };
}

function setup(overrides: Partial<TranscriptScrollControllerOptions<Row>> = {}) {
  const fake = fakeList();
  let rows: Row[] = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({ id }));
  const frames: (() => void)[] = [];
  const events: string[] = [];
  const controller = createTranscriptScrollController<Row>({
    list: () => fake.list,
    rows: () => rows,
    rowIndex: (destination: TranscriptRowDestination, list: readonly Row[]) =>
      list.findIndex((row) => row.id === destination.messageId),
    onUnreachable: (destination) => events.push(`unreachable:${destination.messageId}`),
    onScrolled: (destination, rowId) => events.push(`scrolled:${destination.kind}:${rowId}`),
    onLanded: (destination, rowId) => events.push(`landed:${destination.kind}:${rowId}`),
    onCancelled: (destination, reason) => events.push(`cancelled:${destination.kind}:${reason}`),
    schedule: (callback) => frames.push(callback),
    ...overrides,
  });
  const flush = () => {
    while (frames.length) frames.shift()!();
  };
  return {
    controller,
    moves: fake.moves,
    unmeasured: fake.unmeasured,
    events,
    frames,
    flush,
    setRows: (next: Row[]) => {
      rows = next;
    },
  };
}

const message = (messageId: string) =>
  ({ kind: 'message', messageId, align: 'top', jump: true }) as const;

describe('transcript scroll controller', () => {
  it('scrolls to the newest end on the next frame and is then done', () => {
    const { controller, moves, flush } = setup();
    controller.request({ kind: 'newest' });
    expect(moves).toEqual([]);
    expect(controller.active()).toEqual({ kind: 'newest' });
    flush();
    expect(moves).toEqual(['newest']);
    expect(controller.active()).toBeNull();
    expect(controller.isPinnedToTail()).toBe(true);
  });

  it('scrolls a message to the top, flashes once, and lands when its row is visible', () => {
    const { controller, moves, events, flush } = setup();
    controller.request(message('m3'));
    flush();
    expect(moves).toEqual(['row:m3@2:top']);
    expect(events).toEqual(['scrolled:message:m3']);
    expect(controller.isLanding()).toBe(true);

    // A pass that does not show the row scrolls again; no second flash.
    controller.observeVisibleRows([{ id: 'm1' }]);
    expect(moves).toEqual(['row:m3@2:top', 'row:m3@2:top']);
    controller.observeVisibleRows([{ id: 'm3' }]);
    expect(events).toEqual(['scrolled:message:m3', 'landed:message:m3']);
    expect(controller.active()).toBeNull();
  });

  it('does not land a message that was visible before it scrolled', () => {
    const { controller, moves, events, flush } = setup();
    controller.observeVisibleRows([{ id: 'm3' }]);
    controller.request(message('m3'));
    flush();
    expect(moves).toEqual(['row:m3@2:top']);
    expect(events).toEqual(['scrolled:message:m3', 'landed:message:m3']);
  });

  it('waits for a later pass when the list has not measured the row', () => {
    const { controller, moves, unmeasured, events, flush } = setup();
    unmeasured.add('m4');
    controller.request(message('m4'));
    flush();
    expect(moves).toEqual(['miss:m4']);
    expect(events).toEqual([]);
    unmeasured.clear();
    controller.observeLayout();
    expect(moves).toEqual(['miss:m4', 'row:m4@3:top']);
    expect(events).toEqual(['scrolled:message:m4']);
  });

  it('asks the feature for a row that is not drawn, and lands it when it arrives', () => {
    const { controller, moves, events, flush, setRows } = setup();
    controller.request(message('m9'));
    flush();
    expect(events).toEqual(['unreachable:m9']);
    setRows(['m8', 'm9', 'm10'].map((id) => ({ id })));
    controller.observeLayout();
    expect(moves).toEqual(['row:m9@1:top']);
  });

  it('lets the feature hold the first scroll until a better window opens', () => {
    let allowed = false;
    const { controller, moves, events, flush } = setup({
      canScrollTo: () => allowed,
      onUnreachable: (destination) => events.push(`unreachable:${destination.messageId}`),
    });
    controller.request(message('m5'));
    flush();
    expect(moves).toEqual([]);
    expect(events).toEqual(['unreachable:m5']);
    allowed = true;
    controller.observeLayout();
    expect(moves).toEqual(['row:m5@4:top']);
    // After the first scroll the hold no longer applies.
    allowed = false;
    controller.observeLayout();
    expect(moves).toEqual(['row:m5@4:top', 'row:m5@4:top']);
  });

  it('lands the first unread row at once when it is already visible', () => {
    const { controller, moves, events, frames } = setup();
    controller.observeVisibleRows([{ id: 'm2' }, { id: 'm3' }]);
    controller.request({ kind: 'firstUnread', messageId: 'm2' });
    expect(frames).toEqual([]);
    expect(moves).toEqual([]);
    expect(events).toEqual(['landed:firstUnread:m2']);
  });

  it('centers the first unread row and estimates near it when it is not measured', () => {
    const { controller, moves, unmeasured, events, flush } = setup();
    unmeasured.add('m2');
    controller.request({ kind: 'firstUnread', messageId: 'm2' });
    flush();
    expect(moves).toEqual(['miss:m2', 'estimate:1']);
    unmeasured.clear();
    controller.observeVisibleRows([{ id: 'm1' }]);
    expect(moves).toEqual(['miss:m2', 'estimate:1', 'row:m2@1:center']);
    controller.observeVisibleRows([{ id: 'm2' }]);
    expect(events).toEqual(['scrolled:firstUnread:m2', 'landed:firstUnread:m2']);
  });

  it('runs one request at a time: a new request replaces the active one', () => {
    const { controller, moves, events, flush } = setup();
    controller.request({ kind: 'firstUnread', messageId: 'm2' });
    controller.request(message('m4'));
    expect(events).toEqual(['cancelled:firstUnread:replaced']);
    flush();
    // The replaced request's frame does nothing.
    expect(moves).toEqual(['row:m4@3:top']);

    controller.request({ kind: 'newest' });
    expect(events).toContain('cancelled:message:replaced');
    flush();
    expect(moves).toEqual(['row:m4@3:top', 'newest']);
    controller.observeVisibleRows([{ id: 'm4' }]);
    expect(events).not.toContain('landed:message:m4');
  });

  it('cancels the active request when the reader drags', () => {
    const { controller, moves, events, flush } = setup();
    controller.request(message('m3'));
    flush();
    controller.dragStarted();
    expect(events).toEqual(['scrolled:message:m3', 'cancelled:message:drag']);
    expect(controller.isUserDragging()).toBe(true);
    controller.observeLayout();
    controller.observeVisibleRows([{ id: 'm1' }]);
    expect(moves).toEqual(['row:m3@2:top']);
  });

  it('drops a scheduled scroll when the reader drags before its frame', () => {
    const { controller, moves, events, flush } = setup();
    controller.request({ kind: 'newest' });
    controller.userScrolled();
    flush();
    expect(moves).toEqual([]);
    expect(events).toEqual(['cancelled:newest:drag']);
  });

  it('follows new content only when no drag or landing owns the list', () => {
    const { controller, moves, flush } = setup();
    controller.follow();
    flush();
    expect(moves).toEqual(['newest']);

    controller.request(message('m3'));
    flush();
    controller.follow();
    flush();
    expect(moves).toEqual(['newest', 'row:m3@2:top']);

    controller.cancel();
    controller.dragStarted();
    controller.follow();
    controller.followNow();
    flush();
    expect(moves).toEqual(['newest', 'row:m3@2:top']);

    controller.dragEnded(false);
    controller.followNow();
    expect(moves).toEqual(['newest', 'row:m3@2:top', 'newest']);
  });

  it('keeps the drag held for a frame after a release that momentum may claim', () => {
    const { controller, frames, flush } = setup();
    controller.dragStarted();
    controller.dragEnded(true);
    expect(controller.isUserDragging()).toBe(true);
    // Momentum begins before the frame: the drag stays held.
    controller.momentumStarted();
    flush();
    expect(controller.isUserDragging()).toBe(true);
    controller.momentumEnded();
    expect(controller.isUserDragging()).toBe(false);

    controller.dragStarted();
    controller.dragEnded(true);
    expect(frames).toHaveLength(1);
    flush();
    expect(controller.isUserDragging()).toBe(false);
  });

  it('lands a send once more when its own row is drawn', () => {
    const { controller, moves, flush, setRows } = setup();
    controller.observeTailPinned(false);
    controller.request({ kind: 'newest', untilRowId: 'mine' });
    expect(controller.isPinnedToTail()).toBe(true);
    flush();
    expect(moves).toEqual(['newest']);
    controller.observeLayout();
    expect(moves).toEqual(['newest']);
    setRows([{ id: 'm1' }, { id: 'mine' }]);
    controller.observeLayout();
    expect(moves).toEqual(['newest', 'newest']);
    expect(controller.active()).toBeNull();
  });

  it('applies a scrubber offset at once and replaces a landing', () => {
    const { controller, moves, events } = setup();
    controller.request(message('m3'));
    controller.request({ kind: 'offset', offset: 420 });
    expect(moves).toEqual(['offset:420']);
    expect(events).toEqual(['cancelled:message:replaced']);
    expect(controller.active()).toBeNull();
  });

  it('keeps a scrub requested during momentum pending and lands it when momentum ends', () => {
    const { controller, moves, events } = setup();
    controller.dragStarted();
    controller.dragEnded(true);
    controller.momentumStarted();
    // The list coasts past each offset the scrubber asks for.
    controller.request({ kind: 'offset', offset: 300 });
    controller.request({ kind: 'offset', offset: 900 });
    expect(controller.active()).toEqual({ kind: 'offset', offset: 900 });
    controller.observeLayout();
    controller.momentumEnded();
    expect(moves).toEqual(['offset:300', 'offset:900', 'offset:900', 'offset:900']);
    expect(controller.active()).toBeNull();
    // A later momentum end does not move the list again.
    controller.momentumEnded();
    expect(moves).toHaveLength(4);
    expect(events).toEqual(['cancelled:offset:replaced']);
  });

  it('lets a drag on the list cancel a scrub pending on momentum', () => {
    const { controller, moves, events } = setup();
    controller.momentumStarted();
    controller.request({ kind: 'offset', offset: 900 });
    controller.dragStarted();
    controller.momentumEnded();
    expect(moves).toEqual(['offset:900']);
    expect(events).toEqual(['cancelled:offset:drag']);
    expect(controller.active()).toBeNull();
  });

  it('keeps a reading row in place only while nothing owns the list', () => {
    const { controller, moves } = setup();
    controller.holdReadingPosition(30);
    expect(moves).toEqual([]);
    controller.observeTailPinned(false);
    controller.holdReadingPosition(30);
    expect(moves).toEqual(['shift:30']);
    controller.request(message('m3'));
    controller.holdReadingPosition(30);
    expect(moves).toEqual(['shift:30']);
  });

  it('drops the request without callbacks when the room changes', () => {
    const { controller, moves, events, flush } = setup();
    controller.observeVisibleRows([{ id: 'm2' }]);
    controller.request(message('m3'));
    controller.reset();
    flush();
    expect(moves).toEqual([]);
    expect(events).toEqual([]);
    // Visible rows from the old room no longer settle a boundary.
    controller.request({ kind: 'firstUnread', messageId: 'm2' });
    expect(events).toEqual([]);
  });
});

describe('phone transcript list', () => {
  it('drives the inverted FlatList and reports an unmeasured row', () => {
    const scrollToIndex = vi.fn();
    const scrollToOffset = vi.fn();
    const adapter = phoneTranscriptList(() => ({ scrollToIndex, scrollToOffset }));

    adapter.toNewest();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
    expect(adapter.toRow(4, 'm', 'top')).toBe(true);
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 4, viewPosition: 1, animated: false });

    scrollToIndex.mockImplementationOnce(() =>
      adapter.scrollToIndexFailed({ averageItemLength: 80 }),
    );
    expect(adapter.toRow(9, 'm', 'center')).toBe(false);
    expect(scrollToIndex).toHaveBeenLastCalledWith({
      index: 9,
      viewPosition: 0.5,
      animated: false,
    });
    adapter.toEstimatedRow(9);
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 720, animated: false });
  });
});

describe('desktop transcript list', () => {
  it('drives the scroll node and row nodes', () => {
    const node = { scrollTop: 0, scrollHeight: 900 };
    const scrollIntoView = vi.fn();
    const adapter = desktopTranscriptList(
      () => node,
      (rowId) => (rowId === 'shown' ? { scrollIntoView } : undefined),
    );
    adapter.toNewest();
    expect(node.scrollTop).toBe(900);
    adapter.shiftBy(-100);
    expect(node.scrollTop).toBe(800);
    expect(adapter.toRow(0, 'shown', 'top')).toBe(true);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'start' });
    expect(adapter.toRow(0, 'absent', 'top')).toBe(false);
  });
});
