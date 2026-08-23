import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, createReadStream } from 'node:fs';
import { lstat, mkdtemp as mkdtempFs, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  SelfUpdateManager,
  activateRelease,
  activeReleaseId,
  archiveUrlFor,
  beelineInstallLayout,
  confirmPendingUpdate,
  hostPlatformKey,
  readInstalledBundleIdentity,
  readPendingUpdate,
  readUpdateState,
  relaunchPreviousReleaseAfterFailedUpdate,
  rollbackToPreviousRelease,
  settlePendingUpdateOnStart,
  stageRelease,
  writePendingUpdateFixture,
  type BeelineInstallLayout,
} from './self-update.js';
import {
  compareBundleIdentity,
  compareVersions,
  parseUpdateManifest,
} from './self-update-manifest.js';

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const created = await mkdtempFs(join(tmpdir(), `${prefix}-`));
  tempDirs.push(created);
  return created;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Version + identity comparison
// ---------------------------------------------------------------------------

describe('version comparison', () => {
  it('orders dotted numeric versions', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('2026.02.05', '2026.02.04')).toBeGreaterThan(0);
    expect(compareVersions('2.0', '2.0')).toBe(0);
  });
});

describe('bundle identity comparison', () => {
  const published = (identity: { commit?: string; version?: string }) => ({
    file: 'beeline-linux-x64.tar.gz',
    sha256: 'a'.repeat(64),
    ...identity,
  });

  it('treats a different source commit as an update (the publisher rolls from main)', () => {
    expect(
      compareBundleIdentity({ commit: 'aaa' }, published({ commit: 'bbb' })).kind,
    ).toBe('update-available');
    expect(compareBundleIdentity({ commit: 'aaa' }, published({ commit: 'aaa' })).kind).toBe('current');
  });

  it('falls back to comparable versions when commits are absent', () => {
    expect(compareBundleIdentity({ version: '1.0.0' }, published({ version: '1.1.0' })).kind).toBe('update-available');
    expect(compareBundleIdentity({ version: '2.0.0' }, published({ version: '1.9.0' })).kind).toBe('current');
  });

  it('is deliberately indeterminate when neither side can be named', () => {
    expect(compareBundleIdentity(undefined, published({})).kind).toBe('indeterminate');
    expect(compareBundleIdentity({}, published({})).kind).toBe('indeterminate');
  });
});

// ---------------------------------------------------------------------------
// Manifest seam
// ---------------------------------------------------------------------------

describe('manifest parsing', () => {
  it('maps the published shape onto the internal one (top-level or per-bundle identity)', () => {
    const parsed = parseUpdateManifest(
      JSON.stringify({
        schemaVersion: 1,
        sourceCommit: 'abc123',
        version: '2026.02.05',
        bundles: {
          [hostPlatformKey()]: {
            file: 'beeline-linux-x64.tar.gz',
            sha256: 'A'.repeat(64),
            bytes: 10,
          },
        },
      }),
      hostPlatformKey(),
    );
    expect(parsed.bundle.commit).toBe('abc123');
    expect(parsed.bundle.version).toBe('2026.02.05');
    expect(parsed.bundle.sha256).toBe('a'.repeat(64));

    const perBundle = parseUpdateManifest(
      JSON.stringify({
        bundles: {
          [hostPlatformKey()]: { file: 'b.tar.gz', sha256: 'b'.repeat(64), commit: 'zzz', version: '9.9.9' },
        },
      }),
      hostPlatformKey(),
    );
    expect(perBundle.bundle.commit).toBe('zzz');
    expect(perBundle.bundle.version).toBe('9.9.9');
  });

  it('rejects unusable manifests loudly', () => {
    expect(() => parseUpdateManifest('not json', hostPlatformKey())).toThrow(/not valid JSON/);
    expect(() => parseUpdateManifest('{"bundles":{}}', hostPlatformKey())).toThrow(/no bundle for platform/);
    expect(() =>
      parseUpdateManifest(
        JSON.stringify({ bundles: { [hostPlatformKey()]: { file: 'x.tar.gz', sha256: 'short' } } }),
        hostPlatformKey(),
      ),
    ).toThrow(/sha256/);
    expect(() =>
      parseUpdateManifest(
        JSON.stringify({ bundles: { [hostPlatformKey()]: { file: '../evil.tar.gz', sha256: 'a'.repeat(64) } } }),
        hostPlatformKey(),
      ),
    ).toThrow(/unusable bundle file/);
  });

  it('resolves archive URLs relative to the manifest URL', () => {
    expect(archiveUrlFor('https://example.com/dl/manifest.json', 'beeline-linux-x64.tar.gz')).toBe(
      'https://example.com/dl/beeline-linux-x64.tar.gz',
    );
  });
});

// ---------------------------------------------------------------------------
// Fixture bundles served over local HTTP
// ---------------------------------------------------------------------------

/**
 * A minimal stand-in for the bundled cli: answers `--version` from its own
 * adjacent bundle.json and, in `daemon` mode, records its identity + pid in
 * the runtime dir so the test can prove WHICH bundle came up.
 */
const STUB_CLI = `
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
function identity() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(here, '../../bundle.json'), 'utf8'));
  } catch {
    return {};
  }
}
const args = process.argv.slice(2);
if (args.includes('--version')) {
  const id = identity();
  console.log('beeline stub', id.version ?? 'unknown', (id.commit ?? '').slice(0, 12));
  process.exit(0);
} else if (args[0] === 'daemon') {
  const configFlag = args.indexOf('--config');
  const configPath = args[configFlag + 1];
  const id = identity();
  fs.writeFileSync(path.join(path.dirname(configPath), 'daemon-started.json'),
    JSON.stringify({ pid: process.pid, commit: id.commit, entrypoint: fileURLToPath(import.meta.url) }));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => undefined, 1000);
} else {
  process.exit(2);
}
`;

interface FixtureBundle {
  commit: string;
  version: string;
  tarballPath: string;
  sha256: string;
}

async function buildFixtureBundle(commit: string, version: string): Promise<FixtureBundle> {
  const staging = await tempDir(`build-${commit}`);
  await mkdir(join(staging, 'bin'), { recursive: true });
  await mkdir(join(staging, 'lib', 'beeline'), { recursive: true });
  await writeFile(join(staging, 'lib', 'beeline', 'beeline-cli.mjs'), STUB_CLI);
  await writeFile(
    join(staging, 'bundle.json'),
    `${JSON.stringify({ schemaVersion: 1, name: 'beeline', platform: hostPlatformKey(), commit, version }, null, 2)}\n`,
  );
  const tarballPath = join(staging, 'bundle.tar.gz');
  const tar = spawnSync('tar', ['-czf', tarballPath, '-C', staging, 'lib', 'bundle.json']);
  if (tar.status !== 0) throw new Error(`fixture tar failed: ${tar.stderr?.toString()}`);
  const sha256 = createHash('sha256').update(await readFile(tarballPath)).digest('hex');
  return { commit, version, tarballPath, sha256 };
}

describe('self-update end to end against a local fixture manifest', () => {
  let server: Server;
  let baseUrl = '';
  const files = new Map<string, string>();
  const bodies = new Map<string, string>();

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = request.url ?? '';
      if (bodies.has(url)) {
        response.writeHead(200).end(bodies.get(url));
        return;
      }
      const filePath = files.get(url);
      if (!filePath) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200);
      createReadStream(filePath).pipe(response);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  function serveManifest(bundle: FixtureBundle): string {
    const filename = bundle.tarballPath.split('/').pop()!;
    files.set(`/dl/${filename}`, bundle.tarballPath);
    bodies.set(
      '/dl/manifest.json',
      JSON.stringify({
        schemaVersion: 1,
        bundles: {
          [hostPlatformKey()]: {
            file: filename,
            sha256: bundle.sha256,
            commit: bundle.commit,
            version: bundle.version,
          },
        },
      }),
    );
    return `${baseUrl}/dl/manifest.json`;
  }

  /** A legacy-shaped install (real directory at lib/beeline), like today's installer produces. */
  async function makeLegacyInstall(commit: string, version: string): Promise<{ root: string; layout: BeelineInstallLayout }> {
    const root = await tempDir('install-');
    const binDir = join(root, 'prefix', 'bin');
    const libDir = join(root, 'prefix', 'lib', 'beeline');
    await mkdir(join(libDir, 'lib', 'beeline'), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(libDir, 'lib', 'beeline', 'beeline-cli.mjs'), STUB_CLI);
    await writeFile(join(libDir, 'bundle.json'), `${JSON.stringify({ commit, version }, null, 2)}\n`);
    await writeFile(join(binDir, 'beeline'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { root, layout: beelineInstallLayout({ BEELINE_LIB_DIR: libDir })! };
  }

  it('detects, downloads, verifies, swaps atomically, waits out busy work, then restarts onto the new bundle', async () => {
    const v2 = await buildFixtureBundle('c2newer', '1.1.0');
    const manifestUrl = serveManifest(v2);
    const { root, layout } = await makeLegacyInstall('c1alpha', '1.0.0');

    const runtimeDir = join(root, 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    const configPath = join(runtimeDir, 'runtime.json');
    await writeFile(configPath, '{}');

    let idle = false;
    const notices: string[] = [];
    let restartRequested = false;
    const manager = new SelfUpdateManager({
      layout,
      watchRuntimeDirs: [runtimeDir],
      env: { BEELINE_UPDATE_MANIFEST_URL: manifestUrl },
      checkIntervalMs: 0,
      initialDelayMs: 0,
      idleTimeoutMs: 400,
      idlePollMs: 20,
      isIdle: () => idle,
      notify: (text) => {
        notices.push(text);
      },
      requestRestart: () => {
        restartRequested = true;
      },
      logger: () => undefined,
    });

    // Phase 1 — BUSY: an agent turn is running. The bundle may stage (that
    // touches nothing live), but the install must NOT swap and no restart
    // may be requested.
    await manager.checkAndApply();
    expect(existsSync(join(layout.releasesRoot, v2.commit, '.stage-ok'))).toBe(true);
    expect(await activeReleaseId(layout)).toBe('legacy');
    expect(manager.restartPending).toBe(false);
    expect(restartRequested).toBe(false);

    // Phase 2 — IDLE: the same staged release now activates atomically.
    idle = true;
    await manager.checkAndApply();
    expect(manager.restartPending).toBe(true);
    expect(restartRequested).toBe(true);
    expect((await lstat(layout.libDir)).isSymbolicLink()).toBe(true);
    expect(await activeReleaseId(layout)).toBe(v2.commit);

    // Previous bundle preserved for rollback.
    expect(existsSync(join(layout.releasesRoot, 'c1alpha', 'lib', 'beeline', 'beeline-cli.mjs'))).toBe(true);

    // Rollback journal + Room-visible notice through the existing message path.
    const pending = await readPendingUpdate(layout);
    expect(pending?.releaseId).toBe(v2.commit);
    expect(pending?.previousReleaseId).toBe('c1alpha');
    expect(notices.join("\n")).toContain("the daemon is restarting now");

    // Identity now reads from the INSTALLED bundle itself.
    expect(await readInstalledBundleIdentity(layout)).toEqual({ commit: v2.commit, version: v2.version });

    // Handover: launch the replacement daemon from the ACTIVE bundle and
    // prove the NEW bundle is what came up.
    const pid = await manager.launchReplacement(configPath);
    expect(pid).toBeGreaterThan(0);
    const startedPath = join(runtimeDir, 'daemon-started.json');
    for (let waited = 0; waited < 15_000 && !existsSync(startedPath); waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const started = JSON.parse(await readFile(startedPath, 'utf8'));
    expect(started.commit).toBe(v2.commit);
    expect(started.pid).toBe(pid);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }

    // Health confirmation clears the journal.
    expect(await confirmPendingUpdate(layout)).toBe(true);
    expect(await readPendingUpdate(layout)).toBeUndefined();
  }, 60_000);

  it('aborts loudly on a checksum mismatch without touching the installed bundle', async () => {
    const v2 = await buildFixtureBundle('c3good', '1.2.0');
    const tampered = { ...v2, sha256: 'f'.repeat(64) };
    const manifestUrl = serveManifest(tampered);
    const { layout } = await makeLegacyInstall('c1alpha', '1.0.0');

    await expect(
      stageRelease(layout, manifestUrl, {
        file: tampered.tarballPath.split('/').pop()!,
        sha256: tampered.sha256,
        commit: tampered.commit,
        version: tampered.version,
      }),
    ).rejects.toThrow(/checksum mismatch/);

    // Nothing staged, nothing swapped, installed identity unchanged.
    expect(await activeReleaseId(layout)).toBe('legacy');
    expect(existsSync(join(layout.releasesRoot, tampered.commit))).toBe(false);
    expect(await readInstalledBundleIdentity(layout)).toEqual({ commit: 'c1alpha', version: '1.0.0' });
    void v2;
  });

  it('rolls back when an applied update never confirms healthy, and keeps a fresh one', async () => {
    const { layout } = await makeLegacyInstall('c1old', '1.0.0');
    const b = await buildFixtureBundle('c4newer', '1.5.0');
    const releaseB = await stageRelease(layout, serveManifest(b), {
      file: b.tarballPath.split('/').pop()!,
      sha256: b.sha256,
      commit: b.commit,
      version: b.version,
    });
    const { previousReleaseId } = await activateRelease(layout, releaseB);
    expect(previousReleaseId).toBe('c1old');
    expect(await activeReleaseId(layout)).toBe(releaseB);

    // Stale unconfirmed journal ⇒ the new bundle never proved itself ⇒ rollback.
    await writePendingUpdateFixture(layout, {
      from: { commit: 'c1old', version: '1.0.0' },
      to: { commit: b.commit, version: b.version },
      releaseId: releaseB,
      previousReleaseId,
      appliedAt: Date.now() - 10 * 60_000,
    });
    const settle = await settlePendingUpdateOnStart(layout);
    expect(settle.kind).toBe('rolled-back');
    expect(await activeReleaseId(layout)).toBe(previousReleaseId!);
    expect(await readPendingUpdate(layout)).toBeUndefined();
    expect((await readUpdateState(layout)).lastRollback?.toReleaseId).toBe(previousReleaseId);

    // A FRESH journal is kept pending confirmation instead.
    await writePendingUpdateFixture(layout, {
      from: {},
      to: { commit: b.commit },
      releaseId: releaseB,
      previousReleaseId,
      appliedAt: Date.now(),
    });
    expect((await settlePendingUpdateOnStart(layout)).kind).toBe('pending');
    expect(await readPendingUpdate(layout)).toBeDefined();
  });

  it('honors an explicit operator update request even with auto-update disabled', async () => {
    const v2 = await buildFixtureBundle('c5optin', '1.6.0');
    serveManifest(v2);
    const { root, layout } = await makeLegacyInstall('c1alpha', '1.0.0');
    const runtimeDir = join(root, 'runtime');
    await mkdir(runtimeDir, { recursive: true });

    let restarted = false;
    const manager = new SelfUpdateManager({
      layout,
      watchRuntimeDirs: [runtimeDir],
      env: {
        BEELINE_UPDATE_DISABLE: '1',
        BEELINE_UPDATE_MANIFEST_URL: `${baseUrl}/dl/manifest.json`,
      },
      checkIntervalMs: 3_600_000,
      initialDelayMs: 3_600_000,
      idleTimeoutMs: 10_000,
      idlePollMs: 20,
      isIdle: () => true,
      notify: () => undefined,
      requestRestart: () => {
        restarted = true;
      },
      logger: () => undefined,
    });

    // Disabled + no request + cadence far away → nothing happens on tick.
    await manager.tickOnce();
    expect(await activeReleaseId(layout)).toBe('legacy');

    // Operator writes an update request (what `beeline update` does); the
    // forced path bypasses the disable switch and the cadence.
    await writeFile(join(runtimeDir, 'update-request.json'), '{"requestedAt":1}');
    await manager.tickOnce();
    expect(await activeReleaseId(layout)).toBe(v2.commit);
    expect(manager.restartPending).toBe(true);
    expect(restarted).toBe(true);
    expect(existsSync(join(runtimeDir, 'update-request.json'))).toBe(false);
  });
});

describe('anchor-drift restart (a running daemon picks up an externally swapped install)', () => {
  interface FixtureRelease { id: string; commit: string; version: string }

  /** A release-based install (symlinked anchor) with pre-staged releases, like every post-first-update host. */
  async function makeReleaseInstall(releases: FixtureRelease[], activeId: string): Promise<{ root: string; layout: BeelineInstallLayout }> {
    const root = await tempDir('install-drift');
    const libDir = join(root, 'prefix', 'lib', 'beeline');
    const releasesRoot = join(root, 'prefix', 'lib', 'beeline-releases');
    await mkdir(join(root, 'prefix', 'bin'), { recursive: true });
    for (const release of releases) {
      await mkdir(join(releasesRoot, release.id, 'lib', 'beeline'), { recursive: true });
      await writeFile(join(releasesRoot, release.id, 'lib', 'beeline', 'beeline-cli.mjs'), STUB_CLI);
      await writeFile(
        join(releasesRoot, release.id, 'bundle.json'),
        `${JSON.stringify({ schemaVersion: 1, name: 'beeline', platform: hostPlatformKey(), ...release }, null, 2)}\n`,
      );
    }
    await symlink(join('beeline-releases', activeId), libDir);
    return { root, layout: beelineInstallLayout({ BEELINE_LIB_DIR: libDir })! };
  }

  function makeManager(
    layout: BeelineInstallLayout,
    opts: Partial<ConstructorParameters<typeof SelfUpdateManager>[0]> & { idle: () => boolean },
  ): { manager: SelfUpdateManager; logs: string[]; notices: string[]; restartRequested: () => boolean } {
    const logs: string[] = [];
    const notices: string[] = [];
    let requested = false;
    const manager = new SelfUpdateManager({
      layout,
      env: { BEELINE_UPDATE_MANIFEST_URL: 'https://invalid.invalid/dl/manifest.json' },
      checkIntervalMs: 3_600_000,
      initialDelayMs: 3_600_000,
      idleTimeoutMs: 400,
      idlePollMs: 20,
      isIdle: opts.idle,
      notify: (text) => {
        notices.push(text);
      },
      requestRestart: () => {
        requested = true;
      },
      logger: (line) => logs.push(line),
      ...opts,
    });
    return { manager, logs, notices, restartRequested: () => requested };
  }

  async function waitDaemonStarted(runtimeDir: string): Promise<{ pid: number; commit?: string; entrypoint: string }> {
    const startedPath = join(runtimeDir, 'daemon-started.json');
    for (let waited = 0; waited < 15_000 && !existsSync(startedPath); waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!existsSync(startedPath)) throw new Error('replacement daemon never started');
    return JSON.parse(await readFile(startedPath, 'utf8'));
  }

  it('detects the anchor flip while idle and hands over to a replacement resolved from the CURRENT symlink', async () => {
    const oldR: FixtureRelease = { id: 'r-old', commit: 'c1old', version: '1.0.0' };
    const newR: FixtureRelease = { id: 'r-new', commit: 'c2new', version: '1.1.0' };
    const { root, layout } = await makeReleaseInstall([oldR, newR], oldR.id);
    const runtimeDir = join(root, 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    const configPath = join(runtimeDir, 'runtime.json');
    await writeFile(configPath, '{}');
    const { manager, logs, notices, restartRequested } = makeManager(layout, { idle: () => true });

    // First tick captures what THIS process loaded from; nothing moves.
    await manager.tickOnce();
    expect(manager.restartPending).toBe(false);
    expect(await readPendingUpdate(layout)).toBeUndefined();

    // Someone ELSE swaps the install under us (another daemon's apply,
    // `beeline update` without restart, install.sh, a manual rollback).
    await activateRelease(layout, newR.id);
    expect(await activeReleaseId(layout)).toBe(newR.id);

    await manager.tickOnce();
    expect(manager.restartPending).toBe(true);
    expect(restartRequested()).toBe(true);

    // One clear line per restart: old release, new release, why.
    const driftLine = logs.find((line) => line.includes('self-update RESTART'));
    expect(driftLine).toBeDefined();
    expect(driftLine).toContain(oldR.id);
    expect(driftLine).toContain(newR.id);
    expect(driftLine).toContain('the install anchor moved under this daemon');

    // Rollback journal written so a replacement that cannot boot falls back.
    const pending = await readPendingUpdate(layout);
    expect(pending?.releaseId).toBe(newR.id);
    expect(pending?.previousReleaseId).toBe(oldR.id);
    expect(pending?.from).toEqual({ commit: oldR.commit, version: oldR.version });
    expect(notices.join('\n')).toContain('restarting now');

    // Handover exec target must resolve through the CURRENT anchor.
    const pid = await manager.launchReplacement(configPath);
    expect(pid).toBeGreaterThan(0);
    const started = await waitDaemonStarted(runtimeDir);
    expect(started.pid).toBe(pid);
    expect(started.commit).toBe(newR.commit);
    expect(started.entrypoint).toContain(`/beeline-releases/${newR.id}/`);
    try {
      process.kill(started.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }, 60_000);

  it('defers the drift restart while agent work is running, then restarts once idle', async () => {
    const oldR: FixtureRelease = { id: 'd-old', commit: 'd1old', version: '2.0.0' };
    const newR: FixtureRelease = { id: 'd-new', commit: 'd2new', version: '2.1.0' };
    const { layout } = await makeReleaseInstall([oldR, newR], oldR.id);
    let idle = false;
    const { manager, logs, restartRequested } = makeManager(layout, { idle: () => idle });

    await manager.tickOnce(); // capture loaded release
    await activateRelease(layout, newR.id);

    // Busy: the tick waits out its (short, test-tuned) idle budget, defers,
    // and touches nothing live.
    await manager.tickOnce();
    expect(manager.restartPending).toBe(false);
    expect(restartRequested()).toBe(false);
    expect(await readPendingUpdate(layout)).toBeUndefined();
    expect(logs.some((line) => line.includes('waits until the daemon is idle'))).toBe(true);

    // Idle again: the very next tick hands over.
    idle = true;
    await manager.tickOnce();
    expect(manager.restartPending).toBe(true);
    expect(restartRequested()).toBe(true);
    expect((await readPendingUpdate(layout))?.previousReleaseId).toBe(oldR.id);
  }, 30_000);

  it('keeps detecting drift even with auto-update disabled and no manifest reachable', async () => {
    const oldR: FixtureRelease = { id: 'x-old', commit: 'x1old', version: '3.0.0' };
    const newR: FixtureRelease = { id: 'x-new', commit: 'x2new', version: '3.1.0' };
    const { layout } = await makeReleaseInstall([oldR, newR], oldR.id);
    const { manager, restartRequested } = makeManager(layout, {
      idle: () => true,
      env: { BEELINE_UPDATE_DISABLE: '1', BEELINE_UPDATE_MANIFEST_URL: 'https://invalid.invalid/dl/manifest.json' },
    });

    await manager.tickOnce();
    await activateRelease(layout, newR.id);
    await manager.tickOnce();
    // Executing stale code is never a desired state: disable governs fetching,
    // not adopting an install that already moved.
    expect(manager.restartPending).toBe(true);
    expect(restartRequested()).toBe(true);
    expect((await readPendingUpdate(layout))?.previousReleaseId).toBe(oldR.id);
  }, 30_000);

  it('arms unconfirmed state from the pending journal so a fatal boot failure can roll back', async () => {
    const oldR: FixtureRelease = { id: 'u-old', commit: 'u1old', version: '4.0.0' };
    const newR: FixtureRelease = { id: 'u-new', commit: 'u2new', version: '4.1.0' };
    const { root, layout } = await makeReleaseInstall([oldR, newR], newR.id);
    await writePendingUpdateFixture(layout, {
      from: { commit: oldR.commit, version: oldR.version },
      to: { commit: newR.commit, version: newR.version },
      releaseId: newR.id,
      previousReleaseId: oldR.id,
      appliedAt: Date.now(),
    });
    const { manager } = makeManager(layout, {
      idle: () => true,
      pendingUnconfirmedReleaseId: newR.id,
    });
    expect(manager.hasUnconfirmedUpdate()).toBe(true);
    manager.markUpdateConfirmed();
    expect(manager.hasUnconfirmedUpdate()).toBe(false);
    void root;
  });

  it('falls back to the previous release when the new one cannot boot', async () => {
    const prevR: FixtureRelease = { id: 'f-prev', commit: 'f1prev', version: '5.0.0' };
    const nextR: FixtureRelease = { id: 'f-next', commit: 'f2next', version: '5.1.0' };
    const { root, layout } = await makeReleaseInstall([prevR, nextR], nextR.id);
    const runtimeDir = join(root, 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    const configPath = join(runtimeDir, 'runtime.json');
    await writeFile(configPath, '{}');
    await writePendingUpdateFixture(layout, {
      from: { commit: prevR.commit, version: prevR.version },
      to: { commit: nextR.commit, version: nextR.version },
      releaseId: nextR.id,
      previousReleaseId: prevR.id,
      appliedAt: Date.now(),
    });

    const logs: string[] = [];
    const pid = await relaunchPreviousReleaseAfterFailedUpdate(layout, configPath, {
      logger: (line) => logs.push(line),
    });

    // Loud log naming both releases.
    const fallbackLine = logs.find((line) => line.includes('self-update FALLBACK')) ?? '';
    expect(fallbackLine).toContain(nextR.id);
    expect(fallbackLine).toContain(prevR.id);
    expect(fallbackLine).toContain('failed to boot');

    // The anchor is restored AND the relaunched process runs the PREVIOUS
    // release's own entrypoint.
    expect(pid).toBeGreaterThan(0);
    expect(await activeReleaseId(layout)).toBe(prevR.id);
    const started = await waitDaemonStarted(runtimeDir);
    expect(started.commit).toBe(prevR.commit);
    expect(started.entrypoint).toContain(`/beeline-releases/${prevR.id}/`);
    try {
      process.kill(started.pid!, 'SIGTERM');
    } catch {
      // already gone
    }

    // Rollback recorded in install state; journal consumed.
    expect((await readUpdateState(layout)).lastRollback?.toReleaseId).toBe(prevR.id);
    expect(await readPendingUpdate(layout)).toBeUndefined();
  }, 60_000);

  it('states plainly when a failed release has no previous release to fall back to', async () => {
    const onlyR: FixtureRelease = { id: 's-only', commit: 's1only', version: '6.0.0' };
    const { root, layout } = await makeReleaseInstall([onlyR], onlyR.id);
    const runtimeDir = join(root, 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    const configPath = join(runtimeDir, 'runtime.json');
    await writeFile(configPath, '{}');
    await writePendingUpdateFixture(layout, {
      from: {},
      to: { commit: onlyR.commit },
      releaseId: onlyR.id,
      previousReleaseId: undefined,
      appliedAt: Date.now(),
    });
    const logs: string[] = [];
    const pid = await relaunchPreviousReleaseAfterFailedUpdate(layout, configPath, {
      logger: (line) => logs.push(line),
    });
    expect(pid).toBeUndefined();
    expect(logs.join('\n')).toContain('no previous release');
    expect(await activeReleaseId(layout)).toBe(onlyR.id); // untouched
    expect(await readPendingUpdate(layout)).toBeUndefined();
  }, 30_000);
});

describe('rollback helper', () => {
  it('restores the previous release with a single symlink swap', async () => {
    const root = await tempDir('rb');
    const libDir = join(root, 'prefix', 'lib', 'beeline');
    const releasesRoot = join(root, 'prefix', 'lib', 'beeline-releases');
    for (const release of ['r1', 'r2']) {
      await mkdir(join(releasesRoot, release, 'lib', 'beeline'), { recursive: true });
      await writeFile(join(releasesRoot, release, 'lib', 'beeline', 'beeline-cli.mjs'), `// ${release}\n`);
    }
    await symlink(join('beeline-releases', 'r2'), libDir);
    const layout = beelineInstallLayout({ BEELINE_LIB_DIR: libDir })!;
    await rollbackToPreviousRelease(layout, 'r1');
    expect(await activeReleaseId(layout)).toBe('r1');
    expect(await readFile(join(libDir, 'lib', 'beeline', 'beeline-cli.mjs'), 'utf8')).toBe('// r1\n');
  });
});
