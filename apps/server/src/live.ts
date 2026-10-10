import type { AgentSignInLink } from '@beeline/api-contract/daemon';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
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
      /** A read-cursor change belongs only to this reader's devices. */
      readerId?: string;
      workspaceId?: string;
      sourceRoomId?: string;
      needsYouCandidate?: boolean;
      messageId?: string;
      requestId?: string;
      turnStatus?: CommittedTurnLiveRow['status'];
      operation?: string;
      /** Parent Room when this invalidate names a corner membership. */
      parentRoomId?: string;
      /** The agent that opened that corner, as the corner's own facts record it. */
      openedBy?: string;
      /** True when the Room or corner this membership names is already archived. */
      archived?: boolean;
      /** True when this membership row is no longer a current member. */
      removed?: boolean;
      /** Repository binding or GitHub installation metadata changed. */
      repositoryChanged?: boolean;
      /** True when the corner_facts row records a requested close. */
      closeRequested?: boolean;
      /** An agent_commands row left `claimed`, so another agent's held wake may be due. */
      commandReleased?: boolean;
      trace?: LiveTrace;
      /** Same-process only. PostgreSQL notifications deliberately remain ID-only. */
      committedRow?:
        | { type: 'message'; row: CommittedMessageLiveRow; startedAt?: number }
        | { type: 'turn'; row: CommittedTurnLiveRow; startedAt?: number };
    }
  | { type: 'draft' | 'thought'; roomId: string; agentId: string; turnId: string; text: string; latestChunk?: string;
      /** Process-only marker for suppressing the same write echoed by LISTEN. */ localOrigin?: true }
  | { type: 'retract'; roomId: string; agentId: string; turnId: string; kind: 'draft' | 'thought' }
  | {
      type: 'presence';
      roomId: string;
      agentId: string;
      status: 'online' | 'offline';
      observedAt: number;
      /** A live helper connection holds this presence: it does not age out. */
      held?: boolean;
      ownerEpoch?: string;
      expiresAt?: number;
    }
  /** A server instance accepted a newer connection for this agent. Never sent
   *  to a socket; every instance drops its own older connection for the agent. */
  | { type: 'agent-connection'; roomId: ''; agentId: string; epoch: number }
  /** Committed helper bundle; one row notification fans out to local sockets. */
  | { type: 'helper-release'; roomId: ''; agentId: ''; version: string; sha: string }
  /** One `@agent /login` step (`agent-sign-in.ts`). Never sent to a phone
   *  socket: a helper session forwards only `start`/`code` for its own agent,
   *  and the owner's waiting request reads `link`/`result`. */
  | ({ type: 'agent-sign-in'; roomId: ''; agentId: string; attemptId: string } & (
      | { step: 'start'; cardId: string }
      | { step: 'code'; code: string }
      | { step: 'link'; link: AgentSignInLink }
      | { step: 'result'; outcome: 'signed-in' }
      | { step: 'result'; outcome: 'failed'; error: string }
    ));

export class LiveHub {
  readonly #events = new EventEmitter();
  readonly #history = new Map<string, {
    epoch: string;
    sequence: number;
    bytes: number;
    entries: Array<{ sequence: number; event: LiveEvent; bytes: number }>;
  }>();
  readonly #recentOutputs = new Map<string, { text: string; latestChunk?: string;
    source: 'local' | 'postgres'; at: number }>();
  readonly #localMessageInserts = new Map<string, number>();
  readonly #localTurnUpdates = new Map<string, { status: CommittedTurnLiveRow['status']; at: number }>();
  readonly #presence = new Map<string, Map<string, Extract<LiveEvent, { type: 'presence' }>>>();
  /** Oldest observed Room/agent pair first; one cap across all Rooms. */
  readonly #presenceOrder = new Map<string, { roomId: string; agentId: string }>();
  readonly #humanConnections = new Map<string, { count: number; observedAt: number }>();
  #offlineHumans = 0;
  #humanPruneAt = 0;
  static readonly MAX_PRESENCE_ENTRIES = 20_000;
  static readonly MAX_OFFLINE_HUMANS = 10_000;
  static readonly OFFLINE_HUMAN_TTL_SECONDS = 60 * 60;
  /** When true, writers skip local membership fanout — the PostgreSQL LISTEN
   * path is the sole presence authority (production). Unit tests keep the
   * default so a LiveHub without a listener still receives presence. */
  #listenerOwnsPresenceFanout = false;

  constructor() {
    // Each connected helper contributes a legitimate wildcard listener.
    // Socket admission bounds the fan-in; Node's default warning at ten
    // listeners is too low for an ordinary server instance.
    this.#events.setMaxListeners(0);
  }

  /** Production wires PostgresLiveListener before evidence writes; call once. */
  useListenerPresenceFanout(): void {
    this.#listenerOwnsPresenceFanout = true;
  }

  listenerOwnsPresenceFanout(): boolean {
    return this.#listenerOwnsPresenceFanout;
  }

  humanConnected(identityId: string, now = Date.now()): boolean {
    const previous = this.#humanConnections.get(identityId);
    if (previous?.count === 0) this.#offlineHumans--;
    this.#humanConnections.set(identityId, {
      count: (previous?.count ?? 0) + 1,
      observedAt: Math.floor(now / 1_000),
    });
    this.#pruneHumanConnections(Math.floor(now / 1_000));
    return !previous?.count;
  }

  humanDisconnected(identityId: string, now = Date.now()): boolean {
    const previous = this.#humanConnections.get(identityId);
    if (!previous) return false;
    const count = Math.max(0, previous.count - 1);
    if (previous.count > 0 && count === 0) this.#offlineHumans++;
    this.#humanConnections.set(identityId, { count, observedAt: Math.floor(now / 1_000) });
    this.#pruneHumanConnections(Math.floor(now / 1_000));
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

  publish(input: LiveEvent): void {
    let event = input;
    if (input.type === 'invalidate' && input.messageId) {
      const key = `${input.roomId}:${input.messageId}`;
      const now = Date.now();
      if (input.committedRow?.type === 'message' || input.reason === 'phone-write') {
        this.#localMessageInserts.delete(key);
        this.#localMessageInserts.set(key, now);
        if (this.#localMessageInserts.size > 512)
          this.#localMessageInserts.delete(this.#localMessageInserts.keys().next().value!);
      } else if (input.reason === 'postgres:messages' && input.operation === 'INSERT' &&
          now - (this.#localMessageInserts.get(key) ?? 0) < 10_000) return;
    }
    if (input.type === 'invalidate' && input.agentId && input.requestId) {
      const key = `${input.roomId}:${input.agentId}:${input.requestId}`;
      const now = Date.now();
      if (input.committedRow?.type === 'turn') {
        this.#localTurnUpdates.delete(key);
        this.#localTurnUpdates.set(key, { status: input.committedRow.row.status, at: now });
        if (this.#localTurnUpdates.size > 512)
          this.#localTurnUpdates.delete(this.#localTurnUpdates.keys().next().value!);
      } else if (input.reason === 'postgres:agent_turns' && input.turnStatus &&
          this.#localTurnUpdates.get(key)?.status === input.turnStatus &&
          now - (this.#localTurnUpdates.get(key)?.at ?? 0) < 10_000) return;
    }
    if (input.type === 'draft' || input.type === 'thought') {
      const key = `${input.roomId}:${input.agentId}:${input.turnId}:${input.type}`;
      const source = input.localOrigin ? 'local' : 'postgres';
      const previous = this.#recentOutputs.get(key);
      const now = Date.now();
      if (previous && previous.source !== source && now - previous.at < 10_000 &&
          previous.text === input.text && previous.latestChunk === input.latestChunk) return;
      this.#recentOutputs.delete(key);
      this.#recentOutputs.set(key, { text: input.text, latestChunk: input.latestChunk,
        source, at: now });
      if (this.#recentOutputs.size > 512)
        this.#recentOutputs.delete(this.#recentOutputs.keys().next().value!);
      const { localOrigin: _localOrigin, ...publicEvent } = input;
      event = publicEvent;
    }
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
      const key = `${event.roomId}\u0000${event.agentId}`;
      this.#presenceOrder.delete(key);
      this.#presenceOrder.set(key, { roomId: event.roomId, agentId: event.agentId });
      while (this.#presenceOrder.size > LiveHub.MAX_PRESENCE_ENTRIES) {
        const oldest = this.#presenceOrder.keys().next().value!;
        const entry = this.#presenceOrder.get(oldest)!;
        this.#presenceOrder.delete(oldest);
        const oldRoom = this.#presence.get(entry.roomId);
        oldRoom?.delete(entry.agentId);
        if (oldRoom?.size === 0) this.#presence.delete(entry.roomId);
      }
    } else if (event.type === 'invalidate' && event.archived) {
      const room = this.#presence.get(event.roomId);
      if (room) {
        for (const agentId of room.keys()) this.#presenceOrder.delete(`${event.roomId}\u0000${agentId}`);
        this.#presence.delete(event.roomId);
      }
    }
    if (event.roomId) {
      const history = this.#history.get(event.roomId) ?? {
        epoch: randomUUID(), sequence: 0, bytes: 0, entries: [],
      };
      const replayEvent = event.type === 'invalidate'
        ? (({ committedRow: _private, ...wire }) => wire)(event)
        : event;
      const bytes = Buffer.byteLength(JSON.stringify(replayEvent));
      history.sequence += 1;
      history.entries.push({ sequence: history.sequence, event: replayEvent, bytes });
      history.bytes += bytes;
      while (history.entries.length > 256 || history.bytes > 128 * 1024) {
        const removed = history.entries.shift();
        if (removed) history.bytes -= removed.bytes;
      }
      this.#history.delete(event.roomId);
      this.#history.set(event.roomId, history);
      if (this.#history.size > 256) this.#history.delete(this.#history.keys().next().value!);
    }
    this.#events.emit(event.roomId, event);
    this.#events.emit('*', event);
  }

  #pruneHumanConnections(nowSeconds: number): void {
    if (nowSeconds < this.#humanPruneAt &&
        this.#offlineHumans <= LiveHub.MAX_OFFLINE_HUMANS) return;
    this.#humanPruneAt = nowSeconds + 60;
    for (const [id, item] of this.#humanConnections) {
      if (item.count > 0) continue;
      if (item.observedAt + LiveHub.OFFLINE_HUMAN_TTL_SECONDS <= nowSeconds) {
        this.#humanConnections.delete(id);
        this.#offlineHumans--;
      }
    }
    if (this.#offlineHumans <= LiveHub.MAX_OFFLINE_HUMANS) return;
    for (const [id, item] of this.#humanConnections) {
      if (item.count > 0) continue;
      this.#humanConnections.delete(id);
      if (--this.#offlineHumans <= LiveHub.MAX_OFFLINE_HUMANS) break;
    }
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

  /** Best-effort, bounded socket resume. A different process or an evicted
   * history asks for the ordinary covering snapshot instead of guessing. */
  subscribeReplay(
    roomId: string,
    cursor: { epoch: string; base: number; seen: readonly number[] } | undefined,
    listener: (event: LiveEvent, sequence?: number) => void,
  ): { release: () => void; epoch: string; sequence: number; resumed: boolean;
       replay: readonly { event: LiveEvent; sequence: number }[] } {
    const history = this.#history.get(roomId) ?? {
      epoch: randomUUID(), sequence: 0, bytes: 0, entries: [],
    };
    this.#history.delete(roomId);
    this.#history.set(roomId, history);
    if (this.#history.size > 256) this.#history.delete(this.#history.keys().next().value!);
    const sequence = history.sequence;
    const minimum = history.entries[0]?.sequence ?? sequence + 1;
    const resumed = Boolean(cursor && cursor.epoch === history.epoch &&
      Number.isSafeInteger(cursor.base) && cursor.base >= minimum - 1 &&
      cursor.base <= sequence && cursor.seen.length <= 256 &&
      cursor.seen.every((item) => Number.isSafeInteger(item) && item > cursor.base && item <= sequence));
    const seen = new Set(resumed ? cursor!.seen : []);
    const replay = resumed
      ? history.entries.filter((entry) => entry.sequence > cursor!.base && !seen.has(entry.sequence))
        .map(({ event, sequence: itemSequence }) => ({ event, sequence: itemSequence }))
      : [];
    const release = this.subscribe(roomId, (event) => listener(
      event, event.type === 'invalidate' && event.reason === 'resync'
        ? undefined : this.#history.get(roomId)?.sequence));
    return { release, epoch: history.epoch, sequence, resumed, replay };
  }

  subscribeResync(listener: () => void): () => void {
    this.#events.on('resync', listener);
    return () => this.#events.off('resync', listener);
  }

  resync(): void {
    this.#events.emit('resync');
  }
}
