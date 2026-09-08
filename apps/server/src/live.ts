import { EventEmitter } from 'node:events';

export type LiveEvent =
  /** `agentId` names the author when one agent's own write caused it; a fact the
   *  server itself publishes carries none. `corner-wake.ts` reads it. */
  | { type: 'invalidate'; roomId: string; reason: string; agentId?: string }
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
          (previous.observedAt === event.observedAt && previous.status === 'offline'))
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
