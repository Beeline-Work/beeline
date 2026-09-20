import { EventEmitter } from 'node:events';
import type { RoomViewMessage } from '@beeline/api-contract/phone';

export type CommittedMessageLiveRow = {
  id: string;
  room_id: string;
  author_id: string;
  text: string;
  presentation: RoomViewMessage['presentation'];
  attachments: unknown[];
  /** Derived on read from the row's text and the Room's membership, not stored. */
  tagged_ids: string[];
  reply_to_message_id: string | null;
  root_message_id: string | null;
  request_id: string | null;
  turn_id: string | null;
  agent_model: string | null;
  activity: unknown[] | null;
  durable_fact: RoomViewMessage['durableFact'] | null;
  card_type: string | null;
  card: Record<string, unknown> | null;
  system_event: NonNullable<RoomViewMessage['systemEvent']> | null;
  created_at: Date;
  author_kind: 'human' | 'agent';
  author_name: string;
  author_handle: string | null;
  author_avatar: string | null;
  author_face: string | null;
};

export type CommittedTurnLiveRow = {
  room_id: string;
  request_id: string;
  agent_id: string;
  status: 'working' | 'complete' | 'failed' | 'cancelled';
  started_at: Date;
  created_at: Date;
  generation_id: string | null;
  requested_by: string | null;
};

export type LiveTrace = {
  /** Per database-row notification nonce. It correlates authorized wire phases
   * without exposing a Room, identity, message, request, or command id. */
  id: string;
  databaseAt: number;
  emittedAt: number;
  /** Server-process clock captured before the committing write begins. It is
   * paired with the server's paint-ack receipt as a conservative upper bound. */
  startedAt?: number;
  /** Diagnostics-only server clock captured immediately after the committing
   * database query resolves (including implicit autocommit and driver await). */
  databaseAwaitResolvedAt?: number;
  /** Diagnostics-only server clock captured after the returned row has been
   * converted into the authoritative live projection input. */
  projectionCompletedAt?: number;
  /** Diagnostics-only infrastructure identity; never a user, Room, message,
   * request, command, or content identifier. */
  serverInstance?: string;
  /** Ask this phone to acknowledge paint so the server can take one
   * diagnostics-only DB-clock sample for a cross-process notification. */
  paintAck?: 'database-clock';
};

export type LiveEvent =
  /** `agentId` names the author when one agent's own write caused it; a fact the
   *  server itself publishes carries none. `corner-wake.ts` reads it. */
  | {
      type: 'invalidate';
      roomId: string;
      reason: string;
      agentId?: string;
      targetAgentId?: string;
      messageId?: string;
      requestId?: string;
      operation?: string;
      hiccupAttempt?: number;
      /** Parent Room when this invalidate names a corner membership. */
      parentRoomId?: string;
      /** The agent that opened that corner, as the corner's own facts record it. */
      openedBy?: string;
      /** True when this membership row is no longer a current member. */
      removed?: boolean;
      /** True when the corner_facts row records a requested close. */
      closeRequested?: boolean;
      trace?: LiveTrace;
      /** Same-process only. PostgreSQL notifications deliberately remain ID-only. */
      committedRow?:
        | { type: 'message'; row: CommittedMessageLiveRow; startedAt?: number }
        | { type: 'turn'; row: CommittedTurnLiveRow; startedAt?: number };
    }
  | { type: 'draft' | 'thought'; roomId: string; agentId: string; turnId: string; text: string }
  | { type: 'retract'; roomId: string; agentId: string; turnId: string; kind: 'draft' | 'thought' }
  | {
      type: 'presence';
      roomId: string;
      agentId: string;
      status: 'online' | 'offline';
      observedAt: number;
      ownerEpoch?: string;
      expiresAt?: number;
    };

export class LiveHub {
  readonly #events = new EventEmitter();
  readonly #presence = new Map<string, Map<string, Extract<LiveEvent, { type: 'presence' }>>>();
  readonly #humanConnections = new Map<string, { count: number; observedAt: number }>();
  /** When true, writers skip local membership fanout — the PostgreSQL LISTEN
   * path is the sole presence authority (production). Unit tests keep the
   * default so a LiveHub without a listener still receives presence. */
  #listenerOwnsPresenceFanout = false;

  /** Production wires PostgresLiveListener before evidence writes; call once. */
  useListenerPresenceFanout(): void {
    this.#listenerOwnsPresenceFanout = true;
  }

  listenerOwnsPresenceFanout(): boolean {
    return this.#listenerOwnsPresenceFanout;
  }

  humanConnected(identityId: string, now = Date.now()): boolean {
    const previous = this.#humanConnections.get(identityId);
    this.#humanConnections.set(identityId, {
      count: (previous?.count ?? 0) + 1,
      observedAt: Math.floor(now / 1_000),
    });
    return !previous?.count;
  }

  humanDisconnected(identityId: string, now = Date.now()): boolean {
    const previous = this.#humanConnections.get(identityId);
    if (!previous) return false;
    const count = Math.max(0, previous.count - 1);
    this.#humanConnections.set(identityId, { count, observedAt: Math.floor(now / 1_000) });
    return previous.count > 0 && count === 0;
  }

  humanPresence(
    identityId: string,
  ): { status: 'online' | 'offline'; observedAt: number } | undefined {
    const presence = this.#humanConnections.get(identityId);
    return presence
      ? { status: presence.count > 0 ? 'online' : 'offline', observedAt: presence.observedAt }
      : undefined;
  }

  publish(event: LiveEvent): void {
    if (event.type === 'presence') {
      let room = this.#presence.get(event.roomId);
      if (!room) {
        room = new Map();
        this.#presence.set(event.roomId, room);
      }
      const previous = room.get(event.agentId);
      if (
        previous &&
        (previous.observedAt > event.observedAt ||
          (previous.observedAt === event.observedAt &&
            (previous.status === event.status || previous.status === 'offline')))
      )
        return;
      room.set(event.agentId, event);
    }
    this.#events.emit(event.roomId, event);
    this.#events.emit('*', event);
  }

  subscribeAll(listener: (event: LiveEvent) => void): () => void {
    this.#events.on('*', listener);
    return () => this.#events.off('*', listener);
  }

  presenceSnapshot(roomId: string): readonly Extract<LiveEvent, { type: 'presence' }>[] {
    return [...(this.#presence.get(roomId)?.values() ?? [])];
  }

  latestAgentPresence(
    agentId: string,
    roomId?: string,
  ): Extract<LiveEvent, { type: 'presence' }> | undefined {
    const rooms = roomId ? [this.#presence.get(roomId)] : this.#presence.values();
    let latest: Extract<LiveEvent, { type: 'presence' }> | undefined;
    for (const room of rooms) {
      const event = room?.get(agentId);
      if (event && (!latest || event.observedAt > latest.observedAt)) latest = event;
    }
    return latest;
  }

  subscribe(roomId: string, listener: (event: LiveEvent) => void): () => void {
    const resync = () => listener({ type: 'invalidate', roomId, reason: 'resync' });
    this.#events.on(roomId, listener);
    this.#events.on('resync', resync);
    return () => {
      this.#events.off(roomId, listener);
      this.#events.off('resync', resync);
    };
  }

  subscribeResync(listener: () => void): () => void {
    this.#events.on('resync', listener);
    return () => this.#events.off('resync', listener);
  }

  resync(): void {
    this.#events.emit('resync');
  }
}
