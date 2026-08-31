import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, createReadStream } from 'node:fs';
import {
  lstat,
  mkdtemp as mkdtempFs,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  SelfUpdateManager,
  activateRelease,
  activeReleaseId,
  archiveUrlFor,
  beelineInstallLayout,
  hostPlatformKey,
  readInstalledBundleIdentity,
  readUpdateAttempt,
  rollbackToPreviousRelease,
  settleUpdateAttemptOnStart,
  stageRelease,
  writeUpdateAttempt,
  writeUpdateAttemptFixture,
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
  for (const dir of tempDirs)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
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

async function buildFixtureBundle(commit: string, version: string): Promise<FixtureBundle> {
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
  await writeFile(
    join(staging, 'bundle.json'),
    `${JSON.stringify({ schemaVersion: 1, name: 'beeline', platform: hostPlatformKey(), commit, version }, null, 2)}\n`,
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

  it('detects, downloads, verifies, and swaps atomically once work is idle', async () => {
    const v2 = await buildFixtureBundle('c2newer', '1.1.0');
    const manifestUrl = serveManifest(v2);
    const { root, layout } = await makeLegacyInstall('c1alpha', '1.0.0');

    let idle = false;
    const manager = new SelfUpdateManager({
      layout,
      env: { BEELINE_UPDATE_MANIFEST_URL: manifestUrl },
      checkIntervalMs: 0,
      initialDelayMs: 0,
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

    // Previous bundle preserved for rollback.
    expect(
      existsSync(join(layout.releasesRoot, 'c1alpha', 'lib', 'beeline', 'beeline-cli.mjs')),
    ).toBe(true);

    // The rollback journal is durable operational state. A successful update
    // and restart must not publish anything into Room chat.
    const pending = await readUpdateAttempt(layout);
    expect(pending?.releaseId).toBe(v2.commit);
    expect(pending?.previousReleaseId).toBe('c1alpha');

    // Identity now reads from the INSTALLED bundle itself.
    expect(await readInstalledBundleIdentity(layout)).toEqual({
      commit: v2.commit,
      version: v2.version,
    });

    // A served-turn confirmation retains one durable outcome record.
    await writeUpdateAttempt(layout, { ...pending!, status: 'confirmed' });
    expect((await readUpdateAttempt(layout))?.status).toBe('confirmed');
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
    await writeUpdateAttemptFixture(layout, {
      from: { commit: 'c1old', version: '1.0.0' },
      to: { commit: b.commit, version: b.version },
      releaseId: releaseB,
      previousReleaseId,
      appliedAt: Date.now() - 10 * 60_000,
    });
    const settle = await settleUpdateAttemptOnStart(layout);
    expect(settle.kind).toBe('rolled-back');
    expect(await activeReleaseId(layout)).toBe(previousReleaseId!);
    expect((await readUpdateAttempt(layout))).toMatchObject({
      releaseId: releaseB,
      previousReleaseId,
      status: 'reverted',
    });

    // The exact broken publish cannot churn straight back onto the host.
    const logs: string[] = [];
    const pinned = new SelfUpdateManager({
      layout,
      env: { BEELINE_UPDATE_MANIFEST_URL: serveManifest(b) },
      isIdle: () => true,
      logger: (line) => logs.push(line),
    });
    await pinned.checkAndApply();
    expect(await activeReleaseId(layout)).toBe(previousReleaseId!);
    expect(logs.join('\n')).toContain('reverted after a failed served-turn proof');

    // A genuinely newer publish clears the pin without human intervention.
    const newer = await buildFixtureBundle('c5fixed', '1.6.0');
    const fixed = new SelfUpdateManager({
      layout,
      env: { BEELINE_UPDATE_MANIFEST_URL: serveManifest(newer) },
      isIdle: () => true,
      logger: () => undefined,
    });
    await fixed.checkAndApply();
    expect(await activeReleaseId(layout)).toBe(newer.commit);
    expect((await readUpdateAttempt(layout))?.releaseId).toBe(newer.commit);

    // A FRESH journal is kept pending confirmation instead.
    await writeUpdateAttemptFixture(layout, {
      from: {},
      to: { commit: b.commit },
      releaseId: releaseB,
      previousReleaseId,
      appliedAt: Date.now(),
    });
    expect((await settleUpdateAttemptOnStart(layout)).kind).toBe('pending');
    expect(await readUpdateAttempt(layout)).toBeDefined();
  });

  it('resumes one attempt safely after a crash before proof, after proof, and after deadline', async () => {
    const { layout } = await makeLegacyInstall('stable', '1.0.0');
    const base = {
      from: { commit: 'stable' },
      to: { commit: 'candidate' },
      releaseId: 'candidate',
      previousReleaseId: undefined,
    };

    await writeUpdateAttemptFixture(layout, { ...base, appliedAt: 1_000, confirmBy: 2_000 });
    expect(await settleUpdateAttemptOnStart(layout, { now: () => 1_500 })).toMatchObject({
      kind: 'pending',
    });

    await writeUpdateAttempt(layout, { ...(await readUpdateAttempt(layout))!, status: 'confirmed' });
    expect(await settleUpdateAttemptOnStart(layout, { now: () => 3_000 })).toEqual({ kind: 'none' });

    await writeUpdateAttemptFixture(layout, { ...base, appliedAt: 4_000, confirmBy: 5_000 });
    expect(await settleUpdateAttemptOnStart(layout, { now: () => 5_001 })).toMatchObject({
      kind: 'rolled-back',
    });
    expect((await readUpdateAttempt(layout))?.status).toBe('reverted');
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
      initialDelayMs: 3_600_000,
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
});

// The daemon no longer spawns a successor or separately monitors anchor drift.
// ManagedUpdateHandoff owns one stable-anchor restart request; confirmation and
// rollback are covered by the update-attempt tests above and in managed-update.
describe('rollback helper', () => {
  it('restores the previous release with a single symlink swap', async () => {
    const root = await tempDir('rb');
    const libDir = join(root, 'prefix', 'lib', 'beeline');
    const releasesRoot = join(root, 'prefix', 'lib', 'beeline-releases');
    for (const release of ['r1', 'r2']) {
      await mkdir(join(releasesRoot, release, 'lib', 'beeline'), { recursive: true });
      await writeFile(
        join(releasesRoot, release, 'lib', 'beeline', 'beeline-cli.mjs'),
        `// ${release}\n`,
      );
    }
    await symlink(join('beeline-releases', 'r2'), libDir);
    const layout = beelineInstallLayout({ BEELINE_LIB_DIR: libDir })!;
    await rollbackToPreviousRelease(layout, 'r1');
    expect(await activeReleaseId(layout)).toBe('r1');
    expect(await readFile(join(libDir, 'lib', 'beeline', 'beeline-cli.mjs'), 'utf8')).toBe(
      '// r1\n',
    );
  });
});
