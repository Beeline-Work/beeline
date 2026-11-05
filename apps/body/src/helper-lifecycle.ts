import { captureHelperError } from './sentry.js';
import type { EventEmitter } from 'node:events';
export type HelperExitReason = 'stopped' | 'update' | 'failed';
export const HELPER_EXIT_CODES: Readonly<Record<HelperExitReason, 0 | 75>> = {
  stopped: 0,
  update: 0,
  failed: 75,
};
export type AgentExitReason = HelperExitReason | 'agent-removed';
export type QuiesceReason = 'update' | 'force-update';
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
  #exited = false;
  constructor(
    private readonly options: {
      controller: AbortController;
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
    this.options.controller.abort();
  }
  exit(reason: HelperExitReason): void {
    if (this.#exited) return;
    this.#exited = true;
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
  const log = (reason: unknown) => {
    captureHelperError(reason);
    console.error('[thin-core] unhandled rejection (kept running):', reason);
  };
  emitter.on('unhandledRejection', log);
  return () => emitter.removeListener('unhandledRejection', log);
}
