import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  activeReleaseId,
  clearPendingUpdate,
  confirmPendingUpdate,
  readInstalledBundleIdentity,
  readPendingUpdate,
  readUpdateState,
  rollbackToPreviousRelease,
  SelfUpdateManager,
  writePendingUpdateFixture,
  type BeelineInstallLayout,
  type PendingUpdateRecord,
} from './self-update.js';

export const UPDATE_CONVERGENCE_SLO_MS = 10 * 60_000;
export const DEFAULT_UPDATE_INTERVAL_MS = 30_000;
export const UPDATE_DRAIN_DEADLINE_MS = UPDATE_CONVERGENCE_SLO_MS - 60_000;
const UPDATE_WORKER_DEADLINE_MS = UPDATE_DRAIN_DEADLINE_MS;
// Must exceed the worker's absolute deadline: a legitimate long archive
// download must never be mistaken for a dead owner by another agent daemon.
const LOCK_STALE_MS = UPDATE_WORKER_DEADLINE_MS + 5 * 60_000;
const DEFAULT_UPDATE_INITIAL_DELAY_MS = 0;

export interface UpdateHandoffRecord {
  version: 1;
  loadedRelease: string;
  desiredRelease: string;
  requestedAt: number;
  drainDeadlineAt: number;
}

export function updateHandoffPath(runtimeDir: string): string {
  return resolve(runtimeDir, 'update-handoff.json');
}

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
  readonly #runtimeDir: string;
  readonly #loadedRelease: string | undefined;
  readonly #now: () => number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #runUpdateWorker: () => Promise<void>;
  readonly #drainDeadlineMs: number;
  #nextUpdateCheckAt: number;
  #updateCycleDeadlineAt: number | undefined;
  #worker: Promise<void> | undefined;
  #requested = false;

  private constructor(options: {
    layout: BeelineInstallLayout;
    runtimeDir: string;
    loadedRelease: string | undefined;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    runUpdateWorker?: () => Promise<void>;
    drainDeadlineMs?: number;
  }) {
    this.#layout = options.layout;
    this.#runtimeDir = options.runtimeDir;
    this.#loadedRelease = options.loadedRelease;
    this.#now = options.now ?? Date.now;
    this.#env = options.env ?? process.env;
    this.#runUpdateWorker = options.runUpdateWorker ?? runManagedUpdateWorkerProcess;
    this.#drainDeadlineMs = options.drainDeadlineMs ?? UPDATE_DRAIN_DEADLINE_MS;
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
   * Return true once desired-release drift has been durably journaled.
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
    const handoff: UpdateHandoffRecord = {
      version: 1,
      loadedRelease: this.#loadedRelease!,
      desiredRelease,
      requestedAt,
      drainDeadlineAt,
    };
    await withInstallLock(this.#layout, async () => {
      const pending = await readPendingUpdate(this.#layout);
      if (!pending || pending.releaseId !== desiredRelease) {
        const from =
          (await readInstalledBundleIdentity({
            ...this.#layout,
            libDir: resolve(this.#layout.releasesRoot, this.#loadedRelease!),
          }).catch(() => undefined)) ?? {};
        const to = (await readInstalledBundleIdentity(this.#layout).catch(() => undefined)) ?? {};
        const record: PendingUpdateRecord = {
          from,
          to,
          releaseId: desiredRelease,
          previousReleaseId: this.#loadedRelease,
          appliedAt: requestedAt,
        };
        await writePendingUpdateFixture(this.#layout, record);
      }
      await writeFile(
        updateHandoffPath(this.#runtimeDir),
        `${JSON.stringify(handoff, null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
    });
    this.#requested = true;
    console.log(
      `[thin-core] update handoff armed: loaded release ${this.#loadedRelease} -> ` +
        `${desiredRelease}; absolute drain deadline ${new Date(drainDeadlineAt).toISOString()}`,
    );
    return true;
  }
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
    // Arms the global exact-release rollback journal, but no callback is
    // supplied and the worker exits: systemd still owns every daemon restart.
    restartHandover: true,
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

/** READY is valid update proof only when the process loaded the exact desired release. */
export async function proveLoadedReleaseReady(
  layout: BeelineInstallLayout,
  runtimeDir: string,
  loadedRelease: string | undefined,
): Promise<boolean> {
  const pending = await readPendingUpdate(layout);
  const handoff = await readUpdateHandoff(runtimeDir);
  const desiredRelease = handoff?.desiredRelease ?? pending?.releaseId;
  if (!desiredRelease || !loadedRelease || desiredRelease !== loadedRelease) return false;
  await writeFile(
    resolve(runtimeDir, 'daemon-ready.json'),
    `${JSON.stringify({ readyAt: Date.now(), loadedRelease }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rm(updateHandoffPath(runtimeDir), { force: true });
  if (!pending || pending.releaseId !== loadedRelease) return true;
  return withInstallLock(layout, () => confirmPendingUpdate(layout));
}

/** One rollback, without self-spawning; systemd owns the next process. */
export async function rollbackFailedSuccessor(
  layout: BeelineInstallLayout,
  runtimeDir?: string,
): Promise<boolean> {
  return withInstallLock(layout, async () => {
    const pending = await readPendingUpdate(layout);
    if (!pending) return false;
    if (!pending.previousReleaseId) {
      await clearPendingUpdate(layout);
      return false;
    }
    await rollbackToPreviousRelease(layout, pending.previousReleaseId);
    await clearPendingUpdate(layout);
    if (runtimeDir) await rm(updateHandoffPath(runtimeDir), { force: true });
    return true;
  });
}

export async function readUpdateHandoff(
  runtimeDir: string,
): Promise<UpdateHandoffRecord | undefined> {
  try {
    return JSON.parse(await readFile(updateHandoffPath(runtimeDir), 'utf8')) as UpdateHandoffRecord;
  } catch {
    return undefined;
  }
}
