/**
 * One authenticated relay WebSocket per daemon, shared by every room-instance.
 *
 * A Workspace with N Rooms used to hold roughly N+1 concurrent NIP-42
 * authenticated sockets on the *same* agent pubkey: one per Room push loop
 * (`Body.runRoomPushLoop`), one per Room presence cache
 * (`Body.openChannelPresenceCache`), and one control plane
 * (`WorkspaceSupervisor.run`). Nothing about the protocol needs that —
 * `RelayWs` already multiplexes many NIP-01 subscriptions over one socket by
 * subId and already replays every live REQ after a reconnect — so per-key
 * socket growth was pure cost, and a per-key connection cap would have put a
 * hard ceiling on how many Rooms one agent could serve.
 *
 * Sharing is transparent to callers: each Room still gets its own REQ with its
 * own filters and its own reconnect cursor. The one rule is ownership — a Room
 * must never `disconnect()` the shared client, because that would tear down
 * every sibling Room's subscription too. `acquire()` hands back an explicit
 * `release()` so the Body path is identical whether it is sharing the daemon's
 * socket or (standalone `beeline serve`, unit tests) owning its own.
 */
import WebSocket from 'ws';
import { createBuzzClient } from '@beeline/buzz-client';
import type { Identity } from '@beeline/gate';

export type RelayClientHandle = ReturnType<typeof createBuzzClient>;

export interface RelaySocketLease {
  client: RelayClientHandle;
  /** Drop this holder's claim. A shared socket stays open for its siblings. */
  release(): void;
}

export interface SharedRelaySocketOptions {
  baseUrl: string;
  host?: string;
  wsUrl?: string;
  identity: Identity;
  /** Overridable for tests; defaults to the Node `ws` implementation. */
  WebSocketImpl?: typeof WebSocket;
  /** Overridable for tests; defaults to `createBuzzClient`. */
  createClient?: (options: {
    baseUrl: string;
    host?: string;
    wsUrl?: string;
    identity: Identity;
    WebSocketImpl?: typeof WebSocket;
  }) => RelayClientHandle;
}

export class SharedRelaySocket {
  private client?: RelayClientHandle;
  private connecting?: Promise<RelayClientHandle>;
  private closed = false;

  constructor(private readonly options: SharedRelaySocketOptions) {}

  /** The one connected client, connecting it if needed. Safe to call concurrently. */
  async connected(): Promise<RelayClientHandle> {
    if (this.closed) throw new Error('shared relay socket is closed');
    const create = this.options.createClient ?? createBuzzClient;
    const client = (this.client ??= create({
      baseUrl: this.options.baseUrl,
      ...(this.options.host ? { host: this.options.host } : {}),
      ...(this.options.wsUrl ? { wsUrl: this.options.wsUrl } : {}),
      identity: this.options.identity,
      WebSocketImpl: this.options.WebSocketImpl ?? WebSocket,
    }));
    if (client.socket?.connected) return client;
    // `BuzzClient.connect()` is itself idempotent and keeps the same RelayWs
    // (which owns the registered live REQs), so concurrent Room starts
    // collapse onto one in-flight connect instead of racing.
    this.connecting ??= client
      .connect()
      .then(() => client)
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  /** A lease on the shared socket. `release()` is a no-op: the owner disposes. */
  async acquire(): Promise<RelaySocketLease> {
    const client = await this.connected();
    return { client, release: () => undefined };
  }

  disconnect(): void {
    this.closed = true;
    this.client?.disconnect();
    this.client = undefined;
    this.connecting = undefined;
  }
}
