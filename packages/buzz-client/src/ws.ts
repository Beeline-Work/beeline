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
  private readonly pendingAuth = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  private authed = false;
  private closed = false;
  private challenge: string | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly opts: RelayWsOptions) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === 1 /* OPEN */ && (this.opts.skipAuth || this.authed);
  }

  /** Open socket and complete NIP-42 AUTH when challenged. */
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    return this.connectPromise;
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const WS = this.opts.WebSocketImpl ?? defaultWebSocket();
      const timeoutMs = this.opts.connectTimeoutMs ?? 15_000;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`RelayWs connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      try {
        this.ws = new WS(this.opts.wsUrl);
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
          this.challenge = msg[1];
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
        this.authed = false;
        if (!settled) finish(new Error('RelayWs closed before ready'));
      };

      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('message', onMessage);
      this.ws.addEventListener('error', onError);
      this.ws.addEventListener('close', onClose);
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
    opts?: { subId?: string; onEose?: () => void },
  ): () => void {
    const subId = opts?.subId ?? `sub-${Math.random().toString(36).slice(2, 10)}`;
    const off = this.onMessage((msg) => {
      if (msg[0] === 'EVENT' && msg[1] === subId && msg[2] && typeof msg[2] === 'object') {
        onEvent(msg[2] as NostrEvent, subId);
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        opts?.onEose?.();
      }
    });
    this.send(['REQ', subId, ...filters]);
    return () => {
      off();
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
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.handlers.clear();
  }
}

/** Derive ws(s) URL from an http(s) base URL. */
export function wsUrlFromHttp(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // strip trailing slash
  return u.toString().replace(/\/$/, '');
}
