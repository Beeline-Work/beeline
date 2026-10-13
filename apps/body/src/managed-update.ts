import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { withKernelLock } from './kernel-lock.js';
import {
  beelineInstallLayout,
  prepareLatestRelease,
  readInstalledBundleIdentity,
  readUpdateState,
  type BeelineInstallLayout,
} from './self-update.js';

export const UPDATE_CONVERGENCE_SLO_MS = 10 * 60_000;
export const UPDATE_DRAIN_DEADLINE_MS = 5 * 60_000;
const UPDATE_PREPARE_DEADLINE_MS = 3 * 60_000;

export function withInstallLock<T>(
  layout: BeelineInstallLayout,
  work: () => Promise<T>,
  options: { waitMs?: number; now?: () => number } = {},
): Promise<T> {
  return withKernelLock(`beeline-install:${resolve(layout.libDir)}`, work, options.waitMs);
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const left = parse(actual),
    right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  return true;
}

/** One machine-owned transaction: prepare, bounded idle handoff, successor activation and acknowledgment. */
export class ReleaseTransaction {
  #pendingCheck = false;
  #preparing: Promise<void> | undefined;
  #prepared: string | undefined;
  #minimum: string | undefined;
  #handoffAt: number | undefined;
  #deadlineAt: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #handingOff: Promise<void> | undefined;
  #notice: string | undefined;
  #completed = false;
  constructor(
    readonly options: {
      layout: BeelineInstallLayout;
      loadedRelease?: string;
      env: NodeJS.ProcessEnv;
      prepare?: () => Promise<void>;
      idle: () => boolean;
      interrupt: () => void;
      handoff: (releaseId: string, interrupted: boolean) => Promise<void>;
      changed: (desiredRelease?: string) => void;
      failed: (error: unknown, minimum?: string) => void;
      now?: () => number;
      drainMs?: number;
    },
  ) {}
  get desiredRelease(): string | undefined {
    return this.#prepared;
  }
  get pending(): Promise<void> | undefined {
    return this.#preparing ?? this.#handingOff;
  }
  notify(releaseKey?: string, minimum?: string, manual = false): void {
    if (!manual && !minimum && this.options.env.BEELINE_UPDATE_DISABLE === '1') return;
    if (releaseKey && releaseKey === this.#notice) return;
    this.#notice = releaseKey;
    if (minimum && (!this.#minimum || !versionAtLeast(this.#minimum, minimum))) {
      this.#minimum = minimum;
      this.#handoffAt = this.now();
      try {
        this.options.interrupt();
      } catch (error) {
        this.options.failed(error, minimum);
        return;
      }
    }
    this.#deadlineAt ??= this.now() + UPDATE_CONVERGENCE_SLO_MS;
    this.#pendingCheck = true;
    this.prepare();
  }
  async prepared(releaseId: string): Promise<void> {
    if (this.#minimum) {
      const identity = await readInstalledBundleIdentity({
        ...this.options.layout,
        libDir: resolve(this.options.layout.releasesRoot, releaseId),
      });
      if (!identity?.version || !versionAtLeast(identity.version, this.#minimum)) {
        this.#prepared = undefined;
        clearTimeout(this.#timer);
        throw new Error(
          `published helper ${identity?.version ?? 'unknown'} is below required ${this.#minimum}`,
        );
      }
    }
    if (releaseId === this.options.loadedRelease) {
      this.#prepared = undefined;
      this.#deadlineAt = undefined;
      this.#handoffAt = undefined;
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.options.changed(undefined);
      return;
    }
    this.#prepared = releaseId;
    this.#deadlineAt ??= this.now() + UPDATE_CONVERGENCE_SLO_MS;
    this.#handoffAt ??= Math.min(
      this.now() + (this.options.drainMs ?? UPDATE_DRAIN_DEADLINE_MS),
      this.#deadlineAt - 120_000,
    );
    this.options.changed(releaseId);
    if (!this.#timer)
      this.#timer = setTimeout(
        () => {
          this.#timer = undefined;
          void this.idleChanged();
        },
        Math.max(0, this.#handoffAt - this.now()),
      );
    await this.idleChanged();
  }
  async idleChanged(): Promise<void> {
    if (
      this.#completed ||
      !this.#prepared ||
      this.#preparing ||
      this.#pendingCheck ||
      this.#handingOff
    )
      return;
    const interrupted = this.now() >= this.#handoffAt!;
    if (!interrupted && !this.options.idle()) return;
    clearTimeout(this.#timer);
    const target = this.#prepared;
    this.#handingOff = this.options
      .handoff(target, interrupted)
      .then(() => {
        this.#completed = true;
      })
      .catch((error) => {
        this.options.failed(error, this.#minimum);
        // No second drain allowance. A later explicit event retries this same operation.
      })
      .finally(() => {
        this.#handingOff = undefined;
      });
    await this.#handingOff;
  }
  dispose(): void {
    clearTimeout(this.#timer);
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private prepare(): void {
    if (this.#preparing) return;
    this.#preparing = Promise.resolve()
      .then(async () => {
        while (this.#pendingCheck) {
          this.#pendingCheck = false;
          if (this.options.prepare) await this.options.prepare();
          else
            await prepareReleaseInWorker(
              this.options.env,
              Math.min(this.#deadlineAt!, this.now() + UPDATE_PREPARE_DEADLINE_MS),
            );
          // One read at worker completion; idle/progress events never inspect disk state.
          const target = (await readUpdateState(this.options.layout)).stagedReleaseId;
          if (!this.#pendingCheck && target) await this.prepared(target);
        }
      })
      .catch((error) => {
        this.options.failed(error, this.#minimum);
        if (!this.#prepared) this.#deadlineAt = undefined;
      })
      .finally(() => {
        this.#preparing = undefined;
        if (this.#pendingCheck) this.prepare();
        else void this.idleChanged();
      });
  }
}

/** This entry is also bundled independently from the body CLI. */
export async function runManagedUpdateWorker(): Promise<{
  releaseId: string;
  identity: { version?: string; commit?: string };
}> {
  const layout = beelineInstallLayout(process.env);
  if (!layout) throw new Error('release preparation requires an installed layout');
  return withInstallLock(layout, () =>
    prepareLatestRelease(layout, {
      env: process.env,
      force: process.env.BEELINE_FORCE_REPAIR === '1',
      deadlineAt: Number(process.env.BEELINE_PREPARE_DEADLINE_AT) || Date.now() + 180_000,
      logger: (line) => console.error(line),
    }),
  );
}

export async function prepareReleaseInWorker(
  env: NodeJS.ProcessEnv,
  deadlineAt: number,
  entrypoint?: string,
): Promise<{ releaseId: string; identity: { version?: string; commit?: string } }> {
  const layout = beelineInstallLayout(env)!;
  const bootstrap = entrypoint ?? resolve(layout.libDir, '../beeline-bootstrap.mjs');
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [bootstrap, 'managed-update-worker'], {
      detached: true,
      env: {
        ...env,
        BEELINE_INTERNAL_UPDATE_WORKER: '1',
        BEELINE_UPDATE_GROUP_OWNER: '1',
        BEELINE_PREPARE_DEADLINE_AT: String(deadlineAt),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '',
      stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-16_000);
    });
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(
      () => {
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), 1000).unref();
        reject(new Error('release prepare deadline exceeded'));
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error(`release preparation failed (${code}): ${stderr.trim()}`));
      try {
        const result = JSON.parse(stdout);
        if (!result.releaseId) throw new Error('no verified release');
        done(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
