import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { HELPER_UPDATE_CLOSE_CODE, HELPER_UPDATE_CLOSE_REASON } from '@beeline/api-contract/daemon';
import { isNetworkFailure } from './network-failure.js';

export { isNetworkFailure };

/** The helper machine's one live socket. Transport failures reconnect so the
 * successor can authenticate and read current commands. Existing heartbeat,
 * pong and handshake deadlines bound a failed connection attempt. */
export type LiveLinkState = 'disconnected' | 'connecting' | 'open' | 'suspect' | 'update-required' | 'refused';

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
  /** Legacy timing shape only; reconnect never uses a backoff timer. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Legacy timing shape only; authenticated catch-up certifies recovery. */
  stableSocketMs: number;
  /** Legacy timing shape only; no jittered retry is scheduled. */
  stableCloseJitterMs: number;
  /** TCP keepalive finds an idle, silently dead socket without server traffic. */
  keepAliveDelayMs: number;
  /** An open socket that receives no server ping for this long is dropped. */
  heartbeatTimeoutMs: number;
}

export const LIVE_LINK_TIMING: Readonly<LiveLinkTiming> = Object.freeze({
  handshakeTimeoutMs: 30_000,
  pongTimeoutMs: 15_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  stableSocketMs: 30_000,
  stableCloseJitterMs: 10_000,
  keepAliveDelayMs: 5 * 60_000,
  heartbeatTimeoutMs: 75_000,
});

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
  #pongDeadline: ReturnType<typeof setTimeout> | undefined;
  #heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
  #wanted = false;
  #updateAnnounced = false;
  #reconnects = 0;
  readonly #openListeners = new Set<() => void>();
  readonly #timing: LiveLinkTiming;

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
    if (this.#state === 'update-required' || this.#state === 'refused') return;
    if (this.#wanted) return;
    this.#wanted = true;
    if (!this.#socket) this.#connect();
  }

  stop(forUpdate = false): void {
    this.#wanted = false;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = undefined;
    if (this.#state !== 'update-required' && this.#state !== 'refused') this.#state = 'disconnected';
    socket?.close(forUpdate ? HELPER_UPDATE_CLOSE_CODE : undefined,
      forUpdate ? HELPER_UPDATE_CLOSE_REASON : undefined);
  }

  /** Replace the transport on an explicit resume/path/credential boundary. */
  reconnectNow(): void {
    if (!this.#wanted || this.#state === 'update-required' || this.#state === 'refused') return;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#clearTimers();
    socket?.terminate();
    if (socket) this.options.onClose();
    this.#reconnects += 1;
    this.#connect();
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
    socket?.close(HELPER_UPDATE_CLOSE_CODE, HELPER_UPDATE_CLOSE_REASON);
  }

  #clearTimers(): void {
    clearTimeout(this.#pongDeadline);
    this.#pongDeadline = undefined;
    clearTimeout(this.#heartbeatDeadline);
    this.#heartbeatDeadline = undefined;
  }

  /**
   * (Re)start the wait for the server's next ping. An idle helper performs no
   * operation that could notice a dead path, so the server's own heartbeat is
   * the only signal: no ping in time means the socket is gone.
   */
  #armHeartbeat(socket: WebSocket): void {
    clearTimeout(this.#heartbeatDeadline);
    this.#heartbeatDeadline = setTimeout(() => {
      this.#heartbeatDeadline = undefined;
      if (this.#socket !== socket) return;
      console.warn('[live-link] no server heartbeat; dropping the socket and reconnecting');
      socket.terminate();
    }, this.#timing.heartbeatTimeoutMs);
    this.#heartbeatDeadline.unref?.();
  }

  #connect(): void {
    const socket = this.options.factory(this.options.url(), this.options.protocols(), {
      handshakeTimeout: this.#timing.handshakeTimeoutMs,
    });
    this.#socket = socket;
    this.#state = 'connecting';
    socket.on?.('upgrade', (response: IncomingMessage) => {
      response.socket?.setKeepAlive?.(true, this.#timing.keepAliveDelayMs);
    });
    socket.on?.('unexpected-response', (_request: unknown, response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (status >= 400 && status < 500 && status !== 408 && status !== 429 && status !== 426) {
        this.#state = 'refused';
        console.warn(`[live-link] server permanently refused socket upgrade (${status}); reconnects stopped`);
        this.#clearTimers();
        socket.terminate();
        return;
      }
      if (status !== 426) {
        // Any other refusal (502, 503, a proxy page) ends this attempt now;
        // without this the handshake would wait forever for a close.
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
    socket.on?.('ping', () => {
      if (this.#socket === socket && this.isOpen()) this.#armHeartbeat(socket);
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
      this.#armHeartbeat(socket);
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
      clearTimeout(this.#heartbeatDeadline);
      this.#heartbeatDeadline = undefined;
      if (this.#state !== 'update-required' && this.#state !== 'refused') this.#state = 'disconnected';
      this.options.onClose();
      if (this.#state === 'update-required' || this.#state === 'refused' || !this.#wanted) return;
      this.#reconnects += 1;
      this.#connect();
    };
  }

}
