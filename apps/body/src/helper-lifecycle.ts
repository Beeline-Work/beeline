import type { EventEmitter } from 'node:events';
import { DaemonApiError } from './daemon-api-client.js';
import { isNetworkFailure } from './live-link.js';
import { ROOM_RETRY_DELAYS_MS } from './room-supervisor.js';
import {
  DAEMON_DISTRESS_EXIT_STATUS,
  DELIBERATE_REMOVAL_EXIT_STATUS,
  UNKNOWN_AGENT_EXIT_STATUS,
} from './systemd.js';

/** The final stop's ceiling, below the unit's TimeoutStopSec=90s. */
export const HELPER_HARD_STOP_MS = 80_000;

/** Why the helper process ends. Every daemon exit goes through one of these. */
export type HelperExitReason =
  | 'stopped'
  | 'restart-requested'
  | 'update'
  | 'failed'
  | 'rolled-back'
  | 'force-update-failed'
  | 'distress'
  | 'agent-removed'
  | 'unknown-agent'
  | 'no-agents';

/**
 * One code per reason. 0 and 75 are restarted by the service manager; 77, 78
 * and 79 are in RestartPreventExitStatus and wait for an operator (77), mean
 * the agent was removed (78), or name an agent with no runtime (79). The
 * machine helper exits 79 when it has no agent to host, or handed its agents
 * back to per-agent units after a rollback.
 */
export const HELPER_EXIT_CODES: Readonly<Record<HelperExitReason, 0 | 75 | 77 | 78 | 79>> = {
  stopped: 0,
  'restart-requested': 0,
  update: 0,
  failed: 75,
  'rolled-back': 75,
  'force-update-failed': 75,
  distress: DAEMON_DISTRESS_EXIT_STATUS as 77,
  'agent-removed': DELIBERATE_REMOVAL_EXIT_STATUS as 78,
  'unknown-agent': UNKNOWN_AGENT_EXIT_STATUS as 79,
  'no-agents': UNKNOWN_AGENT_EXIT_STATUS as 79,
};

/** Why intake is closing: an update waits for turns; the others cancel at once. */
export type QuiesceReason = 'update' | 'restart' | 'force-update';

export type HelperLifecycleState =
  | { kind: 'serving' }
  | { kind: 'quiescing'; reason: QuiesceReason }
  | { kind: 'stopping'; reason: HelperExitReason }
  | { kind: 'exited'; code: number };

/**
 * The helper process's own lifecycle, separate from its connection:
 *
 *   serving → quiescing(reason) → stopping (80 s hard) → exited(code)
 *
 * A managed update quiesces only when no turn runs, and waits as long as turns
 * do. `/restart` and a forced update quiesce at once and cancel work. Only the
 * final stop has a hard limit. A managed restart that fails while quiescing
 * goes back to serving, so the helper never refuses turns for good.
 */
export class HelperLifecycle {
  #state: HelperLifecycleState = { kind: 'serving' };
  #hardStop: ReturnType<typeof setTimeout> | undefined;
  readonly #exitProcess: (code: number) => void;

  constructor(
    private readonly options: {
      /** Aborting it begins the core's shutdown. */
      controller: AbortController;
      hardStopMs?: number;
      exitProcess?: (code: number) => void;
    },
  ) {
    this.#exitProcess = options.exitProcess ?? ((code) => process.exit(code));
  }

  get state(): HelperLifecycleState {
    return this.#state;
  }

  get serving(): boolean {
    return this.#state.kind === 'serving';
  }

  /** The reason the final stop was asked for, once one was. */
  get stopReason(): HelperExitReason | undefined {
    return this.#state.kind === 'stopping' ? this.#state.reason : undefined;
  }

  /**
   * Close intake. An update may only start from serving; `/restart` and a
   * forced update also take over a waiting update. Returns whether this call
   * moved the helper to quiescing.
   */
  quiesce(reason: QuiesceReason): boolean {
    const state = this.#state;
    if (state.kind === 'serving' || (state.kind === 'quiescing' && state.reason === 'update' && reason !== 'update')) {
      this.#state = { kind: 'quiescing', reason };
      return true;
    }
    return false;
  }

  /** A managed restart failed after intake closed: serve again. */
  resume(): boolean {
    if (this.#state.kind !== 'quiescing') return false;
    this.#state = { kind: 'serving' };
    return true;
  }

  /**
   * The managed update's idle gate: quiesce only while serving and only if
   * `closeIntakeIfIdle` proves no turn is running (and closes intake in the
   * same step). A busy helper stays serving, so the update waits.
   */
  quiesceUpdateIfIdle(closeIntakeIfIdle: () => boolean): boolean {
    return this.serving && closeIntakeIfIdle() && this.quiesce('update');
  }

  /** A managed restart failed after its quiesce: serve again and reopen intake. */
  resumeAfterFailedUpdate(reopenIntake: () => void): boolean {
    const state = this.#state;
    if (state.kind !== 'quiescing' || state.reason !== 'update' || !this.resume()) return false;
    reopenIntake();
    return true;
  }

  /** The final stop: abort the core, and exit no later than the hard limit. */
  stop(reason: HelperExitReason): void {
    if (this.#state.kind === 'stopping' || this.#state.kind === 'exited') return;
    this.#state = { kind: 'stopping', reason };
    this.#hardStop = setTimeout(() => {
      console.error('[thin-core] shutdown deadline reached; exiting helper');
      this.exit(reason);
    }, this.options.hardStopMs ?? HELPER_HARD_STOP_MS);
    this.#hardStop.unref?.();
    this.options.controller.abort();
  }

  /** The one exit funnel: each reason maps to exactly one code. */
  exit(reason: HelperExitReason): void {
    if (this.#state.kind === 'exited') return;
    clearTimeout(this.#hardStop);
    const code = HELPER_EXIT_CODES[reason];
    this.#state = { kind: 'exited', code };
    this.#exitProcess(code);
  }

  /** SIGTERM and SIGINT are a final stop. */
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
  const log = (reason: unknown) => console.error('[thin-core] unhandled rejection (kept running):', reason);
  emitter.on('unhandledRejection', log);
  return () => emitter.removeListener('unhandledRejection', log);
}

/** A failure the network or an overloaded server caused, which a later try can clear. */
export function isTransientServerFailure(error: unknown): boolean {
  return isNetworkFailure(error) || (error instanceof DaemonApiError && error.retryable);
}

/**
 * Whether a successor that failed before READY may be rolled back now. An
 * outage is not the release's fault, so it only counts once the pending
 * attempt's confirmation deadline has passed.
 */
export function successorRollbackAllowed(
  error: unknown,
  deadlineAt: number | undefined,
  now = Date.now(),
): boolean {
  return !isTransientServerFailure(error) || (deadlineAt !== undefined && now >= deadlineAt);
}

/**
 * Before READY, a transient server failure is not this release's fault. Wait
 * for the live socket to open again (asking the service manager for more start
 * time meanwhile) and retry on every open, plus the bounded early retries.
 * Only past `deadlineAt` — a pending update attempt's confirmation deadline —
 * does the failure escape, so a successor is never rolled back for an outage
 * before its attempt deadline.
 */
export async function retryBeforeReady<T>(
  work: () => Promise<T>,
  options: {
    onLinkOpen: (listener: () => void) => () => void;
    extendStartTimeout: (ms: number) => Promise<void>;
    deadlineAt?: number;
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
      if (options.deadlineAt !== undefined && now() >= options.deadlineAt) throw error;
      failures += 1;
      const timedRetry = ROOM_RETRY_DELAYS_MS[failures - 1];
      console.warn(
        `[thin-core] server unreachable before READY; ${
          timedRetry === undefined ? 'waiting for the live socket to open' : `retrying in ${timedRetry}ms or on open`
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
            options.deadlineAt === undefined ? Infinity : options.deadlineAt - now(),
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
