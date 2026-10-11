import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RoomViewAgentTurn, RoomViewMessage } from '@beeline/buzz-client';
import { ROOM_VIEW_AGENT_LIMIT } from '@beeline/api-contract/phone';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { IdentitySelection, useIdentityRecords } from './identity-records';
import { currentSurfaceStamp, nextSurfaceStamp } from './surface-clock';

type RoomRecords = {
  messages: Map<string, RoomViewMessage>;
  turns: Map<string, { row: RoomViewAgentTurn; stamp: number }>;
  bookmarkedAt: Map<string, number>;
  views: Map<string, Set<string>>;
  seenRows: WeakSet<RoomViewMessage>;
  listeners: Set<() => void>;
  revision: number;
};

const rooms = new Map<string, RoomRecords>();
const keyOf = (scope: string, roomId: string) => `${scope}\u0000${roomId}`;
const readAt = new WeakMap<RoomViewMessage, number>();
const identityRows = new WeakMap<RoomViewMessage, { scope: string; version: number; row: RoomViewMessage }>();
let nextViewId = 0;

export function stampRoomMessageRows(rows: readonly RoomViewMessage[], stamp: number): void {
  for (const row of rows) readAt.set(row, Math.min(readAt.get(row) ?? stamp, stamp));
}

function notify(room: RoomRecords): void {
  room.revision++;
  for (const listener of [...room.listeners]) listener();
}

subscribeClientReset(() => {
  for (const room of rooms.values()) {
    room.messages.clear();
    room.turns.clear();
    room.bookmarkedAt.clear();
    room.views.clear();
    room.seenRows = new WeakSet();
    notify(room);
  }
});

function records(key: string): RoomRecords {
  let room = rooms.get(key);
  if (!room) {
    room = { messages: new Map(), turns: new Map(), bookmarkedAt: new Map(),
      views: new Map(), seenRows: new WeakSet(), listeners: new Set(), revision: 0 };
    rooms.set(key, room);
  }
  return room;
}

function prune(key: string, room: RoomRecords): void {
  for (const id of room.messages.keys()) {
    if ([...room.views.values()].some((ids) => ids.has(id))) continue;
    room.messages.delete(id);
    room.bookmarkedAt.delete(id);
  }
  if (!room.views.size && !room.listeners.size) rooms.delete(key);
}

/** A Room read replaces only turns it could see; a newer live delta survives it. */
export function offerRoomTurns(scope: string | null, roomId: string, turns: readonly RoomViewAgentTurn[], stamp: number): void {
  if (!scope) return;
  const room = records(keyOf(scope, roomId));
  const seen = new Set(turns.map((turn) => turn.agentPubkey));
  let changed = false;
  for (const [id, held] of room.turns) {
    if (!seen.has(id) && held.stamp <= stamp) { room.turns.delete(id); changed = true; }
  }
  for (const turn of turns) {
    const held = room.turns.get(turn.agentPubkey);
    if (held && held.stamp > stamp) continue;
    if (held?.row !== turn) changed = true;
    room.turns.set(turn.agentPubkey, { row: turn, stamp });
  }
  if (changed) notify(room);
}

export function writeRoomTurn(scope: string | null, roomId: string, turn: RoomViewAgentTurn): void {
  if (!scope) return;
  const room = records(keyOf(scope, roomId));
  room.turns.set(turn.agentPubkey, { row: turn, stamp: nextSurfaceStamp() });
  notify(room);
}

export function roomTurns(scope: string | null, roomId: string): readonly RoomViewAgentTurn[] {
  const room = scope ? rooms.get(keyOf(scope, roomId)) : undefined;
  return [...(room?.turns.values() ?? [])].map(({ row }) => row)
    .sort((a, b) => b.createdAt - a.createdAt || a.agentPubkey.localeCompare(b.agentPubkey))
    .slice(0, ROOM_VIEW_AGENT_LIMIT);
}

function accept(room: RoomRecords, incoming: RoomViewMessage, shared: boolean): boolean {
  const held = room.messages.get(incoming.id);
  if (held === incoming || (held && (held.version ?? 0) > (incoming.version ?? 0))) return false;
  if (!readAt.has(incoming)) readAt.set(incoming, currentSurfaceStamp());
  const written = room.bookmarkedAt.get(incoming.id);
  const keepBookmark = shared || (written !== undefined && readAt.get(incoming)! < written);
  const bookmarked = held && keepBookmark ? held.bookmarked : incoming.bookmarked;
  const feedbackReported = Boolean(held?.feedbackReported || incoming.feedbackReported);
  const next = bookmarked === incoming.bookmarked && feedbackReported === Boolean(incoming.feedbackReported)
    ? incoming : { ...incoming, bookmarked, feedbackReported };
  if (next !== incoming) readAt.set(next, readAt.get(incoming)!);
  room.messages.set(incoming.id, next);
  return next !== held;
}

/** Update one loaded row; the server version and viewer state remain authoritative. */
export function writeRoomMessage(scope: string | null, roomId: string, message: RoomViewMessage): void {
  const room = scope ? rooms.get(keyOf(scope, roomId)) : undefined;
  if (room?.messages.has(message.id) && accept(room, message, true)) notify(room);
}

export function writeRoomBookmark(scope: string | null, roomId: string, id: string, bookmarked: boolean): void {
  const room = scope ? rooms.get(keyOf(scope, roomId)) : undefined;
  const held = room?.messages.get(id);
  if (!room || !held) return;
  room.bookmarkedAt.set(id, nextSurfaceStamp());
  room.messages.set(id, { ...held, bookmarked });
  notify(room);
}

export function roomMessageRecord(scope: string | null, roomId: string, id: string): RoomViewMessage | undefined {
  return scope ? rooms.get(keyOf(scope, roomId))?.messages.get(id) : undefined;
}

function offer(key: string, viewKey: string, groups: readonly (readonly RoomViewMessage[])[]): boolean {
  const room = records(key);
  const previous = room.views.get(viewKey);
  const next = new Set<string>();
  let changed = false;
  for (const rows of groups) for (const row of rows) {
    next.add(row.id);
    if (room.seenRows.has(row) && room.messages.has(row.id)) continue;
    room.seenRows.add(row);
    if (accept(room, row, false)) changed = true;
  }
  room.views.set(viewKey, next);
  if (previous && [...previous].some((id) => !next.has(id))) prune(key, room);
  return changed;
}

function useRevision(key: string | undefined): number {
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => undefined;
    const room = records(key);
    room.listeners.add(listener);
    return () => { room.listeners.delete(listener); prune(key, room); };
  }, [key]);
  return useSyncExternalStore(subscribe, () => key ? rooms.get(key)?.revision ?? 0 : 0);
}

export function useRoomTurnRecords(scope: string | null, roomId: string | undefined) {
  const key = scope && roomId ? keyOf(scope, roomId) : undefined;
  const revision = useRevision(key);
  return useMemo(() => roomTurns(scope, roomId ?? ''), [key, revision]);
}

function select(room: RoomRecords | undefined, rows: readonly RoomViewMessage[], scope: string | null, version: number) {
  if (!room) return rows;
  let changed = false;
  const selected = rows.map((row) => {
    const record = room.messages.get(row.id) ?? row;
    let result = record;
    if (scope) {
      const cached = identityRows.get(record);
      result = cached?.scope === scope && cached.version === version ? cached.row
        : new IdentitySelection(scope, readAt.get(record) ?? 0).message(record);
      if (cached?.scope !== scope || cached.version !== version)
        identityRows.set(record, { scope, version, row: result });
    }
    if (result !== row) changed = true;
    return result;
  });
  return changed ? selected : rows;
}

/** Windows keep their order; all mounted views select content from one id-keyed record. */
export function useRoomMessageRecords<const Groups extends readonly (readonly RoomViewMessage[])[]>(
  scope: string | null, roomId: string | undefined, groups: Groups,
): Groups {
  const [viewKey] = useState(() => `view:${++nextViewId}`);
  const held = useRef({ generation: clientResetGeneration(), scope, roomId,
    groups: [...groups] as readonly (readonly RoomViewMessage[])[], blocked: false });
  const generation = clientResetGeneration();
  if (generation !== held.current.generation)
    held.current = { generation, scope, roomId, groups: [...groups], blocked: true };
  else if (held.current.blocked && (scope !== held.current.scope || roomId !== held.current.roomId ||
    groups.length !== held.current.groups.length ||
    groups.some((rows, index) => rows !== held.current.groups[index])))
    held.current.blocked = false;
  const visible = held.current.blocked ? groups.map(() => []) : groups;
  const identityVersion = useIdentityRecords();
  const key = scope && roomId ? keyOf(scope, roomId) : undefined;
  const changed = key ? offer(key, viewKey, visible) : false;
  const room = key ? rooms.get(key) : undefined;
  useRevision(key);
  useLayoutEffect(() => { if (changed && room) notify(room); });
  useLayoutEffect(() => {
    if (!key) return;
    return () => { const held = rooms.get(key); held?.views.delete(viewKey); if (held) prune(key, held); };
  }, [key, viewKey]);
  return visible.map((rows) => select(room, rows, scope, identityVersion)) as unknown as Groups;
}
