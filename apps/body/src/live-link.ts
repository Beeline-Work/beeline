import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';

/**
 * The helper's one live socket to the server.
 *
 * The socket is disposable: any failed or silent connection is dropped and a
 * new one is opened after backoff, with no limit on attempts. Nothing here
 * reads from the server on a timer; the only timers are the reconnect backoff,
 * the handshake deadline, and the pong deadline of a socket already suspected.
 *
 *   disconnected → connecting → open ⇄ suspect
 *   any state → update-required (terminal: never reconnects)
 */
export type LiveLinkState = 'disconnected' | 'connecting' | 'open' | 'suspect' | 'update-required';

export type LiveSocketFactory = (
  url: string,
  protocols: string[],
  options: WebSocket.ClientOptions,
) => WebSocket;

export interface LiveLinkTiming {
  /** An upgrade that gets no answer is abandoned after this long. */
  handshakeTimeoutMs: number;
  /** A suspect socket that does not answer a ping in this window is dropped. */
  pongTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Only a socket that lived this long resets the backoff. */
  stableSocketMs: number;
  /** After a stable socket closes, the first retry waits up to this long. */
  stableCloseJitterMs: number;
  /** TCP keepalive finds an idle, silently dead socket without server traffic. */
  keepAliveDelayMs: number;
}

export const LIVE_LINK_TIMING: Readonly<LiveLinkTiming> = Object.freeze({
  handshakeTimeoutMs: 30_000,
  pongTimeoutMs: 15_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  stableSocketMs: 30_000,
  stableCloseJitterMs: 10_000,
  keepAliveDelayMs: 5 * 60_000,
});

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
]);

/**
 * Whether a failure carries a network-class code anywhere in its cause chain
 * (or is an AggregateError made only of such failures). A response the server
 * actually sent is never one of these.
 */
export function isNetworkFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_')))
      return true;
    if (value instanceof AggregateError && value.errors.length > 0 && value.errors.every(visit))
      return true;
    return visit((value as { cause?: unknown }).cause);
  };
  return visit(error);
}

/** Retry-After may be seconds or an HTTP date. Clamp malformed/remote values. */
export function retryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 60_000) : undefined;
}

export class LiveLink {
  #state: LiveLinkState = 'disconnected';
  #socket: WebSocket | undefined;
  #openedAt: number | undefined;
  #failedConnects = 0;
  #retryAfterMs = 0;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #pongDeadline: ReturnType<typeof setTimeout> | undefined;
  #wanted = false;
  #updateAnnounced = false;
  #reconnects = 0;
  readonly #openListeners = new Set<() => void>();
  readonly #timing: LiveLinkTiming;
  readonly #random: () => number;
  readonly #now: () => number;

  constructor(
    private readonly options: {
      url: () => string;
      protocols: () => string[];
      factory: LiveSocketFactory;
      onOpen: () => void;
      onMessage: (data: string) => void;
      onClose: () => void;
      onUpdateRequired: (minVersion: string) => void;
      timing?: Partial<LiveLinkTiming>;
      random?: () => number;
      now?: () => number;
    },
  ) {
    this.#timing = { ...LIVE_LINK_TIMING, ...options.timing };
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  get state(): LiveLinkState {
    return this.#state;
  }

  get reconnects(): number {
    return this.#reconnects;
  }

  /** A suspect socket is still open for writes until its pong deadline. */
  isOpen(): boolean {
    return this.#state === 'open' || this.#state === 'suspect';
  }

  /** Called on every open, after the link's own open handling. */
  onOpen(listener: () => void): () => void {
    this.#openListeners.add(listener);
    return () => this.#openListeners.delete(listener);
  }

  start(): void {
    if (this.#state === 'update-required') return;
    this.#wanted = true;
    if (!this.#socket && !this.#reconnect) this.#connect();
  }

  stop(): void {
    this.#wanted = false;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = undefined;
    if (this.#state !== 'update-required') this.#state = 'disconnected';
    socket?.close();
  }

  send(data: string): boolean {
    if (!this.isOpen() || this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(data);
    return true;
  }

  /**
   * Something suggests the socket may be dead (a network-class HTTP failure,
   * an admitted fetch past its deadline, a failed reconcile). Ask the socket
   * itself: one ping, and no pong within the deadline drops it. A socket that
   * is not open is already on its way to a new one.
   */
  suspect(): void {
    const socket = this.#socket;
    if (this.#state !== 'open' || !socket) return;
    this.#state = 'suspect';
    try {
      socket.ping?.();
    } catch {
      // A socket that cannot even queue a ping is dropped by the deadline.
    }
    this.#pongDeadline = setTimeout(() => {
      this.#pongDeadline = undefined;
      if (this.#socket === socket && this.#state === 'suspect') socket.terminate();
    }, this.#timing.pongTimeoutMs);
    this.#pongDeadline.unref?.();
  }

  /** The server requires a newer helper: stop for good and say so once. */
  requireUpdate(minVersion: string): void {
    this.#markUpdateRequired();
    if (this.#updateAnnounced) return;
    this.#updateAnnounced = true;
    this.options.onUpdateRequired(minVersion);
  }

  #markUpdateRequired(): void {
    this.#state = 'update-required';
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }

  #clearTimers(): void {
    clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    clearTimeout(this.#pongDeadline);
    this.#pongDeadline = undefined;
  }

  #connect(): void {
    const socket = this.options.factory(this.options.url(), this.options.protocols(), {
      handshakeTimeout: this.#timing.handshakeTimeoutMs,
    });
    this.#socket = socket;
    this.#state = 'connecting';
    this.#openedAt = undefined;
    socket.on?.('upgrade', (response: IncomingMessage) => {
      response.socket?.setKeepAlive?.(true, this.#timing.keepAliveDelayMs);
    });
    socket.on?.('unexpected-response', (_request: unknown, response: IncomingMessage) => {
      if (response.statusCode !== 426) {
        // Any other refusal (502, 503, a proxy page) ends this attempt now;
        // without this the handshake would wait forever for a close.
        this.#retryAfterMs = retryAfterMs(headerValue(response.headers?.['retry-after'])) ?? 0;
        socket.terminate();
        return;
      }
      // A daemon opening after the minimum was raised is refused before any
      // WebSocket frame can arrive. Its short JSON body supplies the same
      // force-update signal as a live push; nothing reconnects meanwhile.
      this.#state = 'update-required';
      this.#clearTimers();
      let body = '';
      response.on('data', (chunk: Buffer) => {
        if (body.length < 1024) body += chunk.toString('utf8').slice(0, 1024 - body.length);
      });
      response.on('end', () => {
        try {
          const refusal = JSON.parse(body) as { error?: unknown; minVersion?: unknown };
          if (refusal.error === 'update_required' && typeof refusal.minVersion === 'string')
            this.requireUpdate(refusal.minVersion);
        } catch {
          // A malformed refusal cannot authorize an install.
        }
      });
      response.on('close', () => socket.terminate());
    });
    socket.on?.('pong', () => {
      if (this.#socket !== socket || this.#state !== 'suspect') return;
      clearTimeout(this.#pongDeadline);
      this.#pongDeadline = undefined;
      this.#state = 'open';
    });
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#state = 'open';
      this.#openedAt = this.#now();
      this.options.onOpen();
      for (const listener of [...this.#openListeners]) {
        try {
          listener();
        } catch (error) {
          console.error('[live-link] open listener failed', error);
        }
      }
    };
    socket.onmessage = (message) => {
      if (this.#socket === socket) this.options.onMessage(String(message.data));
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      clearTimeout(this.#pongDeadline);
      this.#pongDeadline = undefined;
      const openedAt = this.#openedAt;
      this.#openedAt = undefined;
      if (this.#state !== 'update-required') this.#state = 'disconnected';
      this.options.onClose();
      if (this.#state === 'update-required' || !this.#wanted) return;
      this.#scheduleReconnect(openedAt);
    };
  }

  #scheduleReconnect(openedAt: number | undefined): void {
    let delay: number;
    if (openedAt !== undefined && this.#now() - openedAt >= this.#timing.stableSocketMs) {
      this.#failedConnects = 0;
      delay = this.#random() * this.#timing.stableCloseJitterMs;
    } else {
      // Full jitter keeps a host's agents from reconnecting in lockstep.
      const ceiling = Math.min(
        this.#timing.backoffMaxMs,
        this.#timing.backoffBaseMs * 2 ** this.#failedConnects,
      );
      this.#failedConnects += 1;
      delay = this.#random() * ceiling;
    }
    delay = Math.floor(Math.max(delay, this.#retryAfterMs));
    this.#retryAfterMs = 0;
    this.#reconnects += 1;
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      if (this.#wanted && !this.#socket && this.#state !== 'update-required') this.#connect();
    }, delay);
    this.#reconnect.unref?.();
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
