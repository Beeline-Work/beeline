import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RoomViewAgentTurn, RoomViewMessage } from '@beeline/buzz-client';
import { ROOM_VIEW_AGENT_LIMIT } from '@beeline/api-contract/phone';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { IdentitySelection, useIdentityRecords } from './identity-records';
import { currentSurfaceStamp, nextSurfaceStamp } from './surface-clock';

/**
 * One id-keyed record per committed message, per Room. Every view that shows
 * a Room's messages (the live tail, loaded history pages, a detached jump
 * window, the desktop inspector) keeps its own ordered rows as a window and
 * reads each row through this map, so one live delta or mutation result
 * changes that message in every view at once.
 *
 * The map holds only ids some mounted view holds. A record for an id no view
 * holds is dropped, so a large Room stays bounded to its loaded windows.
 */

type RoomRecords = {
  readonly records: Map<string, RoomViewMessage>;
  readonly turns: Map<string, { row: RoomViewAgentTurn; stamp: number }>;
  readonly bookmarkWrittenAt: Map<string, number>;
  /** The row objects each view last offered, by view key, then message id.
   *  One view can hold an id in more than one window (tail and history). */
  readonly views: Map<string, Map<string, Set<RoomViewMessage>>>;
  readonly listeners: Set<() => void>;
  revision: number;
};

const rooms = new Map<string, RoomRecords>();
const roomKey = (scope: string, roomId: string) => `${scope}\u0000${roomId}`;
const identityReadAt = new WeakMap<RoomViewMessage, number>();
const identitySelected = new WeakMap<RoomViewMessage, { scope: string; version: number; row: RoomViewMessage }>();

export function stampRoomMessageRows(rows: readonly RoomViewMessage[], stamp: number): void {
  for (const row of rows)
    identityReadAt.set(row, Math.min(identityReadAt.get(row) ?? stamp, stamp));
}

subscribeClientReset(() => {
  for (const room of rooms.values()) {
    room.records.clear();
    room.turns.clear();
    room.bookmarkWrittenAt.clear();
    room.views.clear();
    notify(room);
  }
});

function roomRecords(key: string): RoomRecords {
  let room = rooms.get(key);
  if (!room) {
    room = { records: new Map(), turns: new Map(), bookmarkWrittenAt: new Map(), views: new Map(), listeners: new Set(), revision: 0 };
    rooms.set(key, room);
  }
  return room;
}

/** An incoming copy loses only to a held copy with a higher version. */
function supersedes(held: RoomViewMessage | undefined, incoming: RoomViewMessage): boolean {
  if (!held) return true;
  if (held === incoming) return false;
  return (incoming.version ?? 0) >= (held.version ?? 0);
}

// A report is monotonic viewer state; a delta or a stale read may omit it.
function withViewerState(
  room: RoomRecords,
  held: RoomViewMessage | undefined,
  incoming: RoomViewMessage,
  source: 'read' | 'shared',
) {
  if (!identityReadAt.has(incoming)) identityReadAt.set(incoming, currentSurfaceStamp());
  if (!held) return incoming;
  const written = room.bookmarkWrittenAt.get(incoming.id);
  const keepBookmark = source === 'shared' ||
    (written !== undefined && identityReadAt.get(incoming)! < written);
  const bookmarked = keepBookmark ? held.bookmarked : incoming.bookmarked;
  const reported = Boolean(held.feedbackReported || incoming.feedbackReported);
  if (bookmarked === incoming.bookmarked && reported === Boolean(incoming.feedbackReported)) return incoming;
  const next = { ...incoming, bookmarked, feedbackReported: reported };
  identityReadAt.set(next, identityReadAt.get(incoming)!);
  return next;
}

function notify(room: RoomRecords) {
  room.revision += 1;
  for (const listener of [...room.listeners]) listener();
}

function dropUnheld(roomId: string, room: RoomRecords) {
  for (const id of room.records.keys()) {
    let held = false;
    for (const rows of room.views.values()) {
      if (rows.has(id)) {
        held = true;
        break;
      }
    }
    if (!held) {
      room.records.delete(id);
      room.bookmarkWrittenAt.delete(id);
    }
  }
  if (!room.views.size && !room.listeners.size) rooms.delete(roomId);
}

/** A Room read replaces turns it could see; a delta after its start survives it. */
export function offerRoomTurns(
  scope: string | null,
  roomId: string,
  turns: readonly RoomViewAgentTurn[],
  readStamp: number,
): void {
  if (!scope) return;
  const room = roomRecords(roomKey(scope, roomId));
  const seen = new Set(turns.map((turn) => turn.agentPubkey));
  let changed = false;
  for (const [agentId, held] of room.turns) {
    if (!seen.has(agentId) && held.stamp <= readStamp) {
      room.turns.delete(agentId);
      changed = true;
    }
  }
  for (const turn of turns) {
    const held = room.turns.get(turn.agentPubkey);
    if (held && held.stamp > readStamp) continue;
    if (held?.row !== turn) changed = true;
    room.turns.set(turn.agentPubkey, { row: turn, stamp: readStamp });
  }
  if (changed) notify(room);
}

export function writeRoomTurn(scope: string | null, roomId: string, turn: RoomViewAgentTurn): void {
  if (!scope) return;
  const room = roomRecords(roomKey(scope, roomId));
  room.turns.set(turn.agentPubkey, { row: turn, stamp: nextSurfaceStamp() });
  notify(room);
}

export function roomTurns(scope: string | null, roomId: string): readonly RoomViewAgentTurn[] {
  const room = scope ? rooms.get(roomKey(scope, roomId)) : undefined;
  return [...(room?.turns.values() ?? [])].map(({ row }) => row)
    .sort((a, b) => b.createdAt - a.createdAt || a.agentPubkey.localeCompare(b.agentPubkey))
    .slice(0, ROOM_VIEW_AGENT_LIMIT);
}

/**
 * A server row for this Room: a live delta or a mutation result. It replaces
 * the record when some view holds that id and it is not older than the record.
 * A row no view holds yet is left to the window that adds it.
 */
export function writeRoomMessage(scope: string | null, roomId: string, message: RoomViewMessage): void {
  if (!scope) return;
  const room = rooms.get(roomKey(scope, roomId));
  if (!room?.records.has(message.id)) return;
  if (!supersedes(room.records.get(message.id), message)) return;
  room.records.set(message.id, withViewerState(room, room.records.get(message.id), message, 'shared'));
  notify(room);
}

export function writeRoomBookmark(scope: string | null, roomId: string, id: string, bookmarked: boolean): void {
  const room = scope ? rooms.get(roomKey(scope, roomId)) : undefined;
  const held = room?.records.get(id);
  if (!room || !held) return;
  room.bookmarkWrittenAt.set(id, nextSurfaceStamp());
  room.records.set(id, { ...held, bookmarked });
  notify(room);
}

/** The current record for one loaded message, if a view holds it. */
export function roomMessageRecord(scope: string | null, roomId: string, messageId: string): RoomViewMessage | undefined {
  return scope ? rooms.get(roomKey(scope, roomId))?.records.get(messageId) : undefined;
}

/**
 * Record the rows one view holds. A row object the view has not offered
 * before is a fresh server copy and replaces the record unless the record is
 * newer; a row it offered before never replaces a record that moved on.
 * Returns whether any record changed.
 */
function offer(
  key: string,
  viewKey: string,
  groups: readonly (readonly RoomViewMessage[])[],
): boolean {
  const room = roomRecords(key);
  const previous = room.views.get(viewKey);
  const next = new Map<string, Set<RoomViewMessage>>();
  let changed = false;
  for (const rows of groups) {
    for (const row of rows) {
      let offered = next.get(row.id);
      if (!offered) next.set(row.id, (offered = new Set()));
      offered.add(row);
      if (previous?.get(row.id)?.has(row) && room.records.has(row.id)) continue;
      if (supersedes(room.records.get(row.id), row)) {
        if (room.records.get(row.id) !== row) changed = true;
        room.records.set(row.id, withViewerState(room, room.records.get(row.id), row, 'read'));
      }
    }
  }
  room.views.set(viewKey, next);
  if (previous && previous.size !== next.size) dropUnheld(key, room);
  else if (previous) {
    for (const id of previous.keys()) {
      if (!next.has(id)) {
        dropUnheld(key, room);
        break;
      }
    }
  }
  return changed;
}

function release(key: string, viewKey: string) {
  const room = rooms.get(key);
  if (!room) return;
  room.views.delete(viewKey);
  dropUnheld(key, room);
}

function select(
  room: RoomRecords | undefined,
  rows: readonly RoomViewMessage[],
  scope: string | null,
  identityVersion: number,
): readonly RoomViewMessage[] {
  if (!room) return rows;
  let changed = false;
  const selected = rows.map((row) => {
    const record = room.records.get(row.id) ?? row;
    let selected = record;
    if (scope) {
      const cached = identitySelected.get(record);
      selected = cached?.scope === scope && cached.version === identityVersion ? cached.row
        : new IdentitySelection(scope, identityReadAt.get(record) ?? 0).message(record);
      if (cached?.scope !== scope || cached.version !== identityVersion)
        identitySelected.set(record, { scope, version: identityVersion, row: selected });
    }
    if (selected !== row) changed = true;
    return selected;
  });
  return changed ? selected : rows;
}

let nextViewId = 0;

function useRoomRevision(key: string | undefined): number {
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => undefined;
    const room = roomRecords(key);
    room.listeners.add(listener);
    return () => {
      room.listeners.delete(listener);
      dropUnheld(key, room);
    };
  }, [key]);
  return useSyncExternalStore(subscribe, () => key ? rooms.get(key)?.revision ?? 0 : 0);
}

export function useRoomTurnRecords(scope: string | null, roomId: string | undefined) {
  const key = scope && roomId ? roomKey(scope, roomId) : undefined;
  const revision = useRoomRevision(key);
  return useMemo(() => roomTurns(scope, roomId ?? ''), [key, revision]);
}

/**
 * One view's windows of a Room, read through the Room's message records.
 * Each group keeps its own order and membership; only each row's content
 * comes from the record. Group arrays keep their identity while no record in
 * them differs from the row given.
 */
export function useRoomMessageRecords<const Groups extends readonly (readonly RoomViewMessage[])[]>(
  scope: string | null,
  roomId: string | undefined,
  groups: Groups,
): Groups {
  const [viewKey] = useState(() => `view:${(nextViewId += 1)}`);
  const held = useRef({ generation: clientResetGeneration(), scope, roomId,
    groups: [...groups] as readonly (readonly RoomViewMessage[])[], blocked: false });
  const generation = clientResetGeneration();
  if (generation !== held.current.generation)
    held.current = { generation, scope, roomId, groups: [...groups], blocked: true };
  else if (held.current.blocked && (scope !== held.current.scope || roomId !== held.current.roomId ||
    groups.length !== held.current.groups.length ||
    groups.some((rows, index) => rows !== held.current.groups[index])))
    held.current.blocked = false;
  const visibleGroups = held.current.blocked ? groups.map(() => []) : groups;
  const identityVersion = useIdentityRecords();
  const key = scope && roomId ? roomKey(scope, roomId) : undefined;
  // Offer during render, so this render already reads the record a fresh
  // server copy just replaced. Other views learn of it after commit.
  const changed = key ? offer(key, viewKey, visibleGroups) : false;
  const room = key ? rooms.get(key) : undefined;
  // Re-render when another view or a live delta changes a record.
  useRoomRevision(key);
  useLayoutEffect(() => {
    if (changed && room) notify(room);
  });
  useLayoutEffect(() => {
    if (!key) return;
    return () => release(key, viewKey);
  }, [key, viewKey]);
  // A group with no changed record is returned as given, so it keeps its identity.
  return visibleGroups.map((rows) => select(room, rows, scope, identityVersion)) as unknown as Groups;
}
