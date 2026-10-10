import { useCallback, useSyncExternalStore } from 'react';
import type {
  ChatListCorner,
  ChatListItem,
  CornerListItem,
  CornerListView,
} from '@beeline/api-contract/phone';

/**
 * The client's one copy of each Room's corner rows. The live connection
 * writes every `corner-status` frame here whichever screen is mounted, and
 * every corners read lands here too, so the Corners screen, the Room list
 * dropdown, the desktop inspector, the corner header and the `#` menu all
 * select the same record.
 *
 * Order: frames are ordered by the Room lane's sequence, and a frame is newer
 * than any read that started before it. A read's rows apply only when no frame
 * landed for its Room since the read started.
 */

export type CornerStatusFrame = {
  readonly roomId: string;
  readonly cornerCount: number;
  readonly waitingCornerCount: number;
  readonly openCorners: readonly ChatListCorner[];
  readonly corners?: readonly CornerListItem[];
  readonly nextOpen?: string;
  readonly sequence?: number;
};

/** What a corners read says besides its rows: the Room, the viewer, the apps. */
export type CornerListHeader = Omit<CornerListView, 'corners' | 'nextOpen' | 'nextArchived'>;

export type RoomCorners = {
  readonly header?: CornerListHeader;
  /** The first page of open corners, newest first. */
  readonly rows?: readonly CornerListItem[];
  /** The cursor after the first page. */
  readonly firstPageNext?: string;
  /** Open corners past the first page, never repeating a first-page row. */
  readonly openMore: readonly CornerListItem[];
  /** The cursor after the last open row held. */
  readonly nextOpen?: string;
  /** The Room list's summary of the viewer's open corners. */
  readonly openCorners?: readonly ChatListCorner[];
  /** The server's exact counts, never counted on the client. */
  readonly cornerCount?: number;
  readonly waitingCornerCount?: number;
  /** `full` when a frame sent the summary; `preview` when the Room list read
   *  sent its capped copy. A preview is never the complete list. */
  readonly summary?: 'full' | 'preview';
  /** Closed corners, once a reader asked for them. */
  readonly archived?: { readonly corners: readonly CornerListItem[]; readonly next?: string };
  /** The Room lane carried every change since `rows` landed. Rows from disk,
   *  or read or framed without a held lane, are never current. */
  readonly current: boolean;
  /** A change only a read of the first page can show; a missing header is
   *  the reader's own reason to read. */
  readonly wantsRead: boolean;
  /** The open pages past the first may hold rows a frame changed. */
  readonly openMoreStale: boolean;
  /** A corner left the open set, so the archived rows may miss it. */
  readonly archivedStale: boolean;
};

type Entry = RoomCorners & {
  /** The clock value of the last frame or change for this Room. */
  readonly changedAt: number;
  /** The last applied `corner-status` sequence on the current lane. */
  readonly sequence?: number;
  /** The lane epoch whose frame sent the full summary. */
  readonly summaryEpoch?: number;
  /** The clock value when a corner last left the open set, or the open set
   *  changed unseen. An archived read started before it may miss that corner. */
  readonly archivedChangedAt: number;
  /** Bumped when the lane is lost or restarts, so a read across it is not current. */
  readonly laneEpoch: number;
  readonly laneHeld: boolean;
};

/** Taken when a read starts and handed back when it lands. */
export type CornerReadMark = {
  readonly clock: number;
  readonly laneEpoch: number;
  readonly laneHeld: boolean;
};

const EMPTY: Entry = {
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

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const factListeners = new Map<string, Set<() => void>>();
let clock = 0;

function entry(roomId: string): Entry {
  return entries.get(roomId) ?? EMPTY;
}

function write(roomId: string, next: Entry): void {
  entries.set(roomId, next);
  for (const listener of [...(listeners.get(roomId) ?? [])]) listener();
}

function emitFacts(roomId: string): void {
  for (const listener of [...(factListeners.get(roomId) ?? [])]) listener();
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

/** The whole Corners page, once both its rows and its header are held. */
export function roomCornerListView(corners: RoomCorners): CornerListView | undefined {
  if (!corners.header || !corners.rows) return undefined;
  return { ...corners.header, corners: corners.rows, ...cursor(corners.firstPageNext) };
}

export function subscribeRoomCorners(roomId: string, listener: () => void): () => void {
  const set = listeners.get(roomId) ?? new Set();
  set.add(listener);
  listeners.set(roomId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(roomId);
  };
}

/** Fires when a held corner's state, reason or lifecycle changed, or a frame
 *  named a change without its rows. Workflow cells re-read on it. */
export function subscribeRoomCornerFacts(roomId: string, listener: () => void): () => void {
  const set = factListeners.get(roomId) ?? new Set();
  set.add(listener);
  factListeners.set(roomId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) factListeners.delete(roomId);
  };
}

export function cornerReadMark(roomId: string): CornerReadMark {
  const current = entry(roomId);
  return { clock, laneEpoch: current.laneEpoch, laneHeld: current.laneHeld };
}

/** The clock a Room list read takes when it starts. */
export function cornerStoreClock(): number {
  return clock;
}

/**
 * The one `corner-status` dedupe. False when the lane already applied this
 * sequence or a newer one, and the frame must go no further.
 */
export function acceptCornerStatusFrame(frame: CornerStatusFrame): boolean {
  const current = entry(frame.roomId);
  if (frame.sequence !== undefined && current.sequence !== undefined &&
      frame.sequence <= current.sequence) return false;
  clock += 1;
  const summary = {
    openCorners: frame.openCorners,
    cornerCount: frame.cornerCount,
    waitingCornerCount: frame.waitingCornerCount,
    summary: 'full' as const,
    summaryEpoch: current.laneEpoch,
    changedAt: clock,
    ...(frame.sequence !== undefined ? { sequence: frame.sequence } : {}),
  };
  if (!frame.corners) {
    // An older server names the change but not the rows.
    write(frame.roomId, {
      ...current, ...summary, current: false, wantsRead: true, archivedChangedAt: clock,
      archivedStale: current.archived !== undefined,
    });
    emitFacts(frame.roomId);
    return true;
  }
  const next = withRows(current, frame.corners, frame.nextOpen);
  const open = new Set([...frame.corners, ...next.openMore].map((item) => item.corner.id));
  const closed = [...(current.rows ?? []), ...current.openMore]
    .some((item) => !open.has(item.corner.id));
  write(frame.roomId, {
    ...next,
    ...summary,
    current: current.laneHeld,
    // The rows are whole again; a reader without a header still reads for it.
    wantsRead: false,
    openMoreStale: current.openMoreStale || next.openMore.length > 0,
    archivedStale: current.archivedStale || (closed && current.archived !== undefined),
    ...(closed ? { archivedChangedAt: clock } : {}),
  });
  if (current.rows && rowsFacts(current.rows) !== rowsFacts(frame.corners)) emitFacts(frame.roomId);
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
    if (!current.laneHeld) entries.set(roomId, { ...current, laneHeld: true });
    return;
  }
  clock += 1;
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
  for (const [roomId, current] of entries) {
    if (current.laneHeld) entries.set(roomId, { ...current, laneHeld: false });
  }
}

/** Nothing holds the Room lane any more, so later changes go unheard. */
export function noteCornerLaneReleased(roomId: string): void {
  const current = entries.get(roomId);
  if (!current) return;
  const { sequence: _sequence, ...rest } = current;
  write(roomId, { ...rest, laneHeld: false, laneEpoch: current.laneEpoch + 1, current: false });
}

/** The server named a corner change without sending its rows. */
export function noteRoomCornersChanged(roomId: string): void {
  clock += 1;
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
  const current = entries.get(roomId);
  if (current?.wantsRead) write(roomId, { ...current, wantsRead: false });
}

/** A read of the first open page landed. */
export function applyCornerListRead(
  roomId: string,
  view: CornerListView,
  mark: CornerReadMark,
): void {
  const current = entry(roomId);
  const { corners, nextOpen, nextArchived: _archived, ...header } = view;
  if (current.changedAt > mark.clock && current.rows) {
    // A frame since the read started holds newer rows; keep them.
    write(roomId, { ...current, header });
    return;
  }
  const next = withRows(current, corners, nextOpen);
  const changed = Boolean(current.rows) && rowsFacts(current.rows) !== rowsFacts(corners);
  write(roomId, {
    ...next,
    header,
    current: current.laneHeld && mark.laneHeld && current.laneEpoch === mark.laneEpoch,
    openMoreStale: current.openMoreStale || (next.openMore.length > 0 && changed),
  });
  if (changed) emitFacts(roomId);
}

/** A saved copy paints before the first read; it is never current. */
export function hydrateRoomCorners(roomId: string, view: CornerListView): void {
  const current = entry(roomId);
  if (current.header && current.rows) return;
  const { corners, nextOpen, nextArchived: _archived, ...header } = view;
  write(roomId, current.rows ? { ...current, header } : { ...withRows(current, corners, nextOpen), header });
}

/**
 * An open page past the first landed. `replace` swaps every held page for
 * these rows, once a frame left the held pages unproven.
 */
export function applyOpenCornerPage(
  roomId: string,
  rows: readonly CornerListItem[],
  nextOpen: string | undefined,
  replace = false,
): void {
  const current = entry(roomId);
  const { nextOpen: _held, ...rest } = current;
  write(roomId, {
    ...rest,
    openMore: withoutRows([...(replace ? [] : current.openMore), ...rows], current.rows ?? []),
    ...cursor(nextOpen),
    ...(replace ? { openMoreStale: false } : {}),
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
  readStartedAt: number,
): void {
  const current = entry(roomId);
  const missed = current.archivedChangedAt > readStartedAt;
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
 * A Room list read landed: its capped corner summary applies where no frame
 * came since it started. It never replaces a frame's full summary while the
 * lane that sent it is still held.
 */
export function applyChatListCorners(
  chats: readonly Pick<ChatListItem, 'room' | 'openCorners' | 'cornerCount' | 'waitingCornerCount'>[],
  readStartedAt: number,
): void {
  for (const item of chats) {
    if (!item.openCorners) continue;
    const current = entry(item.room.id);
    if (current.changedAt > readStartedAt) continue;
    if (current.summary === 'full' && current.laneHeld &&
        current.summaryEpoch === current.laneEpoch) continue;
    write(item.room.id, {
      ...current,
      summary: 'preview',
      openCorners: item.openCorners,
      ...(item.cornerCount !== undefined ? { cornerCount: item.cornerCount } : {}),
      ...(item.waitingCornerCount !== undefined
        ? { waitingCornerCount: item.waitingCornerCount }
        : {}),
    });
  }
}

/** A new identity must not see the last one's corners. */
export function resetRoomCornerStore(): void {
  const rooms = [...entries.keys()];
  entries.clear();
  for (const roomId of rooms) for (const listener of [...(listeners.get(roomId) ?? [])]) listener();
}

/** Select a Room's corner record; re-renders when it changes. Reads nothing. */
export function useRoomCornerRecord(roomId: string | undefined): RoomCorners | undefined {
  const subscribe = useCallback(
    (listener: () => void) => (roomId ? subscribeRoomCorners(roomId, listener) : () => undefined),
    [roomId],
  );
  return useSyncExternalStore(subscribe, () => (roomId ? getRoomCorners(roomId) : undefined));
}

/** The Room list summary of the viewer's open corners, or the Room list row's own copy. */
export function useRoomOpenCorners(
  roomId: string,
  fallback: readonly ChatListCorner[] | undefined,
): readonly ChatListCorner[] | undefined {
  return useRoomCornerRecord(roomId)?.openCorners ?? fallback;
}
