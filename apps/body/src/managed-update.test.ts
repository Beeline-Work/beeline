import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityFromKey } from './runtime.js';
import {
  activeReleaseId,
  readUpdateState,
  readUpdateAttempt,
  settleUpdateAttemptOnStart,
  writeUpdateAttemptFixture,
  writeUpdateState,
  type BeelineInstallLayout,
} from './self-update.js';
import {
  coordinateManagedUpdateHandoff,
  DEFAULT_UPDATE_INTERVAL_MS,
  gateManagedSuccessor,
  ManagedUpdateDrain,
  ManagedUpdateHandoff,
  managedRestartStaggerMs,
  MAX_HOST_RESTART_STAGGER_MS,
  proveLoadedReleaseReady,
  rollbackFailedSuccessor,
  UPDATE_DRAIN_DEADLINE_MS,
} from './managed-update.js';
import { UpdateFunctionalProbeError } from './update-functional-probe.js';
import { updateRollbackAlertPath } from './update-rollback-alert.js';

const roots: string[] = [];
const systemdUnits: string[] = [];
const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(import.meta.url);
const functionalProof = {
  harness: 'fixture-acp',
  sandboxed: true,
  sessionStarted: true as const,
  turnCompleted: true as const,
  nativeTools: ['close_corner'] as const,
};

async function layoutFixture(): Promise<{
  root: string;
  runtimeDir: string;
  layout: BeelineInstallLayout;
}> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-managed-update-'));
  roots.push(root);
  const layout = {
    binDir: resolve(root, 'bin'),
    libDir: resolve(root, 'lib/beeline'),
    releasesRoot: resolve(root, 'lib/beeline-releases'),
  };
  for (const id of ['old', 'new']) {
    const bundle = resolve(layout.releasesRoot, id, 'lib/beeline');
    await mkdir(bundle, { recursive: true });
    await writeFile(resolve(bundle, 'beeline-cli.mjs'), '#!/usr/bin/env node\n');
    await writeFile(resolve(bundle, 'bundle.json'), JSON.stringify({ version: id }));
  }
  await mkdir(dirname(layout.libDir), { recursive: true });
  await symlink('beeline-releases/old', layout.libDir);
  const runtimeDir = resolve(root, 'runtime');
  await mkdir(runtimeDir);
  return { root, runtimeDir, layout };
}

afterEach(async () => {
  await Promise.allSettled(
    systemdUnits
      .splice(0)
      .map((unit) => execFileAsync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8' })),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed update handoff', () => {
  it('keeps a server-minimum release installed when one agent probe fails', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    await writeUpdateAttemptFixture(layout, {
      from: { version: 'v0.0.68' },
      to: { version: 'v0.0.69' },
      releaseId: 'new',
      previousReleaseId: 'old',
      appliedAt: 1_000,
      forcedMinimum: 'v0.0.69',
      requiredProbeIds: ['agent', 'other'],
      confirmedProbeIds: [],
    });
    const result = await gateManagedSuccessor({ layout, runtimeDir, loadedRelease: 'new',
      probeId: 'agent', probe: async () => { throw new Error('agent-specific model failure'); } });
    expect(result.kind).toBe('agent-failed');
    expect(await activeReleaseId(layout)).toBe('new');
    expect((await readUpdateAttempt(layout))?.unavailableProbeIds).toEqual(['agent']);
    expect(await settleUpdateAttemptOnStart(layout, { now: () => Date.now() + 1_000_000 }))
      .toEqual({ kind: 'none' });
    expect((await readUpdateAttempt(layout))?.status).toBe('confirmed');
    expect(await activeReleaseId(layout)).toBe('new');
  });
  it('spreads fifteen agents while respecting the current drain deadline', () => {
    const agents = Array.from({ length: 15 }, (_, index) => index.toString(16).padStart(64, '0'));
    const delays = agents.map((agent) =>
      managedRestartStaggerMs(agent, 'release-new', 100_000, 80_000),
    );
    expect(new Set(delays).size).toBeGreaterThan(10);
    expect(delays.every((delay) => delay >= 0 && delay <= MAX_HOST_RESTART_STAGGER_MS)).toBe(true);
    expect(managedRestartStaggerMs(agents[0]!, 'release-new', 80_001, 80_000)).toBeLessThanOrEqual(
      1,
    );
    expect(managedRestartStaggerMs(agents[0]!, 'release-new', 79_999, 80_000)).toBe(0);
    expect(managedRestartStaggerMs(agents[0]!, 'release-new', 100_000, 80_000)).toBe(delays[0]);
  });

  it('restarts when this process is still executing a previous release after the anchor moved', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    const restarts: string[] = [];
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000, {
      env: { BEELINE_LIB_DIR: resolve(layout.releasesRoot, 'old', 'lib', 'beeline') },
    });

    expect(
      await coordinateManagedUpdateHandoff(
        update,
        () => true,
        async (request) => {
          restarts.push(request.desiredRelease);
        },
      ),
    ).toBe('restarting');
    expect(restarts).toEqual(['new']);
    expect((await readUpdateAttempt(layout))?.previousReleaseId).toBe('old');
  });

  it('lets an active agent turn finish before handing over, then restarts on the next tick', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    let activeTurns = 1;
    let intakeQuiesced = false;
    const restarts: string[] = [];
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);

    expect(
      await coordinateManagedUpdateHandoff(
        update,
        () => {
          if (activeTurns > 0) return false;
          intakeQuiesced = true;
          return true;
        },
        async (request) => {
          restarts.push(request.desiredRelease);
        },
      ),
    ).toBe('waiting-for-idle');
    expect(restarts).toEqual([]);
    expect(intakeQuiesced).toBe(false);

    activeTurns = 0;
    expect(
      await coordinateManagedUpdateHandoff(
        update,
        () => {
          if (activeTurns > 0) return false;
          intakeQuiesced = true;
          return true;
        },
        async (request) => {
          restarts.push(request.desiredRelease);
        },
      ),
    ).toBe('restarting');
    expect(intakeQuiesced).toBe(true);
    expect(restarts).toEqual(['new']);
  });

  it('waits at the drain deadline while a turn is still running', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    let now = 1_000;
    const restarts: Array<[string, string]> = [];
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => now, {
      drainDeadlineMs: 50,
    });
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);

    expect(
      await coordinateManagedUpdateHandoff(
        update,
        () => false,
        async ({ desiredRelease }, mode) => {
          restarts.push([desiredRelease, mode]);
        },
      ),
    ).toBe('waiting-for-idle');
    expect(restarts).toEqual([]);

    now += 50;
    expect(
      await coordinateManagedUpdateHandoff(
        update,
        () => false,
        async ({ desiredRelease }, mode) => {
          restarts.push([desiredRelease, mode]);
        },
      ),
    ).toBe('waiting-for-idle');
    expect(restarts).toEqual([]);
  });

  it('keeps a staged release inert until the turn finishes', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    let now = 1_000;
    const restarts: string[] = [];
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => now, {
      drainDeadlineMs: 50,
    });
    await writeUpdateState(layout, { stagedReleaseId: 'new' });
    const restart = async ({ desiredRelease }: { desiredRelease: string }, mode: string) => {
      restarts.push(`${desiredRelease}:${mode}`);
    };

    expect(await coordinateManagedUpdateHandoff(update, () => false, restart)).toBe(
      'waiting-for-idle',
    );
    expect(await activeReleaseId(layout)).toBe('old');

    now += 50;
    expect(await coordinateManagedUpdateHandoff(update, () => false, restart)).toBe(
      'waiting-for-idle',
    );
    expect(restarts).toEqual([]);
    expect(await activeReleaseId(layout)).toBe('old');
    expect(await coordinateManagedUpdateHandoff(update, () => true, restart)).toBe('restarting');
    expect(restarts).toEqual(['new:drained']);
    expect(await activeReleaseId(layout)).toBe('new');
    expect((await readUpdateAttempt(layout))?.status).toBe('pending');
  });

  it('converges to the exact desired release and accepts only its READY proof', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);

    expect(await update.check()).toBe(true);
    expect((await readUpdateAttempt(layout))?.releaseId).toBe('new');
    expect(await proveLoadedReleaseReady(layout, runtimeDir, 'new')).toBe(false);
    expect(await proveLoadedReleaseReady(layout, runtimeDir, 'old', { functionalProof })).toBe(
      false,
    );
    expect(await proveLoadedReleaseReady(layout, runtimeDir, 'new', { functionalProof })).toBe(
      true,
    );
    expect((await readUpdateAttempt(layout))?.status).toBe('confirmed');
    expect(
      JSON.parse(await readFile(resolve(runtimeDir, 'daemon-ready.json'), 'utf8')),
    ).toMatchObject({
      loadedRelease: 'new',
    });
  });

  it('rolls a bad successor back exactly once', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    await update.check();

    expect(await rollbackFailedSuccessor(layout, runtimeDir)).toBe(true);
    expect(await activeReleaseId(layout)).toBe('old');
    expect(await readUpdateAttempt(layout)).toMatchObject({ releaseId: 'new', status: 'reverted' });
    expect(JSON.parse(await readFile(updateRollbackAlertPath(runtimeDir), 'utf8'))).toMatchObject({
      releaseId: 'new',
    });
    expect(await rollbackFailedSuccessor(layout)).toBe(false);
  });

  it.each([
    ['hung generated extension', 'session-start-failed'],
    ['broken sandbox', 'sandbox-unavailable'],
  ] as const)('automatically rolls back a successor with %s', async (_label, reason) => {
    const { layout, runtimeDir } = await layoutFixture();
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    await update.check();

    const result = await gateManagedSuccessor({
      layout,
      runtimeDir,
      loadedRelease: 'new',
      probeId: 'agent-1',
      probe: () =>
        Promise.reject(new UpdateFunctionalProbeError(reason, 'deliberate acceptance fault')),
    });

    expect(result).toMatchObject({ kind: 'failed', rolledBack: true });
    expect(await activeReleaseId(layout)).toBe('old');
    expect(await readUpdateAttempt(layout)).toMatchObject({
      releaseId: 'new',
      status: 'reverted',
      revertedBy: 'agent-1',
      failure: `functional update probe failed (${reason}): deliberate acceptance fault`,
    });
  });

  it('retains the machine release and flags only the unavailable-model agent', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000, {
      requiredProbeIds: ['agent-1', 'agent-2'],
    });
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    await update.check();
    const result = await gateManagedSuccessor({
      layout,
      runtimeDir,
      loadedRelease: 'new',
      probeId: 'agent-1',
      probe: () =>
        Promise.reject(new UpdateFunctionalProbeError('model-unavailable', 'chosen model gone')),
    });
    expect(result.kind).toBe('agent-unavailable');
    expect(await activeReleaseId(layout)).toBe('new');
    expect(await readUpdateAttempt(layout)).toMatchObject({
      status: 'pending',
      unavailableProbeIds: ['agent-1'],
    });
    expect(
      await proveLoadedReleaseReady(layout, runtimeDir, 'new', {
        probeId: 'agent-2',
        functionalProof,
      }),
    ).toBe(true);
    expect(await readUpdateAttempt(layout)).toMatchObject({
      status: 'confirmed',
      confirmedProbeIds: ['agent-2'],
      unavailableProbeIds: ['agent-1'],
    });
  });

  /**
   * Every daemon on the host shares one update attempt, so the first genuine
   * fault reverts it for the fleet. 2026-09-06 (v0.0.51): helpers whose own
   * probes had passed then logged `successor release 62c8fcb5 did not produce
   * functional proof`, which reads as a bad bundle. The rollback stays; the
   * sentence names the sibling that caused it.
   */
  describe('a sibling that already reverted the shared attempt', () => {
    const siblingFailure = 'functional update probe failed (turn-failed): ACP error -32603';

    it("names the sibling instead of blaming this daemon's own passing probe", async () => {
      const { layout, runtimeDir } = await layoutFixture();
      const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000, {
        requiredProbeIds: ['agent-1', 'agent-2'],
      });
      await rm(layout.libDir);
      await symlink('beeline-releases/new', layout.libDir);
      await update.check();

      const result = await gateManagedSuccessor({
        layout,
        runtimeDir,
        loadedRelease: 'new',
        probeId: 'agent-1',
        // The sibling's rollback lands while this daemon is still probing.
        probe: async () => {
          await rollbackFailedSuccessor(layout, undefined, {
            probeId: 'agent-2',
            failure: siblingFailure,
          });
          return functionalProof;
        },
      });

      expect(result).toMatchObject({ kind: 'failed', rolledBack: false });
      expect((result as { error: Error }).error.message).toBe(
        'successor release new lost its attempt while this daemon proved it: ' +
          "this daemon's own probe passed; " +
          `shared update attempt reverted by sibling agent-2: ${siblingFailure}`,
      );
      // The fleet-wide rollback stands: one sibling's genuine fault reverts all.
      expect(await activeReleaseId(layout)).toBe('old');
    });

    it('says the same when the revert landed before this daemon probed at all', async () => {
      const { layout, runtimeDir } = await layoutFixture();
      const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000, {
        requiredProbeIds: ['agent-1', 'agent-2'],
      });
      await rm(layout.libDir);
      await symlink('beeline-releases/new', layout.libDir);
      await update.check();
      await rollbackFailedSuccessor(layout, undefined, {
        probeId: 'agent-2',
        failure: siblingFailure,
      });

      const probe = vi.fn();
      const result = await gateManagedSuccessor({
        layout,
        runtimeDir,
        loadedRelease: 'new',
        probeId: 'agent-1',
        probe,
      });

      expect(probe).not.toHaveBeenCalled();
      expect((result as { error: Error }).error.message).toBe(
        'successor release new was reverted before this daemon probed it: ' +
          `shared update attempt reverted by sibling agent-2: ${siblingFailure}`,
      );
    });

    it("keeps the plain sentence when nothing reverted this daemon's attempt", async () => {
      const { layout, runtimeDir } = await layoutFixture();
      const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
      await rm(layout.libDir);
      await symlink('beeline-releases/new', layout.libDir);
      await update.check();
      // Confirmed by this same probe id already: the proof is refused, no revert.
      await proveLoadedReleaseReady(layout, runtimeDir, 'new', {
        probeId: 'agent-1',
        functionalProof,
      });

      const result = await gateManagedSuccessor({
        layout,
        runtimeDir,
        loadedRelease: 'new',
        probeId: 'agent-1',
        probe: async () => functionalProof,
      });

      expect((result as { error: Error }).error.message).toBe(
        'successor loaded release new, not the pending desired release',
      );
    });
  });

  it('keeps the journal until every required runtime proves a functional session', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    const secondRuntime = resolve(dirname(runtimeDir), 'runtime-2');
    await mkdir(secondRuntime);
    const requiredProbeIds = ['agent-1', 'agent-2'];
    const first = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000, {
      requiredProbeIds,
    });
    const second = await ManagedUpdateHandoff.create(layout, secondRuntime, () => 1_000, {
      requiredProbeIds,
    });
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    await first.check();
    await second.check();

    expect(
      await proveLoadedReleaseReady(layout, runtimeDir, 'new', {
        probeId: 'agent-1',
        functionalProof,
      }),
    ).toBe(true);
    expect(await readUpdateAttempt(layout)).toMatchObject({
      requiredProbeIds,
      confirmedProbeIds: ['agent-1'],
    });
    expect(
      await proveLoadedReleaseReady(layout, secondRuntime, 'new', {
        probeId: 'agent-2',
        functionalProof,
      }),
    ).toBe(true);
    expect((await readUpdateAttempt(layout))?.status).toBe('confirmed');
  });

  it('stages automatic updates in the locked worker and activates only after intake quiesces', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    let now = 1_000;
    let workerCalls = 0;
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => now, {
      env: { BEELINE_UPDATE_INITIAL_DELAY_MS: '50' },
      runUpdateWorker: async () => {
        workerCalls += 1;
        await writeUpdateState(layout, { stagedReleaseId: 'new' });
      },
    });

    expect(await update.check()).toBe(false);
    now += 50;
    expect(await update.check()).toBe(false);
    await vi.waitFor(() => expect(workerCalls).toBe(1));
    await vi.waitFor(async () =>
      expect(await readUpdateState(layout)).toMatchObject({ stagedReleaseId: 'new' }),
    );
    expect(workerCalls).toBe(1);
    expect(await activeReleaseId(layout)).toBe('old');
    expect(
      await coordinateManagedUpdateHandoff(
        update,
        () => false,
        async () => undefined,
      ),
    ).toBe('waiting-for-idle');
    expect(await activeReleaseId(layout)).toBe('old');
    expect(
      await coordinateManagedUpdateHandoff(
        update,
        () => true,
        async () => undefined,
      ),
    ).toBe('restarting');
    expect(await activeReleaseId(layout)).toBe('new');
    expect((await readUpdateAttempt(layout))?.releaseId).toBe('new');
  });

  it('never makes a watchdog progress tick await a slow update worker', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000, {
      env: { BEELINE_UPDATE_INITIAL_DELAY_MS: '0' },
      runUpdateWorker: () => new Promise<void>(() => undefined),
    });
    const result = await Promise.race([
      update.check(),
      new Promise<'blocked'>((resolveBlocked) => setTimeout(() => resolveBlocked('blocked'), 100)),
    ]);
    expect(result).toBe(false);
  });

  it('rechecks the published channel inside the convergence SLO by default', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    let now = 1_000;
    let workerCalls = 0;
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => now, {
      runUpdateWorker: async () => {
        workerCalls += 1;
      },
    });

    expect(DEFAULT_UPDATE_INTERVAL_MS).toBe(30_000);
    expect(await update.check()).toBe(false);
    await vi.waitFor(() => expect(workerCalls).toBe(1));
    now += DEFAULT_UPDATE_INTERVAL_MS - 1;
    expect(await update.check()).toBe(false);
    expect(workerCalls).toBe(1);
    now += 1;
    expect(await update.check()).toBe(false);
    await vi.waitFor(() => expect(workerCalls).toBe(2));
  });

  it('checks a newly announced release immediately even inside the cadence window', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    let now = 1_000;
    let workerCalls = 0;
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => now, {
      env: { BEELINE_UPDATE_INTERVAL_MS: '21600000' },
      runUpdateWorker: async () => {
        workerCalls += 1;
      },
    });
    await update.check();
    await vi.waitFor(() => expect(workerCalls).toBe(1));
    now += 1;
    await update.check();
    expect(workerCalls).toBe(1);
    update.notifyReleaseAvailable('a'.repeat(40));
    await update.check();
    await vi.waitFor(() => expect(workerCalls).toBe(2));
    expect((await readUpdateState(layout)).notifiedReleaseKey).toBe('a'.repeat(40));
    update.notifyReleaseAvailable('b'.repeat(40));
    await update.check();
    await vi.waitFor(() => expect(workerCalls).toBe(3));
  });

  it('activates an announced release on the next idle progress tick despite a six-hour initial delay', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    let now = 1_000;
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => now, {
      env: { BEELINE_UPDATE_INITIAL_DELAY_MS: '21600000', BEELINE_SYSTEMD_USER: '0' },
      runUpdateWorker: async () => {
        await writeUpdateState(layout, { stagedReleaseId: 'new', lastCheckAt: now });
      },
    });
    expect(await update.check()).toBe(false);
    expect((await readUpdateState(layout)).stagedReleaseId).toBeUndefined();
    update.notifyReleaseAvailable('v0.0.128:release-sha');
    expect(
      await coordinateManagedUpdateHandoff(
        update,
        () => true,
        async () => undefined,
      ),
    ).toBe('none');
    await vi.waitFor(async () =>
      expect((await readUpdateState(layout)).stagedReleaseId).toBe('new'),
    );
    now += 5_000; // the helper's ordinary watchdog progress interval
    expect(
      await coordinateManagedUpdateHandoff(
        update,
        () => true,
        async () => undefined,
      ),
    ).toBe('restarting');
    expect(await activeReleaseId(layout)).toBe('new');
  });
});

async function waitForSystemd(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  } while (Date.now() < deadline);
  throw new Error(`systemd condition not met within ${timeoutMs}ms`);
}

async function systemctl(...args: string[]): Promise<string> {
  return (
    await execFileAsync('systemctl', ['--user', ...args], {
      encoding: 'utf8',
    })
  ).stdout;
}

/** Deterministic clock: `now` plus timers that fire only when the test advances time. */
class FakeClock {
  now = 1_000;
  #timers = new Map<number, { at: number; callback: () => void }>();
  #nextId = 1;
  setTimer = (callback: () => void, ms: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.now + ms, callback });
    return id;
  };
  clearTimer = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };
  pending(): number {
    return this.#timers.size;
  }
  /** Advance `ms`, firing due timers in order and letting each one's async work settle. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.#timers.delete(id);
      this.now = timer.at;
      timer.callback();
      await settle();
    }
    this.now = target;
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((next) => setImmediate(next));
}

describe('managed update drain', () => {
  const MINUTE = 60_000;

  async function drainFixture(options: { activeTurns: number; drainDeadlineMs?: number }) {
    const { layout, runtimeDir } = await layoutFixture();
    const clock = new FakeClock();
    const state = { activeTurns: options.activeTurns, intakeQuiesced: false };
    const restarts: Array<{ release: string; mode: string; at: number }> = [];
    const logs: string[] = [];
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => clock.now, {
      drainDeadlineMs: options.drainDeadlineMs ?? UPDATE_DRAIN_DEADLINE_MS,
    });
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    const drain = new ManagedUpdateDrain({
      update,
      quiesceIfIdle: () => {
        if (state.activeTurns > 0) return false;
        state.intakeQuiesced = true;
        return true;
      },
      activeTurnCount: () => state.activeTurns,
      restart: async (request, mode) => {
        restarts.push({ release: request.desiredRelease, mode, at: clock.now });
      },
      now: () => clock.now,
      log: (line) => logs.push(line),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return { clock, state, restarts, logs, drain };
  }

  it('restarts an idle helper within one tick, arming no timer', async () => {
    const { clock, state, restarts, drain } = await drainFixture({ activeTurns: 0 });
    expect(await drain.tick()).toBe('restarting');
    expect(restarts).toEqual([{ release: 'new', mode: 'drained', at: 1_000 }]);
    expect(state.intakeQuiesced).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it('restarts a busy helper on the first tick after its turn ends and cancels the deadline', async () => {
    const { clock, state, restarts, logs, drain } = await drainFixture({ activeTurns: 1 });
    expect(await drain.tick()).toBe('waiting-for-idle');
    expect(restarts).toEqual([]);
    expect(logs).toEqual([
      '[thin-core] update restart waiting: 1 active turn(s); will resume after work finishes',
    ]);

    await clock.advance(2 * MINUTE);
    expect(restarts).toEqual([]);
    state.activeTurns = 0;
    expect(await drain.tick()).toBe('restarting');
    expect(restarts).toEqual([{ release: 'new', mode: 'drained', at: 1_000 + 2 * MINUTE }]);
    expect(state.intakeQuiesced).toBe(true);
    expect(logs.filter((line) => line.includes('forced'))).toEqual([]);

    // The waiting timer was disarmed with the restart: nothing fires later.
    expect(clock.pending()).toBe(0);
    await clock.advance(UPDATE_DRAIN_DEADLINE_MS);
    expect(restarts).toHaveLength(1);
    expect(await drain.tick()).toBe('restarting');
    expect(restarts).toHaveLength(1);
  });

  it('does not interrupt a stuck turn at the absolute deadline', async () => {
    const { clock, state, restarts, logs, drain } = await drainFixture({ activeTurns: 2 });
    expect(await drain.tick()).toBe('waiting-for-idle');
    const armedAt = clock.now;

    // No further core tick: elapsed time alone must never interrupt work.
    await clock.advance(UPDATE_DRAIN_DEADLINE_MS - 1);
    expect(restarts).toEqual([]);
    await clock.advance(1);
    expect(restarts).toEqual([]);
    expect(state.intakeQuiesced).toBe(false);
    state.activeTurns = 0;
    expect(await drain.tick()).toBe('restarting');
    expect(restarts).toEqual([
      { release: 'new', mode: 'drained', at: armedAt + UPDATE_DRAIN_DEADLINE_MS },
    ]);
  });

  it('logs one waiting line per minute with the current turn count', async () => {
    const { clock, state, logs, drain } = await drainFixture({ activeTurns: 1 });
    await drain.tick();
    await clock.advance(MINUTE);
    state.activeTurns = 3;
    await clock.advance(MINUTE);
    await drain.tick();
    await drain.tick();
    expect(logs).toEqual([
      '[thin-core] update restart waiting: 1 active turn(s); will resume after work finishes',
      '[thin-core] update restart waiting: 1 active turn(s); will resume after work finishes',
      '[thin-core] update restart waiting: 3 active turn(s); will resume after work finishes',
    ]);
  });
});

async function readSystemdState(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

describe.runIf(process.env.BEELINE_SYSTEMD_ACCEPTANCE === '1')(
  'managed update systemd convergence',
  () => {
    it('forces continuous work at the absolute deadline and restarts READY on the new release', async () => {
      const { root, runtimeDir, layout } = await layoutFixture();
      const stored = (name: string) => {
        const identity = identityFromKey(undefined, name);
        return {
          name,
          secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
          publicKey: identity.publicKey,
        };
      };
      const runtimePath = resolve(runtimeDir, 'runtime.json');
      await writeFile(
        runtimePath,
        JSON.stringify({
          version: 2,
          communityId: '11111111-1111-4111-8111-111111111111',
          pairedBy: 'a'.repeat(64),
          agent: stored('update-acceptance-agent'),
          body: stored('update-acceptance-body'),
          rooms: [],
          supervisorRoot: root,
          agentBinary: '/bin/true',
          mcpBinary: '/bin/true',
          createdAt: new Date(0).toISOString(),
        }),
      );
      const statePath = resolve(root, 'systemd-state.json');
      const publishedPath = resolve(root, 'published');
      const fixturePath = resolve(root, 'managed-update-systemd-fixture.mjs');
      const managedUpdateUrl = new URL('./managed-update.ts', import.meta.url).href;
      const roomRuntimeUrl = new URL('./room-runtime.ts', import.meta.url).href;
      const selfUpdateUrl = new URL('./self-update.ts', import.meta.url).href;
      const systemdUrl = new URL('./systemd.ts', import.meta.url).href;
      await writeFile(
        fixturePath,
        `import { existsSync } from 'node:fs';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ManagedUpdateHandoff, proveLoadedReleaseReady } from ${JSON.stringify(managedUpdateUrl)};
import { readUpdateAttempt } from ${JSON.stringify(selfUpdateUrl)};
import { RoomRuntimeCoordinator } from ${JSON.stringify(roomRuntimeUrl)};
import { activeReleaseId } from ${JSON.stringify(selfUpdateUrl)};
import { SystemdNotifier } from ${JSON.stringify(systemdUrl)};

const [runtimePath, statePath, publishedPath, libDir, releasesRoot, binDir] = process.argv.slice(2);
const previous = JSON.parse(await readFile(statePath, 'utf8').catch(() => '{}'));
const generation = Number(previous.generation ?? 0) + 1;
const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
const runtimeDir = dirname(runtimePath);
const layout = { libDir, releasesRoot, binDir };
const loadedRelease = await activeReleaseId(layout);
const notifier = new SystemdNotifier();

if (generation > 1) {
  const attempt = await readUpdateAttempt(layout);
  if (!attempt || attempt.releaseId !== loadedRelease) process.exit(70);
if (!(await proveLoadedReleaseReady(layout, runtimeDir, loadedRelease, { functionalProof: {
  harness: 'fixture-acp', sandboxed: true, sessionStarted: true,
  turnCompleted: true, nativeTools: ['close_corner']
} }))) process.exit(71);
  const successorReadyAt = Date.now();
  await notifier.ready('ready; loaded_release=' + loadedRelease);
  await writeFile(statePath, JSON.stringify({ ...previous, generation, loadedRelease, successorReadyAt }));
  const keepAlive = setInterval(() => {
    void notifier.progress('loaded_release=' + loadedRelease + '; healthy');
  }, 100);
  process.on('SIGTERM', () => {
    clearInterval(keepAlive);
    process.exit(0);
  });
} else {
  const update = await ManagedUpdateHandoff.create(layout, runtimeDir, Date.now, {
    env: { BEELINE_UPDATE_INITIAL_DELAY_MS: '0', BEELINE_UPDATE_INTERVAL_MS: '25' },
    drainDeadlineMs: 500,
    runUpdateWorker: async () => {
      if (!existsSync(publishedPath)) return;
      await rm(libDir);
      await symlink('beeline-releases/new', libDir);
    },
  });
  const coordinator = new RoomRuntimeCoordinator(runtime, runtimePath, {}, {
    drainDeadlineMs: 5_000,
  });
  let finishWork;
  const continuousWork = new Promise((resolveWork) => {
    finishWork = resolveWork;
  });
  let forcedAt;
  coordinator.running.set('continuous-room', {
    body: {
      forceRecoverRoom: async () => {
        forcedAt = Date.now();
        await writeFile(statePath + '.forced', String(forcedAt));
        finishWork();
      },
    },
    controller: new AbortController(),
    promise: continuousWork,
    lastPollAt: Date.now(),
    lastPresenceAt: Date.now(),
    presence: 'online',
    backoffUntil: 0,
    recovering: false,
  });
  await notifier.ready('ready; loaded_release=' + loadedRelease);
  await writeFile(statePath, JSON.stringify({ ...previous, generation, loadedRelease }));
  let checking = false;
  const poll = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (!(await update.check())) return;
      clearInterval(poll);
      const attempt = await readUpdateAttempt(layout);
      if (!attempt) process.exit(72);
      const drainDeadlineAt = Date.now() + 500;
      coordinator.setDrainDeadlineAt(drainDeadlineAt);
      const updateStatus =
        'update pending, converging; loaded_release=' + loadedRelease +
        '; desired_release=' + attempt.releaseId +
        '; intake quiesced, draining; exit_deadline=' + new Date(drainDeadlineAt).toISOString();
      await notifier.stopping(updateStatus);
      await coordinator.shutdown();
      await writeFile(statePath, JSON.stringify({
        ...previous,
        generation,
        loadedRelease,
        updateStatus,
        forcedAt,
      }));
      process.exit(0);
    } finally {
      checking = false;
    }
  }, 20);
}
`,
      );

      const unit = `beeline-update-acceptance-${process.pid}-${Math.random().toString(16).slice(2)}.service`;
      systemdUnits.push(unit);
      await execFileAsync('systemd-run', [
        '--user',
        '--quiet',
        `--unit=${unit}`,
        '--property=Type=notify',
        '--property=NotifyAccess=all',
        '--property=Restart=always',
        '--property=RestartSec=100ms',
        '--property=TimeoutStartSec=5s',
        '--property=KillMode=control-group',
        '--property=Environment=BEELINE_MANAGED_BY_SYSTEMD=1',
        process.execPath,
        '--import',
        nodeRequire.resolve('tsx'),
        fixturePath,
        runtimePath,
        statePath,
        publishedPath,
        layout.libDir,
        layout.releasesRoot,
        layout.binDir,
      ]);
      await waitForSystemd(async () => {
        const state = await readSystemdState(statePath);
        return state.generation === 1 && state.loadedRelease === 'old';
      });

      const publishedAt = Date.now();
      await writeFile(publishedPath, 'new\n');
      await waitForSystemd(async () =>
        (await systemctl('show', '-p', 'StatusText', '--value', unit)).includes(
          'update pending, converging',
        ),
      );
      await waitForSystemd(async () => {
        const state = await readSystemdState(statePath);
        return state.generation >= 2 && state.loadedRelease === 'new';
      });

      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        generation: number;
        loadedRelease: string;
        successorReadyAt: number;
      };
      const forcedAt = Number(await readFile(`${statePath}.forced`, 'utf8'));
      expect(forcedAt - publishedAt).toBeGreaterThanOrEqual(350);
      expect(state.successorReadyAt - publishedAt).toBeLessThan(5_000);
      expect(Number((await systemctl('show', '-p', 'NRestarts', '--value', unit)).trim())).toBe(1);
      expect(await systemctl('show', '-p', 'StatusText', '--value', unit)).toContain(
        'loaded_release=new',
      );
    });
  },
);
