import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type {
  ChatListCorner,
  ChatListItem,
  CornerListItem,
  CornerListView,
} from '@beeline/api-contract/phone';
import { subscribeClientReset } from '@/sync/client-reset';
import { OrderedRecordStore, type RecordMark } from './ordered-record-store';

/** One Room corner record for frames, reads, the list, header and notifier.
 * Whole server summaries replace older summaries; partial pages never derive one.
 * The surface clock orders reads and frames, and lane sequence deduplicates frames. */

type CornerStatusFrame = {
  readonly roomId: string;
  readonly cornerCount: number;
  readonly openCorners: readonly ChatListCorner[];
  readonly corners?: readonly CornerListItem[];
  readonly nextOpen?: string;
  readonly sequence?: number;
};

type CornerListHeader = Omit<CornerListView, 'corners' | 'nextOpen' | 'nextArchived' | 'summary'>;

export type RoomCornerSummary = {
  readonly cornerCount: number;
  readonly openCorners: readonly ChatListCorner[];
};

export type RoomCorners = {
  readonly header?: CornerListHeader;
  readonly headerRead: boolean;
  readonly rows?: readonly CornerListItem[];
  readonly firstPageNext?: string;
  readonly openMore: readonly CornerListItem[];
  readonly nextOpen?: string;
  readonly summary?: RoomCornerSummary;
  readonly archived?: { readonly corners: readonly CornerListItem[]; readonly next?: string };
  /** False after a lost lane or an unproven saved copy. */
  readonly current: boolean;
  readonly wantsRead: boolean;
  readonly openMoreStale: boolean;
  readonly archivedStale: boolean;
};

type Entry = RoomCorners & {
  readonly changedAt: number;
  readonly rowsReadAt?: number;
  readonly sequence?: number;
  readonly summaryAt?: number;
  /** An archived read begun before this clock may miss a closed corner. */
  readonly archivedChangedAt: number;
  readonly laneEpoch: number;
  readonly laneHeld: boolean;
};

export type CornerReadMark = RecordMark & {
  readonly laneEpoch: number;
  readonly laneHeld: boolean;
};

const EMPTY: Entry = {
  headerRead: false,
  openMore: [],
  current: false,
  wantsRead: false,
  openMoreStale: false,
  archivedStale: false,
  changedAt: 0,
  archivedChangedAt: 0,
  laneEpoch: 0,
  laneHeld: false,
};

const records = new OrderedRecordStore<Entry>();
const summaryListeners = new Set<() => void>();
let summaryRevision = 0;
function entry(roomId: string): Entry {
  return records.get(roomId) ?? EMPTY;
}

function write(roomId: string, next: Entry): void {
  const before = records.get(roomId)?.summary;
  records.set(roomId, next);
  if (next.summary !== before) {
    summaryRevision += 1;
    for (const listener of [...summaryListeners]) listener();
  }
}

/**
 * The one summary rule: a source started after the held summary's source
 * replaces it when whole.
 */
function withSummary(
  current: Entry,
  summary: RoomCornerSummary,
  startedAt: number,
): Entry {
  if (current.summaryAt !== undefined && startedAt <= current.summaryAt) return current;
  return { ...current, summary, summaryAt: startedAt };
}

function rowsFacts(rows: readonly CornerListItem[] | undefined): string {
  return JSON.stringify(
    (rows ?? []).map((item) => [item.corner.id, item.state, item.reason, item.lifecycle]),
  );
}

/** `rows` without any id in `taken`, and without repeating one of their own. */
function withoutRows(
  rows: readonly CornerListItem[],
  taken: readonly CornerListItem[],
): CornerListItem[] {
  const seen = new Set(taken.map((item) => item.corner.id));
  return rows.filter((item) => {
    if (seen.has(item.corner.id)) return false;
    seen.add(item.corner.id);
    return true;
  });
}

function cursor(value: string | undefined): { nextOpen?: string } {
  return value ? { nextOpen: value } : {};
}

function withRows(
  current: Entry,
  rows: readonly CornerListItem[],
  firstPageNext: string | undefined,
): Entry {
  const openMore = withoutRows(current.openMore, rows);
  const { nextOpen: _held, firstPageNext: _first, ...rest } = current;
  return {
    ...rest,
    rows,
    ...(firstPageNext ? { firstPageNext } : {}),
    openMore,
    ...cursor(openMore.length ? current.nextOpen : firstPageNext),
  };
}

export function getRoomCorners(roomId: string): RoomCorners {
  return entry(roomId);
}

/** The first page and the held pages after it, as one list. */
export function roomOpenCornerRows(corners: RoomCorners): readonly CornerListItem[] {
  return [...(corners.rows ?? []), ...corners.openMore];
}

/** One corner's row wherever the record holds it: open pages, then archived. */
export function findRoomCornerRow(
  corners: RoomCorners,
  cornerId: string,
): CornerListItem | undefined {
  const match = (item: CornerListItem) => item.corner.id === cornerId;
  return roomOpenCornerRows(corners).find(match) ?? corners.archived?.corners.find(match);
}

/** The whole Corners page, once both its rows and its header are held. */
export function roomCornerListView(corners: RoomCorners): CornerListView | undefined {
  if (!corners.header || !corners.rows) return undefined;
  return { ...corners.header, corners: corners.rows, ...cursor(corners.firstPageNext) };
}

function subscribeRoomCorners(roomId: string, listener: () => void): () => void {
  return records.subscribe(roomId, listener);
}

/** Workflow cells observe the same corner record as every other reader. */
export function subscribeRoomCornerFacts(roomId: string, listener: () => void): () => void {
  let previous = entry(roomId);
  return records.subscribe(roomId, () => {
    const current = entry(roomId);
    const changed = Boolean(previous.rows && current.rows &&
      rowsFacts(previous.rows) !== rowsFacts(current.rows)) ||
      (current.wantsRead && !previous.wantsRead);
    previous = current;
    if (changed) listener();
  });
}

/** Taken when a read starts: its own clock tick, never shared with another read. */
export function cornerReadMark(roomId: string): CornerReadMark {
  const current = entry(roomId);
  return { ...records.mark(), laneEpoch: current.laneEpoch, laneHeld: current.laneHeld };
}

/** One surface clock for Room-list and corner reads. */
export const cornerStoreClock = () => records.clock();
export const cornerStoreGeneration = () => records.generation;
export const shareCornerRead = (key: string, force: boolean, read: () => Promise<boolean>) =>
  records.coalesceRead(key, force, read);

/**
 * The one `corner-status` dedupe. False when the lane already applied this
 * sequence or a newer one, and the frame must go no further.
 */
export function acceptCornerStatusFrame(frame: CornerStatusFrame): boolean {
  const current = entry(frame.roomId);
  if (frame.sequence !== undefined && current.sequence !== undefined &&
      frame.sequence <= current.sequence) return false;
  const clock = records.clock();
  const framed = {
    ...withSummary(
      current,
      { cornerCount: frame.cornerCount, openCorners: frame.openCorners },
      clock,
    ),
    changedAt: clock,
    ...(frame.sequence !== undefined ? { sequence: frame.sequence } : {}),
  };
  if (!frame.corners) {
    // An older server names the change but not the rows.
    write(frame.roomId, {
      ...framed, current: false, wantsRead: true, archivedChangedAt: clock,
      archivedStale: current.archived !== undefined,
    });
    return true;
  }
  const next = withRows(framed, frame.corners, frame.nextOpen);
  const open = new Set([...frame.corners, ...next.openMore].map((item) => item.corner.id));
  const closed = [...(current.rows ?? []), ...current.openMore]
    .some((item) => !open.has(item.corner.id));
  write(frame.roomId, {
    ...next,
    current: current.laneHeld,
    // The rows are whole again; a reader without a header still reads for it.
    wantsRead: false,
    openMoreStale: current.openMoreStale || next.openMore.length > 0,
    archivedStale: current.archivedStale || (closed && current.archived !== undefined),
    ...(closed ? { archivedChangedAt: clock } : {}),
  });
  return true;
}

/**
 * The server confirmed the Room lane. Only a resumed lane carried every change
 * since the last one; a fresh lane restarts the sequence and leaves the rows
 * unproven.
 */
export function noteCornerLaneSubscribed(roomId: string, resumed: boolean): void {
  const current = entry(roomId);
  if (resumed && current.laneEpoch > 0) {
    if (!current.laneHeld) records.silent(roomId, { ...current, laneHeld: true });
    return;
  }
  const clock = records.clock();
  const { sequence: _sequence, ...rest } = current;
  write(roomId, {
    ...rest,
    laneHeld: true,
    laneEpoch: current.laneEpoch + 1,
    changedAt: clock,
    archivedChangedAt: clock,
    current: false,
    wantsRead: true,
    openMoreStale: current.openMore.length > 0,
    archivedStale: current.archived !== undefined,
  });
}

/** The socket closed. A lane the next socket resumes keeps its rows current. */
export function noteCornerSocketDropped(): void {
  for (const [roomId, current] of records.entries()) {
    if (current.laneHeld) records.silent(roomId, { ...current, laneHeld: false });
  }
}

/** Nothing holds the Room lane any more, so later changes go unheard. */
export function noteCornerLaneReleased(roomId: string): void {
  const current = records.get(roomId);
  if (!current) return;
  const { sequence: _sequence, ...rest } = current;
  write(roomId, { ...rest, laneHeld: false, laneEpoch: current.laneEpoch + 1, current: false });
}

/** The server named a corner change without sending its rows. */
export function noteRoomCornersChanged(roomId: string): void {
  const clock = records.clock();
  const current = entry(roomId);
  write(roomId, {
    ...current,
    changedAt: clock,
    archivedChangedAt: clock,
    current: false,
    wantsRead: true,
    openMoreStale: current.openMore.length > 0,
    archivedStale: current.archived !== undefined,
  });
}

/** A reader started a read of the first page. */
export function noteCornerReadStarted(roomId: string): void {
  const current = records.get(roomId);
  if (current?.wantsRead) write(roomId, { ...current, wantsRead: false });
}

/** A read of the first open page landed. */
export function applyCornerListRead(
  roomId: string,
  view: CornerListView,
  mark: CornerReadMark,
): void {
  if (!records.accepts(mark)) return;
  const { corners, nextOpen, nextArchived: _archived, summary, ...header } = view;
  const current = summary
    ? withSummary(
      entry(roomId),
      { cornerCount: summary.cornerCount, openCorners: summary.openCorners },
      mark.clock,
    )
    : entry(roomId);
  if (current.rows &&
      (current.changedAt > mark.clock || (current.rowsReadAt ?? 0) > mark.clock)) {
    // A frame or a read started after this one holds newer rows; keep them.
    write(roomId, { ...current, header, headerRead: true });
    return;
  }
  const next = withRows(current, corners, nextOpen);
  const changed = Boolean(current.rows) && rowsFacts(current.rows) !== rowsFacts(corners);
  write(roomId, {
    ...next,
    // A newer partial answer cannot supply a summary, but it still proves an
    // older whole answer obsolete.
    ...(!summary && (current.summaryAt ?? -Infinity) < mark.clock
      ? { summaryAt: mark.clock } : {}),
    rowsReadAt: mark.clock,
    header,
    headerRead: true,
    current: current.laneHeld && mark.laneHeld && current.laneEpoch === mark.laneEpoch,
    openMoreStale: current.openMoreStale || (next.openMore.length > 0 && changed),
  });
}

/** A saved copy paints before the first read; it is never current. */
export function hydrateRoomCorners(roomId: string, view: CornerListView): void {
  const current = entry(roomId);
  if (current.header && current.rows) return;
  const { corners, nextOpen, nextArchived: _archived, summary: _summary, ...header } = view;
  write(roomId, current.rows ? { ...current, header } : { ...withRows(current, corners, nextOpen), header });
}

/**
 * An open page past the first landed. `replace` swaps every held page for
 * these rows, once a frame left the held pages unproven; a frame since the
 * read started leaves them unproven still.
 */
export function applyOpenCornerPage(
  roomId: string,
  rows: readonly CornerListItem[],
  nextOpen: string | undefined,
  mark: CornerReadMark,
  replace = false,
): void {
  if (!records.accepts(mark)) return;
  const current = entry(roomId);
  const { nextOpen: _held, ...rest } = current;
  write(roomId, {
    ...rest,
    openMore: withoutRows([...(replace ? [] : current.openMore), ...rows], current.rows ?? []),
    ...cursor(nextOpen),
    ...(replace ? { openMoreStale: current.changedAt > mark.clock } : {}),
  });
}

/**
 * Archived rows landed: a first page replaces the held ones, a later page
 * appends. A read that started before a corner left the open set may miss it,
 * so its rows stay stale and the reader reads again.
 */
export function applyArchivedCorners(
  roomId: string,
  rows: readonly CornerListItem[],
  next: string | undefined,
  append: boolean,
  mark: CornerReadMark,
): void {
  if (!records.accepts(mark)) return;
  const current = entry(roomId);
  const missed = current.archivedChangedAt > mark.clock;
  write(roomId, {
    ...current,
    archived: {
      corners: withoutRows([...(append ? current.archived?.corners ?? [] : []), ...rows], []),
      ...(next ? { next } : {}),
    },
    archivedStale: missed || (append && current.archivedStale),
  });
}

/**
 * A Room list read landed, or its saved copy did with `readStartedAt` -1:
 * each row's summary applies by the one summary rule. A row whose corner
 * facts the server omitted says nothing.
 */
export function applyChatListCorners(
  chats: readonly Pick<ChatListItem, 'room' | 'openCorners' | 'cornerCount'>[],
  readStartedAt: number,
): void {
  for (const item of chats) {
    if (item.cornerCount === undefined) continue;
    const current = entry(item.room.id);
    const next = withSummary(
      current,
      { cornerCount: item.cornerCount, openCorners: item.openCorners ?? [] },
      readStartedAt,
    );
    if (next !== current) write(item.room.id, next);
  }
}

/** A new identity must not see the last one's corners, nor a read started for it. */
export function resetRoomCornerStore(): void {
  records.reset();
  summaryRevision += 1;
  for (const listener of [...summaryListeners]) listener();
}

subscribeClientReset(resetRoomCornerStore);

/** Select a Room's corner record; re-renders when it changes. Reads nothing. */
export function useRoomCornerRecord(roomId: string | undefined): RoomCorners | undefined {
  const subscribe = useCallback(
    (listener: () => void) => (roomId ? subscribeRoomCorners(roomId, listener) : () => undefined),
    [roomId],
  );
  return useSyncExternalStore(subscribe, () => (roomId ? getRoomCorners(roomId) : undefined));
}

export function getRoomCornerSummary(roomId: string): RoomCornerSummary | undefined {
  return entry(roomId).summary;
}

export function subscribeRoomCornerSummaries(listener: () => void): () => void {
  summaryListeners.add(listener);
  return () => {
    summaryListeners.delete(listener);
  };
}

/** Select a Room's corner summary; re-renders when it changes. */
export function useRoomCornerSummary(roomId: string): RoomCornerSummary | undefined {
  return useRoomCornerRecord(roomId)?.summary;
}

/** Every held Room's summary by Room id; a new map whenever one changes. */
export function useRoomCornerSummaries(): ReadonlyMap<string, RoomCornerSummary> {
  const revision = useSyncExternalStore(subscribeRoomCornerSummaries, () => summaryRevision);
  return useMemo(() => new Map([...records.entries()].flatMap(([id, record]) =>
    record.summary ? [[id, record.summary] as const] : [])), [revision]);
}
