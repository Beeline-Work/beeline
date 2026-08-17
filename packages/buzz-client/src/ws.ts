/**
 * NIP-01 WebSocket client with NIP-42 AUTH.
 *
 * Transport choice: platform `WebSocket` (globalThis) by default — works in
 * Node ≥22 and browsers. React Native injects its own via `WebSocketImpl`.
 * No Node-only `ws` package in the core path.
 */
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { KIND_AUTH } from './kinds.js';
import type { Identity, WebSocketConstructor, WebSocketLike } from './types.js';

export type Filter = Record<string, unknown>;

type MessageHandler = (msg: unknown[]) => void;

export interface RelayWsOptions {
  wsUrl: string;
  identity: Identity;
  WebSocketImpl?: WebSocketConstructor;
  skipAuth?: boolean;
  connectTimeoutMs?: number;
  reconnectDelayMs?: number;
  /** Idle-traffic keepalive cadence while connected (default 35s). */
  keepaliveIntervalMs?: number;
}

function defaultWebSocket(): WebSocketConstructor {
  const g = globalThis as unknown as { WebSocket?: WebSocketConstructor };
  if (typeof g.WebSocket === 'function') return g.WebSocket;
  throw new Error(
    'No WebSocket global found. Pass BuzzClientConfig.WebSocketImpl (e.g. RN polyfill).',
  );
}

function messageData(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'data' in ev) {
    const d = (ev as { data: unknown }).data;
    if (typeof d === 'string') return d;
    if (d instanceof ArrayBuffer) return new TextDecoder().decode(d);
    if (ArrayBuffer.isView(d)) {
      return new TextDecoder().decode(d as ArrayBufferView);
    }
  }
  return String(ev);
}

/**
 * One authenticated WS connection to a Buzz relay.
 * Call `connect()` before subscribe/publish.
 */
export class RelayWs {
  private ws: WebSocketLike | null = null;
  private readonly handlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly pendingAuth = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  private authed = false;
  private closed = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private successfulConnections = 0;
  private readonly subscriptions = new Map<
    string,
    { filters: Filter[]; reconnectFilters?: () => Filter[] }
  >();

  constructor(private readonly opts: RelayWsOptions) {}

  get connected(): boolean {
    return (
      this.ws !== null && this.ws.readyState === 1 /* OPEN */ && (this.opts.skipAuth || this.authed)
    );
  }

  private notifyClose(): void {
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        /* close observers must not tear the socket */
      }
    }
    this.closeHandlers.clear();
  }

  /** Open socket and complete NIP-42 AUTH when challenged. */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.closed = false;
    const pending = this.doConnect();
    this.connectPromise = pending;
    void pending
      .catch(() => {
        if (!this.closed) this.scheduleReconnect();
      })
      .finally(() => {
        if (!this.connected) this.connectPromise = null;
      });
    return pending;
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const WS = this.opts.WebSocketImpl ?? defaultWebSocket();
      const timeoutMs = this.opts.connectTimeoutMs ?? 15_000;
      let settled = false;

      let socket: WebSocketLike | null = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket?.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`RelayWs connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          this.reconnectAttempts = 0;
          const reconnected = this.successfulConnections > 0;
          this.successfulConnections += 1;
          this.startKeepalive();
          resolve();
          if (reconnected) this.resubscribeLiveRequests();
        }
      };

      try {
        socket = new WS(this.opts.wsUrl);
        this.ws = socket;
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      const onOpen = () => {
        // If skipAuth, resolve on open. Otherwise wait for AUTH challenge or
        // first non-AUTH frame (some relays may not challenge every socket).
        if (this.opts.skipAuth) {
          this.authed = true;
          finish();
        } else {
          // Give the relay a short window to send AUTH; if none arrives, proceed
          // (local stacks sometimes skip challenge on open until first REQ).
          setTimeout(() => {
            if (!settled && !this.authed) {
              // Still wait — many Buzz relays send AUTH immediately.
              // If not challenged within timeoutMs, connect will fail.
            }
          }, 0);
        }
      };

      const onMessage = (raw: unknown) => {
        let msg: unknown;
        try {
          msg = JSON.parse(messageData(raw));
        } catch {
          return;
        }
        if (!Array.isArray(msg) || msg.length === 0) return;

        const type = msg[0];

        if (type === 'AUTH' && typeof msg[1] === 'string') {
          void this.respondAuth(msg[1])
            .then(() => {
              this.authed = true;
              finish();
            })
            .catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
          return;
        }

        if (type === 'OK' && typeof msg[1] === 'string') {
          const id = msg[1];
          const ok = msg[2] === true;
          const pending = this.pendingAuth.get(id);
          if (pending) {
            this.pendingAuth.delete(id);
            if (ok) pending.resolve();
            else pending.reject(new Error(`AUTH rejected: ${String(msg[3] ?? '')}`));
          }
        }

        // If we never got AUTH but are receiving other frames, treat as connected
        // (skipAuth-like path for open local stacks that don't challenge).
        if (!this.authed && !this.opts.skipAuth && type !== 'AUTH' && type !== 'NOTICE') {
          // still waiting for AUTH — do not finish yet
        }

        for (const h of this.handlers) {
          try {
            h(msg as unknown[]);
          } catch {
            /* subscriber errors must not tear the socket */
          }
        }
      };

      const onError = () => {
        finish(new Error(`RelayWs error connecting to ${this.opts.wsUrl}`));
      };

      const onClose = () => {
        if (this.ws !== socket) return;
        this.authed = false;
        this.connectPromise = null;
        this.ws = null;
        this.stopKeepalive();
        this.notifyClose();
        if (!settled) finish(new Error('RelayWs closed before ready'));
        if (!this.closed) this.scheduleReconnect();
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });
  }

  private respondAuth(challenge: string): Promise<void> {
    const relayUrl = this.opts.wsUrl;
    const event = signEvent(
      {
        pubkey: this.opts.identity.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_AUTH,
        tags: [
          ['relay', relayUrl],
          ['challenge', challenge],
        ],
        content: '',
      },
      this.opts.identity.secretKey,
    );

    return new Promise((resolve, reject) => {
      this.pendingAuth.set(event.id, { resolve, reject });
      this.send(['AUTH', event]);
      setTimeout(() => {
        if (this.pendingAuth.has(event.id)) {
          this.pendingAuth.delete(event.id);
          // Some relays OK silently or don't echo; treat timeout as soft-success
          // if the socket is still open — REQ will fail closed if AUTH failed.
          if (this.ws && this.ws.readyState === 1) resolve();
          else reject(new Error('NIP-42 AUTH timed out'));
        }
      }, 5_000);
    });
  }

  private send(frame: unknown[]): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error('RelayWs not open');
    }
    this.ws.send(JSON.stringify(frame));
  }

  /** Register a low-level message handler. Returns unsubscribe. */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Observe transport loss so long-lived clients can reconnect and re-subscribe. */
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Publish an event over WS (`["EVENT", event]`). Resolves on OK true. */
  publish(event: NostrEvent, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`WS publish timeout for ${event.id}`));
      }, timeoutMs);

      const off = this.onMessage((msg) => {
        if (msg[0] === 'OK' && msg[1] === event.id) {
          clearTimeout(timer);
          off();
          if (msg[2] === true) resolve();
          else reject(new Error(`WS publish rejected: ${String(msg[3] ?? '')}`));
        }
      });

      try {
        this.send(['EVENT', event]);
      } catch (e) {
        clearTimeout(timer);
        off();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Subscribe with NIP-01 REQ. Invokes `onEvent` for each EVENT matching the sub.
   * Returns an unsubscribe that sends CLOSE.
   */
  subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent, subId: string) => void,
    opts?: { subId?: string; onEose?: () => void; reconnectFilters?: () => Filter[] },
  ): () => void {
    const subId = opts?.subId ?? `sub-${Math.random().toString(36).slice(2, 10)}`;
    const off = this.onMessage((msg) => {
      if (msg[0] === 'EVENT' && msg[1] === subId && msg[2] && typeof msg[2] === 'object') {
        onEvent(msg[2] as NostrEvent, subId);
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        opts?.onEose?.();
      }
    });
    this.subscriptions.set(subId, { filters, reconnectFilters: opts?.reconnectFilters });
    this.send(['REQ', subId, ...filters]);
    return () => {
      off();
      this.subscriptions.delete(subId);
      try {
        this.send(['CLOSE', subId]);
      } catch {
        /* socket may already be down */
      }
    };
  }

  close(): void {
    this.closed = true;
    this.authed = false;
    this.connectPromise = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopKeepalive();
    this.notifyClose();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.handlers.clear();
    this.subscriptions.clear();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const baseDelay = this.opts.reconnectDelayMs ?? 500;
    const delay = Math.min(baseDelay * 2 ** this.reconnectAttempts, 10_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    const intervalMs = this.opts.keepaliveIntervalMs ?? 35_000;
    this.keepaliveTimer = setInterval(() => this.sendKeepalive(), intervalMs);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  /**
   * A no-op NIP-01 REQ/CLOSE round trip. Cloudflare's edge is documented to
   * close a WS with no traffic in either direction for ~100s, independent of
   * origin-side timeouts — this keeps bytes flowing on an otherwise-quiet
   * subscription so a healthy Room doesn't get closed out from under it.
   */
  private sendKeepalive(): void {
    if (!this.connected) return;
    const subId = `keepalive-${Math.random().toString(36).slice(2, 10)}`;
    try {
      this.send(['REQ', subId, { kinds: [0], limit: 0 }]);
      this.send(['CLOSE', subId]);
    } catch {
      /* a dead socket is already on its way to reconnecting */
    }
  }

  /** Reissue every live REQ after authentication on a replacement socket. */
  private resubscribeLiveRequests(): void {
    for (const [subId, subscription] of this.subscriptions) {
      try {
        this.send(['REQ', subId, ...(subscription.reconnectFilters?.() ?? subscription.filters)]);
      } catch {
        // A concurrent close will schedule another recovery attempt.
      }
    }
  }
}

/**
 * One-shot NIP-01 query over an already-open, already-authenticated socket:
 * REQ → collect EVENTs → resolve on EOSE. Mirrors HTTP `/query`'s semantics
 * (a bounded read, not a live subscription) but pays no per-request NIP-98
 * signing cost since the socket is already authed.
 *
 * `timeoutMs` mirrors `http.ts`'s `QUERY_ATTEMPT_TIMEOUT_MS`. A socket close
 * before EOSE is treated as an immediate failure — callers fall back to HTTP
 * rather than trying to resume the query across a reconnect.
 *
 * CRITICAL: every exit path (resolve, timeout, close) calls the `subscribe()`
 * unsubscribe so the one-shot REQ's subId is never left in
 * `RelayWs.subscriptions` — otherwise a later reconnect's
 * `resubscribeLiveRequests()` would incorrectly replay it as a live REQ.
 */
export function wsQueryEvents(
  ws: RelayWs,
  filters: Filter[],
  timeoutMs = 10_000,
): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let offClose: (() => void) | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offClose?.();
      unsubscribe?.();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`wsQueryEvents timeout after ${timeoutMs}ms`))),
      timeoutMs,
    );

    offClose = ws.onClose(() => finish(() => reject(new Error('wsQueryEvents: socket closed'))));

    unsubscribe = ws.subscribe(filters, (event) => events.push(event), {
      onEose: () => finish(() => resolve(events)),
    });
  });
}

/** Derive ws(s) URL from an http(s) base URL. */
export function wsUrlFromHttp(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // strip trailing slash
  return u.toString().replace(/\/$/, '');
}
