import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, createReadStream } from 'node:fs';
import {
  lstat,
  mkdtemp as mkdtempFs,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { SelfUpdateManager, STAGED_NODE_PATH_FILE, activeReleaseId, archiveUrlFor, beelineInstallLayout, hostPlatformKey, nodeVersionAtLeast, readInstalledBundleIdentity, readUpdateState, stageRelease, type BeelineInstallLayout } from './self-update.js';
import {
  compareBundleIdentity,
  compareVersions,
  parseUpdateManifest,
} from './self-update-manifest.js';
import { forceInstallMinimum, versionAtLeast } from './managed-update.js';

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const created = await mkdtempFs(join(tmpdir(), `${prefix}-`));
  tempDirs.push(created);
  return created;
}

afterAll(async () => {
  for (const dir of tempDirs)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(compareBundleIdentity({ commit: 'aaa' }, published({ commit: 'bbb' })).kind).toBe(
      'update-available',
    );
    expect(compareBundleIdentity({ commit: 'aaa' }, published({ commit: 'aaa' })).kind).toBe(
      'current',
    );
  });

  it('falls back to comparable versions when commits are absent', () => {
    expect(compareBundleIdentity({ version: '1.0.0' }, published({ version: '1.1.0' })).kind).toBe(
      'update-available',
    );
    expect(compareBundleIdentity({ version: '2.0.0' }, published({ version: '1.9.0' })).kind).toBe(
      'current',
    );
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
  it('selects the Intel and Apple-silicon macOS manifest keys', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const arch = Object.getOwnPropertyDescriptor(process, 'arch');
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
      expect(hostPlatformKey()).toBe('darwin-x64');
      Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
      expect(hostPlatformKey()).toBe('darwin-arm64');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
      if (arch) Object.defineProperty(process, 'arch', arch);
    }
  });

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
          [hostPlatformKey()]: {
            file: 'b.tar.gz',
            sha256: 'b'.repeat(64),
            commit: 'zzz',
            version: '9.9.9',
          },
        },
      }),
      hostPlatformKey(),
    );
    expect(perBundle.bundle.commit).toBe('zzz');
    expect(perBundle.bundle.version).toBe('9.9.9');
  });

  it('rejects unusable manifests loudly', () => {
    expect(() => parseUpdateManifest('not json', hostPlatformKey())).toThrow(/not valid JSON/);
    expect(() => parseUpdateManifest('{"bundles":{}}', hostPlatformKey())).toThrow(
      /no bundle for platform/,
    );
    expect(() =>
      parseUpdateManifest(
        JSON.stringify({ bundles: { [hostPlatformKey()]: { file: 'x.tar.gz', sha256: 'short' } } }),
        hostPlatformKey(),
      ),
    ).toThrow(/sha256/);
    expect(() =>
      parseUpdateManifest(
        JSON.stringify({
          bundles: { [hostPlatformKey()]: { file: '../evil.tar.gz', sha256: 'a'.repeat(64) } },
        }),
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

async function buildFixtureBundle(
  commit: string,
  version: string,
  options: { node?: string } = {},
): Promise<FixtureBundle> {
  const staging = await tempDir(`build-${commit}`);
  await mkdir(join(staging, 'bin'), { recursive: true });
  await mkdir(join(staging, 'lib', 'beeline'), { recursive: true });
  await writeFile(join(staging, 'lib', 'beeline', 'beeline-cli.mjs'), STUB_CLI);
  await writeFile(join(staging, 'lib', 'beeline', 'squire-mcp-proxy.mjs'), 'process.exit(0);\n');
  await writeFile(
    join(staging, 'lib', 'beeline', 'agent-tool-mcp-proxy.mjs'),
    'process.exit(0);\n',
  );
  await writeFile(join(staging, 'lib', 'beeline', 'pi-mcp-adapter.mjs'), 'export {};\n');
  await mkdir(join(staging, 'lib', 'beeline', 'codegraph', 'bin'), { recursive: true });
  await writeFile(
    join(staging, 'lib', 'beeline', 'codegraph', 'bin', 'codegraph'),
    '#!/bin/sh\nexit 0\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(staging, 'bundle.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: 'beeline',
        platform: hostPlatformKey(),
        commit,
        version,
        ...(options.node ? { node: options.node } : {}),
      },
      null,
      2,
    )}\n`,
  );
  const tarballPath = join(staging, 'bundle.tar.gz');
  const tar = spawnSync('tar', ['-czf', tarballPath, '-C', staging, 'lib', 'bundle.json']);
  if (tar.status !== 0) throw new Error(`fixture tar failed: ${tar.stderr?.toString()}`);
  const sha256 = createHash('sha256')
    .update(await readFile(tarballPath))
    .digest('hex');
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
  async function makeLegacyInstall(
    commit: string,
    version: string,
  ): Promise<{ root: string; layout: BeelineInstallLayout }> {
    const root = await tempDir('install-');
    const binDir = join(root, 'prefix', 'bin');
    const libDir = join(root, 'prefix', 'lib', 'beeline');
    await mkdir(join(libDir, 'lib', 'beeline'), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(libDir, 'lib', 'beeline', 'beeline-cli.mjs'), STUB_CLI);
    await writeFile(
      join(libDir, 'bundle.json'),
      `${JSON.stringify({ commit, version }, null, 2)}\n`,
    );
    await writeFile(join(binDir, 'beeline'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { root, layout: beelineInstallLayout({ BEELINE_LIB_DIR: libDir })! };
  }

  it('installs a published server minimum under the shared lock while a turn may be active', async () => {
    const { layout } = await makeLegacyInstall('a'.repeat(40), 'v0.0.68');
    const target = await buildFixtureBundle('b'.repeat(40), 'v0.0.69');
    const manifestUrl = serveManifest(target);
    const releaseId = await forceInstallMinimum({
      layout,
      minVersion: 'v0.0.69',
      env: { BEELINE_LIB_DIR: layout.libDir, BEELINE_UPDATE_MANIFEST_URL: manifestUrl,
        BEELINE_SYSTEMD_USER: '0' },
    });
    expect(await activeReleaseId(layout)).toBe(releaseId);
    expect((await readInstalledBundleIdentity(layout))?.version).toBe('v0.0.69');
    expect(versionAtLeast('v0.0.69', 'v0.0.69')).toBe(true);
    expect(versionAtLeast('v0.0.9', 'v0.0.10')).toBe(false);
  });

  it('detects, downloads, verifies, and swaps atomically once work is idle', async () => {
    const v2 = await buildFixtureBundle('c2newer', '1.1.0');
    const manifestUrl = serveManifest(v2);
    const { layout } = await makeLegacyInstall('c1alpha', '1.0.0');

    let idle = false;
    const manager = new SelfUpdateManager({
      layout,
      env: { BEELINE_UPDATE_MANIFEST_URL: manifestUrl },
      checkIntervalMs: 0,
      idleTimeoutMs: 400,
      idlePollMs: 20,
      isIdle: () => idle,
      logger: () => undefined,
    });

    // Phase 1 — BUSY: an agent turn is running. The bundle may stage (that
    // touches nothing live), but the install must NOT swap.
    await manager.checkAndApply();
    expect(existsSync(join(layout.releasesRoot, v2.commit, '.stage-ok'))).toBe(true);
    expect(await activeReleaseId(layout)).toBe('legacy');

    // Phase 2 — IDLE: the same staged release now activates atomically.
    idle = true;
    await manager.checkAndApply();
    expect((await lstat(layout.libDir)).isSymbolicLink()).toBe(true);
    expect(await activeReleaseId(layout)).toBe(v2.commit);

    // The legacy install is migrated without overwriting its files.
    expect(
      existsSync(join(layout.releasesRoot, 'c1alpha', 'lib', 'beeline', 'beeline-cli.mjs')),
    ).toBe(true);

    // Identity now reads from the INSTALLED bundle itself.
    expect(await readInstalledBundleIdentity(layout)).toEqual({
      commit: v2.commit,
      version: v2.version,
    });

  }, 60_000);

  it('ignores a legacy reverted attempt when installing the published release', async () => {
    const target = await buildFixtureBundle('new-publish', '1.1.0');
    const { layout } = await makeLegacyInstall('old-publish', '1.0.0');
    const oldStatePath = join(layout.releasesRoot, '.state', 'update-attempt.json');
    await mkdir(dirname(oldStatePath), { recursive: true });
    const legacyAttempt = JSON.stringify({ version: 1, releaseId: target.commit,
      to: { commit: target.commit, version: target.version }, status: 'reverted',
      failure: 'functional update probe failed', confirmBy: 1 });
    await writeFile(oldStatePath, legacyAttempt);
    const manager = new SelfUpdateManager({ layout,
      env: { BEELINE_UPDATE_MANIFEST_URL: serveManifest(target), BEELINE_SYSTEMD_USER: '0' },
      logger: () => undefined });
    await manager.checkAndApply();
    expect(await activeReleaseId(layout)).toBe(target.commit);
    expect(await readFile(oldStatePath, 'utf8')).toBe(legacyAttempt);
  }, 60_000);

  it('lets the managed worker stage and smoke-test without swapping the live anchor', async () => {
    const v2 = await buildFixtureBundle('c2staged', '1.1.1');
    const manifestUrl = serveManifest(v2);
    const { layout } = await makeLegacyInstall('c1alpha', '1.0.0');
    const manager = new SelfUpdateManager({
      layout,
      env: { BEELINE_UPDATE_MANIFEST_URL: manifestUrl },
      stageOnly: true,
      logger: () => undefined,
    });

    await manager.checkAndApply();

    expect(existsSync(join(layout.releasesRoot, v2.commit, '.stage-ok'))).toBe(true);
    expect(await activeReleaseId(layout)).toBe('legacy');
    expect(existsSync(join(layout.releasesRoot, '.state', 'update-attempt.json'))).toBe(false);
    expect(await readUpdateState(layout)).toMatchObject({
      stagedReleaseId: v2.commit,
      lastCheckResult: 'staged; waiting for serving daemon idle gate',
    });
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
    expect(await readInstalledBundleIdentity(layout)).toEqual({
      commit: 'c1alpha',
      version: '1.0.0',
    });
    void v2;
  });

  it('records an absolute Node runtime that satisfies the staged bundle\'s own engine minimum', async () => {
    // A trivially-satisfied minimum keeps this independent of whatever Node
    // actually runs the test suite.
    const bundle = await buildFixtureBundle('d1node', '2.0.0', { node: '>=1.0.0' });
    const { layout } = await makeLegacyInstall('c1alpha', '1.0.0');
    const releaseId = await stageRelease(layout, serveManifest(bundle), {
      file: bundle.tarballPath.split('/').pop()!,
      sha256: bundle.sha256,
      commit: bundle.commit,
      version: bundle.version,
    });
    const recorded = await readFile(
      join(layout.releasesRoot, releaseId, STAGED_NODE_PATH_FILE),
      'utf8',
    );
    // This process's own interpreter is what staged (and smoke-tested) the
    // release, so it is the one path every later invocation of this exact
    // release -- including through a service manager's own, differently
    // configured PATH -- can trust without re-resolving `node` itself.
    expect(recorded.trim()).toBe(process.execPath);
  });

  it('refuses to stage a bundle whose declared Node requirement this process cannot satisfy', async () => {
    const bundle = await buildFixtureBundle('d2toonew', '2.1.0', { node: '>=999.0.0' });
    const { layout } = await makeLegacyInstall('c1alpha', '1.0.0');

    await expect(
      stageRelease(layout, serveManifest(bundle), {
        file: bundle.tarballPath.split('/').pop()!,
        sha256: bundle.sha256,
        commit: bundle.commit,
        version: bundle.version,
      }),
    ).rejects.toThrow(/requires Node\.js >=999\.0\.0/);

    // Refused before activation: nothing left half-staged, installed bundle
    // unchanged -- the same contract a checksum mismatch keeps above.
    expect(await activeReleaseId(layout)).toBe('legacy');
    expect(existsSync(join(layout.releasesRoot, bundle.commit))).toBe(false);
  });

  it('compares Node versions component-wise', () => {
    expect(nodeVersionAtLeast('20.11.0', [20, 11, 0])).toBe(true);
    expect(nodeVersionAtLeast('20.11.5', [20, 11, 0])).toBe(true);
    expect(nodeVersionAtLeast('20.10.9', [20, 11, 0])).toBe(false);
    expect(nodeVersionAtLeast('18.19.1', [20, 11, 0])).toBe(false);
    expect(nodeVersionAtLeast('21.0.0', [20, 11, 0])).toBe(true);
  });

  it('lets an explicit update apply even when automatic checks are disabled', async () => {
    const v2 = await buildFixtureBundle('c5optin', '1.6.0');
    serveManifest(v2);
    const { layout } = await makeLegacyInstall('c1alpha', '1.0.0');

    const manager = new SelfUpdateManager({
      layout,
      env: {
        BEELINE_UPDATE_DISABLE: '1',
        BEELINE_UPDATE_MANIFEST_URL: `${baseUrl}/dl/manifest.json`,
      },
      checkIntervalMs: 3_600_000,
      idleTimeoutMs: 10_000,
      idlePollMs: 20,
      isIdle: () => true,
      logger: () => undefined,
    });

    // Disabled + no request + cadence far away → nothing happens on tick.
    await manager.tickOnce();
    expect(await activeReleaseId(layout)).toBe('legacy');

    // `beeline update` invokes this one apply path directly. There is no
    // per-runtime request file for a later daemon to consume.
    await manager.checkAndApply({ force: true });
    expect(await activeReleaseId(layout)).toBe(v2.commit);
  });

  it('update-rewrites-unit: a successful update rewrites a stale host broker unit and restarts the elector', async () => {
    const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const home = await tempDir('update-broker-home-');
      const configRoot = join(home, '.config');
      const libDir = join(home, '.local', 'lib', 'beeline');
      const binDir = join(home, '.local', 'bin');
      await mkdir(join(libDir, 'lib', 'beeline'), { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(join(libDir, 'lib', 'beeline', 'beeline-cli.mjs'), STUB_CLI);
      await writeFile(
        join(libDir, 'bundle.json'),
        `${JSON.stringify({ commit: 'c1alpha', version: '1.0.0' }, null, 2)}\n`,
      );
      await writeFile(join(binDir, 'beeline'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      // The stale host state from before #1653: a unit with no PATH line, so
      // the elector fell back to the system Node and Squire crashed.
      const unitPath = join(configRoot, 'systemd', 'user', 'trusty-squire-broker.service');
      await mkdir(dirname(unitPath), { recursive: true });
      await writeFile(unitPath, '[Service]\nExecStart=%h/.local/bin/beeline --squire-broker\n');
      // A helper unit from an older release, before this one changed it.
      const helperUnitPath = join(configRoot, 'systemd', 'user', 'beeline-helper.service');
      await writeFile(helperUnitPath, '[Service]\nExecStart=%h/.local/bin/beeline daemon --machine\n');

      // The updater finds the real `systemctl` on PATH; this shim records the
      // control calls without touching the test host's user manager.
      const fakeBin = await tempDir('update-broker-bin-');
      const systemctlLog = join(fakeBin, 'systemctl.log');
      await writeFile(
        join(fakeBin, 'systemctl'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"\n`,
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${fakeBin}:${process.env.PATH ?? ''}`);
      vi.stubEnv('SYSTEMCTL_LOG', systemctlLog);

      const v2 = await buildFixtureBundle('c2newer', '1.1.0');
      const manifestUrl = serveManifest(v2);
      const layout = beelineInstallLayout({ BEELINE_LIB_DIR: libDir, HOME: home })!;
      const manager = new SelfUpdateManager({
        layout,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: configRoot,
          BEELINE_LIB_DIR: libDir,
          BEELINE_SYSTEMD_USER: '',
          BEELINE_UPDATE_MANIFEST_URL: manifestUrl,
        },
        isIdle: () => true,
        logger: () => undefined,
      });
      await manager.checkAndApply({ force: true });
      expect(await activeReleaseId(layout)).toBe(v2.commit);

      const rewritten = await readFile(unitPath, 'utf8');
      expect(rewritten).toContain(`Environment=PATH=${dirname(process.execPath)}:`);
      const control = await readFile(systemctlLog, 'utf8');
      expect(control).toContain('restart --no-block trusty-squire-broker.service');

      // An installed helper unit is converged by the same update, so the next
      // helper restart runs under the current unit.
      const helperUnit = await readFile(helperUnitPath, 'utf8');
      expect(helperUnit).toContain('ExecStart=%h/.local/bin/beeline daemon --machine');
      expect(helperUnit).toContain('OOMPolicy=continue');
      expect(control).toContain('daemon-reload');
    } finally {
      if (previousPlatform) Object.defineProperty(process, 'platform', previousPlatform);
    }
  }, 60_000);
});
