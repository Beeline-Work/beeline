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
 *   4. self-update.ts activateRelease / stageRelease — swap the symlink atomically; resolve entrypoints
 *      tolerantly (both shapes).
 *   5. cli.ts (--version, and every command via repairInstallForwarders) and
 *      self-update-cli.ts (update --status) — read identity
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
import { assertInstallTestIsolation } from './lifecycle-test-guard.js';
import {
  access,
  chmod,
  copyFile,
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

/** Release id encoded in a `beeline-releases/<id>` path, if any. */
export function releaseIdFromPath(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined;
  const segments = resolve(path.trim()).split(/[/\\]/);
  const idx = segments.lastIndexOf(RELEASES_SEGMENT);
  const id = idx >= 0 ? segments[idx + 1] : undefined;
  return id ? sanitizeReleaseId(id) : undefined;
}

/**
 * The release this process is actually executing, when `BEELINE_LIB_DIR` or
 * the invocation path still names a `beeline-releases/<id>` tree that belongs
 * to `layout`. The stable launcher exports the unresolved anchor, so this is
 * undefined for a healthy start and the caller falls back to `activeReleaseId`.
 * A pinned ExecStart (or any other launch that leaves a resolved release path
 * in the environment) keeps the old id here even after the anchor has moved —
 * that is what lets an idle helper notice it is stale and restart.
 */
export function runningReleaseId(
  layout: BeelineInstallLayout,
  env: NodeJS.ProcessEnv = process.env,
  invocationPath = process.argv[1],
): string | undefined {
  const releasesRoot = resolve(layout.releasesRoot);
  const anchor = resolve(layout.libDir);
  for (const raw of [env.BEELINE_LIB_DIR, invocationPath]) {
    if (!raw?.trim()) continue;
    const resolved = resolve(raw.trim());
    if (resolved !== anchor && !resolved.startsWith(`${releasesRoot}/`)) continue;
    const id = releaseIdFromPath(resolved);
    if (id) return id;
  }
  return undefined;
}

/** Canonical first-install layout used by `npx usebeeline connect`. */
export function defaultBeelineInstallLayout(
  env: NodeJS.ProcessEnv = process.env,
): BeelineInstallLayout {
  const home = env.HOME?.trim() || homedir();
  return anchorLayout(resolve(home, '.local', 'lib', 'beeline'));
}

/**
 * Locate the installed bundle the way `relay-stack/web/install.sh` laid it
 * out — used when `BEELINE_LIB_DIR` itself is absent, e.g. `npx usebeeline
 * update` runs from a throwaway npm cache, never through the installed
 * `beeline` wrapper that exports it. Honors the installer's own env var
 * precedence rather than guessing: `BEELINE_INSTALL_LIB_DIR` overrides the
 * anchor directly, `BEELINE_INSTALL_DIR` overrides the bin dir (the anchor
 * follows its parent prefix), otherwise the installer's own default under
 * `$HOME/.local`. This only LOCATES a candidate layout — it says nothing
 * about whether a bundle actually exists there; call
 * `readInstalledBundleIdentity` to find out.
 */
export function discoveredBeelineInstallLayout(
  env: NodeJS.ProcessEnv = process.env,
): BeelineInstallLayout {
  const explicitAnchor = env.BEELINE_INSTALL_LIB_DIR?.trim();
  if (explicitAnchor) return anchorLayout(explicitAnchor);
  const explicitBinDir = env.BEELINE_INSTALL_DIR?.trim();
  if (explicitBinDir)
    return anchorLayout(resolve(dirname(resolve(explicitBinDir)), 'lib', 'beeline'));
  return defaultBeelineInstallLayout(env);
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

/** The file name a staged/installed release's recorded-good Node path is kept under (bundle root). */
export const STAGED_NODE_PATH_FILE = '.node-path';

/** The `node` engine minimum a bundle declares in its own bundle.json, if any. */
export async function readBundleEngineMinimum(
  bundleDir: string,
): Promise<readonly [number, number, number] | undefined> {
  for (const candidate of bundleJsonCandidates(bundleDir)) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as { node?: string };
      const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(parsed.node ?? '');
      if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

export function nodeVersionAtLeast(
  version: string,
  minimum: readonly [number, number, number],
): boolean {
  const parts = version.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const actual = parts[index] ?? 0;
    const required = minimum[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}

export interface UpdateStateFile {
  lastCheckAt?: number;
  lastCheckResult?: string;
  lastCheckError?: string;
  /** Last server-announced release for which this install checked the manifest. */
  notifiedReleaseKey?: string;
  /** Verified release staged by the disposable worker, not yet activated. */
  stagedReleaseId?: string;
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
  const path = updateStatePath(layout);
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await fsyncDir(dirname(path));
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
const CODEGRAPH_ENTRYPOINT = 'lib/beeline/codegraph/bin/codegraph';

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
  return [BUNDLE_ENTRYPOINT, PI_MCP_ADAPTER_ENTRYPOINT, CODEGRAPH_ENTRYPOINT];
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
  opts: {
    fetchImpl?: typeof fetch;
    smokeTestCli?: boolean;
    logger?: (line: string) => void;
    force?: boolean;
    deadlineAt?: number;
  } = {},
): Promise<string> {
  assertInstallTestIsolation(layout);
  const deadlineAt = opts.deadlineAt ?? Date.now() + 3 * 60_000;
  const remaining = () => {
    const ms = deadlineAt - Date.now();
    if (ms <= 0) throw new Error('release preparation deadline exceeded');
    return ms;
  };
  const fetchImpl: typeof fetch = (input, init) =>
    (opts.fetchImpl ?? fetch)(input, {
      ...init,
      signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(remaining()),
      ]),
    });
  const log = opts.logger ?? ((line: string) => console.log(`[body] self-update: ${line}`));
  let releaseId = sanitizeReleaseId(
    (published.commit ?? published.version ?? `release-${Date.now()}`) +
      (opts.force ? `-repair-${Date.now()}` : ''),
  );
  let releaseDir = join(layout.releasesRoot, releaseId);

  // Already staged and verified? Reuse it — a retry after a busy-deferred
  // attempt must not redownload 14MB.
  let okMarker = join(releaseDir, '.stage-ok');
  let previouslyVerified = false;
  try {
    const recorded = await readFile(okMarker, 'utf8');
    if (recorded.trim() === published.sha256 && !opts.force) return releaseId;
    // Different bytes under the same published identity get a new immutable directory.
    releaseId = sanitizeReleaseId(`${releaseId}-${published.sha256.slice(0, 12)}`);
    releaseDir = join(layout.releasesRoot, releaseId);
    okMarker = join(releaseDir, '.stage-ok');
    const matching = await readFile(okMarker, 'utf8').catch(() => '');
    if (matching.trim() === published.sha256 && !opts.force) return releaseId;
    previouslyVerified = Boolean(matching);
  } catch {
    // not staged yet
  }
  // Never extract over the process's immutable release, even if its marker
  // was lost in an interrupted legacy migration or manually damaged.
  if ((await activeReleaseId(layout)) === releaseId) {
    releaseId = sanitizeReleaseId(`${releaseId}-repair-${Date.now()}`);
    releaseDir = join(layout.releasesRoot, releaseId);
    okMarker = join(releaseDir, '.stage-ok');
    previouslyVerified = false;
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
        const timer = setTimeout(() => child.kill('SIGKILL'), Math.min(30_000, remaining()));
        let out = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          rejectList(error);
        });
        child.once('exit', (status) => {
          clearTimeout(timer);
          status === 0 ? resolveList(out) : rejectList(new Error('tar -tzf failed'));
        });
      })
    )
      .split('\n')
      .filter(Boolean);
    for (const entry of entries) {
      if (entry.startsWith('/') || entry.split('/').includes('..')) {
        throw new Error(`unsafe path in published bundle: ${entry}`);
      }
    }

    const extract = await run(
      'tar',
      ['-xzf', tempArchive, '-C', releaseDir],
      Math.min(60_000, remaining()),
    );
    if (extract.status !== 0) throw new Error(`extracting bundle failed: ${extract.stderr}`);

    for (const relative of requiredBundlePaths()) {
      try {
        await access(join(releaseDir, relative), fsConstants.F_OK);
      } catch {
        throw new Error(`staged bundle is missing ${relative}`);
      }
    }
    const identity = await readInstalledBundleIdentity({ ...layout, libDir: releaseDir });
    if (
      (published.commit && identity?.commit !== published.commit) ||
      (published.version && identity?.version !== published.version)
    )
      throw new Error('staged bundle identity differs from the published manifest');

    // Record a Node runtime that satisfies this release's own engine minimum
    // as an absolute path, so every later invocation of this release --
    // including through a service manager's generated unit, whose PATH is
    // never this process's PATH -- can run it without re-resolving `node` on
    // a possibly-older PATH (the exact gap that left a crash-on-import helper
    // unit restart-looping for 8+ hours: the per-agent process staging the
    // release had a good node via its own PATH drop-in; the brand new helper
    // unit's generated PATH did not). build-beeline-bundle.mjs's wrapper is
    // the one reader of this file.
    const engineMinimum = await readBundleEngineMinimum(releaseDir);
    if (engineMinimum) {
      if (!nodeVersionAtLeast(process.versions.node, engineMinimum)) {
        throw new Error(
          `staged bundle requires Node.js >=${engineMinimum.join('.')}, but this process is ` +
            `running Node.js ${process.versions.node} — install a satisfying Node runtime and retry`,
        );
      }
      await writeFile(join(releaseDir, STAGED_NODE_PATH_FILE), `${process.execPath}\n`, 'utf8');
    }

    // Smoke-test the new cli BEFORE it can become active: a bundle that cannot
    // even answer --version must never win the symlink.
    if (opts.smokeTestCli !== false) {
      const probe = await run(
        process.execPath,
        [join(releaseDir, BUNDLE_ENTRYPOINT), '--version'],
        Math.min(60_000, remaining()),
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

const FORWARDER_TOOLS = [
  'beeline',
  'buzz-agent',
  'buzz-dev-mcp',
  'beeline-readonly-mcp',
  'codegraph',
] as const;

/**
 * Bin-name aliases: installed wrapper name -> the bundle tool it execs. The
 * published npm package declares BOTH bins (`packages/usebeeline/package.json`:
 * `usebeeline` and `beeline` point at the same entry), but the install only
 * laid down `beeline`, so an installed host had no `usebeeline` on PATH at
 * all. The alias file is byte-identical to the target tool's forwarder — it
 * derives <prefix> from its own $0, so the different filename resolves the
 * same way — and is rewritten on every activation like any other bin entry,
 * so it survives update swaps by construction.
 */
const FORWARDER_ALIASES: Readonly<Record<string, (typeof FORWARDER_TOOLS)[number]>> = {
  usebeeline: 'beeline',
};

function forwarderScript(tool: string): string {
  const common = [
    '#!/bin/sh',
    'set -eu',
    'case $0 in',
    '  /*) script_path=$0 ;;',
    '  *) script_path=$(pwd -P)/$0 ;;',
    'esac',
    'prefix_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd -P)',
    'export BEELINE_LIB_DIR="$prefix_dir/lib/beeline"',
  ];
  if (tool !== 'beeline')
    return [...common, `exec "$prefix_dir/lib/beeline/bin/${tool}" "$@"`, ''].join('\n');
  return [
    ...common,
    'beeline_node=${BEELINE_NODE:-}',
    'if [ -z "$beeline_node" ] && [ -f "$prefix_dir/lib/beeline-node-path" ]; then beeline_node=$(cat "$prefix_dir/lib/beeline-node-path"); fi',
    'if [ -z "$beeline_node" ]; then beeline_node=$(command -v node); fi',
    'if [ "${1:-}" = helper-bootstrap ] || { [ "${1:-}" = daemon ] && [ "${2:-}" = --machine ]; }; then',
    '  export BEELINE_BOOT_LAUNCHER_PID=$$ BEELINE_BOOT_LAUNCHER_PARENT_PID=$PPID',
    '  entry=$("$beeline_node" "$prefix_dir/lib/beeline-bootstrap.mjs" select-release)',
    '  case $(uname -s) in Linux) export BEELINE_MANAGED_BY_SYSTEMD=1 ;; Darwin) export BEELINE_MANAGED_BY_LAUNCHD=1 ;; esac',
    '  exec "$beeline_node" "$entry" daemon --machine',
    'fi',
    'exec "$beeline_node" "$prefix_dir/lib/beeline-bootstrap.mjs" "$@"',
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
 * existing bundle without overwriting its files), then the symlink takes its place. That
 * one-time migration has a millisecond-scale window between the two renames;
 * every subsequent swap is a single rename.
 *
 * Bin entry points are rewritten to stable forwarders into the symlinked
 * bundle, so they never need to change again across releases.
 */
export async function activateRelease(
  layout: BeelineInstallLayout,
  releaseId: string,
): Promise<void> {
  assertInstallTestIsolation(layout);
  let releaseDir = join(layout.releasesRoot, releaseId);
  await access(join(releaseDir, BUNDLE_ENTRYPOINT), fsConstants.F_OK);

  await mkdir(layout.releasesRoot, { recursive: true });
  await mkdir(layout.binDir, { recursive: true });

  const kind = await pathKind(layout.libDir);
  if (kind === 'directory') {
    // Legacy migration. Name the preserved copy after its own identity when
    // it carries one.
    const legacyIdentity = await readBundleJson(layout.libDir);
    const legacyId = sanitizeReleaseId(
      legacyIdentity?.commit ?? legacyIdentity?.version ?? `legacy-${Date.now()}`,
    );
    const legacyDir = join(layout.releasesRoot, legacyId);
    try {
      await access(legacyDir, fsConstants.F_OK);
      // Collision (same id already staged): keep both, suffix this one.
      const preservedId = `${legacyId}-${Date.now()}`;
      await rename(layout.libDir, join(layout.releasesRoot, preservedId));
      await normalizeLegacyBundleShape(join(layout.releasesRoot, preservedId));
    } catch {
      await rename(layout.libDir, legacyDir);
      await normalizeLegacyBundleShape(legacyDir);
    }
  }

  const tempLink = `${layout.libDir}.new-${process.pid}`;
  await rm(tempLink, { force: true });
  await symlink(join('beeline-releases', releaseId), tempLink);
  await rename(tempLink, layout.libDir);
  await fsyncDir(dirname(layout.libDir));

  // Stable forwarders in bin/ — identical across releases, so this is setup,
  // not per-update churn.
  await installRecoveryLauncher(layout, releaseDir);
  await writeBinForwarders(layout, releaseDir);
}

async function installRecoveryLauncher(
  layout: BeelineInstallLayout,
  releaseDir: string,
): Promise<void> {
  const bootstrap = join(releaseDir, 'lib/beeline/recovery-cli.mjs');
  if (
    await access(bootstrap).then(
      () => true,
      () => false,
    )
  ) {
    const stable = resolve(layout.libDir, '../beeline-bootstrap.mjs');
    const temporary = `${stable}.${process.pid}.tmp`;
    await copyFile(bootstrap, temporary);
    await rename(temporary, stable);
    await replaceFile(
      resolve(layout.libDir, '../beeline-node-path'),
      `${process.execPath}\n`,
      0o600,
    );
  }
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
 * release-shaped so entrypoint resolution and identity reads see one shape. Deliberately tolerant of
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
  const entries: ReadonlyArray<readonly [string, (typeof FORWARDER_TOOLS)[number]]> = [
    ...FORWARDER_TOOLS.map((tool) => [tool, tool] as const),
    ...Object.entries(FORWARDER_ALIASES).map(([alias, tool]) => [alias, tool] as const),
  ];
  for (const [name, tool] of entries) {
    const target = join(activeBundleRoot, 'bin', tool);
    try {
      await access(target, fsConstants.X_OK);
    } catch {
      continue; // bundle does not ship this tool; leave any existing entry alone
    }
    const independent = await access(resolve(layout.libDir, '../beeline-bootstrap.mjs')).then(
      () => true,
      () => false,
    );
    await replaceFile(
      join(layout.binDir, name),
      independent || tool !== 'beeline'
        ? forwarderScript(tool)
        : forwarderScript('legacy-beeline').replace('/bin/legacy-beeline', '/bin/beeline'),
      0o755,
    );
  }
}

/**
 * Heal `<prefix>/bin/*` on installs where a stale or foreign writer left
 * entries that do not follow the anchor contract — most notably installer v1's
 * raw wrappers, whose `pwd -P` resolves the anchor symlink to the release ROOT
 * and execs a path that is not there (the MODULE_NOT_FOUND regression). A
 * daemon that survived the drift can still start (it is launched by node
 * directly, not through the wrapper), so it repairs the shell entries at
 * startup and every later fresh-shell invocation works again. Bin-name
 * aliases (FORWARDER_ALIASES) are healed the same way, so a host installed
 * before an alias existed gains it on the next daemon start without waiting
 * for an update. Only meaningful once the install is release-based (anchor
 * is a symlink); legacy real-dir installs are consistent by construction.
 * Idempotent: a matching forwarder is left untouched.
 */
export async function repairInstallForwarders(
  layout: BeelineInstallLayout,
  opts: { logger?: (line: string) => void } = {},
): Promise<boolean> {
  assertInstallTestIsolation(layout);
  if ((await pathKind(layout.libDir)) !== 'symlink') return false;
  await installRecoveryLauncher(layout, layout.libDir);
  const forwarderHealthy = async (name: string, tool: string): Promise<boolean> => {
    let current: string | undefined;
    try {
      current = await readFile(join(layout.binDir, name), 'utf8');
    } catch {
      current = undefined;
    }
    const independent = await access(resolve(layout.libDir, '../beeline-bootstrap.mjs')).then(
      () => true,
      () => false,
    );
    const expected =
      independent || tool !== 'beeline'
        ? forwarderScript(tool)
        : forwarderScript('legacy-beeline').replace('/bin/legacy-beeline', '/bin/beeline');
    return current === expected;
  };
  let healthy = await forwarderHealthy('beeline', 'beeline');
  for (const [alias, tool] of Object.entries(FORWARDER_ALIASES)) {
    if (!(await forwarderHealthy(alias, tool))) healthy = false;
  }
  if (healthy) return false;
  await mkdir(layout.binDir, { recursive: true });
  // The anchor itself is the active bundle root; access() follows the symlink.
  await writeBinForwarders(layout, layout.libDir);
  opts.logger?.(
    `[body] self-update: repaired <prefix>/bin forwarders to follow the active-bundle anchor (${layout.libDir})`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Compatibility entry for one explicit preparation
// ---------------------------------------------------------------------------

export interface SelfUpdateManagerOptions {
  layout: BeelineInstallLayout;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetchImpl?: typeof fetch;
  logger?: (line: string) => void;
  /** Download, verify, and smoke-test only. The serving daemon activates after it proves idle. */
  stageOnly?: boolean;
}

export function describeIdentity(identity: InstalledBundleIdentity | undefined): string {
  if (!identity) return 'unknown';
  const parts: string[] = [];
  if (identity.version) parts.push(identity.version);
  if (identity.commit) parts.push(identity.commit.slice(0, 12));
  return parts.join(' ') || 'unknown';
}

/** Compatibility facade for callers that prepare one release. It owns no lifecycle or idle loop. */
export class SelfUpdateManager {
  constructor(private readonly options: SelfUpdateManagerOptions) {}
  async checkAndApply(opts: { force?: boolean } = {}): Promise<void> {
    const target = await prepareLatestRelease(this.options.layout, {
      ...this.options,
      force: opts.force,
    });
    if (!this.options.stageOnly) await activateRelease(this.options.layout, target.releaseId);
  }
}

export async function prepareLatestRelease(
  layout: BeelineInstallLayout,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    logger?: (line: string) => void;
    force?: boolean;
    deadlineAt?: number;
    manifest?: { url: string; bundle: PublishedBundle };
  } = {},
): Promise<{ releaseId: string; identity: InstalledBundleIdentity }> {
  try {
    const manifestUrl = options.manifest?.url ?? resolveManifestUrl(options.env ?? process.env);
    const bundle =
      options.manifest?.bundle ??
      parseUpdateManifest(
        await fetchText(manifestUrl, options.fetchImpl ?? fetch),
        hostPlatformKey(),
      ).bundle;
    const pending = (await readUpdateState(layout)).stagedReleaseId;
    const pendingDigest = pending
      ? await readFile(join(layout.releasesRoot, pending, '.stage-ok'), 'utf8').catch(() => '')
      : '';
    const releaseId =
      !options.force && pending && pendingDigest.trim() === bundle.sha256
        ? pending
        : await stageRelease(layout, manifestUrl, bundle, {
            fetchImpl: options.fetchImpl,
            logger: options.logger,
            force: options.force,
            deadlineAt: options.deadlineAt,
          });
    await writeUpdateState(layout, {
      lastCheckAt: Date.now(),
      lastCheckResult: 'verified',
      stagedReleaseId: releaseId,
    });
    return { releaseId, identity: { version: bundle.version, commit: bundle.commit } };
  } catch (error) {
    await writeUpdateState(layout, {
      ...(await readUpdateState(layout)),
      lastCheckAt: Date.now(),
      lastCheckResult: 'unconfirmed',
      lastCheckError: String(error),
    }).catch(() => undefined);
    throw error;
  }
}
