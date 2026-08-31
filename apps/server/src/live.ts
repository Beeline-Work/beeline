import { EventEmitter } from 'node:events';

export type LiveEvent =
  | { type: 'invalidate'; roomId: string; reason: string }
  | { type: 'draft' | 'thought'; roomId: string; agentId: string; turnId: string; text: string }
  | { type: 'retract'; roomId: string; agentId: string; turnId: string; kind: 'draft' | 'thought' }
  | {
      type: 'presence';
      roomId: string;
      agentId: string;
      status: 'online' | 'offline';
      observedAt: number;
    };

export class LiveHub {
  readonly #events = new EventEmitter();

  publish(event: LiveEvent): void {
    this.#events.emit(event.roomId, event);
  }

  subscribe(roomId: string, listener: (event: LiveEvent) => void): () => void {
    this.#events.on(roomId, listener);
    return () => this.#events.off(roomId, listener);
  }
}
