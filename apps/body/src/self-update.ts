/**
 * Daemon self-update: detect a newer published bundle, download + verify it,
 * swap the installed bundle atomically, and restart onto it — never while
 * agent work is running.
 *
 * Boundary note: this module is DAEMON-side machinery. It deliberately does
 * not widen any agent-facing write scope; only the daemon process itself
 * touches the install prefix, on its own trusted schedule.
 *
 * Install layout — THE CONTRACT
 * ============================
 *
 * `<prefix>/lib/beeline` is the ACTIVE BUNDLE ANCHOR. One meaning, everywhere.
 * It is either:
 *   - a SYMLINK → `lib/beeline-releases/<activeReleaseId>` (every install
 *     after its first activation — including everything the current installer
 *     lays down), or
 *   - a real directory on a never-updated legacy install, in one of two
 *     content shapes: "flat" (installer v1 output: beeline-cli.mjs,
 *     beeline-readonly-mcp.mjs, squire-mcp-proxy.mjs and bundle.json directly inside) or already
 *     release-shaped. Migration normalizes flat to release-shaped.
 *
 * A BUNDLE ROOT (what a published tar extracts, what a release dir contains)
 * is always:
 *   bin/<tools>  +  lib/beeline/{beeline-cli.mjs,beeline-readonly-mcp.mjs,squire-mcp-proxy.mjs,bundle.json}
 * so the canonical CLI entrypoint through the anchor is
 *   <prefix>/lib/beeline/lib/beeline/beeline-cli.mjs
 * with <anchor>/beeline-cli.mjs tolerated as the legacy-flat fallback.
 *
 * EVERY consumer of `<prefix>/lib/beeline`, so the two halves cannot drift:
 *   1. relay-stack/web/install.sh      creates/maintains the anchor + stable
 *                                      <prefix>/bin forwarders; converges
 *                                      legacy and mid-migration hosts.
 *   2. scripts/build-beeline-bundle.mjs  the IN-BUNDLE CLI and read-only MCP
 *                                      wrappers resolve $0 WITHOUT following
 *                                      symlinks so that running them through
 *                                      the anchor keeps the ANCHOR path in
 *                                      BEELINE_LIB_DIR; both then resolve their
 *                                      entrypoint under lib/beeline/.
 *   3. self-update.ts beelineInstallLayout()  reads BEELINE_LIB_DIR and
 *                                      normalizes any value found inside a
 *                                      beeline-releases subtree back to the
 *                                      prefix anchor (defence against wrappers
 *                                      already shipped on hosts that resolved
 *                                      symlinks).
 *   4. self-update.ts activateRelease / rollbackToPreviousRelease /
 *      settleUpdateAttemptOnStart /
 *      stageRelease — swap the symlink atomically; resolve entrypoints
 *      tolerantly (both shapes).
 *   5. cli.ts (--version, and every command via repairInstallForwarders) and
 *      self-update-cli.ts (update --status/--rollback) — read identity
 *      through the anchor; repair stale <prefix>/bin forwarders at start.
 *
 * History: #310 made the relaunch path treat the anchor as a bundle root while
 * the installed wrappers treated it as the lib directory itself, and the
 * wrappers' pwd -P resolution leaked release-internal paths into
 * BEELINE_LIB_DIR — after one update executed from a post-swap shell, a daemon
 * computed its whole layout INSIDE the previous release (releases root,
 * bin-dir and all), every subsequent activation patched that nested copy, the
 * prefix-level bin entries were never rewritten, and a fresh-shell `beeline`
 * died with MODULE_NOT_FOUND on <release-root>/beeline-cli.mjs. This block is
 * the fix for that; keep all five consumers agreeing or amend them together.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  compareBundleIdentity,
  parseUpdateManifest,
  resolveManifestUrl,
  type InstalledBundleIdentity,
  type PublishedBundle,
} from './self-update-manifest.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface BeelineInstallLayout {
  /** `<prefix>/bin` — entry wrappers. */
  binDir: string;
  /** `<prefix>/lib/beeline` — active bundle; a symlink once release-based. */
  libDir: string;
  /** `<prefix>/lib/beeline-releases` — every downloaded/staged bundle. */
  releasesRoot: string;
}

/**
 * Resolve the install layout from the environment. The bundled `bin/beeline`
 * wrapper exports BEELINE_LIB_DIR precisely so the CLI can find its own
 * install prefix (`import.meta.url` is defined away inside esbuild bundles).
 * A dev checkout (npm link / tsx) has no layout and self-update reports that
 * honestly instead of guessing.
 */
const RELEASES_SEGMENT = 'beeline-releases';

/**
 * Normalize whatever BEELINE_LIB_DIR a wrapper handed us into the stable
 * prefix anchor (`<prefix>/lib/beeline`). Wrappers shipped before this
 * contract existed exported the SYMLINK-RESOLVED path
 * (`<prefix>/lib/beeline-releases/<id>/lib/beeline`), which would make every
 * derivation below address one frozen release instead of the install — the
 * exact drift behind the MODULE_NOT_FOUND regression. Detect that shape by
 * path segments (not realpath: the anchor must stay unresolved) and climb
 * back out to the prefix.
 */
function anchorLayout(rawLibDir: string): BeelineInstallLayout {
  const libDir = resolve(rawLibDir);
  const segments = libDir.split(/[/\\]/);
  const idx = segments.lastIndexOf(RELEASES_SEGMENT);
  if (idx >= 2 && segments[idx - 1] === 'lib') {
    const prefix = segments.slice(0, idx - 1).join('/');
    return {
      binDir: `${prefix}/bin`,
      libDir: `${prefix}/lib/beeline`,
      releasesRoot: `${prefix}/lib/${RELEASES_SEGMENT}`,
    };
  }
  return {
    // Two levels up from the anchor (<prefix>/lib/beeline): bin/ is the
    // prefix's bin, NOT <prefix>/lib/bin — deriving it one level up was the
    // defect that made activateRelease write its stable forwarders where
    // nothing executed them, leaving stale raw wrappers in <prefix>/bin.
    binDir: resolve(libDir, '../../bin'),
    libDir,
    releasesRoot: resolve(libDir, `../${RELEASES_SEGMENT}`),
  };
}

export function beelineInstallLayout(
  env: NodeJS.ProcessEnv = process.env,
): BeelineInstallLayout | undefined {
  const raw = env.BEELINE_LIB_DIR?.trim();
  if (!raw) return undefined;
  return anchorLayout(raw);
}

/** Canonical first-install layout used by `npx usebeeline connect`. */
export function defaultBeelineInstallLayout(
  env: NodeJS.ProcessEnv = process.env,
): BeelineInstallLayout {
  const home = env.HOME?.trim() || homedir();
  return anchorLayout(resolve(home, '.local', 'lib', 'beeline'));
}

/** Platform key matching build-beeline-bundle.mjs's supported set. */
export function hostPlatformKey(): string {
  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : '';
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!os || !arch)
    throw new Error(`no Beeline bundle exists for ${process.platform}-${process.arch}`);
  return `${os}-${arch}`;
}

// ---------------------------------------------------------------------------
// Identity of the installed bundle
// ---------------------------------------------------------------------------

interface BundleJson {
  schemaVersion?: number;
  name?: string;
  platform?: string;
  commit?: string;
  version?: string;
}

/** Where bundle.json lives: release-shaped bundles nest it, legacy-flat ones keep it at the root. */
function bundleJsonCandidates(bundleDir: string): string[] {
  return [join(bundleDir, 'lib', 'beeline', 'bundle.json'), join(bundleDir, 'bundle.json')];
}

async function readBundleJson(bundleDir: string): Promise<InstalledBundleIdentity | undefined> {
  let raw: string | undefined;
  for (const candidate of bundleJsonCandidates(bundleDir)) {
    try {
      raw = await readFile(candidate, 'utf8');
      break;
    } catch {
      // try the next shape
    }
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as BundleJson;
    return {
      ...(typeof parsed.commit === 'string' && parsed.commit ? { commit: parsed.commit } : {}),
      ...(typeof parsed.version === 'string' && parsed.version ? { version: parsed.version } : {}),
    };
  } catch {
    return undefined;
  }
}

export interface UpdateStateFile {
  lastCheckAt?: number;
  lastCheckResult?: string;
}

/**
 * Install-scoped state lives beside the releases (one install may serve
 * several daemons; the identity of "what is installed" is shared).
 */
function updateStatePath(layout: BeelineInstallLayout): string {
  return join(layout.releasesRoot, '.state', 'update-state.json');
}

export async function readUpdateState(layout: BeelineInstallLayout): Promise<UpdateStateFile> {
  try {
    return JSON.parse(await readFile(updateStatePath(layout), 'utf8')) as UpdateStateFile;
  } catch {
    return {};
  }
}

export async function writeUpdateState(
  layout: BeelineInstallLayout,
  state: UpdateStateFile,
): Promise<void> {
  await mkdir(join(layout.releasesRoot, '.state'), { recursive: true });
  await writeFile(updateStatePath(layout), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * What is this daemon running? Reads the installed bundle itself — never a
 * source checkout, which may not exist on the host. When the installed
 * bundle predates stamped identities, the daemon's own record of what it
 * last applied is used instead.
 */
export async function readInstalledBundleIdentity(
  layout: BeelineInstallLayout,
  _state: UpdateStateFile = {},
): Promise<InstalledBundleIdentity | undefined> {
  const fromDisk = await readBundleJson(layout.libDir);
  if (fromDisk && (fromDisk.commit || fromDisk.version)) return fromDisk;
  return fromDisk;
}

// ---------------------------------------------------------------------------
// Release directories
// ---------------------------------------------------------------------------

function sanitizeReleaseId(id: string): string {
  const cleaned = id.replace(/[^0-9a-zA-Z._-]/g, '-').slice(0, 80);
  return cleaned || 'release';
}

async function pathKind(path: string): Promise<'symlink' | 'directory' | 'missing'> {
  // lstat, never stat: the live install BECOMES a symlink after the first
  // update, and stat would follow it and misread the layout as legacy.
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 'symlink';
    return info.isDirectory() ? 'directory' : 'missing';
  } catch {
    return 'missing';
  }
}

/** The release id the `lib/beeline` symlink currently names ('legacy' for a real dir). */
export async function activeReleaseId(layout: BeelineInstallLayout): Promise<string | undefined> {
  const kind = await pathKind(layout.libDir);
  if (kind === 'directory') return 'legacy';
  if (kind === 'missing') return undefined;
  const { readlink } = await import('node:fs/promises');
  try {
    const target = await readlink(layout.libDir);
    return sanitizeReleaseId(target.split('/').pop() ?? target);
  } catch {
    return undefined;
  }
}

async function fsyncDir(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // best effort — not every filesystem supports directory fsync
  }
}

// ---------------------------------------------------------------------------
// Fetch + stage a release
// ---------------------------------------------------------------------------

/** Directory part of the manifest URL; archive filenames resolve against it. */
export function archiveUrlFor(manifestUrl: string, file: string): string {
  const withoutTrailingSlash = manifestUrl.replace(/\/+$/, '');
  const index = withoutTrailingSlash.lastIndexOf('/');
  if (index < 0) return file;
  return `${withoutTrailingSlash.slice(0, index)}/${file}`;
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`fetching ${url} failed: HTTP ${response.status}`);
  return response.text();
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolveRun({ status: -1, stderr });
    });
    child.once('exit', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stderr });
    });
  });
}

const BUNDLE_ENTRYPOINT = 'lib/beeline/beeline-cli.mjs';
const PI_MCP_ADAPTER_ENTRYPOINT = 'lib/beeline/pi-mcp-adapter.mjs';

/** Entrypoint candidates: release-shaped first, then the legacy-flat fallback. */
function entrypointCandidates(bundleDir: string): string[] {
  return [join(bundleDir, BUNDLE_ENTRYPOINT), join(bundleDir, 'beeline-cli.mjs')];
}

/**
 * Resolve the runnable CLI entrypoint inside a bundle directory, tolerating
 * both content shapes (see the layout contract above). Releases created by
 * stageRelease are always release-shaped; releases preserved from a legacy
 * migration may be flat until normalized.
 */
export async function resolveBundleEntrypoint(bundleDir: string): Promise<string | undefined> {
  for (const candidate of entrypointCandidates(bundleDir)) {
    try {
      await access(candidate, fsConstants.F_OK);
      return candidate;
    } catch {
      // next shape
    }
  }
  return undefined;
}

/** Files whose presence makes an extracted bundle installable. */
function requiredBundlePaths(): string[] {
  return [
    BUNDLE_ENTRYPOINT,
    PI_MCP_ADAPTER_ENTRYPOINT,
  ];
}

/**
 * Download the published archive, verify its sha256 (a mismatch aborts
 * loudly and leaves everything untouched), extract into
 * `releases/<releaseId>`, and smoke-test the new cli before it can ever
 * become active. Idempotent per sha: an already-staged verified release is
 * reused.
 */
export async function stageRelease(
  layout: BeelineInstallLayout,
  manifestUrl: string,
  published: PublishedBundle,
  opts: { fetchImpl?: typeof fetch; smokeTestCli?: boolean; logger?: (line: string) => void } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.logger ?? ((line: string) => console.log(`[body] self-update: ${line}`));
  const releaseId = sanitizeReleaseId(
    published.commit ?? published.version ?? `release-${Date.now()}`,
  );
  const releaseDir = join(layout.releasesRoot, releaseId);

  // Already staged and verified? Reuse it — a retry after a busy-deferred
  // attempt must not redownload 14MB.
  const okMarker = join(releaseDir, '.stage-ok');
  let previouslyVerified = false;
  try {
    const recorded = await readFile(okMarker, 'utf8');
    if (recorded.trim() === published.sha256) return releaseId;
    previouslyVerified = true; // verified for a DIFFERENT digest: never delete this dir
  } catch {
    // not staged yet
  }

  await mkdir(releaseDir, { recursive: true });
  const tempArchive = join(layout.releasesRoot, `.download-${releaseId}-${process.pid}.tar.gz`);
  try {
    log(`downloading ${published.file}`);
    const response = await fetchImpl(archiveUrlFor(manifestUrl, published.file), {
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`downloading ${published.file} failed: HTTP ${response.status}`);
    }
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
      hash.update(buffer);
      chunks.push(buffer);
    }
    const actual = hash.digest('hex');
    if (actual !== published.sha256.toLowerCase()) {
      throw new Error(
        `checksum mismatch for ${published.file}: expected ${published.sha256}, got ${actual} — aborting without touching the installed bundle`,
      );
    }
    await writeFile(tempArchive, Buffer.concat(chunks), { mode: 0o600 });

    // Path-traversal guard, mirroring the installer.
    const entries = (
      await new Promise<string>((resolveList, rejectList) => {
        const child = spawn('tar', ['-tzf', tempArchive], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
        });
        child.once('error', rejectList);
        child.once('exit', (status) =>
          status === 0 ? resolveList(out) : rejectList(new Error('tar -tzf failed')),
        );
      })
    )
      .split('\n')
      .filter(Boolean);
    for (const entry of entries) {
      if (entry.startsWith('/') || entry.split('/').includes('..')) {
        throw new Error(`unsafe path in published bundle: ${entry}`);
      }
    }

    const extract = await run('tar', ['-xzf', tempArchive, '-C', releaseDir], 5 * 60_000);
    if (extract.status !== 0) throw new Error(`extracting bundle failed: ${extract.stderr}`);

    for (const relative of requiredBundlePaths()) {
      try {
        await access(join(releaseDir, relative), fsConstants.F_OK);
      } catch {
        throw new Error(`staged bundle is missing ${relative}`);
      }
    }

    // Smoke-test the new cli BEFORE it can become active: a bundle that cannot
    // even answer --version must never win the symlink.
    if (opts.smokeTestCli !== false) {
      const probe = await run(
        process.execPath,
        [join(releaseDir, BUNDLE_ENTRYPOINT), '--version'],
        60_000,
      );
      if (probe.status !== 0) {
        throw new Error(
          `staged bundle failed its startup smoke test (--version exited ${probe.status})${probe.stderr ? `: ${probe.stderr.trim()}` : ''}`,
        );
      }
    }

    await writeFile(okMarker, `${published.sha256}\n`, 'utf8');
    log(`staged release ${releaseId} (sha256 verified)`);
    return releaseId;
  } catch (error) {
    // A failed stage must leave no half-extracted release behind — the
    // installed bundle is untouched by construction; keep it that way here.
    // A directory that was already verified (or activated) before is NEVER
    // deleted: it may be the live install.
    if (!previouslyVerified) await rm(releaseDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(tempArchive, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Atomic activation
// ---------------------------------------------------------------------------

const FORWARDER_TOOLS = ['beeline', 'buzz-agent', 'buzz-dev-mcp', 'beeline-readonly-mcp'] as const;

function forwarderScript(tool: string): string {
  // Must stay byte-identical with relay-stack/web/install.sh's forwarder
  // heredocs — repairInstallForwarders compares file content against this
  // exact text, and the two writers must never disagree about what a healthy
  // forwarder looks like. The anchor is resolved with cd+pwd -P against REAL
  // directories (prefix/bin), then exported so the bundle wrapper never has
  // to hand node a '..' component through the symlinked anchor.
  return [
    '#!/bin/sh',
    'set -eu',
    'case $0 in',
    '  /*) script_path=$0 ;;',
    '  *) script_path=$(pwd -P)/$0 ;;',
    'esac',
    'prefix_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd -P)',
    'export BEELINE_LIB_DIR="$prefix_dir/lib/beeline"',
    `exec "$prefix_dir/lib/beeline/bin/${tool}" "$@"`,
    '',
  ].join('\n');
}

async function replaceFile(path: string, contents: string, mode: number): Promise<void> {
  const temp = `${path}.new-${process.pid}`;
  await writeFile(temp, contents, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
}

/**
 * Point the live install at `releaseId` with a single atomic rename.
 *
 * The `lib/beeline` symlink is replaced by renaming a freshly-created symlink
 * over it — rename(2) is atomic, so there is no window in which the install
 * is half-replaced. Legacy installs (real directory) are migrated first:
 * the directory moves wholesale into `releases/<legacyId>` (preserving the
 * previous bundle for rollback), then the symlink takes its place. That
 * one-time migration has a millisecond-scale window between the two renames;
 * every subsequent swap is a single rename.
 *
 * Bin entry points are rewritten to stable forwarders into the symlinked
 * bundle, so they never need to change again across releases.
 */
export async function activateRelease(
  layout: BeelineInstallLayout,
  releaseId: string,
): Promise<{ previousReleaseId: string | undefined }> {
  const releaseDir = join(layout.releasesRoot, releaseId);
  await access(join(releaseDir, BUNDLE_ENTRYPOINT), fsConstants.F_OK);

  await mkdir(layout.releasesRoot, { recursive: true });
  await mkdir(layout.binDir, { recursive: true });

  let previousReleaseId = await activeReleaseId(layout);
  const kind = await pathKind(layout.libDir);
  if (kind === 'directory') {
    // Legacy migration. Name the preserved copy after its own identity when
    // it carries one, so rollback language stays meaningful.
    const legacyIdentity = await readBundleJson(layout.libDir);
    const legacyId = sanitizeReleaseId(
      legacyIdentity?.commit ?? legacyIdentity?.version ?? `legacy-${Date.now()}`,
    );
    const legacyDir = join(layout.releasesRoot, legacyId);
    try {
      await access(legacyDir, fsConstants.F_OK);
      // Collision (same id already staged): keep both, suffix this one.
      previousReleaseId = `${legacyId}-${Date.now()}`;
      await rename(layout.libDir, join(layout.releasesRoot, previousReleaseId));
      await normalizeLegacyBundleShape(join(layout.releasesRoot, previousReleaseId));
    } catch {
      await rename(layout.libDir, legacyDir);
      await normalizeLegacyBundleShape(legacyDir);
      previousReleaseId = legacyId;
    }
  }

  const tempLink = `${layout.libDir}.new-${process.pid}`;
  await rm(tempLink, { force: true });
  await symlink(join('beeline-releases', releaseId), tempLink);
  await rename(tempLink, layout.libDir);
  await fsyncDir(dirname(layout.libDir));

  // Stable forwarders in bin/ — identical across releases, so this is setup,
  // not per-update churn.
  await writeBinForwarders(layout, releaseDir);

  return { previousReleaseId };
}

/** Files a legacy-flat bundle keeps at its root; migration moves them into lib/beeline/. */
const LEGACY_FLAT_BUNDLE_FILES = [
  'beeline-cli.mjs',
  'beeline-readonly-mcp.mjs',
  'pi-mcp-adapter.mjs',
  'bundle.json',
];

/**
 * A real-directory install preserved from before self-update existed may hold
 * the bundle FLAT (installer v1 wrote beeline-cli.mjs beside bundle.json).
 * Move those files down into lib/beeline/ so the preserved copy is
 * release-shaped and every consumer — the rollback entrypoint check, the
 * relaunch path, identity reads — sees one shape. Deliberately tolerant of
 * mid-migration directories that carry files at BOTH levels (a repair
 * reinstall through the anchor symlink can produce exactly that): an inner
 * file always wins, a missing inner file is filled from the root, and
 * anything else at the root is left untouched.
 */
export async function normalizeLegacyBundleShape(bundleDir: string): Promise<void> {
  const innerLib = join(bundleDir, 'lib', 'beeline');
  let anyFlat = false;
  for (const name of LEGACY_FLAT_BUNDLE_FILES) {
    try {
      await access(join(bundleDir, name), fsConstants.F_OK);
      anyFlat = true;
      break;
    } catch {
      // not flat here
    }
  }
  if (!anyFlat) return;
  await mkdir(innerLib, { recursive: true });
  for (const name of LEGACY_FLAT_BUNDLE_FILES) {
    try {
      await access(join(innerLib, name), fsConstants.F_OK);
      continue; // inner copy wins; leave the stray root copy alone
    } catch {
      // fill from the root
    }
    await rename(join(bundleDir, name), join(innerLib, name)).catch(() => undefined);
  }
}

/**
 * Rewrite `<prefix>/bin/*` as stable forwarders into the ACTIVE bundle root
 * (`<prefix>/lib/beeline/bin/<tool>` — through the anchor, never a resolved
 * release path). Used by activation and by repairInstallForwarders.
 */
async function writeBinForwarders(
  layout: BeelineInstallLayout,
  activeBundleRoot: string,
): Promise<void> {
  for (const tool of FORWARDER_TOOLS) {
    const target = join(activeBundleRoot, 'bin', tool);
    try {
      await access(target, fsConstants.X_OK);
    } catch {
      continue; // bundle does not ship this tool; leave any existing entry alone
    }
    await replaceFile(join(layout.binDir, tool), forwarderScript(tool), 0o755);
  }
}

/**
 * Heal `<prefix>/bin/*` on installs where a stale or foreign writer left
 * entries that do not follow the anchor contract — most notably installer v1's
 * raw wrappers, whose `pwd -P` resolves the anchor symlink to the release ROOT
 * and execs a path that is not there (the MODULE_NOT_FOUND regression). A
 * daemon that survived the drift can still start (it is launched by node
 * directly, not through the wrapper), so it repairs the shell entries at
 * startup and every later fresh-shell invocation works again. Only meaningful
 * once the install is release-based (anchor is a symlink); legacy real-dir
 * installs are consistent by construction. Idempotent: a matching forwarder
 * is left untouched.
 */
export async function repairInstallForwarders(
  layout: BeelineInstallLayout,
  opts: { logger?: (line: string) => void } = {},
): Promise<boolean> {
  if ((await pathKind(layout.libDir)) !== 'symlink') return false;
  const forwarderPath = join(layout.binDir, 'beeline');
  let current: string | undefined;
  try {
    current = await readFile(forwarderPath, 'utf8');
  } catch {
    current = undefined;
  }
  if (current === forwarderScript('beeline')) return false;
  await mkdir(layout.binDir, { recursive: true });
  // The anchor itself is the active bundle root; access() follows the symlink.
  await writeBinForwarders(layout, layout.libDir);
  opts.logger?.(
    `[body] self-update: repaired <prefix>/bin forwarders to follow the active-bundle anchor (${layout.libDir})`,
  );
  return true;
}

/**
 * Roll the live install back to a previously-active release (single atomic
 * rename, same mechanism as activation).
 */
export async function rollbackToPreviousRelease(
  layout: BeelineInstallLayout,
  previousReleaseId: string,
): Promise<void> {
  const releaseDir = join(layout.releasesRoot, previousReleaseId);
  const entrypoint = await resolveBundleEntrypoint(releaseDir);
  if (!entrypoint) {
    throw new Error(`release ${previousReleaseId} has no runnable CLI entrypoint`);
  }
  const tempLink = `${layout.libDir}.rollback-${process.pid}`;
  await rm(tempLink, { force: true });
  await symlink(join('beeline-releases', previousReleaseId), tempLink);
  await rename(tempLink, layout.libDir);
  await fsyncDir(dirname(layout.libDir));
}

// ---------------------------------------------------------------------------
// One update-attempt record (restart + prove + revert coordination)
// ---------------------------------------------------------------------------

/**
 * The only crash-surviving update transition. The active anchor is current
 * release; this record names the previous release and one candidate attempt.
 * Keeping the record after confirmation/revert makes the outcome visible to
 * an operator without a second pin, handoff file, or request outbox.
 */
export interface UpdateAttemptRecord {
  version: 1;
  from: InstalledBundleIdentity;
  to: InstalledBundleIdentity;
  releaseId: string;
  previousReleaseId: string | undefined;
  appliedAt: number;
  confirmBy: number;
  status: 'pending' | 'confirmed' | 'reverted';
  failure?: string;
  /** Running agent identities that must each complete a functional probe. */
  requiredProbeIds?: string[];
  /** Successfully probed identities; updated atomically under the install lock. */
  confirmedProbeIds?: string[];
}

export function updateAttemptPath(layout: BeelineInstallLayout): string {
  return join(layout.releasesRoot, '.state', 'update-attempt.json');
}

export async function readUpdateAttempt(
  layout: BeelineInstallLayout,
): Promise<UpdateAttemptRecord | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(updateAttemptPath(layout), 'utf8'),
    ) as UpdateAttemptRecord;
    if (
      raw.version !== 1 ||
      typeof raw.appliedAt !== 'number' ||
      typeof raw.confirmBy !== 'number' ||
      typeof raw.releaseId !== 'string' ||
      !['pending', 'confirmed', 'reverted'].includes(raw.status)
    ) {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

export async function writeUpdateAttempt(
  layout: BeelineInstallLayout,
  record: UpdateAttemptRecord,
): Promise<void> {
  await mkdir(join(layout.releasesRoot, '.state'), { recursive: true });
  const path = updateAttemptPath(layout);
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, path);
}

/** Replace the single attempt while the caller holds the install lock. */
export async function replaceUpdateAttempt(
  layout: BeelineInstallLayout,
  record: UpdateAttemptRecord,
): Promise<void> {
  await writeUpdateAttempt(layout, record);
}

/** Test helper: install one update attempt directly. */
export async function writeUpdateAttemptFixture(
  layout: BeelineInstallLayout,
  record: Omit<UpdateAttemptRecord, 'version' | 'confirmBy' | 'status'> &
    Partial<Pick<UpdateAttemptRecord, 'version' | 'confirmBy' | 'status'>>,
): Promise<void> {
  await writeUpdateAttempt(layout, {
    ...record,
    version: record.version ?? 1,
    confirmBy: record.confirmBy ?? record.appliedAt + DEFAULT_UPDATE_CONFIRM_WINDOW_MS,
    status: record.status ?? 'pending',
  });
}

/**
 * How long a freshly-applied update is given to prove itself before the
 * daemon declares it healthy and stops keeping the rollback option hot. If
 * the supervisor throws fatally (or the process dies outright) inside this
 * window, the previous bundle comes back.
 */
export const DEFAULT_UPDATE_CONFIRM_WINDOW_MS = 5 * 60_000;

export type UpdateAttemptSettle =
  | { kind: 'none' }
  | { kind: 'pending'; confirmAt: number; record: UpdateAttemptRecord }
  | { kind: 'rolled-back'; record: UpdateAttemptRecord };

/**
 * Called at daemon start. An unconfirmed update older than the confirm
 * window can only mean the new bundle never became healthy (crash before JS
 * ran, or repeated fatal failure) — roll back before serving anything.
 */
export async function settleUpdateAttemptOnStart(
  layout: BeelineInstallLayout,
  opts: { now?: () => number; confirmWindowMs?: number } = {},
): Promise<UpdateAttemptSettle> {
  const record = await readUpdateAttempt(layout);
  if (!record || record.status !== 'pending') return { kind: 'none' };
  const now = opts.now ?? Date.now;
  const confirmAt = opts.confirmWindowMs
    ? record.appliedAt + opts.confirmWindowMs
    : record.confirmBy;
  if (now() <= confirmAt) {
    return { kind: 'pending', confirmAt, record };
  }
  if (record.previousReleaseId) {
    await rollbackToPreviousRelease(layout, record.previousReleaseId);
  }
  await writeUpdateAttempt(layout, {
    ...record,
    confirmBy: confirmAt,
    status: 'reverted',
    failure: 'update did not serve a verified turn before its confirmation deadline',
  });
  return { kind: 'rolled-back', record };
}

// ---------------------------------------------------------------------------
// The manager (daemon-side loop)
// ---------------------------------------------------------------------------

export interface SelfUpdateManagerOptions {
  layout: BeelineInstallLayout;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** How often the loop wakes at all. Default 60s. */
  tickMs?: number;
  /** Minimum interval between manifest checks. Default 6h. */
  checkIntervalMs?: number;
  /** Delay before the very first automatic check (startup grace). Default 2min. */
  initialDelayMs?: number;
  /** How long to wait for agent work to finish before restarting. Default 30min. */
  idleTimeoutMs?: number;
  idlePollMs?: number;
  confirmWindowMs?: number;
  /** Busy gate: true when no agent work is running anywhere in this daemon. */
  isIdle?: () => boolean;
  /** Running daemon identities captured when the release is applied. */
  requiredProbeIds?: string[];
  fetchImpl?: typeof fetch;
  logger?: (line: string) => void;
}

export function describeIdentity(identity: InstalledBundleIdentity | undefined): string {
  if (!identity) return 'unknown';
  const parts: string[] = [];
  if (identity.version) parts.push(identity.version);
  if (identity.commit) parts.push(identity.commit.slice(0, 12));
  return parts.join(' ') || 'unknown';
}

export class SelfUpdateManager {
  private readonly options: Required<
    Pick<
      SelfUpdateManagerOptions,
      'layout' | 'tickMs' | 'checkIntervalMs' | 'initialDelayMs' | 'idleTimeoutMs' | 'idlePollMs'
    >
  > & { env: NodeJS.ProcessEnv; now: () => number };
  private readonly isIdle: () => boolean;
  private readonly requiredProbeIds: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  private timer: NodeJS.Timeout | undefined;
  private nextCheckAllowedAt = 0;
  private disposed = false;
  private applying = false;
  private deferredBusyNotice = false;
  private lastVerdictLog = '';

  constructor(options: SelfUpdateManagerOptions) {
    const env = options.env ?? process.env;
    const numberEnv = (name: string, fallback: number): number => {
      const raw = env[name];
      if (!raw) return fallback;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : fallback;
    };
    this.options = {
      layout: options.layout,
      tickMs: options.tickMs ?? numberEnv('BEELINE_UPDATE_TICK_MS', 60_000),
      checkIntervalMs:
        options.checkIntervalMs ?? numberEnv('BEELINE_UPDATE_INTERVAL_MS', 6 * 60 * 60_000),
      initialDelayMs:
        options.initialDelayMs ?? numberEnv('BEELINE_UPDATE_INITIAL_DELAY_MS', 2 * 60_000),
      idleTimeoutMs:
        options.idleTimeoutMs ?? numberEnv('BEELINE_UPDATE_IDLE_TIMEOUT_MS', 30 * 60_000),
      idlePollMs: options.idlePollMs ?? 5_000,
      env,
      now: options.now ?? Date.now,
    };
    this.isIdle = options.isIdle ?? (() => true);
    this.requiredProbeIds = [...new Set(options.requiredProbeIds ?? [])].sort();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.logger ?? ((line: string) => console.log(line));
  }

  start(): void {
    if (this.timer || this.disposed) return;
    this.nextCheckAllowedAt = this.options.now() + this.options.initialDelayMs;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.tickMs);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private busy(): boolean {
    return !this.isIdle();
  }

  /** Public single tick — test/CLI synchronization point. */
  async tickOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.applying) return;
    const now = this.options.now();
    const disabled = this.options.env.BEELINE_UPDATE_DISABLE === '1';
    if (disabled || now < this.nextCheckAllowedAt) return;
    this.applying = true;
    try {
      await this.checkAndApply();
    } catch (error) {
      this.log(
        `[body] self-update check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const state = await readUpdateState(this.options.layout);
      await writeUpdateState(this.options.layout, {
        ...state,
        lastCheckAt: now,
        lastCheckResult: `failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300,
        ),
      }).catch(() => undefined);
    } finally {
      this.applying = false;
    }
  }

  async checkAndApply(opts: { force?: boolean } = {}): Promise<void> {
    const now = this.options.now();
    const manifestUrl = resolveManifestUrl(this.options.env);
    const platform = hostPlatformKey();
    const raw = await fetchText(manifestUrl, this.fetchImpl);
    const { bundle } = parseUpdateManifest(raw, platform);
    const state = await readUpdateState(this.options.layout);
    const previousAttempt = await readUpdateAttempt(this.options.layout);
    if (previousAttempt?.status === 'reverted' && !opts.force) {
      const sameCommit = Boolean(
        previousAttempt.to.commit && previousAttempt.to.commit === bundle.commit,
      );
      const sameVersion = Boolean(
        previousAttempt.to.version && previousAttempt.to.version === bundle.version,
      );
      if (sameCommit || sameVersion) {
        const line =
          `release ${describeIdentity(previousAttempt.to)} reverted after a failed served-turn proof; ` +
          'waiting for a newer publish or `beeline update --force`';
        if (line !== this.lastVerdictLog) {
          this.log(`[body] self-update: ${line}`);
          this.lastVerdictLog = line;
        }
        await writeUpdateState(this.options.layout, {
          ...state,
          lastCheckAt: now,
          lastCheckResult: 'skipped: latest attempt reverted',
        });
        return;
      }
    }
    // An explicit --force overrides an indeterminate comparison when the
    // published side at least names itself; otherwise compare normally.
    const installed = await readInstalledBundleIdentity(this.options.layout, state);
    const compared = compareBundleIdentity(installed, bundle);
    const verdict =
      opts.force && compared.kind === 'indeterminate' && (bundle.commit || bundle.version)
        ? ({ kind: 'update-available', published: bundle } as const)
        : compared;

    const verdictLine =
      verdict.kind === 'update-available'
        ? `update available: ${describeIdentity(installed)} -> ${describeIdentity({ commit: verdict.published.commit, version: verdict.published.version })}`
        : verdict.kind === 'current'
          ? 'installed bundle is current'
          : `cannot decide: ${verdict.reason}`;
    if (verdictLine !== this.lastVerdictLog) {
      this.log(`[body] self-update: ${verdictLine}`);
      this.lastVerdictLog = verdictLine;
    }
    await writeUpdateState(this.options.layout, {
      ...state,
      lastCheckAt: now,
      lastCheckResult: verdict.kind === 'update-available' ? verdictLine : verdictLine,
    });

    if (verdict.kind === 'current') return;
    if (verdict.kind === 'indeterminate') {
      this.log(
        '[body] self-update: skipping automatic apply; run `beeline update --force` to apply anyway',
      );
      return;
    }

    await this.apply(verdict.published, manifestUrl);
  }

  private async apply(published: PublishedBundle, manifestUrl: string): Promise<void> {
    const now = this.options.now();
    const state = await readUpdateState(this.options.layout);
    const installed = await readInstalledBundleIdentity(this.options.layout, state);
    const targetIdentity = {
      ...(published.commit ? { commit: published.commit } : {}),
      ...(published.version ? { version: published.version } : {}),
    };

    // Stage (download/verify/extract/smoke) FIRST — none of that touches the
    // live install or interrupts anything, so it may proceed while busy.
    const releaseId = await stageRelease(this.options.layout, manifestUrl, published, {
      fetchImpl: this.fetchImpl,
      logger: (line) => this.log(line.replace(/^\[body\] self-update: /, '[body] self-update: ')),
    });

    // Busy gate: never interrupt a turn, a corner, or intake mid-flight.
    if (this.busy()) {
      if (!this.deferredBusyNotice) {
        this.log(
          '[body] self-update: agent work is running; the restart waits until the daemon is idle',
        );
        this.deferredBusyNotice = true;
      }
      const idle = await this.waitForIdle();
      if (!idle) {
        this.log(
          '[body] self-update: still busy after the idle wait; deferring the restart to the next tick (staged bundle kept)',
        );
        return;
      }
    }
    this.deferredBusyNotice = false;

    const { previousReleaseId } = await activateRelease(this.options.layout, releaseId);
    await writeUpdateAttempt(this.options.layout, {
      version: 1,
      from: installed ?? {},
      to: targetIdentity,
      releaseId,
      previousReleaseId,
      appliedAt: now,
      confirmBy: now + DEFAULT_UPDATE_CONFIRM_WINDOW_MS,
      status: 'pending',
      ...(this.requiredProbeIds.length > 0
        ? { requiredProbeIds: this.requiredProbeIds, confirmedProbeIds: [] }
        : {}),
    });
    await writeUpdateState(this.options.layout, {
      ...state,
      lastCheckAt: now,
      lastCheckResult: 'applied',
    });
    this.log(
      `[body] self-update: Beeline bundle ${describeIdentity(installed)} -> ` +
        `${describeIdentity(targetIdentity)} applied; the daemon coordinator will restart from the stable anchor (previous release kept for rollback).`,
    );
  }

  /** Poll the busy gate until idle or the idle wait budget is spent. */
  async waitForIdle(): Promise<boolean> {
    const deadline = this.options.now() + this.options.idleTimeoutMs;
    for (;;) {
      if (!this.busy()) return true;
      if (this.options.now() >= deadline) return false;
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, Math.min(this.options.idlePollMs, 250)),
      );
    }
  }
}
