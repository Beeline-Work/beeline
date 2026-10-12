import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  activeReleaseId,
  readInstalledBundleIdentity,
  readUpdateState,
  runningReleaseId,
  SelfUpdateManager,
  activateRelease,
  writeUpdateState,
  type BeelineInstallLayout,
} from './self-update.js';
import { convergeLaunchdTrustySquireBrokerService } from './launchd.js';
import { convergeHelperServiceUnit, convergeTrustySquireBrokerService } from './systemd.js';
import { withAdapterInstallLock } from './adapter-install-lock.js';

export const UPDATE_CONVERGENCE_SLO_MS = 10 * 60_000;
// Leave time for service shutdown and successor startup within the convergence target.
export const UPDATE_DRAIN_DEADLINE_MS = 5 * 60_000;
export const MAX_HOST_RESTART_STAGGER_MS = 15_000;

/** Stable per-agent spread after intake quiesces, bounded by the handoff deadline. */
export function managedRestartStaggerMs(
  agentId: string,
  desiredRelease: string,
  drainDeadlineAt: number,
  now: number = Date.now(),
): number {
  const digest = createHash('sha256').update(agentId).update('\0').update(desiredRelease).digest();
  const spread = digest.readUInt32BE(0) % (MAX_HOST_RESTART_STAGGER_MS + 1);
  return Math.min(spread, Math.max(0, drainDeadlineAt - now));
}
const UPDATE_WORKER_DEADLINE_MS = UPDATE_CONVERGENCE_SLO_MS - 60_000;
// Must exceed the worker's absolute deadline: a legitimate long archive
// download must never be mistaken for a dead owner by another agent daemon.
const LOCK_STALE_MS = UPDATE_WORKER_DEADLINE_MS + 5 * 60_000;

export interface ManagedUpdateRestartRequest {
  loadedRelease: string;
  desiredRelease: string;
  drainDeadlineAt: number;
}

export type ManagedUpdateHandoffProgress = 'none' | 'waiting-for-idle' | 'restarting';

export async function withInstallLock<T>(
  layout: BeelineInstallLayout,
  work: () => Promise<T>,
  options: { now?: () => number; waitMs?: number } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const lock = resolve(layout.releasesRoot, '.state', 'install.lock');
  const deadline = now() + (options.waitMs ?? 10_000);
  await mkdir(dirname(lock), { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(resolve(lock, 'owner'), `${process.pid}\n${now()}\n`, 'utf8');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age =
        now() -
        (await stat(lock)
          .then((value) => value.mtimeMs)
          .catch(() => now()));
      if (age > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (now() >= deadline) throw new Error('timed out waiting for Beeline install lock');
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** A server minimum is a push, so its release install never waits for idle ticks. */
export async function forceInstallMinimum(input: {
  layout: BeelineInstallLayout;
  minVersion: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const env = input.env ?? process.env;
  return withInstallLock(input.layout, async () => {
    const active = await activeReleaseId(input.layout);
    const installed = await readInstalledBundleIdentity(input.layout);
    if (installed?.version && versionAtLeast(installed.version, input.minVersion) && active)
      return active;
    const manager = new SelfUpdateManager({
      layout: input.layout,
      env,
      isIdle: () => true,
      stageOnly: true,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    await manager.checkAndApply({ force: true });
    const state = await readUpdateState(input.layout);
    const staged = state.stagedReleaseId;
    if (!staged) throw new Error(`published helper release is below required ${input.minVersion}`);
    const target = await readInstalledBundleIdentity({
      ...input.layout,
      libDir: resolve(input.layout.releasesRoot, staged),
    });
    if (!target?.version || !versionAtLeast(target.version, input.minVersion))
      throw new Error(`published helper ${target?.version ?? 'unknown'} is below required ${input.minVersion}`);
    return withAdapterInstallLock(async () => {
      await activateRelease(input.layout, staged);
      const { stagedReleaseId: _stagedReleaseId, ...withoutStagedRelease } = state;
      await writeUpdateState(input.layout, withoutStagedRelease);
      return staged;
    }, env);
  }, { waitMs: UPDATE_CONVERGENCE_SLO_MS });
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): number[] | undefined => {
    const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
    return parts?.every(Number.isSafeInteger) ? parts : undefined;
  };
  const left = parse(actual);
  const right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return true;
}

/** Event-driven update handoff; progress ticks only observe staged work and the drain. */
export class ManagedUpdateHandoff {
  readonly #layout: BeelineInstallLayout;
  readonly #loadedRelease: string | undefined;
  readonly #now: () => number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #runUpdateWorker: () => Promise<void>;
  readonly #onWorkerSettled: (() => void) | undefined;
  readonly #drainDeadlineMs: number;
  #checkRequested = false;
  #updateCycleDeadlineAt: number | undefined;
  #worker: Promise<void> | undefined;
  #requested = false;
  #restartRequest: ManagedUpdateRestartRequest | undefined;
  #stagedReleaseId: string | undefined;
  #notifiedReleaseKey: string | undefined;

  private constructor(options: {
    layout: BeelineInstallLayout;
    loadedRelease: string | undefined;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    runUpdateWorker?: () => Promise<void>;
    onWorkerSettled?: () => void;
    drainDeadlineMs?: number;
  }) {
    this.#layout = options.layout;
    this.#loadedRelease = options.loadedRelease;
    this.#now = options.now ?? Date.now;
    this.#env = options.env ?? process.env;
    this.#runUpdateWorker = options.runUpdateWorker ?? runManagedUpdateWorkerProcess;
    this.#onWorkerSettled = options.onWorkerSettled;
    this.#drainDeadlineMs = options.drainDeadlineMs ?? UPDATE_DRAIN_DEADLINE_MS;
  }

  static async create(
    layout: BeelineInstallLayout,
    now: () => number = Date.now,
    options: {
      env?: NodeJS.ProcessEnv;
      runUpdateWorker?: () => Promise<void>;
      onWorkerSettled?: () => void;
      drainDeadlineMs?: number;
    } = {},
  ): Promise<ManagedUpdateHandoff> {
    const env = options.env ?? process.env;
    return new ManagedUpdateHandoff({
      layout,
      loadedRelease: runningReleaseId(layout, env) ?? (await activeReleaseId(layout)),
      now,
      ...options,
    });
  }

  /** The live server socket wakes this install immediately; the manifest stays authoritative. */
  notifyReleaseAvailable(releaseKey: string): void {
    if (!releaseKey || this.#notifiedReleaseKey === releaseKey) return;
    this.#notifiedReleaseKey = releaseKey;
    this.#checkRequested = true;
  }

  /** A fresh socket covers notices missed while disconnected with one manifest read. */
  reconcileOnConnect(): void {
    this.#checkRequested = true;
  }

  /**
   * Return true once the active release differs from the serving release.
   * restartRequest() also observes staged releases behind the idle gate.
   * Restart intent is process-local.
   *
   * The core calls this only after a completed progress tick. Manifest I/O,
   * archive verification, extraction, and smoke tests run in a disposable
   * process group. The parent merely serializes that worker with the install
   * lock and observes the resulting atomic anchor change.
   */
  async check(): Promise<boolean> {
    if (this.#requested || !this.#loadedRelease) return this.#requested;
    const desiredRelease = await activeReleaseId(this.#layout).catch(() => undefined);
    if (desiredRelease && desiredRelease !== this.#loadedRelease) {
      return this.#armRestart(desiredRelease);
    }

    // A newer notice arriving during a download must finish its own manifest
    // check before we arm the drain for the previously staged bundle.
    if (this.#worker) return false;
    if (this.#env.BEELINE_UPDATE_DISABLE !== '1' && this.#checkRequested) {
      this.#checkRequested = false;
      const now = this.#now();
      const notifiedReleaseKey = this.#notifiedReleaseKey;
      this.#updateCycleDeadlineAt = now + this.#drainDeadlineMs;
      this.#worker = withInstallLock(this.#layout, async () => {
        const current = await activeReleaseId(this.#layout).catch(() => undefined);
        if (current && current !== this.#loadedRelease) return;
        await this.#runUpdateWorker();
        if (notifiedReleaseKey) {
          await writeUpdateState(this.#layout, {
            ...(await readUpdateState(this.#layout)),
            notifiedReleaseKey,
          });
        }
      })
        .catch((error) => {
          console.error(
            `[thin-core] update worker failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          this.#worker = undefined;
          this.#onWorkerSettled?.();
        });
      return false;
    }
    if (this.#stagedReleaseId) return false;

    const state = await readUpdateState(this.#layout);
    if (state.stagedReleaseId && state.stagedReleaseId !== this.#loadedRelease) {
      const requestedAt = this.#now();
      this.#stagedReleaseId = state.stagedReleaseId;
      this.#restartRequest = {
        loadedRelease: this.#loadedRelease,
        desiredRelease: state.stagedReleaseId,
        drainDeadlineAt: requestedAt + this.#drainDeadlineMs,
      };
      console.log(
        `[thin-core] staged update ${state.stagedReleaseId} is waiting for active turns to drain`,
      );
      // `check()` retains its historical meaning: true means the stable anchor
      // already drifted. The staged state is
      // consumed only by restartRequest(), which owns the idle/quiesce gate.
      return false;
    }

    return false;
  }

  #armRestart(desiredRelease: string): boolean {
    const requestedAt = this.#now();
    const drainDeadlineAt = Math.min(
      requestedAt + this.#drainDeadlineMs,
      this.#updateCycleDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    this.#restartRequest = {
      loadedRelease: this.#loadedRelease!,
      desiredRelease,
      drainDeadlineAt,
    };
    this.#requested = true;
    console.log(
      `[thin-core] update restart armed: loaded release ${this.#loadedRelease} -> ` +
        `${desiredRelease}; drain target ${new Date(drainDeadlineAt).toISOString()}`,
    );
    return true;
  }

  /**
   * Resolve one handoff tick against the daemon's authoritative turn registry.
   * The coordinator keeps intake open until a quiet gap or the bounded
   * drain deadline before activating a staged release.
   */
  async restartRequest(readyToRestart: (request: ManagedUpdateRestartRequest, deadlineReached: boolean) => boolean): Promise<
    | { kind: 'none' }
    | { kind: 'waiting'; request: ManagedUpdateRestartRequest }
    | {
        kind: 'restart';
        mode: ManagedUpdateRestartMode;
        request: ManagedUpdateRestartRequest;
      }
  > {
    const activeDrift = await this.check();
    if (!activeDrift && !this.#stagedReleaseId) return { kind: 'none' };
    const request = this.#restartRequest;
    if (!request) throw new Error('update drift was detected without an in-memory restart request');
    const deadlineReached = this.#now() >= request.drainDeadlineAt;
    if (!readyToRestart(request, deadlineReached)) {
      return { kind: 'waiting', request };
    }
    if (this.#stagedReleaseId) {
      const stagedReleaseId = this.#stagedReleaseId;
      await withInstallLock(this.#layout, async () => {
        const active = await activeReleaseId(this.#layout);
        if (active === this.#loadedRelease) {
          await activateRelease(this.#layout, stagedReleaseId);
        } else if (active !== stagedReleaseId) {
          throw new Error(
            `staged release ${stagedReleaseId} lost activation race to ${active ?? 'unknown'}`,
          );
        }
        const state = await readUpdateState(this.#layout);
        const { stagedReleaseId: _stagedReleaseId, ...withoutStagedRelease } = state;
        await writeUpdateState(this.#layout, withoutStagedRelease);
      });
      // The activation just installed a new bundle; converge the host elector
      // onto it from this, the first process running the new launcher. The
      // elector unit is not touched by the swap itself, so a pre-#1653 host
      // would otherwise keep its PATH-less unit. Best-effort.
      if (process.platform === 'linux' && this.#env.BEELINE_SYSTEMD_USER !== '0') {
        await convergeTrustySquireBrokerService({
          libDir: this.#layout.libDir,
          env: this.#env,
          log: (line) => console.log(line),
        });
        // Carry a changed helper unit onto a host that installed an older
        // one; the restart below applies it.
        await convergeHelperServiceUnit({
          libDir: this.#layout.libDir,
          env: this.#env,
          log: (line) => console.log(line),
        });
      } else if (process.platform === 'darwin' && this.#env.BEELINE_LAUNCHD_USER !== '0') {
        await convergeLaunchdTrustySquireBrokerService({
          libDir: this.#layout.libDir,
          env: this.#env,
          log: (line) => console.log(line),
        });
      }
      this.#stagedReleaseId = undefined;
      // Activation must not grant another drain window if the restart fails.
      this.#requested = true;
      this.#restartRequest = request;
    }
    return { kind: 'restart', mode: deadlineReached ? 'interrupted' : 'drained', request: this.#restartRequest ?? request };
  }
}

export type ManagedUpdateRestartMode = 'drained' | 'interrupted';

/** One funnel from a completed core tick to the process handoff callback. */
export async function coordinateManagedUpdateHandoff(
  update: ManagedUpdateHandoff,
  readyToRestart: (request: ManagedUpdateRestartRequest, deadlineReached: boolean) => boolean,
  restart: (request: ManagedUpdateRestartRequest, mode: ManagedUpdateRestartMode) => Promise<void>,
  waiting: (request: ManagedUpdateRestartRequest) => Promise<void> = async () => undefined,
): Promise<ManagedUpdateHandoffProgress> {
  const next = await update.restartRequest(readyToRestart);
  if (next.kind === 'none') return 'none';
  if (next.kind === 'waiting') {
    await waiting(next.request);
    return 'waiting-for-idle';
  }
  await restart(next.request, next.mode ?? 'drained');
  return 'restarting';
}

export const UPDATE_DRAIN_WAIT_LOG_INTERVAL_MS = 60_000;

export interface ManagedUpdateDrainOptions {
  update: ManagedUpdateHandoff;
  /** Close intake atomically; the deadline permits interrupting active turns. */
  quiesce: (deadlineReached: boolean) => boolean;
  activeTurnCount: () => number;
  /** Exits after a quiet gap, or journals interrupted work at the deadline. */
  restart: (request: ManagedUpdateRestartRequest, mode: ManagedUpdateRestartMode) => Promise<void>;
  /** Progress report while a turn keeps the armed restart waiting (sd_notify STATUS). */
  waiting?: (request: ManagedUpdateRestartRequest) => Promise<void>;
  /** Restore serving when a timer-driven activation/restart fails. */
  failed?: (error: unknown) => void;
  log?: (line: string) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * Each completed core tick calls `tick()`. Busy helpers keep intake open for
 * at most the drain window. The timer also enforces the deadline if no core
 * tick arrives, then the successor reclaims interrupted work.
 */
export class ManagedUpdateDrain {
  readonly #options: ManagedUpdateDrainOptions;
  readonly #log: (line: string) => void;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #waitLogTimer: unknown;
  #resolving: Promise<ManagedUpdateHandoffProgress> | undefined;
  #rerunRequested = false;
  #restarting = false;

  constructor(options: ManagedUpdateDrainOptions) {
    this.#options = options;
    this.#log = options.log ?? ((line) => console.log(line));
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Called from every completed core progress tick. */
  tick(): Promise<ManagedUpdateHandoffProgress> {
    return this.#resolve();
  }

  #resolve(): Promise<ManagedUpdateHandoffProgress> {
    if (this.#restarting) return Promise.resolve('restarting');
    if (this.#resolving) {
      this.#rerunRequested = true;
      return this.#resolving;
    }
    this.#resolving = this.#step().finally(() => {
      this.#resolving = undefined;
      if (this.#rerunRequested) {
        this.#rerunRequested = false;
        void this.#resolve().catch((error) => {
          if (this.#options.failed) this.#options.failed(error);
          else this.#log(`[thin-core] update drain failed: ${String(error)}`);
        });
      }
    });
    return this.#resolving;
  }

  async #step(): Promise<ManagedUpdateHandoffProgress> {
    const { update, quiesce, activeTurnCount } = this.#options;
    let armed: ManagedUpdateRestartRequest | undefined;
    const progress = await coordinateManagedUpdateHandoff(
      update,
      (_request, deadlineReached) => (activeTurnCount() === 0 || deadlineReached) && quiesce(deadlineReached),
      async (request, mode) => {
        this.#disarm();
        await this.#options.restart(request, mode);
        // Latched only once the process is on its way out; a failed restart
        // attempt leaves the next tick free to try again.
        this.#restarting = true;
      },
      async (request) => {
        armed = request;
        await this.#options.waiting?.(request);
      },
    );
    if (armed && !this.#waitLogTimer) this.#arm(armed);
    return progress;
  }

  #arm(request: ManagedUpdateRestartRequest): void {
    this.#logWaiting();
    this.#scheduleWaitLog(request);
  }

  #scheduleWaitLog(request: ManagedUpdateRestartRequest): void {
    this.#waitLogTimer = this.#setTimer(() => {
      this.#waitLogTimer = undefined;
      if (this.#restarting) return;
      void this.#resolve().catch((error) => {
        if (this.#options.failed) this.#options.failed(error);
        else this.#log(`[thin-core] update drain failed: ${String(error)}`);
        if (!this.#restarting && this.#waitLogTimer === undefined) this.#scheduleWaitLog(request);
      });
    }, Math.min(UPDATE_DRAIN_WAIT_LOG_INTERVAL_MS, updateWaitMs(this.#options, request)));
  }

  #logWaiting(): void {
    this.#log(
      `[thin-core] update restart waiting: ${this.#options.activeTurnCount()} active turn(s); ` +
        'intake open; waiting for a quiet gap',
    );
  }

  #disarm(): void {
    if (this.#waitLogTimer !== undefined) this.#clearTimer(this.#waitLogTimer);
    this.#waitLogTimer = undefined;
  }
}

function updateWaitMs(options: ManagedUpdateDrainOptions, request: ManagedUpdateRestartRequest): number {
  const remaining = request.drainDeadlineAt - (options.now ?? Date.now)();
  return remaining > 0 ? remaining : UPDATE_DRAIN_WAIT_LOG_INTERVAL_MS;
}

/**
 * Internal update worker entrypoint. All output on stdout is one JSON result;
 * diagnostics stay on stderr so the thin core can parse the result exactly.
 */
export async function runManagedUpdateWorker(): Promise<{ activeRelease?: string }> {
  const { beelineInstallLayout } = await import('./self-update.js');
  const layout = beelineInstallLayout(process.env);
  if (!layout) throw new Error('managed update worker requires an installed bundle layout');
  const manager = new SelfUpdateManager({
    layout,
    env: process.env,
    isIdle: () => true,
    stageOnly: true,
    logger: (line) => console.error(line),
  });
  await manager.checkAndApply();
  const activeRelease = await activeReleaseId(layout);
  return activeRelease ? { activeRelease } : {};
}

/** Spawn the update worker as a killable process group with an absolute deadline. */
async function runManagedUpdateWorkerProcess(): Promise<void> {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('cannot resolve the current Beeline entrypoint');
  await new Promise<void>((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, [entrypoint, 'managed-update-worker'], {
      detached: true,
      env: { ...process.env, BEELINE_INTERNAL_UPDATE_WORKER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-16_000);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) rejectWorker(error);
      else resolveWorker();
    };
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        child.kill(signal);
      }
    };
    const deadline = setTimeout(() => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 1_000).unref?.();
      finish(new Error(`update worker exceeded ${UPDATE_WORKER_DEADLINE_MS}ms deadline`));
    }, UPDATE_WORKER_DEADLINE_MS);
    deadline.unref?.();
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(
            `update worker exited ${code ?? signal ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        );
        return;
      }
      try {
        JSON.parse(stdout) as { activeRelease?: string };
        finish();
      } catch {
        finish(new Error(`update worker returned invalid JSON: ${stdout.slice(-500)}`));
      }
    });
  });
}
