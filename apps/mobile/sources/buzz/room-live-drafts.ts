import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { LiveOverlay } from '@beeline/buzz-client';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import type { LiveWireEvent } from '@/sync/transport/monolith-rig-transport';
import { subscribeClientReset } from '@/sync/client-reset';
import { liveDraftRowId } from './draft-settle';
import {
  applyLiveOverlayStructure,
  liveDraftDrainKey,
  liveDraftDrainStore,
} from './live-draft-drain';

/**
 * The one copy of each Room's live drafts. Every view (the Room transcript,
 * a workflow run) selects from here. The live connection writes each draft
 * frame once; a lane's text lives in the drain store, which paints it.
 *
 * A Room's drafts end when its live lane did not resume (a retract or turn
 * end may be lost in the gap; the server's snapshot re-sends every open
 * draft), when no view listens to the Room any longer, and on a client reset.
 */

type DraftLane = Extract<LiveOverlay, { kind: 'draft' }>;

type RoomDrafts = {
  lanes: readonly DraftLane[];
  /** Lanes whose turn stopped working. The transcript keeps them until its final lands. */
  readonly ended: Set<string>;
  /** The newest output chunk per lane, for views that show only that. */
  readonly latestChunks: Map<string, string>;
  /** Structure changes: a lane opened, closed or ended. */
  readonly listeners: Set<() => void>;
  /** Any change, text included. */
  readonly textListeners: Set<() => void>;
  revision: number;
};

const noLanes: readonly DraftLane[] = [];
const rooms = new Map<string, RoomDrafts>();

subscribeClientReset(() => {
  for (const roomId of [...rooms.keys()]) clearRoomDrafts(roomId);
});

function roomDrafts(roomId: string): RoomDrafts {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      lanes: noLanes,
      ended: new Set(),
      latestChunks: new Map(),
      listeners: new Set(),
      textListeners: new Set(),
      revision: 0,
    };
    rooms.set(roomId, room);
  }
  return room;
}

function notify(room: RoomDrafts, structure: boolean) {
  room.revision += 1;
  if (structure) for (const listener of [...room.listeners]) listener();
  for (const listener of [...room.textListeners]) listener();
}

/** Drop every draft of a Room, and its text in the drain. */
export function clearRoomDrafts(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const lane of room.lanes)
    liveDraftDrainStore.remove(liveDraftDrainKey(lane.agentPubkey, lane.requestId));
  const had = room.lanes.length > 0;
  room.lanes = noLanes;
  room.ended.clear();
  room.latestChunks.clear();
  if (!room.listeners.size && !room.textListeners.size) rooms.delete(roomId);
  if (had) notify(room, true);
}

/** Open, grow or close one draft lane. */
export function applyRoomDraft(roomId: string, update: DraftLane, latestChunk?: string): void {
  const room = roomDrafts(roomId);
  const key = liveDraftDrainKey(update.agentPubkey, update.requestId);
  const before = liveDraftDrainStore.getReceived(key);
  const lanes = applyLiveOverlayStructure(room.lanes, update) as readonly DraftLane[];
  const structure = lanes !== room.lanes;
  room.lanes = lanes;
  if (latestChunk !== undefined) room.latestChunks.set(key, latestChunk);
  if (structure || liveDraftDrainStore.getReceived(key) !== before) notify(room, structure);
}

/**
 * The live connection's one write of a Room frame into its drafts. `resumed`
 * is the connection's own verdict on a `subscribed` frame.
 */
export function applyRoomDraftFrame(live: LiveWireEvent, resumed: boolean): void {
  if (!('roomId' in live)) return;
  if (live.type === 'subscribed') {
    if (!resumed) clearRoomDrafts(live.roomId);
  } else if (live.type === 'draft' || (live.type === 'retract' && live.kind === 'draft')) {
    const closed = live.type === 'retract';
    applyRoomDraft(
      live.roomId,
      {
        kind: 'draft',
        key: `draft:${live.agentId}:${live.turnId}`,
        stableId: liveDraftRowId(live.agentId, live.turnId),
        agentPubkey: live.agentId,
        requestId: live.turnId,
        ...(live.type === 'draft' ? { text: live.text } : {}),
        closed,
        // Seconds, but not whole seconds: a draft's first snapshot is the
        // anchor its row keeps for the turn, and two turns a few hundred
        // milliseconds apart must not tie.
        createdAt: Date.now() / 1000,
      },
      live.type === 'draft' ? live.latestChunk : undefined,
    );
  } else if (live.type === 'message-delta' && live.message.requestId) {
    liveDraftDrainStore.finalize(liveDraftDrainKey(live.message.author.pubkey, live.message.requestId));
  } else if (live.type === 'turn-delta' && live.turn.status !== 'working') {
    const key = liveDraftDrainKey(live.turn.agentPubkey, live.turn.requestId);
    if (live.turn.status === 'complete') liveDraftDrainStore.finalize(key);
    const room = rooms.get(live.roomId);
    if (!room || room.ended.has(key)) return;
    if (!room.lanes.some((lane) => liveDraftDrainKey(lane.agentPubkey, lane.requestId) === key))
      return;
    room.ended.add(key);
    notify(room, true);
  }
}

function subscribeRoom(roomId: string | undefined, text: boolean) {
  return (listener: () => void) => {
    if (!roomId) return () => undefined;
    const room = roomDrafts(roomId);
    const listeners = text ? room.textListeners : room.listeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!room.lanes.length && !room.listeners.size && !room.textListeners.size && rooms.get(roomId) === room)
        rooms.delete(roomId);
    };
  };
}

/** A Room's draft lanes, in the order they opened. Text growth does not re-render. */
export function useRoomDraftLanes(roomId: string | undefined): readonly DraftLane[] {
  const subscribe = useMemo(() => subscribeRoom(roomId, false), [roomId]);
  return useSyncExternalStore(subscribe, () => (roomId ? rooms.get(roomId)?.lanes : undefined) ?? noLanes);
}

/**
 * The newest output chunk of each draft still being written in one Room,
 * keyed by agent and turn. Thoughts are private and are never here. The
 * Room stays subscribed while a view reads it.
 */
export function useRoomLiveDrafts(roomId: string | undefined): ReadonlyMap<string, string> {
  useEffect(() => {
    if (!roomId) return;
    let active = true;
    let stop: (() => void) | undefined;
    void sharedLiveConnection()
      .register([{ '#h': [roomId] }], () => undefined)
      .then((unregister) => {
        if (active) stop = unregister;
        else unregister();
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [roomId]);
  const subscribe = useMemo(() => subscribeRoom(roomId, true), [roomId]);
  const revision = useSyncExternalStore(subscribe, () =>
    roomId ? (rooms.get(roomId)?.revision ?? 0) : 0,
  );
  return useMemo(() => {
    const texts = new Map<string, string>();
    const room = roomId ? rooms.get(roomId) : undefined;
    if (!room) return texts;
    for (const lane of room.lanes) {
      const key = liveDraftDrainKey(lane.agentPubkey, lane.requestId);
      if (lane.closed || room.ended.has(key)) continue;
      const text = room.latestChunks.get(key) ?? '';
      if (text.trim()) texts.set(`${lane.agentPubkey}:${lane.requestId}`, text);
    }
    return texts;
    // `revision` changes with every draft write of this Room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, roomId]);
}
