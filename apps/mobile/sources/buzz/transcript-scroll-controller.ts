import { useRef, useState } from 'react';

import { scheduleAnimationFrame } from './host-scheduler';

/**
 * The one owner of transcript list movement. Features ask for a destination
 * and never call a list's scroll methods; `transcript-scroll.boundary.test.ts`
 * fails if any other file does.
 *
 * One request runs at a time. A new request replaces the active one, and a
 * user drag cancels it. A row request stays active across layout and
 * visibility passes until a visibility report shows its row, so a scroll made
 * with stale row measurements is made again on the next pass.
 *
 * - `newest`: the newest end. Runs on the next frame. `untilRowId` keeps it
 *   armed until that row is drawn, then lands once more (a desktop send).
 * - `message`: the row that shows a message, at the top or the center. With
 *   `jump`, a reader reaching for that message (a notification, a quote, a
 *   forward source): the feature may open a store window around it and
 *   flashes it on landing. Without, a row that is already shown (the code
 *   reader's return).
 * - `firstUnread`: the row that holds the unread boundary, centered. It is
 *   done when the row is visible, whether or not it had to scroll.
 * - `offset`: a raw list offset (the scrubber). Runs at once.
 */
export type TranscriptScrollDestination =
  | { kind: 'newest'; untilRowId?: string }
  | { kind: 'message'; messageId: string; align: TranscriptRowAlign; jump: boolean }
  | { kind: 'firstUnread'; messageId: string }
  | { kind: 'offset'; offset: number };

export type TranscriptRowAlign = 'top' | 'center';

export type TranscriptRowDestination = Extract<
  TranscriptScrollDestination,
  { kind: 'message' | 'firstUnread' }
>;

export type TranscriptScrollCancelReason = 'replaced' | 'drag' | 'cancelled';

/** The calls a platform list answers. Only the adapters below implement it. */
export type TranscriptScrollList = {
  toNewest(): void;
  /** False when the list cannot reach the row yet (not measured or not drawn). */
  toRow(index: number, rowId: string, align: TranscriptRowAlign): boolean;
  /** Scroll near a row the list could not reach, so its neighbours measure. */
  toEstimatedRow(index: number): void;
  toOffset(offset: number): void;
  /** Move by `delta` px to keep a reading row in place. */
  shiftBy(delta: number): void;
};

export type TranscriptScrollRow = { readonly id: string };

export type TranscriptScrollControllerOptions<Row extends TranscriptScrollRow> = {
  list(): TranscriptScrollList | null;
  /** Rows in list index order. */
  rows(): readonly Row[];
  /** Index in `rows` of the row that shows the destination, or -1. */
  rowIndex(destination: TranscriptRowDestination, rows: readonly Row[]): number;
  /**
   * Whether a row request may scroll to `index` before its first scroll. Lets
   * a feature fetch a better window first. Later passes always may.
   */
  canScrollTo?(destination: TranscriptRowDestination, index: number): boolean;
  /** A row request cannot scroll yet: the feature reveals or fetches its row. */
  onUnreachable?(destination: TranscriptRowDestination): void;
  /** First successful scroll of a row request. */
  onScrolled?(destination: TranscriptRowDestination, rowId: string): void;
  /** A visibility report shows the row; the request is done. */
  onLanded?(destination: TranscriptRowDestination, rowId: string): void;
  /** The request ended before it landed. */
  onCancelled?(
    destination: TranscriptScrollDestination,
    reason: TranscriptScrollCancelReason,
  ): void;
  schedule?(callback: () => void): void;
};

export type TranscriptScrollController<Row extends TranscriptScrollRow> = {
  request(destination: TranscriptScrollDestination): void;
  /** Follow new content to the newest end, unless a drag or a row request owns the list. */
  follow(): void;
  /** Same as `follow`, without waiting a frame (a measured desktop resize). */
  followNow(): void;
  /** Keep a reading row in place while nothing else owns the list. */
  holdReadingPosition(delta: number): void;
  cancel(): void;
  /** The room changed: drop the request and the visible rows, no callbacks. */
  reset(): void;
  /** Re-attempt the active request after a layout change. */
  observeLayout(): void;
  observeVisibleRows(rows: readonly Row[]): void;
  observeTailPinned(pinned: boolean): void;
  /** A touch drag or momentum began. Cancels the active request. */
  dragStarted(): void;
  /** The finger lifted. With `momentumMayFollow`, wait a frame for momentum to claim it. */
  dragEnded(momentumMayFollow: boolean): void;
  momentumEnded(): void;
  /** A wheel or touch scroll with no drag lifecycle (web). Cancels the active request. */
  userScrolled(): void;
  active(): TranscriptScrollDestination | null;
  /** A row request owns the list. */
  isLanding(): boolean;
  isPinnedToTail(): boolean;
  isUserDragging(): boolean;
};

type Active = {
  readonly destination: TranscriptScrollDestination;
  scrolled: boolean;
};

function isRowDestination(
  destination: TranscriptScrollDestination,
): destination is TranscriptRowDestination {
  return destination.kind === 'message' || destination.kind === 'firstUnread';
}

const defaultSchedule = (callback: () => void) => {
  if (scheduleAnimationFrame(() => callback()) === false) callback();
};

export function createTranscriptScrollController<Row extends TranscriptScrollRow>(
  options: TranscriptScrollControllerOptions<Row>,
): TranscriptScrollController<Row> {
  const schedule = options.schedule ?? defaultSchedule;
  let active: Active | null = null;
  let visibleRows: readonly Row[] = [];
  let pinned = true;
  let dragging = false;
  let dragSequence = 0;

  const end = (reason: TranscriptScrollCancelReason) => {
    const ended = active;
    if (!ended) return;
    active = null;
    options.onCancelled?.(ended.destination, reason);
  };

  const land = (current: Active, rowId: string) => {
    if (active !== current) return;
    active = null;
    options.onLanded?.(current.destination as TranscriptRowDestination, rowId);
  };

  /** The visible row that settles a row request, or null. */
  const settledRow = (current: Active): Row | null => {
    const destination = current.destination;
    if (!isRowDestination(destination)) return null;
    if (destination.kind === 'message' && !current.scrolled) return null;
    const index = options.rowIndex(destination, visibleRows);
    return index >= 0 ? visibleRows[index]! : null;
  };

  const attempt = (current: Active) => {
    if (active !== current) return;
    const list = options.list();
    const destination = current.destination;
    if (destination.kind === 'newest') {
      const waiting = Boolean(
        destination.untilRowId && !options.rows().some((row) => row.id === destination.untilRowId),
      );
      if (current.scrolled && waiting) return;
      current.scrolled = true;
      if (!waiting) active = null;
      list?.toNewest();
      pinned = true;
      return;
    }
    if (!isRowDestination(destination)) return;
    const settled = settledRow(current);
    if (settled) {
      land(current, settled.id);
      return;
    }
    const rows = options.rows();
    const index = options.rowIndex(destination, rows);
    if (
      index < 0 ||
      !list ||
      (!current.scrolled && options.canScrollTo && !options.canScrollTo(destination, index))
    ) {
      options.onUnreachable?.(destination);
      return;
    }
    const rowId = rows[index]!.id;
    const align = destination.kind === 'message' ? destination.align : 'center';
    if (!list.toRow(index, rowId, align)) {
      if (destination.kind === 'firstUnread') list.toEstimatedRow(index);
      return;
    }
    if (!current.scrolled) {
      current.scrolled = true;
      options.onScrolled?.(destination, rowId);
      if (active !== current) return;
    }
    const after = settledRow(current);
    if (after) land(current, after.id);
  };

  const request = (destination: TranscriptScrollDestination) => {
    end('replaced');
    if (destination.kind === 'offset') {
      options.list()?.toOffset(destination.offset);
      return;
    }
    const current: Active = { destination, scrolled: false };
    active = current;
    // The viewer asked for the newest end; an arrival in the meantime follows.
    if (destination.kind === 'newest') pinned = true;
    // A boundary already on screen is a completed landing.
    const settled = destination.kind === 'firstUnread' ? settledRow(current) : null;
    if (settled) {
      land(current, settled.id);
      return;
    }
    schedule(() => attempt(current));
  };

  const followAllowed = () => !dragging && !(active && isRowDestination(active.destination));

  return {
    request,
    follow() {
      if (!followAllowed()) return;
      if (active?.destination.kind === 'newest') return;
      request({ kind: 'newest' });
    },
    followNow() {
      if (!followAllowed()) return;
      options.list()?.toNewest();
    },
    holdReadingPosition(delta) {
      if (active || pinned || delta === 0) return;
      options.list()?.shiftBy(delta);
    },
    cancel() {
      end('cancelled');
    },
    reset() {
      active = null;
      visibleRows = [];
    },
    observeLayout() {
      if (active) attempt(active);
    },
    observeVisibleRows(rows) {
      visibleRows = rows;
      if (active) attempt(active);
    },
    observeTailPinned(next) {
      pinned = next;
    },
    dragStarted() {
      dragSequence += 1;
      dragging = true;
      end('drag');
    },
    dragEnded(momentumMayFollow) {
      const current = ++dragSequence;
      if (!momentumMayFollow) {
        dragging = false;
        return;
      }
      schedule(() => {
        if (dragSequence === current) dragging = false;
      });
    },
    momentumEnded() {
      dragSequence += 1;
      dragging = false;
    },
    userScrolled() {
      end('drag');
    },
    active: () => active?.destination ?? null,
    isLanding: () => Boolean(active && isRowDestination(active.destination)),
    isPinnedToTail: () => pinned,
    isUserDragging: () => dragging,
  };
}

/** One controller per transcript surface; option callbacks always read the latest render. */
export function useTranscriptScrollController<Row extends TranscriptScrollRow>(
  options: TranscriptScrollControllerOptions<Row>,
): TranscriptScrollController<Row> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [controller] = useState(() =>
    createTranscriptScrollController<Row>({
      list: () => optionsRef.current.list(),
      rows: () => optionsRef.current.rows(),
      rowIndex: (destination, rows) => optionsRef.current.rowIndex(destination, rows),
      canScrollTo: (destination, index) =>
        optionsRef.current.canScrollTo?.(destination, index) ?? true,
      onUnreachable: (destination) => optionsRef.current.onUnreachable?.(destination),
      onScrolled: (destination, rowId) => optionsRef.current.onScrolled?.(destination, rowId),
      onLanded: (destination, rowId) => optionsRef.current.onLanded?.(destination, rowId),
      onCancelled: (destination, reason) => optionsRef.current.onCancelled?.(destination, reason),
      schedule: (callback) => (optionsRef.current.schedule ?? defaultSchedule)(callback),
    }),
  );
  return controller;
}

type PhoneList = {
  scrollToIndex(params: { index: number; viewPosition: number; animated: boolean }): void;
  scrollToOffset(params: { offset: number; animated: boolean }): void;
};

/**
 * The inverted phone FlatList. Offset 0 is the newest end, and view position 1
 * puts a row's start at the top of the viewport. Pass `scrollToIndexFailed`
 * as the list's `onScrollToIndexFailed`: the list calls it synchronously from
 * `scrollToIndex` when the row is not measured yet.
 */
export function phoneTranscriptList(getList: () => PhoneList | null): TranscriptScrollList & {
  scrollToIndexFailed(info: { averageItemLength: number }): void;
} {
  let failed = false;
  let averageItemLength = 0;
  return {
    toNewest() {
      getList()?.scrollToOffset({ offset: 0, animated: false });
    },
    toRow(index, _rowId, align) {
      const list = getList();
      if (!list) return false;
      failed = false;
      list.scrollToIndex({ index, viewPosition: align === 'top' ? 1 : 0.5, animated: false });
      return !failed;
    },
    toEstimatedRow(index) {
      // Variable-height rows cannot provide getItemLayout. Scroll near the
      // row, let that window measure, then the next pass resolves it again.
      if (averageItemLength > 0)
        getList()?.scrollToOffset({ offset: averageItemLength * index, animated: false });
    },
    toOffset(offset) {
      getList()?.scrollToOffset({ offset, animated: false });
    },
    shiftBy() {},
    scrollToIndexFailed(info) {
      failed = true;
      averageItemLength = info.averageItemLength;
    },
  };
}

type DesktopNode = {
  scrollTop: number;
  readonly scrollHeight: number;
};

type DesktopRowNode = { scrollIntoView(options: { block: 'start' | 'center' }): void };

/** The desktop transcript: a plain scrollable DOM node with one node per row. */
export function desktopTranscriptList(
  getScrollNode: () => DesktopNode | null,
  getRowNode: (rowId: string) => DesktopRowNode | undefined,
): TranscriptScrollList {
  return {
    toNewest() {
      const node = getScrollNode();
      if (node) node.scrollTop = node.scrollHeight;
    },
    toRow(_index, rowId, align) {
      const row = getRowNode(rowId);
      if (!row) return false;
      row.scrollIntoView({ block: align === 'top' ? 'start' : 'center' });
      return true;
    },
    toEstimatedRow() {},
    toOffset(offset) {
      const node = getScrollNode();
      if (node) node.scrollTop = offset;
    },
    shiftBy(delta) {
      const node = getScrollNode();
      if (node) node.scrollTop += delta;
    },
  };
}
