import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { RoomViewMessage } from '@beeline/buzz-client';

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

/** The per-message version the server stamps on committed rows. Rows without
 *  one (servers before it shipped) apply in arrival order. */
type VersionedMessage = RoomViewMessage & { readonly version?: number };

type RoomRecords = {
  readonly records: Map<string, RoomViewMessage>;
  /** The row objects each view last offered, by view key, then message id.
   *  One view can hold an id in more than one window (tail and history). */
  readonly views: Map<string, Map<string, Set<RoomViewMessage>>>;
  readonly listeners: Set<() => void>;
  revision: number;
};

const rooms = new Map<string, RoomRecords>();

function roomRecords(roomId: string): RoomRecords {
  let room = rooms.get(roomId);
  if (!room) {
    room = { records: new Map(), views: new Map(), listeners: new Set(), revision: 0 };
    rooms.set(roomId, room);
  }
  return room;
}

/** An incoming copy loses only to a held copy with a higher version. */
function supersedes(held: RoomViewMessage | undefined, incoming: RoomViewMessage): boolean {
  if (!held) return true;
  if (held === incoming) return false;
  const heldVersion = (held as VersionedMessage).version;
  const incomingVersion = (incoming as VersionedMessage).version;
  return (
    heldVersion === undefined || incomingVersion === undefined || incomingVersion >= heldVersion
  );
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
    if (!held) room.records.delete(id);
  }
  if (!room.views.size && !room.listeners.size) rooms.delete(roomId);
}

/**
 * A server row for this Room: a live delta or a mutation result. It replaces
 * the record when some view holds that id and it is not older than the record.
 * A row no view holds yet is left to the window that adds it.
 */
export function writeRoomMessage(roomId: string, message: RoomViewMessage): void {
  const room = rooms.get(roomId);
  if (!room?.records.has(message.id)) return;
  if (!supersedes(room.records.get(message.id), message)) return;
  room.records.set(message.id, message);
  notify(room);
}

/** The current record for one loaded message, if a view holds it. */
export function roomMessageRecord(roomId: string, messageId: string): RoomViewMessage | undefined {
  return rooms.get(roomId)?.records.get(messageId);
}

/**
 * Record the rows one view holds. A row object the view has not offered
 * before is a fresh server copy and replaces the record unless the record is
 * newer; a row it offered before never replaces a record that moved on.
 * Returns whether any record changed.
 */
function offer(
  roomId: string,
  viewKey: string,
  groups: readonly (readonly RoomViewMessage[])[],
): boolean {
  const room = roomRecords(roomId);
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
        room.records.set(row.id, row);
      }
    }
  }
  room.views.set(viewKey, next);
  if (previous && previous.size !== next.size) dropUnheld(roomId, room);
  else if (previous) {
    for (const id of previous.keys()) {
      if (!next.has(id)) {
        dropUnheld(roomId, room);
        break;
      }
    }
  }
  return changed;
}

function release(roomId: string, viewKey: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.views.delete(viewKey);
  dropUnheld(roomId, room);
}

function select(
  room: RoomRecords | undefined,
  rows: readonly RoomViewMessage[],
): readonly RoomViewMessage[] {
  if (!room) return rows;
  let changed = false;
  const selected = rows.map((row) => {
    const record = room.records.get(row.id) ?? row;
    if (record !== row) changed = true;
    return record;
  });
  return changed ? selected : rows;
}

let nextViewId = 0;

/**
 * One view's windows of a Room, read through the Room's message records.
 * Each group keeps its own order and membership; only each row's content
 * comes from the record. Group arrays keep their identity while no record in
 * them differs from the row given.
 */
export function useRoomMessageRecords<const Groups extends readonly (readonly RoomViewMessage[])[]>(
  roomId: string | undefined,
  groups: Groups,
): Groups {
  const [viewKey] = useState(() => `view:${(nextViewId += 1)}`);
  // Offer during render, so this render already reads the record a fresh
  // server copy just replaced. Other views learn of it after commit.
  const changed = roomId ? offer(roomId, viewKey, groups) : false;
  const room = roomId ? rooms.get(roomId) : undefined;
  // Re-render when another view or a live delta changes a record.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!roomId) return () => undefined;
      const current = roomRecords(roomId);
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
        dropUnheld(roomId, current);
      };
    },
    [roomId],
  );
  useSyncExternalStore(subscribe, () => (roomId ? (rooms.get(roomId)?.revision ?? 0) : 0));
  useLayoutEffect(() => {
    if (changed && room) notify(room);
  });
  useLayoutEffect(() => {
    if (!roomId) return;
    return () => release(roomId, viewKey);
  }, [roomId, viewKey]);
  // A group with no changed record is returned as given, so it keeps its identity.
  return groups.map((rows) => select(room, rows)) as unknown as Groups;
}
