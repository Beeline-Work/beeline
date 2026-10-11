import { useCallback, useSyncExternalStore } from 'react';
import type {
  ChatListCorner,
  ChatListItem,
  CornerListItem,
  CornerListView,
} from '@beeline/api-contract/phone';
import { subscribeClientReset } from '@/sync/client-reset';

/**
 * The client's one copy of each Room's corner rows. The live connection
 * writes every `corner-status` frame here whichever screen is mounted, and
 * every corners read lands here too, so the Corners screen, the Room list
 * dropdown, the desktop inspector, the corner header and the `#` menu all
 * select the same record.
 *
 * It also owns each Room's corner summary: the counts and the capped list of
 * open corners the Room list row, its dropdown, the repository guard and
 * notifications read. A `corner-status` frame, a first-page corners read and
 * a Room list read each carry the whole summary and replace it; any other
 * corners read patches the summary's corners by id. Either applies only when
 * its source started after the held summary's source.
 *
 * Order: every read and frame takes its own clock tick, so no two share a
 * mark. Frames are ordered by the Room lane's sequence, and a frame is newer
 * than any read that started before it. A read's rows apply only when no frame
 * or later read landed for its Room since the read started.
 */

type CornerStatusFrame = {
  readonly roomId: string;
  readonly cornerCount: number;
  readonly openCorners: readonly ChatListCorner[];
  readonly corners?: readonly CornerListItem[];
  readonly nextOpen?: string;
  readonly sequence?: number;
};

/** What a corners read says besides its rows: the Room, the viewer, the apps. */
type CornerListHeader = Omit<CornerListView, 'corners' | 'nextOpen' | 'nextArchived' | 'summary'>;

/** A Room's open-corner summary. The count is the server's, never counted here;
 *  the list keeps every Mine corner and fills to the server's cap. */
export type RoomCornerSummary = {
  readonly cornerCount: number;
  readonly openCorners: readonly ChatListCorner[];
};

export type RoomCorners = {
  readonly header?: CornerListHeader;
  /** A corners read set `header`; one from disk is never current. */
  readonly headerRead: boolean;
  /** The first page of open corners, newest first. */
  readonly rows?: readonly CornerListItem[];
  /** The cursor after the first page. */
  readonly firstPageNext?: string;
  /** Open corners past the first page, never repeating a first-page row. */
  readonly openMore: readonly CornerListItem[];
  /** The cursor after the last open row held. */
  readonly nextOpen?: string;
  /** The Room's corner summary, the one copy every Room list surface reads. */
  readonly summary?: RoomCornerSummary;
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
  /** The clock value when the read that set `rows` started. */
  readonly rowsReadAt?: number;
  /** The last applied `corner-status` sequence on the current lane. */
  readonly sequence?: number;
  /** The clock value when the source of `summary` started. */
  readonly summaryAt?: number;
  /** The clock value when a corner last left the open set, or the open set
   *  changed unseen. An archived read started before it may miss that corner. */
  readonly archivedChangedAt: number;
  /** Bumped when the lane is lost or restarts, so a read across it is not current. */
  readonly laneEpoch: number;
  readonly laneHeld: boolean;
};

/** Taken when a read starts and handed back when it lands. */
export type CornerReadMark = {
  /** A read across a store reset belongs to the previous account. */
  readonly generation: number;
  readonly clock: number;
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

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const factListeners = new Map<string, Set<() => void>>();
const summaryListeners = new Set<() => void>();
let summaries: ReadonlyMap<string, RoomCornerSummary> = new Map();
let clock = 0;
let generation = 0;

function entry(roomId: string): Entry {
  return entries.get(roomId) ?? EMPTY;
}

function write(roomId: string, next: Entry): void {
  const before = entries.get(roomId)?.summary;
  entries.set(roomId, next);
  if (next.summary !== before) {
    const changed = new Map(summaries);
    if (next.summary) changed.set(roomId, next.summary);
    else changed.delete(roomId);
    summaries = changed;
  }
  for (const listener of [...(listeners.get(roomId) ?? [])]) listener();
  if (next.summary !== before) for (const listener of [...summaryListeners]) listener();
}

/**
 * The one summary rule: a source started after the held summary's source
 * replaces it when whole, and patches its corners by id when partial.
 */
function withSummary(
  current: Entry,
  summary: RoomCornerSummary,
  startedAt: number,
): Entry {
  if (current.summaryAt !== undefined && startedAt <= current.summaryAt) return current;
  return { ...current, summary, summaryAt: startedAt };
}

/** The summary corner `item` names, as that row now says it. */
function patchedCorner(held: ChatListCorner, item: CornerListItem): ChatListCorner {
  if (item.state === 'archived') return held;
  const { mine: _mine, waitingSince, attention, ...rest } = held;
  const mine = item.mine === true;
  // The server's rule: only a waiting corner hands back or owes attention.
  const waiting = item.state === 'waiting';
  const since = waiting && mine
    ? waitingSince ?? item.latestMessage?.createdAt
    : undefined;
  return {
    ...rest,
    name: item.corner.name,
    state: item.state,
    ...(mine ? { mine: true as const } : {}),
    ...(since !== undefined ? { waitingSince: since } : {}),
    ...(waiting && held.state === 'waiting' && attention ? { attention } : {}),
  };
}

/** A partial read's rows patch the held summary's corners by id. */
function withSummaryRows(
  current: Entry,
  rows: readonly CornerListItem[],
  startedAt: number,
): Entry {
  const summary = current.summary;
  if (!summary || (current.summaryAt !== undefined && startedAt <= current.summaryAt))
    return current;
  const byId = new Map(rows.map((item) => [item.corner.id, item]));
  let named = false;
  let changed = false;
  const openCorners = summary.openCorners.map((held) => {
    const item = byId.get(held.id);
    if (!item) return held;
    named = true;
    const next = patchedCorner(held, item);
    if (JSON.stringify(next) !== JSON.stringify(held)) changed = true;
    return next;
  });
  if (!named) return current;
  // A read that agrees with the summary still proves it as of its start, so
  // an older read that lands later cannot restore what this read saw gone.
  if (!changed) return { ...current, summaryAt: startedAt };
  return { ...current, summary: { ...summary, openCorners }, summaryAt: startedAt };
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

/** Taken when a read starts: its own clock tick, never shared with another read. */
export function cornerReadMark(roomId: string): CornerReadMark {
  const current = entry(roomId);
  clock += 1;
  return { generation, clock, laneEpoch: current.laneEpoch, laneHeld: current.laneHeld };
}

/** The clock tick a Room list read takes when it starts. */
export function cornerStoreClock(): number {
  clock += 1;
  return clock;
}

/** The store's generation, without taking a read mark. */
export function cornerStoreGeneration(): number {
  return generation;
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
    emitFacts(frame.roomId);
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
  if (mark.generation !== generation) return;
  const { corners, nextOpen, nextArchived: _archived, summary, ...header } = view;
  const current = summary
    ? withSummary(
      entry(roomId),
      { cornerCount: summary.cornerCount, openCorners: summary.openCorners },
      mark.clock,
    )
    : withSummaryRows(entry(roomId), corners, mark.clock);
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
    rowsReadAt: mark.clock,
    header,
    headerRead: true,
    current: current.laneHeld && mark.laneHeld && current.laneEpoch === mark.laneEpoch,
    openMoreStale: current.openMoreStale || (next.openMore.length > 0 && changed),
  });
  if (changed) emitFacts(roomId);
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
  if (mark.generation !== generation) return;
  const current = withSummaryRows(entry(roomId), rows, mark.clock);
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
  if (mark.generation !== generation) return;
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
  generation += 1;
  const rooms = [...entries.keys()];
  entries.clear();
  summaries = new Map();
  for (const roomId of rooms) for (const listener of [...(listeners.get(roomId) ?? [])]) listener();
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
  return useSyncExternalStore(subscribeRoomCornerSummaries, () => summaries);
}
