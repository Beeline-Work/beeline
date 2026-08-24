import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeReleaseId, readPendingUpdate, type BeelineInstallLayout } from './self-update.js';
import {
  ManagedUpdateHandoff,
  proveLoadedReleaseReady,
  readUpdateHandoff,
  rollbackFailedSuccessor,
} from './managed-update.js';

const roots: string[] = [];

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed update handoff', () => {
  it('converges to the exact desired release and accepts only its READY proof', async () => {
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
    expect(await readPendingUpdate(layout)).toBeUndefined();
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
    expect(await readPendingUpdate(layout)).toBeUndefined();
    expect(await proveLoadedReleaseReady(layout, secondRuntime, 'new')).toBe(true);
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
});
