import { AppState } from 'react-native';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import type { NostrEvent } from '@beeline/nostr';
import type { LiveWireEvent, MonolithSurfaceEvent } from './monolith-rig-transport';
import { noteLiveFrame } from './live-frame-epoch';
import { applyNeedsYouLiveDelta } from '@/buzz/needs-you';
import {
  acceptCornerStatusFrame,
  noteCornerLaneReleased,
  noteCornerLaneSubscribed,
  noteCornerSocketDropped,
  noteRoomCornersChanged,
  resetRoomCornerStore,
} from '@/buzz/room-corner-store';
import { subscribeClientReset } from '@/sync/client-reset';

type SurfaceFilters = readonly {
  readonly '#h'?: readonly string[];
  readonly '#d'?: readonly string[];
}[];
type SurfaceListener = (event: NostrEvent | MonolithSurfaceEvent) => void;

// Draft and thought share one wire member, so they narrow to the same type.
type DraftEvent = Extract<LiveWireEvent, { type: 'draft' | 'thought' }>;
type ThoughtEvent = DraftEvent;
type PresenceEvent = Extract<LiveWireEvent, { type: 'presence' }>;
type CornerStatusEvent = Extract<LiveWireEvent, { type: 'corner-status' }>;

type CachedOverlay<Event> = { readonly event: Event; readonly receivedAt: number };

type RoomOverlayCache = {
  drafts: Map<string, CachedOverlay<DraftEvent>>;
  thoughts: Map<string, CachedOverlay<ThoughtEvent>>;
  presence: Map<string, PresenceEvent>;
  /** The newest corner status this socket heard, for a Room list that joins later. */
  cornerStatus?: CornerStatusEvent;
};

type Registration = {
  readonly id: number;
  readonly filters: SurfaceFilters;
  readonly listener: SurfaceListener;
  readonly roomIds: ReadonlySet<string>;
  /** A socket was open at some point while this registration held. */
  sawOpen: boolean;
  closed: boolean;
};
type RoomCursor = { epoch: string; base: number; seen: Set<number> };

type LiveConnectionDeps = {
  authorization: () => Promise<string>;
  liveUrl: () => string;
  /** Fires on an identity or relay change. */
  subscribeIdentityChange: (listener: () => void) => () => void;
  /** Fires when the app returns to the foreground from the background. */
  subscribeForeground: (listener: () => void) => () => void;
};

/** A socket stuck opening on a bad network fires no close on its own. */
const LIVE_CONNECT_TIMEOUT_MS = 15_000;
/** A push can beat the socket frame for the same message; past this, the
 *  socket missed it. */
const PUSH_MISS_GRACE_MS = 5_000;
/** Message ids recently delivered by the socket, to judge a later push. */
const HEARD_MESSAGE_LIMIT = 256;
/** Parent-Room invalidations that name a corner change without its rows. */
const CORNER_LIST_REASONS: ReadonlySet<string> = new Set(['corner-status', 'corner', 'resync']);
/** The same window the server's own `liveDraftSnapshot` is gated on: past it a
 *  cached draft is no longer live text, so a late join must not paint it. A
 *  turn that ends `failed` or `cancelled` leaves no `retract` behind, so this
 *  and the terminal `turn-delta` eviction are what retire such a draft here. */
const LIVE_OVERLAY_TTL_MS = 90_000;

function roomIdsFromFilters(filters: SurfaceFilters): Set<string> {
  return new Set(
    filters
      .flatMap((filter) => [
        ...(filter['#h'] ?? []),
        ...(filter['#d'] ?? []).map((value) => value.split(':').at(-1) ?? ''),
      ])
      .filter(Boolean),
  );
}

function overlayKey(agentId: string, turnId: string): string {
  return `${agentId}:${turnId}`;
}

function isSocketOpen(socket: WebSocket): boolean {
  return socket.readyState === 1;
}

function dropExpiredOverlays(cache: RoomOverlayCache, now: number): void {
  for (const [key, entry] of cache.drafts)
    if (now - entry.receivedAt >= LIVE_OVERLAY_TTL_MS) cache.drafts.delete(key);
  for (const [key, entry] of cache.thoughts)
    if (now - entry.receivedAt >= LIVE_OVERLAY_TTL_MS) cache.thoughts.delete(key);
}

/**
 * One phone live socket for the app. `surfaceSubscribe` only registers;
 * rooms are refcounted over this connection and the socket outlives screens.
 */
export class LiveConnection {
  private readonly registrations = new Map<number, Registration>();
  private readonly refcount = new Map<string, number>();
  private readonly seenSubscribed = new Set<string>();
  private readonly pendingSubscribe = new Set<string>();
  private readonly overlays = new Map<string, RoomOverlayCache>();
  private readonly roomCursors = new Map<string, RoomCursor>();
  private readonly traceOwners = new Map<string, Registration>();
  private readonly connectedListeners = new Set<() => void>();
  private socket: WebSocket | undefined;
  private connectInFlight: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Rooms on screen, counted per holder; the server holds their pushes. */
  private readonly viewing = new Map<string, number>();
  private readonly heardMessages = new Set<string>();
  private readonly subscribeWaiters = new Set<() => void>();
  private foregroundSyncTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs = 1_000;
  private nextRegistrationId = 1;
  private generation = 0;
  /** Bumped only by `dispose`; a held view survives an identity change. */
  private viewEpoch = 0;
  private readonly unsubscribeIdentity: () => void;
  private readonly unsubscribeForeground: () => void;

  constructor(private readonly deps: LiveConnectionDeps) {
    this.unsubscribeIdentity = deps.subscribeIdentityChange(() => this.handleIdentityChanged());
    this.unsubscribeForeground = deps.subscribeForeground(() => this.handleForeground());
  }

  register(filters: SurfaceFilters, listener: SurfaceListener): Promise<() => void> {
    const roomIds = roomIdsFromFilters(filters);
    const registration: Registration = {
      id: this.nextRegistrationId++,
      filters,
      listener,
      roomIds,
      sawOpen: Boolean(this.socket && isSocketOpen(this.socket)),
      closed: false,
    };
    this.registrations.set(registration.id, registration);
    const held: string[] = [];
    const fresh: string[] = [];
    for (const roomId of roomIds) {
      const previous = this.refcount.get(roomId) ?? 0;
      this.refcount.set(roomId, previous + 1);
      if (this.seenSubscribed.has(roomId)) held.push(roomId);
      else if (previous === 0 && !this.pendingSubscribe.has(roomId)) fresh.push(roomId);
    }
    if (fresh.length && this.socket && isSocketOpen(this.socket)) this.sendSubscribe(fresh);
    for (const roomId of held) this.replayLateJoin(registration, roomId);
    // Registration is complete before the socket authenticates. Initial
    // Workspace/Room reads start after this promise, so a slow live handshake
    // must not hold the deck on its loading view.
    void this.ensureSocket();
    return Promise.resolve(() => this.stop(registration));
  }

  dispose(): void {
    this.dropConnection();
    for (const registration of this.registrations.values()) registration.closed = true;
    this.registrations.clear();
    this.refcount.clear();
    this.viewEpoch += 1;
    this.viewing.clear();
    this.unsubscribeIdentity();
    this.unsubscribeForeground();
  }

  /**
   * Hold a Room's pushes while it is on screen. The server keeps the view
   * until the returned release says it left, or the socket that carried it
   * closes; a replacement socket carries every held view again on open.
   */
  view(roomId: string): () => void {
    const epoch = this.viewEpoch;
    const previous = this.viewing.get(roomId) ?? 0;
    this.viewing.set(roomId, previous + 1);
    if (previous === 0) this.sendViewing(roomId, true);
    let released = false;
    return () => {
      if (released || epoch !== this.viewEpoch) return;
      released = true;
      const remaining = (this.viewing.get(roomId) ?? 1) - 1;
      if (remaining > 0) {
        this.viewing.set(roomId, remaining);
        return;
      }
      this.viewing.delete(roomId);
      this.sendViewing(roomId, false);
    };
  }

  /**
   * Settles once the server confirmed every Room these filters name, or after
   * `timeoutMs`. A read started after that misses nothing the subscription
   * would carry, so its surface needs no second, covering read.
   */
  whenSubscribed(filters: SurfaceFilters, timeoutMs: number): Promise<void> {
    const roomIds = [...roomIdsFromFilters(filters)];
    const confirmed = () => roomIds.every((roomId) => this.seenSubscribed.has(roomId));
    if (confirmed()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = () => {
        if (!confirmed()) return;
        settle();
      };
      const timer = setTimeout(() => settle(), timeoutMs);
      const settle = () => {
        clearTimeout(timer);
        this.subscribeWaiters.delete(waiter);
        resolve();
      };
      this.subscribeWaiters.add(waiter);
    });
  }

  /**
   * A push arrived for a message in a Room this socket carries. When the
   * socket never delivered that message, it is silently dead: replace it.
   */
  notePushedMessage(roomId: string, messageId: string): void {
    if (!this.seenSubscribed.has(roomId) || this.heardMessages.has(messageId)) return;
    const socket = this.socket;
    setTimeout(() => {
      if (this.socket !== socket || !this.seenSubscribed.has(roomId)) return;
      if (!this.heardMessages.has(messageId)) this.reconnect();
    }, PUSH_MISS_GRACE_MS);
  }

  /** Fires once per successful socket open, first connect and every
   *  reconnect alike. A caller that keeps its own state in sync with the
   *  server (rather than reading room/turn deltas off active registrations)
   *  uses this as its one covering reconcile trigger instead of polling. */
  subscribeConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }

  /**
   * Replace the socket now. A backgrounded socket can look open while the
   * server has long stopped delivering to it; the fresh socket's resubscribe
   * frames are every surface's covering read. Also called when a read proves
   * the current socket missed events.
   */
  reconnect(): void {
    if (this.connectInFlight) {
      // Registration can return while the first connect promise is still
      // settling. Keep a foreground/read recovery request made in that gap.
      if (this.socket || this.reconnectTimer) {
        const generation = this.generation;
        void this.connectInFlight.then(() => {
          if (generation === this.generation) this.reconnect();
        });
      }
      return;
    }
    if (this.socket?.readyState === 0) return;
    if (!this.socket && !this.reconnectTimer) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectDelayMs = 1_000;
    const current = this.socket;
    this.socket = undefined;
    this.dropSocketState();
    current?.close();
    void this.ensureSocket();
  }

  private handleForeground(): void {
    // A one-shot ordered socket echo proves the background connection still
    // carries its subscriptions. Replace it only when that path is silent.
    if (this.socket && isSocketOpen(this.socket)) {
      if (this.foregroundSyncTimer) clearTimeout(this.foregroundSyncTimer);
      const current = this.socket;
      current.send(JSON.stringify({ type: 'sync' }));
      this.foregroundSyncTimer = setTimeout(() => {
        this.foregroundSyncTimer = undefined;
        if (this.socket === current) this.reconnect();
      }, 3_000);
      return;
    }
    this.reconnect();
  }

  /**
   * Mounted screens stay registered across an identity or relay change. The
   * next socket subscribes their Rooms without the old identity's cursors, so
   * each hears a fresh `subscribed` (or a roomless reconnect signal) and reads
   * again as the new identity.
   */
  private handleIdentityChanged(): void {
    this.dropConnection();
    this.refcount.clear();
    for (const registration of this.registrations.values()) {
      registration.sawOpen = true;
      for (const roomId of registration.roomIds)
        this.refcount.set(roomId, (this.refcount.get(roomId) ?? 0) + 1);
    }
    if (this.registrations.size) void this.ensureSocket();
  }

  private dropConnection(): void {
    this.generation += 1;
    this.connectInFlight = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const current = this.socket;
    this.socket = undefined;
    current?.close();
    if (this.foregroundSyncTimer) clearTimeout(this.foregroundSyncTimer);
    this.foregroundSyncTimer = undefined;
    this.seenSubscribed.clear();
    this.pendingSubscribe.clear();
    this.overlays.clear();
    this.roomCursors.clear();
    this.traceOwners.clear();
    this.heardMessages.clear();
    this.reconnectDelayMs = 1_000;
    resetRoomCornerStore();
  }

  private stop(registration: Registration): void {
    if (registration.closed) return;
    registration.closed = true;
    this.registrations.delete(registration.id);
    for (const [traceId, owner] of this.traceOwners) {
      if (owner === registration) this.traceOwners.delete(traceId);
    }
    for (const roomId of registration.roomIds) {
      const previous = this.refcount.get(roomId) ?? 0;
      const next = previous - 1;
      if (next > 0) this.refcount.set(roomId, next);
      else {
        this.refcount.delete(roomId);
        const acknowledged = this.seenSubscribed.delete(roomId);
        this.overlays.delete(roomId);
        this.roomCursors.delete(roomId);
        noteCornerLaneReleased(roomId);
        if (acknowledged && this.socket && isSocketOpen(this.socket))
          this.socket.send(JSON.stringify({ type: 'unsubscribe', roomId }));
      }
    }
  }

  private ensureSocket(): Promise<void> {
    if (this.socket) return Promise.resolve();
    if (this.connectInFlight) return this.connectInFlight;
    // A connect from before an identity change settles after the next one starts.
    const flight: Promise<void> = this.connect().finally(() => {
      if (this.connectInFlight === flight) this.connectInFlight = undefined;
    });
    this.connectInFlight = flight;
    return flight;
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    try {
      const token = await this.deps.authorization();
      if (generation !== this.generation) return;
      const url = this.deps.liveUrl();
      const next = new WebSocket(url, [`bearer.${token}`]);
      this.socket = next;
      const connectTimer = setTimeout(() => {
        if (this.socket !== next || next.readyState !== 0) return;
        this.socket = undefined;
        this.dropSocketState();
        next.close();
        this.scheduleReconnect();
      }, LIVE_CONNECT_TIMEOUT_MS);
      next.onopen = () => {
        clearTimeout(connectTimer);
        if (this.socket !== next) return;
        this.reconnectDelayMs = 1_000;
        this.sendSubscribe([...this.refcount.keys()]);
        for (const roomId of this.viewing.keys()) this.sendViewing(roomId, true);
        this.coverRoomlessRegistrations();
        for (const listener of this.connectedListeners) listener();
      };
      next.onmessage = (message) => {
        if (this.socket !== next) return;
        let live: LiveWireEvent;
        try {
          live = JSON.parse(String(message.data)) as LiveWireEvent;
        } catch {
          return;
        }
        if (live.type === 'sync-ok') {
          if (this.foregroundSyncTimer) clearTimeout(this.foregroundSyncTimer);
          this.foregroundSyncTimer = undefined;
          return;
        }
        noteLiveFrame();
        this.dispatch(live, next);
      };
      next.onclose = () => {
        clearTimeout(connectTimer);
        if (this.socket !== next) return;
        this.socket = undefined;
        this.dropSocketState();
        this.scheduleReconnect();
      };
    } catch {
      if (generation !== this.generation) return;
      this.scheduleReconnect();
    }
  }

  private dropSocketState(): void {
    if (this.foregroundSyncTimer) clearTimeout(this.foregroundSyncTimer);
    this.foregroundSyncTimer = undefined;
    this.seenSubscribed.clear();
    this.pendingSubscribe.clear();
    noteCornerSocketDropped();
    // Keep the last painted overlays and Room cursors across a transport
    // reconnect. A resumed server lane only replays what changed.
    this.traceOwners.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureSocket();
    }, delayMs);
  }

  /**
   * A registration without Rooms hears only identity-wide invalidations, which
   * a socket gap can drop. One that lived through a gap gets one covering
   * signal per reopened socket instead of a timer; a new one already read.
   */
  private coverRoomlessRegistrations(): void {
    for (const registration of this.registrations.values()) {
      if (registration.closed) continue;
      if (registration.roomIds.size === 0 && registration.sawOpen)
        registration.listener({
          monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' },
        });
      registration.sawOpen = true;
    }
  }

  private sendViewing(roomId: string, viewing: boolean): void {
    if (!this.socket || !isSocketOpen(this.socket)) return;
    this.socket.send(JSON.stringify({ type: 'viewing', roomId, viewing }));
  }

  private hear(messageId: string | undefined): void {
    if (!messageId) return;
    this.heardMessages.delete(messageId);
    this.heardMessages.add(messageId);
    if (this.heardMessages.size > HEARD_MESSAGE_LIMIT) {
      const oldest = this.heardMessages.values().next().value;
      if (oldest !== undefined) this.heardMessages.delete(oldest);
    }
  }

  private sendSubscribe(roomIds: readonly string[]): void {
    if (!this.socket || !isSocketOpen(this.socket) || roomIds.length === 0) return;
    // The phone server accepts at most 32 Rooms in one subscribe frame.
    for (let offset = 0; offset < roomIds.length; offset += 32) {
      const batch = roomIds.slice(offset, offset + 32);
      for (const roomId of batch) this.pendingSubscribe.add(roomId);
      const cursors = Object.fromEntries(batch.flatMap((roomId) => {
        const cursor = this.roomCursors.get(roomId);
        return cursor ? [[roomId, { epoch: cursor.epoch, base: cursor.base,
          seen: [...cursor.seen].sort((a, b) => a - b) }]] : [];
      }));
      this.socket.send(JSON.stringify({ type: 'subscribe', roomIds: batch,
        ...(Object.keys(cursors).length ? { cursors } : {}) }));
    }
  }

  private replayLateJoin(registration: Registration, roomId: string): void {
    const cursor = this.roomCursors.get(roomId);
    registration.listener({ monolithLive: { type: 'subscribed', roomId,
      ...(cursor ? { epoch: cursor.epoch, cursor: cursor.base, resumed: true } : {}) } });
    const cache = this.overlays.get(roomId);
    if (!cache) return;
    dropExpiredOverlays(cache, Date.now());
    for (const entry of cache.drafts.values()) registration.listener({ monolithLive: entry.event });
    for (const entry of cache.thoughts.values())
      registration.listener({ monolithLive: entry.event });
    for (const event of cache.presence.values()) registration.listener({ monolithLive: event });
    if (cache.cornerStatus) registration.listener({ monolithLive: cache.cornerStatus });
  }

  private dispatch(live: LiveWireEvent | { type: 'pong' }, generation: WebSocket): void {
    if (live.type === 'pong') return;
    if (live.type === 'message-delta') this.hear(live.message.id);
    else if (live.type === 'invalidate') this.hear(live.messageId);
    if (live.type === 'trace-painted') {
      const owner = this.traceOwners.get(live.id);
      this.traceOwners.delete(live.id);
      if (owner && !owner.closed) owner.listener({ monolithLive: live });
      return;
    }
    if (live.type === 'draft-append' || live.type === 'thought-append') {
      const kind = live.type === 'draft-append' ? 'draft' : 'thought';
      const cache = this.overlays.get(live.roomId);
      const previous = (kind === 'draft' ? cache?.drafts : cache?.thoughts)
        ?.get(overlayKey(live.agentId, live.turnId))?.event;
      if (!previous || previous.text.length !== live.offset ||
          (previous.revision ?? 0) + 1 !== live.revision) {
        // An out-of-sequence append cannot paint. The reconnect's full
        // subscribe snapshot restores this lane and covers other missed rows.
        this.roomCursors.delete(live.roomId);
        this.overlays.delete(live.roomId);
        this.reconnect();
        return;
      }
      live = {
        type: kind, roomId: live.roomId, agentId: live.agentId,
        turnId: live.turnId, revision: live.revision,
        text: previous.text + live.chunk,
        ...(live.sequence !== undefined ? { sequence: live.sequence } : {}),
        latestChunk: live.latestChunk ?? live.chunk,
      };
    }
    if (!('roomId' in live)) return;
    if (live.type === 'needs-you-delta') applyNeedsYouLiveDelta(live);
    if (live.roomId === '' &&
        (live.type === 'bookmark-delta' || live.type === 'needs-you-delta' ||
          live.type === 'resource-change' || live.type === 'invalidate')) {
      for (const registration of this.registrations.values()) {
        if (!registration.closed && registration.roomIds.size === 0)
          registration.listener({ monolithLive: live });
      }
      return;
    }
    if (!this.refcount.has(live.roomId)) {
      if (live.type !== 'subscribed') return;
      this.pendingSubscribe.delete(live.roomId);
      if (this.socket === generation && isSocketOpen(generation))
        generation.send(JSON.stringify({ type: 'unsubscribe', roomId: live.roomId }));
      return;
    }
    if (live.type === 'subscribed') {
      this.pendingSubscribe.delete(live.roomId);
      this.seenSubscribed.add(live.roomId);
      let resumed = Boolean(live.resumed);
      if (typeof live.epoch === 'string' && Number.isSafeInteger(live.cursor)) {
        const previous = this.roomCursors.get(live.roomId);
        resumed = Boolean(live.resumed) && previous?.epoch === live.epoch;
        if (!resumed) {
          this.roomCursors.set(live.roomId, { epoch: live.epoch, base: live.cursor!, seen: new Set() });
          this.overlays.delete(live.roomId);
        }
      }
      noteCornerLaneSubscribed(live.roomId, resumed);
      for (const waiter of [...this.subscribeWaiters]) waiter();
    } else if (typeof live.sequence === 'number') {
      const cursor = this.roomCursors.get(live.roomId);
      if (cursor && live.sequence > cursor.base) {
        if (live.sequence > cursor.base + 256) {
          this.roomCursors.delete(live.roomId);
          this.reconnect();
          return;
        }
        cursor.seen.add(live.sequence);
        while (cursor.seen.delete(cursor.base + 1)) cursor.base += 1;
      }
    }
    if (live.type === 'corner-status' && !acceptCornerStatusFrame(live)) return;
    if (live.type === 'invalidate' && !live.deliveryId && CORNER_LIST_REASONS.has(live.reason))
      noteRoomCornersChanged(live.roomId);
    this.rememberOverlay(live);
    for (const registration of this.registrations.values()) {
      if (registration.closed || !registration.roomIds.has(live.roomId)) continue;
      const trace = 'trace' in live ? live.trace : undefined;
      registration.listener({
        monolithLive: live,
        ...(typeof trace?.startedAt === 'number' || trace?.paintAck === 'database-clock'
          ? {
              acknowledgePaint: () => {
                if (registration.closed || this.socket !== generation || !isSocketOpen(generation))
                  return;
                this.traceOwners.set(trace.id, registration);
                generation.send(JSON.stringify({ type: 'trace-paint', id: trace.id }));
              },
            }
          : {}),
      });
    }
  }

  private rememberOverlay(live: LiveWireEvent): void {
    if (live.type === 'draft') {
      const cache = this.overlayCache(live.roomId);
      cache.drafts.set(overlayKey(live.agentId, live.turnId), {
        event: live,
        receivedAt: Date.now(),
      });
      return;
    }
    if (live.type === 'thought') {
      const cache = this.overlayCache(live.roomId);
      cache.thoughts.set(overlayKey(live.agentId, live.turnId), {
        event: live,
        receivedAt: Date.now(),
      });
      return;
    }
    if (live.type === 'presence') {
      const cache = this.overlayCache(live.roomId);
      cache.presence.set(live.agentId, live);
      return;
    }
    if (live.type === 'corner-status') {
      // The corner store already refused an older sequence.
      this.overlayCache(live.roomId).cornerStatus = live;
      return;
    }
    if (live.type === 'retract') {
      const cache = this.overlays.get(live.roomId);
      if (!cache) return;
      const key = overlayKey(live.agentId, live.turnId);
      if (live.kind === 'draft') cache.drafts.delete(key);
      else cache.thoughts.delete(key);
      return;
    }
    if (live.type === 'turn-delta') {
      if (live.turn.status === 'working') return;
      const cache = this.overlays.get(live.roomId);
      if (!cache) return;
      const key = overlayKey(live.turn.agentPubkey, live.turn.requestId);
      cache.drafts.delete(key);
      cache.thoughts.delete(key);
    }
  }

  private overlayCache(roomId: string): RoomOverlayCache {
    const existing = this.overlays.get(roomId);
    if (existing) {
      dropExpiredOverlays(existing, Date.now());
      return existing;
    }
    const created: RoomOverlayCache = {
      drafts: new Map(),
      thoughts: new Map(),
      presence: new Map(),
    };
    this.overlays.set(roomId, created);
    return created;
  }
}

let shared: LiveConnection | undefined;

export function sharedLiveConnection(): LiveConnection {
  shared ??= new LiveConnection({
    authorization: () => monolithSession.authorization(),
    liveUrl: () => `${getBuzzRuntimeConfig().monolithUrl.replace(/^http/, 'ws')}/v1/phone/live`,
    subscribeIdentityChange: subscribeClientReset,
    subscribeForeground: (listener) => {
      let backgrounded = AppState.currentState === 'background';
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'background') backgrounded = true;
        else if (state === 'active' && backgrounded) {
          backgrounded = false;
          listener();
        }
      });
      return () => subscription.remove();
    },
  });
  return shared;
}

export function resetSharedLiveConnection(): void {
  shared?.dispose();
  shared = undefined;
}
