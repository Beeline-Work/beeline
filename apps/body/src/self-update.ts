import { activateRelease, prepareLatestRelease, type SelfUpdateManagerOptions } from './self-update-activate-release.js';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { assertInstallTestIsolation } from './lifecycle-test-guard.js';
import { access, chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type InstalledBundleIdentity, type PublishedBundle } from './self-update-manifest.js';
export { activateRelease, normalizeLegacyBundleShape, repairInstallForwarders, type SelfUpdateManagerOptions, describeIdentity, prepareLatestRelease, pruneHelperReleases } from './self-update-activate-release.js';



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
export const RELEASES_SEGMENT = 'beeline-releases';


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
export function anchorLayout(rawLibDir: string): BeelineInstallLayout {
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
 * Locate the installed bundle the way `web/install.sh` laid it
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

export interface BundleJson {
  schemaVersion?: number;
  name?: string;
  platform?: string;
  commit?: string;
  version?: string;
}


/** Where bundle.json lives: release-shaped bundles nest it, legacy-flat ones keep it at the root. */
export function bundleJsonCandidates(bundleDir: string): string[] {
  return [join(bundleDir, 'lib', 'beeline', 'bundle.json'), join(bundleDir, 'bundle.json')];
}


export async function readBundleJson(bundleDir: string): Promise<InstalledBundleIdentity | undefined> {
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
  /** The bundle displaced by the last activation, kept for rollback. */
  previousReleaseId?: string;
}


/**
 * Install-scoped state lives beside the releases (one install may serve
 * several daemons; the identity of "what is installed" is shared).
 */
export function updateStatePath(layout: BeelineInstallLayout): string {
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

export function sanitizeReleaseId(id: string): string {
  const cleaned = id.replace(/[^0-9a-zA-Z._-]/g, '-').slice(0, 80);
  return cleaned || 'release';
}


export async function pathKind(path: string): Promise<'symlink' | 'directory' | 'missing'> {
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


export async function fsyncDir(path: string): Promise<void> {
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


export async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, { signal: undefined });
  if (!response.ok) throw new Error(`fetching ${url} failed: HTTP ${response.status}`);
  return response.text();
}


export function run(
  command: string,
  args: string[],
  _timeoutMs: number,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once('error', () => {
      resolveRun({ status: -1, stderr });
    });
    child.once('exit', (status) => {
      resolveRun({ status, stderr });
    });
  });
}


export const BUNDLE_ENTRYPOINT = 'lib/beeline/beeline-cli.mjs';

export const PI_MCP_ADAPTER_ENTRYPOINT = 'lib/beeline/pi-mcp-adapter.mjs';

export const CODEGRAPH_ENTRYPOINT = 'lib/beeline/codegraph/bin/codegraph';


/** Entrypoint candidates: release-shaped first, then the legacy-flat fallback. */
export function entrypointCandidates(bundleDir: string): string[] {
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
export function requiredBundlePaths(): string[] {
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
      signal: undefined,
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
        child.once('error', (error) => {
          rejectList(error);
        });
        child.once('exit', (status) => {
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

export const FORWARDER_TOOLS = [
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
export const FORWARDER_ALIASES: Readonly<Record<string, (typeof FORWARDER_TOOLS)[number]>> = {
  usebeeline: 'beeline',
};


export function forwarderScript(tool: string): string {
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


export async function replaceFile(path: string, contents: string, mode: number): Promise<void> {
  const temp = `${path}.new-${process.pid}`;
  await writeFile(temp, contents, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
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
