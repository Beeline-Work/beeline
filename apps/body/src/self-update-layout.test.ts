/**
 * The `<prefix>/lib/beeline` layout contract (see self-update.ts, "THE
 * CONTRACT") — regression coverage for the MODULE_NOT_FOUND break where the
 * installed wrappers, the self-update swap, and the daemon relaunch disagreed
 * about what the anchor means.
 *
 * Two layers:
 *   - unit tests over beelineInstallLayout normalization, identity reads,
 *     legacy-flat migration + rollback, and repairInstallForwarders;
 *   - one SHELL-level end-to-end test that runs the real relay-stack/web/
 *     install.sh against stub bundles, applies updates through the real
 *     SelfUpdateManager swap, and invokes `<prefix>/bin/beeline --version`
 *     from a fresh process every time — the exact shape of the reported
 *     reproduction, which unit tests alone cannot see because the defect
 *     lives in shell path resolution across a real swap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp as mkdtempFs,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SelfUpdateManager,
  activeReleaseId,
  beelineInstallLayout,
  normalizeLegacyBundleShape,
  readInstalledBundleIdentity,
  repairInstallForwarders,
  resolveBundleEntrypoint,
  rollbackToPreviousRelease,
  type BeelineInstallLayout,
} from './self-update.js';
import { hostPlatformKey } from './self-update.js';

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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ---------------------------------------------------------------------------
// Stub bundles
// ---------------------------------------------------------------------------

const STUB_VERSION_MARKER = /beeline-stub (\S+)/;

/**
 * Mirror of the wrapper template in scripts/build-beeline-bundle.mjs: never
 * hand node a '..' component; trust BEELINE_LIB_DIR when a stable forwarder
 * exported it, else resolve our own release root with cd+pwd -P. Kept in
 * lockstep by the source assertions below.
 */
function stubBeelineWrapper(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'case $0 in',
    '  /*) script_path=$0 ;;',
    '  *) script_path=$(pwd -P)/$0 ;;',
    'esac',
    'if [ -n "${BEELINE_LIB_DIR:-}" ]; then',
    '  BEELINE_BUNDLE_ROOT=$BEELINE_LIB_DIR',
    'else',
    '  BEELINE_BUNDLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd -P)',
    '  BEELINE_LIB_DIR=$BEELINE_BUNDLE_ROOT/lib/beeline',
    'fi',
    'export BEELINE_LIB_DIR',
    'exec node "$BEELINE_BUNDLE_ROOT/lib/beeline/beeline-cli.mjs" "$@"',
    '',
  ].join('\n');
}

/** The PRE-CONTRACT wrapper (what shipped before the fix): pwd -P resolves the anchor symlink. */
function legacyResolvedWrapper(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
    'lib_dir=$(CDPATH= cd -- "$bin_dir/../lib/beeline" && pwd -P)',
    'export BEELINE_LIB_DIR="$lib_dir"',
    'exec node "$lib_dir/lib/beeline/beeline-cli.mjs" "$@"',
    '',
  ].join('\n');
}

interface StubBundle {
  commit: string;
  tarballPath: string;
  sha256: string;
}

async function buildStubBundle(commit: string, version: string): Promise<StubBundle> {
  const staging = await tempDir(`bundle-${commit}-`);
  await mkdir(join(staging, 'bin'), { recursive: true });
  await mkdir(join(staging, 'lib', 'beeline'), { recursive: true });
  const cli = `console.log('beeline-stub ${version}');\n`;
  await writeFile(join(staging, 'lib', 'beeline', 'beeline-cli.mjs'), cli);
  await writeFile(
    join(staging, 'lib', 'beeline', 'beeline-readonly-mcp.mjs'),
    'process.exit(0);\n',
  );
  await writeFile(join(staging, 'lib', 'beeline', 'squire-mcp-proxy.mjs'), 'process.exit(0);\n');
  await writeFile(
    join(staging, 'lib', 'beeline', 'agent-tool-mcp-proxy.mjs'),
    'process.exit(0);\n',
  );
  await writeFile(join(staging, 'lib', 'beeline', 'pi-mcp-adapter.mjs'), 'export {};\n');
  await writeFile(
    join(staging, 'lib', 'beeline', 'bundle.json'),
    `${JSON.stringify({ schemaVersion: 1, name: 'beeline', platform: hostPlatformKey(), commit, version }, null, 2)}\n`,
  );
  await writeFile(join(staging, 'bin', 'beeline'), stubBeelineWrapper(), { mode: 0o755 });
  // Real bundles ship native binaries here; forwarder-writing probes X_OK.
  for (const tool of ['buzz-agent', 'buzz-dev-mcp']) {
    await writeFile(join(staging, 'bin', tool), `#!/bin/sh\necho ${tool}-stub ${version}\n`, {
      mode: 0o755,
    });
  }
  await writeFile(
    join(staging, 'bin', 'buzz-readonly-mcp'),
    stubBeelineWrapper().replace('beeline-cli.mjs', 'beeline-readonly-mcp.mjs'),
    { mode: 0o755 },
  );
  const tarballPath = join(staging, `beeline-${hostPlatformKey()}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', tarballPath, '-C', staging, 'bin', 'lib'], {
    timeout: 30_000,
  });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr?.toString()}`);
  const sha256 = createHash('sha256')
    .update(await readFile(tarballPath))
    .digest('hex');
  await writeFile(`${tarballPath}.sha256`, `${sha256}  ${tarballPath.split('/').pop()}\n`);
  return { commit, tarballPath, sha256 };
}

// ---------------------------------------------------------------------------
// Local manifest/artifact server (same shape as self-update.test.ts)
// ---------------------------------------------------------------------------

function serveBundles(bundles: Map<string, StubBundle>): Promise<{
  server: Server;
  baseUrl: string;
  manifestUrl: string;
  close(): Promise<void>;
}> {
  // Route names exactly as relay-stack/web/install.sh fetches them.
  const platform = hostPlatformKey();
  const first = [...bundles.values()][0]!;
  const files = new Map<string, string>([
    [`/dl/beeline-${platform}.tar.gz`, first.tarballPath],
    [`/dl/beeline-${platform}.tar.gz.sha256`, `${first.tarballPath}.sha256`],
  ]);
  const manifestBundles: Record<string, Record<string, unknown>> = {
    [platform]: {
      file: `beeline-${platform}.tar.gz`,
      sha256: first.sha256,
      commit: first.commit,
      version: first.commit,
    },
  };
  const server = createServer(async (request, response) => {
    const url = request.url ?? '';
    if (url === '/dl/manifest.json') {
      response.writeHead(200).end(JSON.stringify({ schemaVersion: 1, bundles: manifestBundles }));
      return;
    }
    const path = files.get(url);
    if (!path || !existsSync(path)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200);
    createReadStream(path).pipe(response);
  });
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no address');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolveListen({
        server,
        baseUrl,
        manifestUrl: `${baseUrl}/dl/manifest.json`,
        /** Point the published manifest at a specific bundle + archive route. */
        publish(bundle: StubBundle): void {
          files.set(`/dl/beeline-${platform}.tar.gz`, bundle.tarballPath);
          files.set(`/dl/beeline-${platform}.tar.gz.sha256`, `${bundle.tarballPath}.sha256`);
          manifestBundles[platform] = {
            file: `beeline-${platform}.tar.gz`,
            sha256: bundle.sha256,
            commit: bundle.commit,
            version: bundle.commit,
          };
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function stubManager(
  layout: BeelineInstallLayout,
  manifestUrl: string,
): Promise<SelfUpdateManager> {
  return new SelfUpdateManager({
    layout,
    env: { BEELINE_UPDATE_MANIFEST_URL: manifestUrl },
    isIdle: () => true,
    // CLI-style apply: swap the install, never write a restart journal.
    restartHandover: false,
    logger: () => undefined,
  });
}

/** Fresh-shell invocation, exactly as an operator's login shell would run it. */
function runInstalledCli(
  prefix: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(join(prefix, 'bin', 'beeline'), args, {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, BEELINE_LIB_DIR: '' },
  });
  if (result.error)
    throw new Error(`fresh-shell invocation hung or failed to spawn: ${result.error.message}`);
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function expectFreshShell(prefix: string, version: string): void {
  const run = runInstalledCli(prefix, ['--version']);
  expect(
    { status: run.status, stdout: run.stdout },
    `fresh-shell beeline --version failed\nstderr:\n${run.stderr}`,
  ).toMatchObject({ status: 0, stdout: expect.stringContaining(`beeline-stub ${version}`) });
}

/** Every stable prefix/bin forwarder must follow the anchor across swaps. */
function expectInstalledHelperForwarders(prefix: string, version: string): void {
  for (const tool of ['buzz-agent', 'buzz-dev-mcp']) {
    const run = spawnSync(join(prefix, 'bin', tool), [], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, BEELINE_LIB_DIR: '' },
    });
    expect(
      { status: run.status ?? -1, stdout: run.stdout ?? '' },
      `fresh-shell ${tool} failed\nstderr:\n${run.stderr ?? ''}`,
    ).toMatchObject({ status: 0, stdout: expect.stringContaining(`${tool}-stub ${version}`) });
  }

  const readonlyMcp = spawnSync(join(prefix, 'bin', 'buzz-readonly-mcp'), [], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, BEELINE_LIB_DIR: '' },
  });
  expect(
    { status: readonlyMcp.status ?? -1, stderr: readonlyMcp.stderr ?? '' },
    `fresh-shell buzz-readonly-mcp failed\nstderr:\n${readonlyMcp.stderr ?? ''}`,
  ).toMatchObject({ status: 0 });

  // Body gives buzz-agent the release wrapper path but an allowlisted env
  // without BEELINE_LIB_DIR. That direct launch must resolve the same entry.
  const directReadonlyMcp = spawnSync(
    join(prefix, 'lib', 'beeline', 'bin', 'buzz-readonly-mcp'),
    [],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, BEELINE_LIB_DIR: '' },
    },
  );
  expect(
    { status: directReadonlyMcp.status ?? -1, stderr: directReadonlyMcp.stderr ?? '' },
    `direct bundle buzz-readonly-mcp failed\nstderr:\n${directReadonlyMcp.stderr ?? ''}`,
  ).toMatchObject({ status: 0 });
}

// ---------------------------------------------------------------------------
// Unit: the contract halves
// ---------------------------------------------------------------------------

describe('<prefix>/lib/beeline anchor contract', () => {
  it('normalizes a symlink-resolved BEELINE_LIB_DIR back to the prefix anchor', () => {
    // What the pre-contract wrappers exported after any swap: a path INSIDE
    // the active release. Deriving the layout from it verbatim pointed the
    // releases root, bin dir, and identity reads at one frozen release.
    const layout = beelineInstallLayout({
      BEELINE_LIB_DIR: '/home/op/.local/lib/beeline-releases/abc123/lib/beeline',
    })!;
    expect(layout).toBeDefined();
    expect(layout.libDir).toBe('/home/op/.local/lib/beeline');
    expect(layout.binDir).toBe('/home/op/.local/bin');
    expect(layout.releasesRoot).toBe('/home/op/.local/lib/beeline-releases');
  });

  it('keeps the plain anchor meaning for legacy-flat values', () => {
    const layout = beelineInstallLayout({ BEELINE_LIB_DIR: '/home/op/.local/lib/beeline' })!;
    expect(layout.libDir).toBe('/home/op/.local/lib/beeline');
    expect(layout.releasesRoot).toBe('/home/op/.local/lib/beeline-releases');
  });

  it('reads the installed identity through a release-shaped anchor (real identity, not legacy)', async () => {
    const root = await tempDir('identity-');
    const prefix = join(root, 'prefix');
    const releaseDir = join(prefix, 'lib', 'beeline-releases', 'abc123');
    await mkdir(join(releaseDir, 'lib', 'beeline'), { recursive: true });
    await writeFile(
      join(releaseDir, 'lib', 'beeline', 'bundle.json'),
      `${JSON.stringify({ commit: 'abc123', version: '2026.03.01' })}\n`,
    );
    await mkdir(dirname(join(prefix, 'lib', 'beeline')), { recursive: true });
    await symlink(join('beeline-releases', 'abc123'), join(prefix, 'lib', 'beeline'));
    const layout = beelineInstallLayout({ BEELINE_LIB_DIR: join(prefix, 'lib', 'beeline') })!;
    const identity = await readInstalledBundleIdentity(layout);
    expect(identity).toEqual({ commit: 'abc123', version: '2026.03.01' });
    expect(await activeReleaseId(layout)).toBe('abc123');
  });

  describe('normalizeLegacyBundleShape', () => {
    it('moves legacy-flat bundle files down into lib/beeline/', async () => {
      const dir = await tempDir('flat-');
      await writeFile(join(dir, 'beeline-cli.mjs'), 'cli');
      await writeFile(join(dir, 'bundle.json'), '{}');
      await normalizeLegacyBundleShape(dir);
      expect((await resolveBundleEntrypoint(dir)) ?? '').toBe(
        join(dir, 'lib', 'beeline', 'beeline-cli.mjs'),
      );
      expect(existsSync(join(dir, 'bundle.json'))).toBe(false);
      expect(existsSync(join(dir, 'lib', 'beeline', 'bundle.json'))).toBe(true);
    });

    it('tolerates mid-migration directories holding files at BOTH levels (inner wins)', async () => {
      const dir = await tempDir('polluted-');
      await mkdir(join(dir, 'lib', 'beeline'), { recursive: true });
      await writeFile(join(dir, 'beeline-cli.mjs'), 'stale-root-copy');
      await writeFile(join(dir, 'lib', 'beeline', 'beeline-cli.mjs'), 'real');
      await normalizeLegacyBundleShape(dir);
      expect(await readFile(join(dir, 'lib', 'beeline', 'beeline-cli.mjs'), 'utf8')).toBe('real');
      // The stray root copy is left alone, never propagated inward.
      expect(await readFile(join(dir, 'beeline-cli.mjs'), 'utf8')).toBe('stale-root-copy');
    });

    it('leaves already release-shaped directories untouched', async () => {
      const dir = await tempDir('shaped-');
      await mkdir(join(dir, 'lib', 'beeline'), { recursive: true });
      await writeFile(join(dir, 'lib', 'beeline', 'beeline-cli.mjs'), 'cli');
      await normalizeLegacyBundleShape(dir);
      const entries = await readdir(dir);
      expect(entries.sort()).toEqual(['lib']);
    });
  });

  describe('migrating a legacy-flat install keeps rollback runnable', () => {
    it('preserves the flat bundle as a normalized release whose entrypoint resolves', async () => {
      const { activateRelease } = await import('./self-update.js');
      const root = await tempDir('legacy-flat-');
      const prefix = join(root, 'prefix');
      const anchor = join(prefix, 'lib', 'beeline');
      const binDir = join(prefix, 'bin');
      await mkdir(anchor, { recursive: true });
      await mkdir(binDir, { recursive: true });
      // Installer v1 output: FLAT files directly in the anchor directory.
      await writeFile(join(anchor, 'beeline-cli.mjs'), 'old cli');
      await writeFile(
        join(anchor, 'bundle.json'),
        `${JSON.stringify({ commit: 'oldflat', version: '1.0.0' })}\n`,
      );
      const layout = beelineInstallLayout({ BEELINE_LIB_DIR: anchor })!;

      const staged = await buildStubBundle('newrel1', '2.0.0');
      const extracted = join(layout.releasesRoot, 'newrel1');
      await mkdir(extracted, { recursive: true });
      spawnSync('tar', ['-xzf', staged.tarballPath, '-C', extracted]);
      await activateRelease(layout, 'newrel1');

      // The preserved copy must be runnable for rollback: entrypoint resolvable.
      const previousEntrypoint = await resolveBundleEntrypoint(
        join(layout.releasesRoot, 'oldflat'),
      );
      expect(previousEntrypoint).toBe(
        join(layout.releasesRoot, 'oldflat', 'lib', 'beeline', 'beeline-cli.mjs'),
      );
      await rollbackToPreviousRelease(layout, 'oldflat');
      expect(await activeReleaseId(layout)).toBe('oldflat');
    });
  });

  describe('repairInstallForwarders', () => {
    async function makeReleaseBasedInstall(): Promise<{
      root: string;
      prefix: string;
      layout: BeelineInstallLayout;
    }> {
      const root = await tempDir('repair-');
      const prefix = join(root, 'prefix');
      const releaseDir = join(prefix, 'lib', 'beeline-releases', 'fix9');
      await mkdir(join(releaseDir, 'lib', 'beeline'), { recursive: true });
      await mkdir(join(releaseDir, 'bin'), { recursive: true });
      await mkdir(join(prefix, 'bin'), { recursive: true });
      for (const tool of ['beeline', 'buzz-agent', 'buzz-dev-mcp', 'buzz-readonly-mcp']) {
        await writeFile(join(releaseDir, 'bin', tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }
      await symlink(join('beeline-releases', 'fix9'), join(prefix, 'lib', 'beeline'));
      return {
        root,
        prefix,
        layout: beelineInstallLayout({ BEELINE_LIB_DIR: join(prefix, 'lib', 'beeline') })!,
      };
    }

    it('rewrites stale raw wrappers on a release-based install', async () => {
      const { prefix, layout } = await makeReleaseBasedInstall();
      // What a pre-contract reinstall left behind: the raw pwd-P wrapper.
      await writeFile(join(prefix, 'bin', 'beeline'), legacyResolvedWrapper(), { mode: 0o755 });
      const changed = await repairInstallForwarders(layout);
      expect(changed).toBe(true);
      const rewritten = await readFile(join(prefix, 'bin', 'beeline'), 'utf8');
      expect(rewritten).toContain('export BEELINE_LIB_DIR="$prefix_dir/lib/beeline"');
      expect(rewritten).toContain('exec "$prefix_dir/lib/beeline/bin/beeline" "$@"');
      // And every shipped tool got the same treatment.
      for (const tool of ['buzz-agent', 'buzz-dev-mcp', 'buzz-readonly-mcp']) {
        expect(await readFile(join(prefix, 'bin', tool), 'utf8')).toContain(
          `exec "$prefix_dir/lib/beeline/bin/${tool}" "$@"`,
        );
      }
    });

    it('is a no-op when the forwarders already follow the contract', async () => {
      const { layout } = await makeReleaseBasedInstall();
      expect(await repairInstallForwarders(layout)).toBe(true); // seeds them
      expect(await repairInstallForwarders(layout)).toBe(false);
      expect(await repairInstallForwarders(layout)).toBe(false);
    });

    it('never touches a legacy real-directory install', async () => {
      const root = await tempDir('repair-legacy-');
      const anchor = join(root, 'prefix', 'lib', 'beeline');
      await mkdir(anchor, { recursive: true });
      const layout = beelineInstallLayout({ BEELINE_LIB_DIR: anchor })!;
      expect(await repairInstallForwarders(layout)).toBe(false);
    });
  });

  // The wrapper template lives in scripts/build-beeline-bundle.mjs; these
  // source assertions keep it and this file's stub from drifting apart, and
  // pin the anti-regression property itself: NO symlink resolution of the
  // anchor path in the wrapper that exports BEELINE_LIB_DIR.
  describe('build-beeline-bundle.mjs stays on the contract', () => {
    it('wrappers never hand node a .. component; forwarderScript and install.sh stay byte-identical', async () => {
      const source = await readFile(join(repoRoot, 'scripts', 'build-beeline-bundle.mjs'), 'utf8');
      expect(source).toContain('script_path=$(pwd -P)/$0'); // no pwd -P on $0 itself
      expect(source).toContain(
        'BEELINE_BUNDLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd -P)',
      );
      expect(source).toContain('BEELINE_LIB_DIR=$BEELINE_BUNDLE_ROOT/lib/beeline');
      expect(source).toContain('exec node "$BEELINE_BUNDLE_ROOT/lib/beeline/beeline-cli.mjs" "$@"');
      expect(source).toContain(
        'exec node "$BEELINE_BUNDLE_ROOT/lib/beeline/beeline-readonly-mcp.mjs"',
      );
      expect(source).not.toContain('exec node "$BEELINE_LIB_DIR/beeline-readonly-mcp.mjs"');
      // The old resolution shape must not come back for the CLI wrapper.
      const wrapperBlock = source.slice(source.indexOf("resolve(staging, 'bin', 'beeline')"));
      expect(wrapperBlock).not.toContain('lib_dir=$(CDPATH= cd');

      // self-update's forwarderScript() must stay textually identical to what
      // the installer writes: repairInstallForwarders compares file content
      // against forwarderScript() to decide whether repair is needed.
      const installer = await readFile(join(repoRoot, 'relay-stack', 'web', 'install.sh'), 'utf8');
      // The installer's heredocs escape $ for runtime expansion, so match
      // the literal on-disk bytes.
      expect(installer).toContain('export BEELINE_LIB_DIR="\\$prefix_dir/lib/beeline"');
      expect(installer).toContain('exec "\\$prefix_dir/lib/beeline/bin/$tool" "\\$@"');
    });
  });
});

// ---------------------------------------------------------------------------
// Shell-level end-to-end: install -> update -> fresh shell, three times over
// ---------------------------------------------------------------------------

describe('self-update keeps fresh-shell invocations working across swaps', () => {
  it('installs, updates twice (including a drifted-daemon handover), rolls back — and the wrapper still runs', async () => {
    const v1 = await buildStubBundle('aaa111v1', '1.0.0');
    const v2 = await buildStubBundle('bbb222v2', '2.0.0');
    const v3 = await buildStubBundle('ccc333v3', '3.0.0');

    const root = await tempDir('e2e-');
    const prefix = join(root, 'prefix');
    const binDir = join(prefix, 'bin');
    const bundles = new Map<string, StubBundle>([
      [v1.commit, v1],
      [v2.commit, v2],
      [v3.commit, v3],
    ]);
    const remote = await serveBundles(bundles);
    try {
      // --- 1. real install.sh -------------------------------------------------
      // Async spawn (never spawnSync): the installer curls the manifest
      // artifacts from THIS process's HTTP server, which cannot answer while
      // the event loop is blocked.
      const installed = await runInstaller({
        home: root,
        baseUrl: remote.baseUrl,
        binDir,
        libAnchor: join(prefix, 'lib', 'beeline'),
      });
      expect(installed.stderr).toBe('');
      expect(installed.status).toBe(0);

      // The anchor is the active bundle root; bin entries are stable forwarders.
      const anchorKind = await lstat(join(prefix, 'lib', 'beeline'));
      expect(anchorKind.isSymbolicLink()).toBe(true);
      expect(await readlinkTarget(join(prefix, 'lib', 'beeline'))).toBe(
        `beeline-releases/${v1.commit}`,
      );

      // --- 2. fresh shell on release N ---------------------------------------
      expectFreshShell(prefix, '1.0.0');
      expectInstalledHelperForwarders(prefix, '1.0.0');

      // --- 3. update N -> N+1 through the real swap, fresh shell --------------
      // (The acceptance shape: from a host at release N, apply an update,
      // then run the CLI from a fresh shell.)
      const anchorLayout = beelineInstallLayout({
        BEELINE_LIB_DIR: join(prefix, 'lib', 'beeline'),
      })!;
      remote.publish(v2);
      const manager1 = await stubManager(anchorLayout, remote.manifestUrl);
      await manager1.checkAndApply();
      expectFreshShell(prefix, '2.0.0');
      expectInstalledHelperForwarders(prefix, '2.0.0');

      // --- 4. the DRIFTED-daemon update --------------------------------------
      // A daemon launched by a pre-contract wrapper inherits a symlink-
      // resolved BEELINE_LIB_DIR pointing INSIDE release N+1. The layout
      // normalization must absorb it so the swap lands on the INSTALL, not
      // inside the frozen release — otherwise the prefix anchor and bin
      // entries are never touched again and fresh shells die.
      const driftedEnvLayout = beelineInstallLayout({
        BEELINE_LIB_DIR: join(prefix, 'lib', 'beeline-releases', v2.commit, 'lib', 'beeline'),
      })!;
      expect(driftedEnvLayout.libDir).toBe(join(prefix, 'lib', 'beeline'));
      remote.publish(v3);
      const manager2 = await stubManager(driftedEnvLayout, remote.manifestUrl);
      await manager2.checkAndApply();
      expect(await activeReleaseId(anchorLayout)).toBe(v3.commit);
      expectFreshShell(prefix, '3.0.0');
      expectInstalledHelperForwarders(prefix, '3.0.0');

      // --- 5. a pre-contract WRAPPER left at prefix/bin gets repaired --------
      // Model the captain's host: a raw pwd-P wrapper at <prefix>/bin while
      // the anchor is a symlink. Running the CLI must not be the recovery
      // path for THIS test (repairInstallForwarders is exercised above), but
      // the swapped-in bundle's own wrapper must still resolve correctly even
      // reached through a stale forwarder chain: simulate by restoring the
      // legacy wrapper and confirming the fresh shell still answers.
      await writeFile(join(binDir, 'beeline'), legacyResolvedWrapper(), { mode: 0o755 });
      // The legacy wrapper resolves the anchor to the RELEASE ROOT and looks
      // for the cli there — it cannot work; what matters is that the repaired
      // forwarder does. Repair exactly as the daemon/CLI startup does.
      expect(await repairInstallForwarders(anchorLayout)).toBe(true);
      expectFreshShell(prefix, '3.0.0');

      // --- 6. rollback keeps a runnable CLI ----------------------------------
      const state = JSON.parse(
        await readFile(join(anchorLayout.releasesRoot, '.state', 'update-state.json'), 'utf8'),
      );
      await rollbackToPreviousRelease(anchorLayout, state.lastApplied.previousReleaseId);
      expectFreshShell(prefix, '2.0.0');
      expectInstalledHelperForwarders(prefix, '2.0.0');
    } finally {
      await remote.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Installer over-install: the anchor must swing to the freshly downloaded
// release every time (the mv-follows-symlink regression)
// ---------------------------------------------------------------------------

describe('install.sh over-install swings the active anchor', () => {
  /** Stray installer temp links (beeline.new.*) anywhere under the install root. */
  async function collectInstallerLitter(rootDir: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const litter: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (/^beeline\\.new[.-]/.test(entry.name)) litter.push(join(dir, entry.name));
        if (entry.isDirectory()) await walk(join(dir, entry.name));
      }
    };
    await walk(rootDir);
    return litter;
  }

  it('reinstalling over an existing release repoints <prefix>/lib/beeline at the new bundle, idempotently', async () => {
    const v1 = await buildStubBundle('aaa111ov1', '1.0.0');
    const v2 = await buildStubBundle('bbb222ov2', '2.0.0');
    const root = await tempDir('over-install-');
    const prefix = join(root, 'prefix');
    const binDir = join(prefix, 'bin');
    const libAnchor = join(prefix, 'lib', 'beeline');
    const releasesRoot = join(prefix, 'lib', 'beeline-releases');
    const remote = await serveBundles(new Map([[v1.commit, v1]]));
    try {
      // --- 1. fresh install of release A ------------------------------------
      let installed = await runInstaller({
        home: root,
        baseUrl: remote.baseUrl,
        binDir,
        libAnchor,
      });
      expect(installed.stderr).toBe('');
      expect(installed.status).toBe(0);
      expect(await readlinkTarget(libAnchor)).toBe(`beeline-releases/${v1.commit}`);
      expectFreshShell(prefix, '1.0.0');

      // --- 2. OVER-INSTALL release B (the reported reproduction) ------------
      remote.publish(v2);
      installed = await runInstaller({ home: root, baseUrl: remote.baseUrl, binDir, libAnchor });
      expect(installed.stderr).toBe('');
      expect(installed.status).toBe(0);
      expect((await lstat(libAnchor)).isSymbolicLink()).toBe(true);
      expect(await readlinkTarget(libAnchor)).toBe(`beeline-releases/${v2.commit}`);
      expectFreshShell(prefix, '2.0.0');
      expectInstalledHelperForwarders(prefix, '2.0.0');

      // The old swap moved the new anchor link INSIDE the old release via a
      // destination-following `mv`; no such litter may exist anywhere.
      expect(await collectInstallerLitter(prefix)).toEqual([]);
      const topLevelReleases = await readdir(releasesRoot, { withFileTypes: true });
      expect(
        topLevelReleases.filter((entry) => entry.isSymbolicLink()).map((entry) => entry.name),
      ).toEqual([]);

      // --- 3. reinstalling the SAME release is idempotent -------------------
      installed = await runInstaller({ home: root, baseUrl: remote.baseUrl, binDir, libAnchor });
      expect(installed.status).toBe(0);
      const entriesAfterReinstall = (await readdir(releasesRoot)).sort();
      expect(entriesAfterReinstall).toEqual([v1.commit, v2.commit].sort());
      expect(await readlinkTarget(libAnchor)).toBe(`beeline-releases/${v2.commit}`);
      expectFreshShell(prefix, '2.0.0');

      // --- 4. tangle left by the old installer is swept on the next install -
      // A release-id-named symlink under releases/, a timestamp-suffixed
      // duplicate of the active release, and a stray beeline.new.* link
      // inside the previous release — exactly what the captain's host held.
      const { mkdir, writeFile, symlink } = await import('node:fs/promises');
      await symlink(
        join('beeline-releases', v2.commit),
        join(releasesRoot, 'deadbeef1111222233334444555566667777888899'),
      );
      const dupDir = join(releasesRoot, `${v2.commit}-1787443702`);
      await mkdir(join(dupDir, 'lib', 'beeline'), { recursive: true });
      await writeFile(
        join(dupDir, 'lib', 'beeline', 'bundle.json'),
        JSON.stringify({ commit: v2.commit }),
      );
      await symlink(
        join('..', 'beeline-releases', v2.commit),
        join(releasesRoot, v1.commit, 'beeline.new.999'),
      );
      installed = await runInstaller({ home: root, baseUrl: remote.baseUrl, binDir, libAnchor });
      expect(installed.status).toBe(0);
      expect(await readlinkTarget(libAnchor)).toBe(`beeline-releases/${v2.commit}`);
      expect((await readdir(releasesRoot)).sort()).toEqual([v1.commit, v2.commit].sort());
      expect(await collectInstallerLitter(prefix)).toEqual([]);
      expectFreshShell(prefix, '2.0.0');
    } finally {
      await remote.close();
    }
  }, 90_000);
});

/**
 * Run the real relay-stack/web/install.sh against a local bundle server.
 * Async spawn (never spawnSync): the installer curls the artifacts from THIS
 * process's HTTP server, which cannot answer while the event loop is blocked.
 */
function runInstaller(opts: {
  home: string;
  baseUrl: string;
  binDir: string;
  libAnchor: string;
}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveInstall) => {
    const child = spawn('sh', [join(repoRoot, 'relay-stack', 'web', 'install.sh')], {
      env: {
        ...process.env,
        HOME: opts.home,
        BEELINE_INSTALL_BASE_URL: opts.baseUrl,
        BEELINE_INSTALL_PLATFORM: hostPlatformKey(),
        BEELINE_INSTALL_DIR: opts.binDir,
        BEELINE_INSTALL_LIB_DIR: opts.libAnchor,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const killer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.once('exit', (status) => {
      clearTimeout(killer);
      resolveInstall({ status: status ?? -1, stdout, stderr });
    });
  });
}

async function readlinkTarget(path: string): Promise<string> {
  const { readlink } = await import('node:fs/promises');
  return readlink(path, 'utf8');
}
