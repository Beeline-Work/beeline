import type { EventEmitter } from 'node:events';
import { DaemonApiError } from './daemon-api-client.js';
import { isNetworkFailure } from './live-link.js';
import { ROOM_RETRY_DELAYS_MS } from './room-supervisor.js';
/** The process exits before the native manager's common 90-second ceiling. */
export const HELPER_HARD_STOP_MS = 80_000;
export type HelperExitReason = 'stopped' | 'update' | 'failed';
export const HELPER_EXIT_CODES: Readonly<Record<HelperExitReason, 0 | 75>> = {
  stopped: 0,
  update: 0,
  failed: 75,
};
export type AgentExitReason = HelperExitReason | 'restart-requested' | 'agent-removed';
export type QuiesceReason = 'update' | 'restart' | 'force-update';
export type HelperLifecycleState =
  { kind: 'starting' } | { kind: 'serving' } | { kind: 'stopping'; reason: HelperExitReason };

/** Cancellation and intake closure for one hosted agent never control process exit. */
export class AgentLifecycle {
  #quiesced: QuiesceReason | undefined;
  #reason: AgentExitReason | undefined;
  constructor(private readonly options: { controller: AbortController }) {}
  get serving(): boolean {
    return !this.#quiesced && !this.options.controller.signal.aborted;
  }
  get state():
    | { kind: 'serving' }
    | { kind: 'quiescing'; reason: QuiesceReason }
    | { kind: 'stopping'; reason: AgentExitReason } {
    return this.#reason
      ? { kind: 'stopping', reason: this.#reason }
      : this.#quiesced
        ? { kind: 'quiescing', reason: this.#quiesced }
        : { kind: 'serving' };
  }
  get stopReason(): AgentExitReason | undefined {
    return this.#reason;
  }
  quiesce(reason: QuiesceReason): boolean {
    if (!this.serving && !(this.#quiesced === 'update' && reason !== 'update')) return false;
    this.#quiesced = reason;
    return true;
  }
  resume(): boolean {
    if (this.#reason || !this.#quiesced) return false;
    this.#quiesced = undefined;
    return true;
  }
  quiesceUpdateIfIdle(close: () => boolean): boolean {
    return this.serving && close() && this.quiesce('update');
  }
  resumeAfterFailedUpdate(reopen: () => void): boolean {
    if (this.#quiesced !== 'update' || !this.resume()) return false;
    reopen();
    return true;
  }
  stop(reason: AgentExitReason): void {
    this.#reason ??= reason;
    this.options.controller.abort();
  }
}

/** Only the native service manager decides whether an exited helper restarts. */
export class HelperLifecycle {
  #state: HelperLifecycleState = { kind: 'starting' };
  #hardStop: ReturnType<typeof setTimeout> | undefined;
  #exited = false;
  constructor(
    private readonly options: {
      controller: AbortController;
      hardStopMs?: number;
      exitProcess?: (code: number) => void;
    },
  ) {}
  get state(): HelperLifecycleState {
    return this.#state;
  }
  get serving(): boolean {
    return this.#state.kind === 'serving';
  }
  get stopReason(): HelperExitReason | undefined {
    return this.#state.kind === 'stopping' ? this.#state.reason : undefined;
  }
  beginServing(): void {
    if (this.#state.kind === 'starting') this.#state = { kind: 'serving' };
  }
  stop(reason: HelperExitReason): void {
    if (this.#state.kind === 'stopping') return;
    this.#state = { kind: 'stopping', reason };
    this.#hardStop = setTimeout(
      () => this.exit(reason),
      this.options.hardStopMs ?? HELPER_HARD_STOP_MS,
    );
    this.#hardStop.unref?.();
    this.options.controller.abort();
  }
  exit(reason: HelperExitReason): void {
    if (this.#exited) return;
    this.#exited = true;
    clearTimeout(this.#hardStop);
    (this.options.exitProcess ?? process.exit)(HELPER_EXIT_CODES[reason]);
  }
  installSignals(emitter: EventEmitter = process): () => void {
    const stop = () => this.stop('stopped');
    emitter.once('SIGINT', stop);
    emitter.once('SIGTERM', stop);
    return () => {
      emitter.removeListener('SIGINT', stop);
      emitter.removeListener('SIGTERM', stop);
    };
  }
}

/**
 * Log an unhandled rejection and keep serving. A stray promise (a watchdog
 * feed, a fire-and-forget wake) must not take every Room down with it.
 */
export function installUnhandledRejectionGuard(emitter: EventEmitter = process): () => void {
  const log = (reason: unknown) =>
    console.error('[thin-core] unhandled rejection (kept running):', reason);
  emitter.on('unhandledRejection', log);
  return () => emitter.removeListener('unhandledRejection', log);
}

/** A failure the network or an overloaded server caused, which a later try can clear. */
export function isTransientServerFailure(error: unknown): boolean {
  return isNetworkFailure(error) || (error instanceof DaemonApiError && error.retryable);
}

/**
 * Before READY, a transient server failure is not this release's fault. Wait
 * for the live socket to open again (asking the service manager for more start
 * time meanwhile) and retry on every open, plus the bounded early retries.
 * Network failures retry until recovery or shutdown.
 */
export async function retryBeforeReady<T>(
  work: () => Promise<T>,
  options: {
    onLinkOpen: (listener: () => void) => () => void;
    extendStartTimeout: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    now?: () => number;
    /** How much start time each extension asks for while waiting. */
    waitSliceMs?: number;
  },
): Promise<T> {
  const now = options.now ?? Date.now;
  const slice = options.waitSliceMs ?? 60_000;
  let failures = 0;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      if (!isTransientServerFailure(error) || options.signal?.aborted) throw error;
      failures += 1;
      const timedRetry = ROOM_RETRY_DELAYS_MS[failures - 1];
      console.warn(
        `[thin-core] server unreachable before READY; ${
          timedRetry === undefined
            ? 'waiting for the live socket to open'
            : `retrying in ${timedRetry}ms or on open`
        }:`,
        error,
      );
      let opened = false;
      let wake = () => undefined as void;
      const off = options.onLinkOpen(() => {
        opened = true;
        wake();
      });
      try {
        const waitStarted = now();
        while (!opened && !options.signal?.aborted) {
          const remaining = [
            slice,
            timedRetry === undefined ? Infinity : timedRetry - (now() - waitStarted),
          ];
          const wait = Math.min(...remaining);
          if (wait <= 0) break;
          await options.extendStartTimeout(wait + 15_000);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, wait);
            function done() {
              clearTimeout(timer);
              options.signal?.removeEventListener('abort', done);
              resolve();
            }
            wake = done;
            options.signal?.addEventListener('abort', done, { once: true });
            if (opened || options.signal?.aborted) done();
          });
        }
      } finally {
        off();
      }
    }
  }
}
