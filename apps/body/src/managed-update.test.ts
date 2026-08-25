import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { newIdentity } from '@beeline/gate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeReleaseId, readPendingUpdate, type BeelineInstallLayout } from './self-update.js';
import {
  confirmDaemonHealthy,
  DEFAULT_UPDATE_INTERVAL_MS,
  ManagedUpdateHandoff,
  proveLoadedReleaseReady,
  readUpdateHandoff,
  rollbackFailedSuccessor,
  supervisePendingUpdateHealth,
} from './managed-update.js';

const roots: string[] = [];
const systemdUnits: string[] = [];
const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(import.meta.url);

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
  it('converges to the exact desired release but keeps rollback armed until SERVE proof', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);

    expect(await update.check()).toBe(true);
    expect(await readUpdateHandoff(runtimeDir)).toMatchObject({
      loadedRelease: 'old',
      desiredRelease: 'new',
    });
    expect((await readPendingUpdate(layout))?.releaseId).toBe('new');
    expect(await proveLoadedReleaseReady(layout, runtimeDir, 'old')).toBe(false);
    expect(await proveLoadedReleaseReady(layout, runtimeDir, 'new')).toBe(true);
    expect(await readPendingUpdate(layout)).toBeDefined();
    expect(
      await confirmDaemonHealthy(layout, runtimeDir, 'new', {
        kind: 'room-local-ready',
        roomId: 'room-1',
      }),
    ).toBe(true);
    expect(await readPendingUpdate(layout)).toBeUndefined();
    expect(
      JSON.parse(await readFile(resolve(runtimeDir, 'daemon-ready.json'), 'utf8')),
    ).toMatchObject({
      loadedRelease: 'new',
      serveProof: { kind: 'room-local-ready', roomId: 'room-1' },
    });
  });

  it('rolls back a booted successor that never proves it can serve, then refuses to ping-pong', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    await update.check();
    expect(await proveLoadedReleaseReady(layout, runtimeDir, 'new')).toBe(true);

    const neverServes = new Promise<never>(() => undefined);
    await expect(
      supervisePendingUpdateHealth(layout, runtimeDir, 'new', neverServes, Date.now() + 10),
    ).resolves.toMatchObject({ kind: 'rolled-back' });
    expect(await activeReleaseId(layout)).toBe('old');
    expect(await readPendingUpdate(layout)).toBeUndefined();

    await expect(
      supervisePendingUpdateHealth(layout, runtimeDir, 'old', neverServes, Date.now() + 10),
    ).resolves.toMatchObject({ kind: 'rollback-unavailable' });
    expect(await activeReleaseId(layout)).toBe('old');
  });

  it.each([
    { serveProof: { kind: 'room-served', roomId: 'room-1' } as const, label: 'a served Room' },
    {
      serveProof: { kind: 'room-local-ready', roomId: 'room-1' } as const,
      label: 'a local Room during relay outage',
    },
    { serveProof: { kind: 'no-rooms' } as const, label: 'an explicit zero-Room state' },
  ])('confirms normally from $label', async ({ serveProof }) => {
    const { layout, runtimeDir } = await layoutFixture();
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    await update.check();
    expect(await proveLoadedReleaseReady(layout, runtimeDir, 'new')).toBe(true);

    await expect(
      supervisePendingUpdateHealth(
        layout,
        runtimeDir,
        'new',
        Promise.resolve(serveProof),
        Date.now() + 1_000,
      ),
    ).resolves.toMatchObject({ kind: 'confirmed', proof: serveProof });
    expect(await activeReleaseId(layout)).toBe('new');
    expect(await readPendingUpdate(layout)).toBeUndefined();
  });

  it('rolls a bad successor back exactly once', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    await update.check();

    expect(await rollbackFailedSuccessor(layout, runtimeDir)).toBe(true);
    expect(await activeReleaseId(layout)).toBe('old');
    expect(await rollbackFailedSuccessor(layout)).toBe(false);
    expect(await readUpdateHandoff(runtimeDir)).toBeUndefined();
  });

  it('accepts each instance exact-release proof after another instance cleared the global journal', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    const secondRuntime = resolve(dirname(runtimeDir), 'runtime-2');
    await mkdir(secondRuntime);
    const first = await ManagedUpdateHandoff.create(layout, runtimeDir, () => 1_000);
    const second = await ManagedUpdateHandoff.create(layout, secondRuntime, () => 1_000);
    await rm(layout.libDir);
    await symlink('beeline-releases/new', layout.libDir);
    await first.check();
    await second.check();

    expect(await proveLoadedReleaseReady(layout, runtimeDir, 'new')).toBe(true);
    expect(await confirmDaemonHealthy(layout, runtimeDir, 'new', { kind: 'no-rooms' })).toBe(true);
    expect(await readPendingUpdate(layout)).toBeUndefined();
    expect(await proveLoadedReleaseReady(layout, secondRuntime, 'new')).toBe(true);
    expect(await confirmDaemonHealthy(layout, secondRuntime, 'new', { kind: 'no-rooms' })).toBe(
      true,
    );
    expect(await readUpdateHandoff(secondRuntime)).toBeUndefined();
  });

  it('stages automatic updates in the locked disposable worker before handoff', async () => {
    const { layout, runtimeDir } = await layoutFixture();
    let now = 1_000;
    let workerCalls = 0;
    const update = await ManagedUpdateHandoff.create(layout, runtimeDir, () => now, {
      env: { BEELINE_UPDATE_INITIAL_DELAY_MS: '50' },
      runUpdateWorker: async () => {
        workerCalls += 1;
        await rm(layout.libDir);
        await symlink('beeline-releases/new', layout.libDir);
      },
    });

    expect(await update.check()).toBe(false);
    now += 50;
    expect(await update.check()).toBe(false);
    await vi.waitFor(() => expect(workerCalls).toBe(1));
    await vi.waitFor(async () => expect(await update.check()).toBe(true));
    expect(workerCalls).toBe(1);
    expect(await readUpdateHandoff(runtimeDir)).toMatchObject({
      loadedRelease: 'old',
      desiredRelease: 'new',
    });
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
        const identity = newIdentity(name);
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
          relayBaseUrl: 'http://relay.invalid',
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
import { ManagedUpdateHandoff, confirmDaemonHealthy, proveLoadedReleaseReady, readUpdateHandoff } from ${JSON.stringify(managedUpdateUrl)};
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
  const handoff = await readUpdateHandoff(runtimeDir);
  if (!handoff || handoff.desiredRelease !== loadedRelease) process.exit(70);
  if (!(await proveLoadedReleaseReady(layout, runtimeDir, loadedRelease))) process.exit(71);
  if (!(await confirmDaemonHealthy(layout, runtimeDir, loadedRelease, { kind: 'no-rooms' }))) process.exit(73);
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
      const handoff = await readUpdateHandoff(runtimeDir);
      if (!handoff) process.exit(72);
      coordinator.setDrainDeadlineAt(handoff.drainDeadlineAt);
      const updateStatus =
        'update pending, converging; loaded_release=' + loadedRelease +
        '; desired_release=' + handoff.desiredRelease +
        '; intake quiesced, draining; exit_deadline=' + new Date(handoff.drainDeadlineAt).toISOString();
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
