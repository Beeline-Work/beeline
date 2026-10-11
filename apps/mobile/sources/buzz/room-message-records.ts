import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { RoomViewMessage } from '@beeline/buzz-client';
import { ROOM_VIEW_MESSAGE_LIMIT, ROOM_VIEW_TOOL_ROW_LIMIT } from '@beeline/api-contract/phone';
import { subscribeClientReset } from '@/sync/client-reset';
import { IdentitySelection, useIdentityRecords } from './identity-records';
import { currentSurfaceStamp } from './surface-clock';

/**
 * One id-keyed record per committed message, per Room, per relay and viewer.
 * Every view of a Room's messages (the live tail, loaded history pages, a
 * detached jump window, the desktop inspector) holds only ordered ids and
 * reads each message's content from here, so one live delta, read or
 * mutation result changes that message in every view at once.
 *
 * The message `version` alone decides which copy wins: a copy with a lower
 * version never replaces a held one, so a slow full read cannot roll a newer
 * delta back in any view.
 *
 * A tail is a window that also takes new messages: a delta for an id no
 * window holds joins every tail of its Room, newest last, at most one Room
 * read long.
 *
 * `bookmarked` is the viewer's own state and no message version covers it.
 * Live deltas and mutation results never carry it, so they keep the held
 * value. A read that started before this device last wrote it keeps the held
 * value too, so a slow read cannot undo a settled bookmark.
 */

/** The relay origin and viewer a set of records was read for. */
export type RoomRecordScope = string;

export function roomRecordScope(relayUrl: string, viewerPubkey: string): RoomRecordScope {
  return JSON.stringify([new URL(relayUrl).origin, viewerPubkey]);
}

export type RoomTail = {
  readonly ids: readonly string[];
  /** A corner's settled tool and output rows, kept apart from `ids`. */
  readonly toolIds?: readonly string[];
};

type Window = RoomTail & { readonly tail: boolean };

type RoomRecords = {
  readonly records: Map<string, RoomViewMessage>;
  readonly windows: Map<string, Window>;
  /** When each record stopped being held, so a window can adopt it first. */
  readonly unheldSince: Map<string, number>;
  /** The viewer-state clock at this device's last write of each record's viewer state. */
  readonly viewerWrittenAt: Map<string, number>;
  readonly listeners: Set<() => void>;
  revision: number;
};

/**
 * A record no window holds stays this long. One window hands an id to another
 * across a render (a tail row sliding into loaded history); it must not be
 * dropped in between.
 */
const UNHELD_GRACE_MS = 10_000;

const rooms = new Map<string, RoomRecords>();
/** Advances with every viewer-state write on this device. */
let viewerClock = 0;
/** The viewer-state clock when the read that returned each row started. */
const readStartedAt = new WeakMap<RoomViewMessage, number>();
/**
 * The surface clock when each row's server copy was read: a read row's read
 * start, otherwise when it was stored. A live identity record newer than
 * this applies to the row; a row read later already carries the change.
 */
const identityReadAt = new WeakMap<RoomViewMessage, number>();

/** Call when a Room read starts; pass the result to `stampRoomRead`. */
export function roomReadStamp(): number {
  return viewerClock;
}

/**
 * Mark the rows of a Room read or history page with when the read started.
 * A row without a mark counts as older than every viewer-state write.
 */
export function stampRoomRead<T>(read: T, stamp: number, surfaceStamp?: number): T {
  const { messages, toolRows } = read as {
    readonly messages?: readonly RoomViewMessage[];
    readonly toolRows?: readonly RoomViewMessage[];
  };
  for (const row of [...(messages ?? []), ...(toolRows ?? [])]) {
    const earlier = readStartedAt.get(row);
    readStartedAt.set(row, earlier === undefined ? stamp : Math.min(earlier, stamp));
    if (surfaceStamp !== undefined) {
      const read = identityReadAt.get(row);
      identityReadAt.set(row, read === undefined ? surfaceStamp : Math.min(read, surfaceStamp));
    }
  }
  return read;
}
const roomKey = (scope: RoomRecordScope, roomId: string) => `${scope}\u0000${roomId}`;

subscribeClientReset(() => {
  const cleared = [...rooms.values()];
  rooms.clear();
  for (const room of cleared) {
    room.records.clear();
    room.windows.clear();
    notify(room);
  }
});

function roomRecords(scope: RoomRecordScope, roomId: string): RoomRecords {
  const key = roomKey(scope, roomId);
  let room = rooms.get(key);
  if (!room) {
    room = {
      records: new Map(),
      windows: new Map(),
      unheldSince: new Map(),
      viewerWrittenAt: new Map(),
      listeners: new Set(),
      revision: 0,
    };
    rooms.set(key, room);
  }
  return room;
}

function messageTimeMs(message: RoomViewMessage): number {
  return message.createdAtMs ?? message.createdAt * 1_000;
}

function byMessageTime(left: RoomViewMessage, right: RoomViewMessage): number {
  return messageTimeMs(left) - messageTimeMs(right) || left.id.localeCompare(right.id);
}

/** A settled corner tool or output row, which the full read returns in `toolRows`. */
function isCornerWorkRow(message: RoomViewMessage): boolean {
  return (
    message.presentation === 'activity' &&
    !message.durableFact &&
    Boolean(message.activity?.some((item) => item.kind === 'tool' || item.kind === 'output'))
  );
}

/**
 * Whether `incoming` replaces `held`. Versions decide: a copy without one
 * (a server before versions, an old disk copy) never replaces one with a
 * version, and a lower version never replaces a higher one.
 */
function supersedes(held: RoomViewMessage | undefined, incoming: RoomViewMessage): boolean {
  if (!held) return true;
  if (held === incoming) return false;
  if (held.version === undefined) return true;
  return incoming.version !== undefined && incoming.version >= held.version;
}

function withBookmark(message: RoomViewMessage, bookmarked: boolean | undefined): RoomViewMessage {
  if (Boolean(message.bookmarked) === Boolean(bookmarked)) return message;
  if (bookmarked) return { ...message, bookmarked: true };
  const { bookmarked: _dropped, ...rest } = message;
  return rest;
}

/**
 * Write one row under the version rule. Returns whether the record changed.
 * A `shared` row (a live delta or mutation result) has no viewer state; a
 * `read` row has it unless the read started before this device last wrote it.
 */
function put(room: RoomRecords, incoming: RoomViewMessage, source: 'shared' | 'read'): boolean {
  const held = room.records.get(incoming.id);
  const writtenAt = room.viewerWrittenAt.get(incoming.id);
  const staleViewerState =
    source === 'shared' ||
    (writtenAt !== undefined && (readStartedAt.get(incoming) ?? -1) < writtenAt);
  const message = held && staleViewerState ? withBookmark(incoming, held.bookmarked) : incoming;
  if (!supersedes(held, message)) return false;
  if (held && sameJson(held, message)) return false;
  if (!identityReadAt.has(message))
    identityReadAt.set(message, identityReadAt.get(incoming) ?? currentSurfaceStamp());
  room.records.set(message.id, message);
  return true;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => sameJson((left as Record<string, unknown>)[key], rightRecord[key]))
  );
}

function notify(room: RoomRecords) {
  room.revision += 1;
  for (const listener of [...room.listeners]) listener();
}

function heldIds(room: RoomRecords): Set<string> {
  const held = new Set<string>();
  for (const window of room.windows.values()) {
    for (const id of window.ids) held.add(id);
    for (const id of window.toolIds ?? []) held.add(id);
  }
  return held;
}

/** Drop records no window has held for the grace period, and an idle Room. */
function sweep(scope: RoomRecordScope, roomId: string, room: RoomRecords) {
  const held = heldIds(room);
  const now = Date.now();
  for (const id of room.records.keys()) {
    if (held.has(id)) {
      room.unheldSince.delete(id);
      continue;
    }
    const since = room.unheldSince.get(id);
    if (since === undefined) room.unheldSince.set(id, now);
    else if (now - since >= UNHELD_GRACE_MS) {
      room.records.delete(id);
      room.unheldSince.delete(id);
      room.viewerWrittenAt.delete(id);
    }
  }
  if (!room.windows.size && !room.listeners.size && rooms.get(roomKey(scope, roomId)) === room)
    rooms.delete(roomKey(scope, roomId));
}

function sortedIds(room: RoomRecords, ids: Iterable<string>, limit: number): string[] {
  return [...new Set(ids)]
    .map((id) => room.records.get(id))
    .filter((message): message is RoomViewMessage => Boolean(message))
    .sort(byMessageTime)
    .slice(-limit)
    .map((message) => message.id);
}

function sameIds(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function setWindow(room: RoomRecords, holder: string, next: Window): boolean {
  const current = room.windows.get(holder);
  if (
    current &&
    current.tail === next.tail &&
    sameIds(current.ids, next.ids) &&
    sameIds(current.toolIds, next.toolIds)
  )
    return false;
  room.windows.set(holder, next);
  return true;
}

/** A new message joins a tail when it is not older than the tail's oldest row. */
function joinTail(room: RoomRecords, window: Window, message: RoomViewMessage): Window {
  let { ids, toolIds } = window;
  if (!ids.includes(message.id)) {
    const oldest = ids[0] ? room.records.get(ids[0]) : undefined;
    if (!oldest || ids.length < ROOM_VIEW_MESSAGE_LIMIT || byMessageTime(message, oldest) >= 0)
      ids = sortedIds(room, [...ids, message.id], ROOM_VIEW_MESSAGE_LIMIT);
  }
  if (toolIds && !toolIds.includes(message.id) && isCornerWorkRow(message))
    toolIds = sortedIds(room, [...toolIds, message.id], ROOM_VIEW_TOOL_ROW_LIMIT);
  return ids === window.ids && toolIds === window.toolIds ? window : { ...window, ids, toolIds };
}

/** The message a delta frame describes, with the frame's version on it. */
export function roomDeltaMessage(delta: {
  readonly message: RoomViewMessage;
  readonly version?: number;
}): RoomViewMessage {
  return delta.version === undefined || delta.message.version !== undefined
    ? delta.message
    : { ...delta.message, version: delta.version };
}

/**
 * The one write for a server row of a Room: a live delta (from the live
 * connection) or a mutation result, for the relay and viewer it came from. A
 * held record takes it under the version rule; the row joins every tail of
 * the Room that does not hold it yet, even when another window (the
 * inspector) already holds it. A row no window can take is not kept.
 */
export function applyRoomMessage(
  scope: RoomRecordScope,
  roomId: string,
  message: RoomViewMessage,
): void {
  const room = rooms.get(roomKey(scope, roomId));
  if (!room) return;
  const known = room.records.has(message.id);
  let changed = put(room, message, 'shared');
  const record = room.records.get(message.id)!;
  let joined = false;
  for (const [holder, window] of room.windows) {
    if (!window.tail) continue;
    const next = joinTail(room, window, record);
    if (next === window) continue;
    room.windows.set(holder, next);
    joined = true;
  }
  if (joined) changed = true;
  else if (!known && !heldIds(room).has(message.id)) {
    room.records.delete(message.id);
    changed = false;
  }
  if (changed) notify(room);
}

/** The settled result of this viewer's bookmark change on one held message. */
export function applyRoomBookmark(
  scope: RoomRecordScope,
  roomId: string,
  messageId: string,
  bookmarked: boolean,
): void {
  const room = rooms.get(roomKey(scope, roomId));
  const held = room?.records.get(messageId);
  if (!room || !held) return;
  viewerClock += 1;
  room.viewerWrittenAt.set(messageId, viewerClock);
  const next = withBookmark(held, bookmarked);
  if (next === held) return;
  room.records.set(messageId, next);
  notify(room);
}

/**
 * Rows a read returned, for a window that is about to hold them. Each one
 * replaces its record unless the record has a higher version.
 */
export function writeRoomMessages(
  scope: RoomRecordScope,
  roomId: string,
  rows: readonly RoomViewMessage[],
): void {
  const room = roomRecords(scope, roomId);
  let changed = false;
  for (const row of rows) if (put(room, row, 'read')) changed = true;
  if (changed) notify(room);
}

/** Set the ordered ids one window holds; null releases the window. */
export function holdRoomMessages(
  scope: RoomRecordScope,
  roomId: string,
  holder: string,
  ids: readonly string[] | null,
): void {
  const room = ids ? roomRecords(scope, roomId) : rooms.get(roomKey(scope, roomId));
  if (!room) return;
  const changed = ids
    ? setWindow(room, holder, { ids, tail: false })
    : room.windows.delete(holder);
  sweep(scope, roomId, room);
  if (changed) notify(room);
}

/**
 * A full Room read for one tail. The tail becomes the read's rows plus any
 * row it already holds that is newer than everything the read returned: a
 * delta the read had not caught yet. A corner tail also holds the read's
 * tool rows, plus any held tool row newer than every tool row the read returned.
 */
export function applyRoomTailRead(
  scope: RoomRecordScope,
  roomId: string,
  holder: string,
  read: { readonly messages: readonly RoomViewMessage[]; readonly toolRows?: readonly RoomViewMessage[] },
  collectsToolRows: boolean,
): RoomTail {
  const room = roomRecords(scope, roomId);
  let changed = false;
  for (const row of [...read.messages, ...(read.toolRows ?? [])])
    if (put(room, row, 'read')) changed = true;
  const previous = room.windows.get(holder);
  const readIds = new Set(read.messages.map((message) => message.id));
  const readNewest = read.messages.reduce(
    (newest, message) => Math.max(newest, messageTimeMs(message)),
    0,
  );
  const newer = (previous?.ids ?? []).filter((id) => {
    const message = room.records.get(id);
    return !readIds.has(id) && message !== undefined && messageTimeMs(message) >= readNewest;
  });
  const ids = newer.length
    ? sortedIds(room, [...readIds, ...newer], ROOM_VIEW_MESSAGE_LIMIT)
    : read.messages.map((message) => message.id);
  const readToolIds = new Set((read.toolRows ?? []).map((message) => message.id));
  const readToolNewest = (read.toolRows ?? []).reduce(
    (newest, message) => Math.max(newest, messageTimeMs(message)),
    0,
  );
  const newerToolIds = (previous?.toolIds ?? []).filter((id) => {
    const message = room.records.get(id);
    return !readToolIds.has(id) && message !== undefined && messageTimeMs(message) >= readToolNewest;
  });
  const toolIds = !collectsToolRows
    ? undefined
    : newerToolIds.length
      ? sortedIds(room, [...readToolIds, ...newerToolIds], ROOM_VIEW_TOOL_ROW_LIMIT)
      : [...readToolIds];
  if (setWindow(room, holder, { ids, toolIds, tail: true })) changed = true;
  sweep(scope, roomId, room);
  if (changed) notify(room);
  return room.windows.get(holder)!;
}

/** Keep only the tail rows `keep` accepts, as a terminal turn drops its live activity. */
export function pruneRoomTail(
  scope: RoomRecordScope,
  roomId: string,
  holder: string,
  keep: (message: RoomViewMessage) => boolean,
): void {
  const room = rooms.get(roomKey(scope, roomId));
  const window = room?.windows.get(holder);
  if (!room || !window) return;
  const ids = window.ids.filter((id) => {
    const message = room.records.get(id);
    return !message || keep(message);
  });
  if (ids.length === window.ids.length) return;
  room.windows.set(holder, { ...window, ids });
  sweep(scope, roomId, room);
  notify(room);
}

export function roomTail(
  scope: RoomRecordScope | undefined,
  roomId: string,
  holder: string,
): RoomTail | undefined {
  return scope ? rooms.get(roomKey(scope, roomId))?.windows.get(holder) : undefined;
}

/** The current record for one loaded message, if a window holds it. */
export function roomMessageRecord(
  scope: RoomRecordScope | undefined,
  roomId: string,
  messageId: string,
): RoomViewMessage | undefined {
  return scope ? rooms.get(roomKey(scope, roomId))?.records.get(messageId) : undefined;
}

/** Every message some window of this Room holds, oldest first. */
export function heldRoomMessages(
  scope: RoomRecordScope | undefined,
  roomId: string,
): RoomViewMessage[] {
  const room = scope ? rooms.get(roomKey(scope, roomId)) : undefined;
  if (!room) return [];
  return [...heldIds(room)]
    .map((id) => room.records.get(id))
    .filter((message): message is RoomViewMessage => Boolean(message))
    .sort(byMessageTime);
}

/** The records for `ids`, in that order; an id without a record is skipped. */
export function selectRoomMessages(
  scope: RoomRecordScope | undefined,
  roomId: string,
  ids: readonly string[],
): RoomViewMessage[] {
  const room = scope ? rooms.get(roomKey(scope, roomId)) : undefined;
  if (!room) return [];
  return ids
    .map((id) => room.records.get(id))
    .filter((message): message is RoomViewMessage => Boolean(message));
}

/** Grows with every change to this Room's records or windows. */
export function roomRecordRevision(scope: RoomRecordScope | undefined, roomId: string): number {
  return scope ? (rooms.get(roomKey(scope, roomId))?.revision ?? 0) : 0;
}

const idleSubscribe = () => () => undefined;

/** Re-render on any change to this Room's records or windows; returns its revision. */
export function useRoomRecordRevision(scope: RoomRecordScope | undefined, roomId: string | undefined) {
  const room = scope && roomId ? roomRecords(scope, roomId) : undefined;
  useEffect(() => {
    if (!room || !scope || !roomId) return;
    return () => sweep(scope, roomId, room);
  }, [room, roomId, scope]);
  return useSyncExternalStore(
    room
      ? (listener: () => void) => {
          room.listeners.add(listener);
          return () => {
            room.listeners.delete(listener);
          };
        }
      : idleSubscribe,
    () => room?.revision ?? 0,
  );
}

function useStableRows(rows: RoomViewMessage[]): readonly RoomViewMessage[] {
  const previous = useRef<readonly RoomViewMessage[]>(rows);
  const current = previous.current;
  if (current.length !== rows.length || rows.some((row, index) => row !== current[index]))
    previous.current = rows;
  return previous.current;
}

/**
 * One window's messages: its ids, read through the records. The array keeps
 * its identity while no record or id in it changes.
 */
export function useRoomMessages(
  scope: RoomRecordScope | undefined,
  roomId: string | undefined,
  ids: readonly string[],
): readonly RoomViewMessage[] {
  useRoomRecordRevision(scope, roomId);
  const identityVersion = useIdentityRecords();
  const rows = roomId ? selectRoomMessages(scope, roomId, ids) : [];
  return useStableRows(scope ? rows.map((row) => withLiveIdentity(scope, row, identityVersion)) : rows);
}

const identitySelected = new WeakMap<RoomViewMessage, { version: number; row: RoomViewMessage }>();

/**
 * A record with the live identity records newer than its read selected over
 * it. The record scope and the identity scope name the same relay and viewer.
 * One selected copy is kept per record and records version, so the rows keep
 * their identity between renders.
 */
function withLiveIdentity(scope: RoomRecordScope, row: RoomViewMessage, version: number): RoomViewMessage {
  const cached = identitySelected.get(row);
  if (cached?.version === version) return cached.row;
  const selected = new IdentitySelection(scope, identityReadAt.get(row) ?? 0).message(row);
  identitySelected.set(row, { version, row: selected });
  return selected;
}

/** One tail's ids, current with every delta that joins it. */
export function useRoomTail(
  scope: RoomRecordScope | undefined,
  roomId: string | undefined,
  holder: string,
): RoomTail | undefined {
  useRoomRecordRevision(scope, roomId);
  return roomId ? roomTail(scope, roomId, holder) : undefined;
}
