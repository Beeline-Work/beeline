import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { HELPER_UPDATE_CLOSE_CODE, HELPER_UPDATE_CLOSE_REASON } from '@beeline/api-contract/daemon';
export { isNetworkFailure } from './network-failure.js';

export type LiveLinkState = 'connected' | 'disconnected';
export type LiveSocketFactory = (url: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket;
export interface LiveLinkTiming { keepAliveDelayMs: number }
export const LIVE_LINK_TIMING: Readonly<LiveLinkTiming> = Object.freeze({ keepAliveDelayMs: 30_000 });

export function retryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 60_000) : undefined;
}

/** The sole owner of the machine's physical connection. Only close opens a
 * successor; TCP keepalive detects dead links without application timers. */
export class LiveLink {
  #socket?: WebSocket;
  #wanted = false;
  #updateAnnounced = false;
  #reconnects = 0;
  #state: LiveLinkState = 'disconnected';
  readonly #openListeners = new Set<() => void>();
  constructor(private readonly options: {
    url: () => string; protocols: () => string[]; factory: LiveSocketFactory;
    onOpen: () => void; onMessage: (data: string) => void; onClose: () => void;
    onUpdateRequired: (minVersion: string) => void; timing?: Partial<LiveLinkTiming>;
  }) {}
  get state(): LiveLinkState { return this.#state; }
  get reconnects(): number { return this.#reconnects; }
  isOpen(): boolean { return this.#state === 'connected'; }
  onOpen(listener: () => void): () => void { this.#openListeners.add(listener); return () => this.#openListeners.delete(listener); }
  start(): void {
    if (this.#wanted || this.#updateAnnounced) return;
    this.#wanted = true;
    this.#connect();
  }
  stop(forUpdate = false): void {
    this.#wanted = false;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#state = 'disconnected';
    socket?.close(forUpdate ? HELPER_UPDATE_CLOSE_CODE : undefined, forUpdate ? HELPER_UPDATE_CLOSE_REASON : undefined);
  }
  send(data: string): boolean {
    if (!this.isOpen() || this.#socket?.readyState !== WebSocket.OPEN) return false;
    try { this.#socket.send(data); return true; }
    catch { return false; } // The socket's close event owns recovery.
  }
  requireUpdate(minVersion: string): void {
    if (this.#updateAnnounced) return;
    this.#updateAnnounced = true;
    this.stop(true);
    this.options.onUpdateRequired(minVersion);
  }
  #connect(): void {
    const socket = this.options.factory(this.options.url(), this.options.protocols(), {});
    this.#socket = socket;
    socket.on?.('upgrade', (response: IncomingMessage) => {
      response.socket?.setKeepAlive?.(true, this.options.timing?.keepAliveDelayMs ?? LIVE_LINK_TIMING.keepAliveDelayMs);
    });
    socket.on?.('unexpected-response', (_request: unknown, response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      // A login/version refusal ends this connection. Ordinary request
      // refusals never touch it. Consume the response before ending upgrade.
      if (status === 401 || status === 403 || status === 426) this.#wanted = false;
      let body = '';
      response.on('data', (chunk: Buffer) => { if (body.length < 1024) body += chunk.toString('utf8').slice(0, 1024 - body.length); });
      response.on('end', () => {
        if (status === 426) {
          try {
            const value = JSON.parse(body) as { error?: string; minVersion?: string };
            if (value.error === 'update_required' && typeof value.minVersion === 'string') this.requireUpdate(value.minVersion);
          } catch { /* A malformed refusal cannot authorize an install. */ }
        }
        socket.terminate();
      });
    });
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#state = 'connected';
      this.options.onOpen();
      for (const listener of [...this.#openListeners]) listener();
    };
    socket.onmessage = message => { if (this.#socket === socket) this.options.onMessage(String(message.data)); };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#state = 'disconnected';
      this.options.onClose();
      if (this.#wanted) {
        this.#reconnects++;
        queueMicrotask(() => { if (this.#wanted && !this.#socket) this.#connect(); });
      }
    };
  }
}
