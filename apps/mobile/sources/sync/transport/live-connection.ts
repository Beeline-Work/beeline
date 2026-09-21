import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import type { NostrEvent } from '@beeline/nostr';
import type { LiveWireEvent, MonolithSurfaceEvent } from './monolith-rig-transport';

type SurfaceFilters = readonly {
  readonly '#h'?: readonly string[];
  readonly '#d'?: readonly string[];
}[];
type SurfaceListener = (event: NostrEvent | MonolithSurfaceEvent) => void;

type DraftEvent = Extract<LiveWireEvent, { type: 'draft' }>;
type ThoughtEvent = Extract<LiveWireEvent, { type: 'thought' }>;
type PresenceEvent = Extract<LiveWireEvent, { type: 'presence' }>;

type RoomOverlayCache = {
  drafts: Map<string, DraftEvent>;
  thoughts: Map<string, ThoughtEvent>;
  presence: Map<string, PresenceEvent>;
};

type Registration = {
  readonly id: number;
  readonly filters: SurfaceFilters;
  readonly listener: SurfaceListener;
  readonly roomIds: ReadonlySet<string>;
  tickDueAt: number;
  closed: boolean;
};

type LiveConnectionDeps = {
  authorization: () => Promise<string>;
  liveUrl: () => string;
  subscribeIdentityChange: (listener: () => void) => () => void;
};

const FALLBACK_INTERVAL_MS = 30_000;

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

/**
 * One phone live socket for the app. `surfaceSubscribe` only registers;
 * rooms are refcounted over this connection and the socket outlives screens.
 */
export class LiveConnection {
  private readonly registrations = new Map<number, Registration>();
  private readonly refcount = new Map<string, number>();
  private readonly seenSubscribed = new Set<string>();
  private readonly overlays = new Map<string, RoomOverlayCache>();
  private readonly traceOwners = new Map<string, Registration>();
  private socket: WebSocket | undefined;
  private connectInFlight: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private fallbackTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectDelayMs = 1_000;
  private nextRegistrationId = 1;
  private generation = 0;
  private readonly unsubscribeIdentity: () => void;

  constructor(private readonly deps: LiveConnectionDeps) {
    this.unsubscribeIdentity = deps.subscribeIdentityChange(() => this.handleIdentityChanged());
  }

  register(filters: SurfaceFilters, listener: SurfaceListener): Promise<() => void> {
    const roomIds = roomIdsFromFilters(filters);
    const registration: Registration = {
      id: this.nextRegistrationId++,
      filters,
      listener,
      roomIds,
      tickDueAt: Date.now() + FALLBACK_INTERVAL_MS,
      closed: false,
    };
    this.registrations.set(registration.id, registration);
    const held: string[] = [];
    const fresh: string[] = [];
    for (const roomId of roomIds) {
      const previous = this.refcount.get(roomId) ?? 0;
      this.refcount.set(roomId, previous + 1);
      if (this.seenSubscribed.has(roomId)) held.push(roomId);
      else if (previous === 0) fresh.push(roomId);
    }
    this.ensureFallback();
    if (fresh.length && this.socket && isSocketOpen(this.socket)) this.sendSubscribe(fresh);
    for (const roomId of held) this.replayLateJoin(registration, roomId);
    return this.ensureSocket().then(() => () => this.stop(registration));
  }

  dispose(): void {
    this.handleIdentityChanged();
    this.unsubscribeIdentity();
  }

  private handleIdentityChanged(): void {
    this.generation += 1;
    this.connectInFlight = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = undefined;
    const current = this.socket;
    this.socket = undefined;
    current?.close();
    for (const registration of this.registrations.values()) registration.closed = true;
    this.registrations.clear();
    this.refcount.clear();
    this.seenSubscribed.clear();
    this.overlays.clear();
    this.traceOwners.clear();
    this.reconnectDelayMs = 1_000;
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
        if (acknowledged && this.socket && isSocketOpen(this.socket))
          this.socket.send(JSON.stringify({ type: 'unsubscribe', roomId }));
      }
    }
  }

  private ensureFallback(): void {
    if (this.fallbackTimer) return;
    this.fallbackTimer = setInterval(() => {
      const now = Date.now();
      for (const registration of this.registrations.values()) {
        if (registration.closed || now < registration.tickDueAt) continue;
        registration.tickDueAt = now + FALLBACK_INTERVAL_MS;
        const roomId = [...registration.roomIds][0] ?? '';
        registration.listener({
          monolithLive: { type: 'invalidate', roomId, reason: 'poll' },
        });
      }
    }, FALLBACK_INTERVAL_MS);
  }

  private ensureSocket(): Promise<void> {
    if (this.socket) return Promise.resolve();
    this.connectInFlight ??= this.connect().finally(() => {
      this.connectInFlight = undefined;
    });
    return this.connectInFlight;
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    try {
      const token = await this.deps.authorization();
      if (generation !== this.generation) return;
      const url = this.deps.liveUrl();
      const next = new WebSocket(url, [`bearer.${token}`]);
      this.socket = next;
      next.onopen = () => {
        if (this.socket !== next) return;
        this.reconnectDelayMs = 1_000;
        const roomIds = [...this.refcount.keys()];
        if (roomIds.length === 0) return;
        next.send(JSON.stringify({ type: 'subscribe', roomIds }));
      };
      next.onmessage = (message) => {
        if (this.socket !== next) return;
        let live: LiveWireEvent;
        try {
          live = JSON.parse(String(message.data)) as LiveWireEvent;
        } catch {
          return;
        }
        this.dispatch(live, next);
      };
      next.onclose = () => {
        if (this.socket !== next) return;
        this.socket = undefined;
        this.seenSubscribed.clear();
        this.overlays.clear();
        this.traceOwners.clear();
        this.scheduleReconnect();
      };
    } catch {
      if (generation !== this.generation) return;
      this.scheduleReconnect();
    }
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

  private sendSubscribe(roomIds: readonly string[]): void {
    if (!this.socket || !isSocketOpen(this.socket) || roomIds.length === 0) return;
    this.socket.send(JSON.stringify({ type: 'subscribe', roomIds: [...roomIds] }));
  }

  private replayLateJoin(registration: Registration, roomId: string): void {
    registration.listener({ monolithLive: { type: 'subscribed', roomId } });
    const cache = this.overlays.get(roomId);
    if (!cache) return;
    for (const event of cache.drafts.values())
      registration.listener({ monolithLive: event });
    for (const event of cache.thoughts.values())
      registration.listener({ monolithLive: event });
    for (const event of cache.presence.values())
      registration.listener({ monolithLive: event });
  }

  private dispatch(live: LiveWireEvent, generation: WebSocket): void {
    if (live.type === 'trace-painted') {
      const owner = this.traceOwners.get(live.id);
      this.traceOwners.delete(live.id);
      if (owner && !owner.closed) owner.listener({ monolithLive: live });
      return;
    }
    if (!('roomId' in live)) return;
    if (!this.refcount.has(live.roomId)) {
      if (live.type === 'subscribed' && this.socket === generation && isSocketOpen(generation))
        generation.send(JSON.stringify({ type: 'unsubscribe', roomId: live.roomId }));
      return;
    }
    if (live.type === 'subscribed') this.seenSubscribed.add(live.roomId);
    this.rememberOverlay(live);
    for (const registration of this.registrations.values()) {
      if (registration.closed || !registration.roomIds.has(live.roomId)) continue;
      const trace = 'trace' in live ? live.trace : undefined;
      registration.listener({
        monolithLive: live,
        ...(typeof trace?.startedAt === 'number' || trace?.paintAck === 'database-clock'
          ? {
              acknowledgePaint: () => {
                if (
                  registration.closed ||
                  this.socket !== generation ||
                  !isSocketOpen(generation)
                )
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
      cache.drafts.set(overlayKey(live.agentId, live.turnId), live);
      return;
    }
    if (live.type === 'thought') {
      const cache = this.overlayCache(live.roomId);
      cache.thoughts.set(overlayKey(live.agentId, live.turnId), live);
      return;
    }
    if (live.type === 'presence') {
      const cache = this.overlayCache(live.roomId);
      cache.presence.set(live.agentId, live);
      return;
    }
    if (live.type === 'retract') {
      const cache = this.overlays.get(live.roomId);
      if (!cache) return;
      const key = overlayKey(live.agentId, live.turnId);
      if (live.kind === 'draft') cache.drafts.delete(key);
      else cache.thoughts.delete(key);
    }
  }

  private overlayCache(roomId: string): RoomOverlayCache {
    const existing = this.overlays.get(roomId);
    if (existing) return existing;
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
    subscribeIdentityChange: (listener) => monolithSession.subscribeIdentityChange(listener),
  });
  return shared;
}

export function resetSharedLiveConnection(): void {
  shared?.dispose();
  shared = undefined;
}
