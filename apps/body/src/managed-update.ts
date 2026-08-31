import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  activeReleaseId,
  readInstalledBundleIdentity,
  readUpdateState,
  rollbackToPreviousRelease,
  SelfUpdateManager,
  readUpdateAttempt,
  replaceUpdateAttempt,
  writeUpdateAttempt,
  type BeelineInstallLayout,
  type UpdateAttemptRecord,
} from './self-update.js';
import { findAgentRuntimeConfigPaths, readRuntimeRecord, runtimeDaemonPid } from './runtime.js';
import type { UpdateFunctionalProbeResult } from './update-functional-probe.js';
import { queueUpdateRollbackAlert } from './update-rollback-alert.js';

export const UPDATE_CONVERGENCE_SLO_MS = 10 * 60_000;
export const DEFAULT_UPDATE_INTERVAL_MS = 30_000;
export const UPDATE_DRAIN_DEADLINE_MS = UPDATE_CONVERGENCE_SLO_MS - 60_000;
const UPDATE_WORKER_DEADLINE_MS = UPDATE_DRAIN_DEADLINE_MS;
// Must exceed the worker's absolute deadline: a legitimate long archive
// download must never be mistaken for a dead owner by another agent daemon.
const LOCK_STALE_MS = UPDATE_WORKER_DEADLINE_MS + 5 * 60_000;
const DEFAULT_UPDATE_INITIAL_DELAY_MS = 0;

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

/** Pull-based update handoff: called only from completed thin-core ticks. */
export class ManagedUpdateHandoff {
  readonly #layout: BeelineInstallLayout;
  readonly #loadedRelease: string | undefined;
  readonly #now: () => number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #runUpdateWorker: () => Promise<void>;
  readonly #drainDeadlineMs: number;
  readonly #requiredProbeIds: string[];
  #nextUpdateCheckAt: number;
  #updateCycleDeadlineAt: number | undefined;
  #worker: Promise<void> | undefined;
  #requested = false;
  #restartRequest: ManagedUpdateRestartRequest | undefined;

  private constructor(options: {
    layout: BeelineInstallLayout;
    runtimeDir: string;
    loadedRelease: string | undefined;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    runUpdateWorker?: () => Promise<void>;
    drainDeadlineMs?: number;
    requiredProbeIds?: string[];
  }) {
    this.#layout = options.layout;
    this.#loadedRelease = options.loadedRelease;
    this.#now = options.now ?? Date.now;
    this.#env = options.env ?? process.env;
    this.#runUpdateWorker = options.runUpdateWorker ?? runManagedUpdateWorkerProcess;
    this.#drainDeadlineMs = options.drainDeadlineMs ?? UPDATE_DRAIN_DEADLINE_MS;
    this.#requiredProbeIds = [...new Set(options.requiredProbeIds ?? [])].sort();
    this.#nextUpdateCheckAt =
      this.#now() +
      numberEnv(this.#env, 'BEELINE_UPDATE_INITIAL_DELAY_MS', DEFAULT_UPDATE_INITIAL_DELAY_MS);
  }

  static async create(
    layout: BeelineInstallLayout,
    runtimeDir: string,
    now: () => number = Date.now,
    options: {
      env?: NodeJS.ProcessEnv;
      runUpdateWorker?: () => Promise<void>;
      drainDeadlineMs?: number;
      requiredProbeIds?: string[];
    } = {},
  ): Promise<ManagedUpdateHandoff> {
    return new ManagedUpdateHandoff({
      layout,
      runtimeDir,
      loadedRelease: await activeReleaseId(layout),
      now,
      ...options,
    });
  }

  /**
   * Return true once desired-release drift is represented by the single
   * install-scoped update attempt. Restart intent itself is process-local:
   * systemd restarts from the stable anchor after any crash.
   *
   * The core calls this only after a completed progress tick. Manifest I/O,
   * archive verification, extraction, and smoke tests run in a disposable
   * process group. The parent merely serializes that worker with the install
   * lock and observes the resulting atomic anchor change.
   */
  async check(): Promise<boolean> {
    if (this.#requested || !this.#loadedRelease) return this.#requested;
    let desiredRelease = await activeReleaseId(this.#layout).catch(() => undefined);
    if (desiredRelease && desiredRelease !== this.#loadedRelease) {
      try {
        return await this.#journalDrift(desiredRelease);
      } catch (error) {
        console.error(
          `[thin-core] could not persist update handoff yet: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }

    const now = this.#now();
    if (this.#env.BEELINE_UPDATE_DISABLE === '1' || now < this.#nextUpdateCheckAt) return false;
    this.#nextUpdateCheckAt =
      now + numberEnv(this.#env, 'BEELINE_UPDATE_INTERVAL_MS', DEFAULT_UPDATE_INTERVAL_MS);
    if (!this.#worker) {
      this.#updateCycleDeadlineAt = now + this.#drainDeadlineMs;
      // Never await archive/network work from the progress callback: doing so
      // would freeze WATCHDOG ticks during a healthy but slow update. The core
      // observes the worker's atomic anchor change on a later completed tick.
      this.#worker = withInstallLock(this.#layout, async () => {
        // Another daemon may have applied the update while this one waited.
        const current = await activeReleaseId(this.#layout).catch(() => undefined);
        if (current && current !== this.#loadedRelease) return;
        // All daemons sharing this install start together. Keep the short SLO
        // cadence without making each one fetch the same manifest: the first
        // lock holder records the install-scoped check and the rest reuse it.
        const state = await readUpdateState(this.#layout);
        const interval = numberEnv(
          this.#env,
          'BEELINE_UPDATE_INTERVAL_MS',
          DEFAULT_UPDATE_INTERVAL_MS,
        );
        if (state.lastCheckAt !== undefined && now - state.lastCheckAt < interval) return;
        await this.#runUpdateWorker();
      })
        .catch((error) => {
          console.error(
            `[thin-core] update worker failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          this.#worker = undefined;
        });
    }
    return false;
  }

  async #journalDrift(desiredRelease: string): Promise<boolean> {
    const requestedAt = this.#now();
    const drainDeadlineAt = Math.min(
      requestedAt + this.#drainDeadlineMs,
      this.#updateCycleDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    await withInstallLock(this.#layout, async () => {
      const attempt = await readUpdateAttempt(this.#layout);
      if (!attempt || attempt.releaseId !== desiredRelease || attempt.status !== 'pending') {
        const from =
          (await readInstalledBundleIdentity({
            ...this.#layout,
            libDir: resolve(this.#layout.releasesRoot, this.#loadedRelease!),
          }).catch(() => undefined)) ?? {};
        const to = (await readInstalledBundleIdentity(this.#layout).catch(() => undefined)) ?? {};
        const record: UpdateAttemptRecord = {
          version: 1,
          from,
          to,
          releaseId: desiredRelease,
          previousReleaseId: this.#loadedRelease,
          appliedAt: requestedAt,
          confirmBy: requestedAt + UPDATE_CONVERGENCE_SLO_MS,
          status: 'pending',
          ...(this.#requiredProbeIds.length > 0
            ? { requiredProbeIds: this.#requiredProbeIds, confirmedProbeIds: [] }
            : {}),
        };
        await writeUpdateAttempt(this.#layout, record);
      } else if (this.#requiredProbeIds.length > 0) {
        // The disposable worker normally captures the whole live fleet, but
        // each old daemon also contributes its startup snapshot before it
        // exits. This closes discovery/env races without ever removing a
        // sibling proof requirement already written by another daemon.
        const requiredProbeIds = [
          ...new Set([...(attempt.requiredProbeIds ?? []), ...this.#requiredProbeIds]),
        ].sort();
        await replaceUpdateAttempt(this.#layout, {
          ...attempt,
          requiredProbeIds,
          confirmedProbeIds: attempt.confirmedProbeIds ?? [],
        });
      }
    });
    this.#restartRequest = {
      loadedRelease: this.#loadedRelease!,
      desiredRelease,
      drainDeadlineAt,
    };
    this.#requested = true;
    console.log(
      `[thin-core] update restart armed: loaded release ${this.#loadedRelease} -> ` +
        `${desiredRelease}; absolute drain deadline ${new Date(drainDeadlineAt).toISOString()}`,
    );
    return true;
  }

  /**
   * Resolve one handoff tick against the daemon's authoritative turn registry.
   * The staged release may already be active, but restart stays deferred while
   * accepted work is running. `quiesceIfIdle` closes intake in the same
   * synchronous transition that proves idle, so a new turn cannot race the
   * handoff. The persisted wall-clock deadline is the only override, so a
   * wedged turn cannot block convergence forever.
   */
  async restartRequest(quiesceIfIdle: () => boolean): Promise<
    | { kind: 'none' }
    | { kind: 'waiting'; request: ManagedUpdateRestartRequest }
    | {
        kind: 'restart';
        request: ManagedUpdateRestartRequest;
      }
  > {
    if (!(await this.check())) return { kind: 'none' };
    const request = this.#restartRequest;
    if (!request) throw new Error('update drift was detected without an in-memory restart request');
    if (quiesceIfIdle()) return { kind: 'restart', request };
    if (this.#now() < request.drainDeadlineAt) return { kind: 'waiting', request };
    return { kind: 'restart', request };
  }
}

/** One funnel from a completed core tick to the process handoff callback. */
export async function coordinateManagedUpdateHandoff(
  update: ManagedUpdateHandoff,
  quiesceIfIdle: () => boolean,
  restart: (request: ManagedUpdateRestartRequest) => Promise<void>,
  waiting: (request: ManagedUpdateRestartRequest) => Promise<void> = async () => undefined,
): Promise<ManagedUpdateHandoffProgress> {
  const next = await update.restartRequest(quiesceIfIdle);
  if (next.kind === 'none') return 'none';
  if (next.kind === 'waiting') {
    await waiting(next.request);
    return 'waiting-for-idle';
  }
  await restart(next.request);
  return 'restarting';
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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
    requiredProbeIds: await runningRuntimeProbeIds(process.env),
    logger: (line) => console.error(line),
  });
  await manager.checkAndApply();
  const activeRelease = await activeReleaseId(layout);
  return activeRelease ? { activeRelease } : {};
}

/** Stable agent identities whose live daemons will cross this shared install boundary. */
export async function runningRuntimeProbeIds(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const ids: string[] = [];
  for (const path of await findAgentRuntimeConfigPaths(env).catch(() => [] as string[])) {
    if (!(await runtimeDaemonPid(path).catch(() => undefined))) continue;
    const runtime = await readRuntimeRecord(path).catch(() => undefined);
    if (runtime?.agent.publicKey) ids.push(runtime.agent.publicKey);
  }
  return [...new Set(ids)].sort();
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

/** A served ACP turn is valid only for the exact pending update attempt. */
export async function proveLoadedReleaseReady(
  layout: BeelineInstallLayout,
  runtimeDir: string,
  loadedRelease: string | undefined,
  options: {
    probeId?: string;
    functionalProof?: UpdateFunctionalProbeResult;
    now?: () => number;
  } = {},
): Promise<boolean> {
  const attempt = await readUpdateAttempt(layout);
  const desiredRelease = attempt?.status === 'pending' ? attempt.releaseId : undefined;
  if (!desiredRelease || !loadedRelease || desiredRelease !== loadedRelease) return false;
  if ((await activeReleaseId(layout).catch(() => undefined)) !== loadedRelease) return false;
  if (!options.functionalProof) return false;
  const probeId = options.probeId ?? runtimeDir;
  const accepted = await withInstallLock(layout, async () => {
    if ((await activeReleaseId(layout).catch(() => undefined)) !== loadedRelease) return false;
    const current = await readUpdateAttempt(layout);
    if (!current || current.releaseId !== loadedRelease || current.status !== 'pending') return false;
    const confirmed = [...new Set([...(current.confirmedProbeIds ?? []), probeId])].sort();
    const required = current.requiredProbeIds ?? [probeId];
    await replaceUpdateAttempt(layout, {
      ...current,
      confirmedProbeIds: confirmed,
      ...(required.every((id) => confirmed.includes(id)) ? { status: 'confirmed' as const } : {}),
    });
    return true;
  });
  if (!accepted) return false;
  await writeFile(
    resolve(runtimeDir, 'daemon-ready.json'),
    `${JSON.stringify(
      {
        readyAt: (options.now ?? Date.now)(),
        loadedRelease,
        functionalProof: options.functionalProof,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return true;
}

export type ManagedSuccessorGateResult =
  | { kind: 'passed'; proof: UpdateFunctionalProbeResult }
  | { kind: 'failed'; error: unknown; rolledBack: boolean };

/** One fail-closed transaction from an update attempt to a served ACP turn. */
export async function gateManagedSuccessor(input: {
  layout: BeelineInstallLayout;
  runtimeDir: string;
  loadedRelease: string | undefined;
  probeId: string;
  probe: () => Promise<UpdateFunctionalProbeResult>;
}): Promise<ManagedSuccessorGateResult> {
  try {
    const attempt = await readUpdateAttempt(input.layout);
    const desiredRelease = attempt?.status === 'pending' ? attempt.releaseId : undefined;
    if (!desiredRelease || !input.loadedRelease || desiredRelease !== input.loadedRelease) {
      throw new Error(
        `successor loaded release ${input.loadedRelease ?? 'unknown'}, not the pending desired release`,
      );
    }
    const proof = await input.probe();
    if (
      !(await proveLoadedReleaseReady(input.layout, input.runtimeDir, input.loadedRelease, {
        probeId: input.probeId,
        functionalProof: proof,
      }))
    ) {
      throw new Error(`successor release ${input.loadedRelease} did not produce functional proof`);
    }
    return { kind: 'passed', proof };
  } catch (error) {
    return {
      kind: 'failed',
      error,
      rolledBack: await rollbackFailedSuccessor(input.layout, input.runtimeDir),
    };
  }
}

/** One rollback, without self-spawning; systemd owns the next process. */
export async function rollbackFailedSuccessor(
  layout: BeelineInstallLayout,
  runtimeDir?: string,
): Promise<boolean> {
  return withInstallLock(layout, async () => {
    const attempt = await readUpdateAttempt(layout);
    if (!attempt || attempt.status !== 'pending') return false;
    if (!attempt.previousReleaseId) {
      await replaceUpdateAttempt(layout, {
        ...attempt,
        status: 'reverted',
        failure: 'functional served-turn proof failed, but no previous release exists',
      });
      return false;
    }
    await rollbackToPreviousRelease(layout, attempt.previousReleaseId);
    await replaceUpdateAttempt(layout, {
      ...attempt,
      status: 'reverted',
      failure: 'functional served-turn proof failed before confirmation',
    });
    if (runtimeDir) await queueUpdateRollbackAlert(runtimeDir, attempt.releaseId);
    return true;
  });
}
