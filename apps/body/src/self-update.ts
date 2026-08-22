/**
 * Daemon self-update: detect a newer published bundle, download + verify it,
 * swap the installed bundle atomically, and restart onto it — never while
 * agent work is running.
 *
 * Boundary note: this module is DAEMON-side machinery. It deliberately does
 * not widen any agent-facing write scope; only the daemon process itself
 * touches the install prefix, on its own trusted schedule.
 *
 * Install layout (the one `relay-stack/web/install.sh` produces):
 *   <prefix>/bin/beeline            sh wrapper
 *   <prefix>/bin/buzz-agent …       binaries / wrappers
 *   <prefix>/lib/beeline/           the running bundle (cli mjs files + bundle.json)
 *
 * After the first self-update the layout becomes release-based so that the
 * swap is a single atomic rename:
 *   <prefix>/lib/beeline-releases/<releaseId>/   full extracted bundles
 *   <prefix>/lib/beeline            SYMLINK → beeline-releases/<active>
 * The previous release is kept for rollback. A legacy install (real directory
 * at lib/beeline) is migrated in place on first activation.
 */
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  type Dirent,
} from 'node:fs';
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
import { dirname, join, resolve } from 'node:path';
import { launchRuntimeDaemon } from './runtime.js';
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
export function beelineInstallLayout(env: NodeJS.ProcessEnv = process.env): BeelineInstallLayout | undefined {
  const libDir = env.BEELINE_LIB_DIR?.trim();
  if (!libDir) return undefined;
  return {
    binDir: resolve(libDir, '../bin'),
    libDir: resolve(libDir),
    releasesRoot: resolve(libDir, '../beeline-releases'),
  };
}

/** Platform key matching build-beeline-bundle.mjs's supported set. */
export function hostPlatformKey(): string {
  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : '';
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!os || !arch) throw new Error(`no Beeline bundle exists for ${process.platform}-${process.arch}`);
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

async function readBundleJson(bundleDir: string): Promise<InstalledBundleIdentity | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(bundleDir, 'bundle.json'), 'utf8');
  } catch {
    return undefined;
  }
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
  lastApplied?: { releaseId: string; previousReleaseId?: string; identity: InstalledBundleIdentity; at: number };
  lastRollback?: { releaseId: string; toReleaseId: string; reason: string; at: number };
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

export async function writeUpdateState(layout: BeelineInstallLayout, state: UpdateStateFile): Promise<void> {
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
  state: UpdateStateFile = {},
): Promise<InstalledBundleIdentity | undefined> {
  const fromDisk = await readBundleJson(layout.libDir);
  if (fromDisk && (fromDisk.commit || fromDisk.version)) return fromDisk;
  if (state.lastApplied?.identity) return state.lastApplied.identity;
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

async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectHash);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stderr: string }> {
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

/** Files whose presence makes an extracted bundle installable. */
function requiredBundlePaths(): string[] {
  return [BUNDLE_ENTRYPOINT];
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
  const releaseId = sanitizeReleaseId(published.commit ?? published.version ?? `release-${Date.now()}`);
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
    const entries = (await new Promise<string>((resolveList, rejectList) => {
      const child = spawn('tar', ['-tzf', tempArchive], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.once('error', rejectList);
      child.once('exit', (status) => (status === 0 ? resolveList(out) : rejectList(new Error('tar -tzf failed'))));
    })).split('\n').filter(Boolean);
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
      const probe = await run(process.execPath, [join(releaseDir, BUNDLE_ENTRYPOINT), '--version'], 60_000);
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

const FORWARDER_TOOLS = ['beeline', 'buzz-agent', 'buzz-dev-mcp', 'buzz-readonly-mcp'] as const;

function forwarderScript(tool: string): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
    `exec "$bin_dir/../lib/beeline/bin/${tool}" "$@"`,
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
    } catch {
      await rename(layout.libDir, legacyDir);
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
  for (const tool of FORWARDER_TOOLS) {
    const target = join(releaseDir, 'bin', tool);
    try {
      await access(target, fsConstants.X_OK);
    } catch {
      continue; // bundle does not ship this tool; leave any existing entry alone
    }
    await replaceFile(join(layout.binDir, tool), forwarderScript(tool), 0o755);
  }

  return { previousReleaseId };
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
  await access(join(releaseDir, BUNDLE_ENTRYPOINT), fsConstants.F_OK);
  const tempLink = `${layout.libDir}.rollback-${process.pid}`;
  await rm(tempLink, { force: true });
  await symlink(join('beeline-releases', previousReleaseId), tempLink);
  await rename(tempLink, layout.libDir);
  await fsyncDir(dirname(layout.libDir));
}

// ---------------------------------------------------------------------------
// Pending-update journal (restart + rollback coordination)
// ---------------------------------------------------------------------------

export interface PendingUpdateRecord {
  from: InstalledBundleIdentity;
  to: InstalledBundleIdentity;
  releaseId: string;
  previousReleaseId: string | undefined;
  appliedAt: number;
}

export function pendingUpdatePath(layout: BeelineInstallLayout): string {
  return join(layout.releasesRoot, '.state', 'pending-update.json');
}

export async function readPendingUpdate(layout: BeelineInstallLayout): Promise<PendingUpdateRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(pendingUpdatePath(layout), 'utf8')) as PendingUpdateRecord;
    if (typeof raw.appliedAt !== 'number' || typeof raw.releaseId !== 'string') return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

async function writePendingUpdate(layout: BeelineInstallLayout, record: PendingUpdateRecord): Promise<void> {
  await mkdir(join(layout.releasesRoot, '.state'), { recursive: true });
  await writeFile(pendingUpdatePath(layout), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function clearPendingUpdate(layout: BeelineInstallLayout): Promise<void> {
  await rm(pendingUpdatePath(layout), { force: true });
}

/** Test/CLI helper: write a pending-update journal directly. */
export async function writePendingUpdateFixture(
  layout: BeelineInstallLayout,
  record: PendingUpdateRecord,
): Promise<void> {
  await mkdir(join(layout.releasesRoot, '.state'), { recursive: true });
  await writeFile(pendingUpdatePath(layout), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * How long a freshly-applied update is given to prove itself before the
 * daemon declares it healthy and stops keeping the rollback option hot. If
 * the supervisor throws fatally (or the process dies outright) inside this
 * window, the previous bundle comes back.
 */
export const DEFAULT_UPDATE_CONFIRM_WINDOW_MS = 5 * 60_000;

export type PendingUpdateSettle =
  | { kind: 'none' }
  | { kind: 'pending'; confirmAt: number; record: PendingUpdateRecord }
  | { kind: 'rolled-back'; record: PendingUpdateRecord };

/**
 * Called at daemon start. An unconfirmed update older than the confirm
 * window can only mean the new bundle never became healthy (crash before JS
 * ran, or repeated fatal failure) — roll back before serving anything.
 */
export async function settlePendingUpdateOnStart(
  layout: BeelineInstallLayout,
  opts: { now?: () => number; confirmWindowMs?: number } = {},
): Promise<PendingUpdateSettle> {
  const record = await readPendingUpdate(layout);
  if (!record) return { kind: 'none' };
  const now = opts.now ?? Date.now;
  const windowMs = opts.confirmWindowMs ?? DEFAULT_UPDATE_CONFIRM_WINDOW_MS;
  if (now() - record.appliedAt <= windowMs) {
    return { kind: 'pending', confirmAt: record.appliedAt + windowMs, record };
  }
  if (record.previousReleaseId) {
    await rollbackToPreviousRelease(layout, record.previousReleaseId);
  }
  await clearPendingUpdate(layout);
  const state = await readUpdateState(layout);
  await writeUpdateState(layout, {
    ...state,
    lastRollback: {
      releaseId: record.releaseId,
      toReleaseId: record.previousReleaseId ?? 'unknown',
      reason: 'update never confirmed healthy',
      at: now(),
    },
  });
  return { kind: 'rolled-back', record };
}

/** Mark a pending update healthy: clear the journal, keep the state record. */
export async function confirmPendingUpdate(layout: BeelineInstallLayout): Promise<boolean> {
  const record = await readPendingUpdate(layout);
  if (!record) return false;
  await clearPendingUpdate(layout);
  return true;
}

// ---------------------------------------------------------------------------
// CLI → daemon restart requests
// ---------------------------------------------------------------------------

function updateRequestPath(runtimeDir: string): string {
  return join(runtimeDir, 'update-request.json');
}

/**
 * Ask any running daemon(s) to swap onto the now-installed bundle and
 * restart, honouring their own busy gate. `beeline update` writes these; the
 * manager consumes them within one tick.
 */
export async function queueRestartRequest(configPath: string): Promise<void> {
  await writeFile(
    updateRequestPath(dirname(configPath)),
    `${JSON.stringify({ requestedAt: Date.now() })}\n`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// The manager (daemon-side loop)
// ---------------------------------------------------------------------------

export interface SelfUpdateManagerOptions {
  layout: BeelineInstallLayout;
  /**
   * This daemon's durable state dir (dirname of runtime.json) — where
   * `beeline update` leaves an update request the manager consumes within
   * one tick. Install-scoped state lives in the layout, not here.
   */
  watchRuntimeDirs?: string[];
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
  /** Room-visible notice publisher (best-effort). */
  notify?: (text: string) => Promise<void> | void;
  /** Called when the manager has swapped and wants the process restarted. */
  requestRestart?: () => void;
  /**
   * Write the rollback journal + ask for a restart after activating. True
   * for the DAEMON path (it hands its own process over). The `beeline
   * update` CLI sets this false: it swaps the install but starts nothing,
   * so no journal may exist claiming a restart happened — otherwise the
   * next start would roll back a bundle that was never given a chance.
   */
  restartHandover?: boolean;
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
    Pick<SelfUpdateManagerOptions, 'layout' | 'tickMs' | 'checkIntervalMs' | 'initialDelayMs' | 'idleTimeoutMs' | 'idlePollMs'>
  > & { watchRuntimeDirs: string[]; env: NodeJS.ProcessEnv; now: () => number };
  private readonly isIdle: () => boolean;
  private readonly notifyFn: (text: string) => Promise<void> | void;
  private readonly requestRestartCb: (() => void) | undefined;
  private readonly restartHandover: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  private timer: NodeJS.Timeout | undefined;
  private nextCheckAllowedAt = 0;
  private disposed = false;
  private applying = false;
  private deferredBusyNotice = false;
  private lastVerdictLog = '';
  /** Set once a newer bundle is LIVE and the process should hand over. */
  restartPending = false;
  private unconfirmedReleaseId: string | undefined;
  private attachedSupervisor: { isWorkspaceIdle(): boolean; broadcastDaemonNotice(text: string): Promise<void> } | undefined;

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
      watchRuntimeDirs: options.watchRuntimeDirs ?? [],
      tickMs: options.tickMs ?? numberEnv('BEELINE_UPDATE_TICK_MS', 60_000),
      checkIntervalMs: options.checkIntervalMs ?? numberEnv('BEELINE_UPDATE_INTERVAL_MS', 6 * 60 * 60_000),
      initialDelayMs: options.initialDelayMs ?? numberEnv('BEELINE_UPDATE_INITIAL_DELAY_MS', 2 * 60_000),
      idleTimeoutMs: options.idleTimeoutMs ?? numberEnv('BEELINE_UPDATE_IDLE_TIMEOUT_MS', 30 * 60_000),
      idlePollMs: options.idlePollMs ?? 5_000,
      env,
      now: options.now ?? Date.now,
    };
    this.isIdle = options.isIdle ?? (() => true);
    this.notifyFn = options.notify ?? (async () => undefined);
    this.requestRestartCb = options.requestRestart;
    this.restartHandover = options.restartHandover !== false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.logger ?? ((line: string) => console.log(line));
  }

  /** Wire the current WorkspaceSupervisor instance (recreated each run loop). */
  attachSupervisor(
    supervisor: { isWorkspaceIdle(): boolean; broadcastDaemonNotice(text: string): Promise<void> } | undefined,
  ): void {
    this.attachedSupervisor = supervisor;
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

  /** True while an applied-but-unconfirmed update could still need rollback. */
  hasUnconfirmedUpdate(): boolean {
    return this.unconfirmedReleaseId !== undefined;
  }

  markUpdateConfirmed(): void {
    this.unconfirmedReleaseId = undefined;
  }

  /**
   * Spawn the replacement daemon from the ACTIVE (post-swap) bundle. Must be
   * called only after the caller fully drained its supervisor — this is the
   * handover point.
   */
  async launchReplacement(configPath: string): Promise<number> {
    const entrypoint = join(this.options.layout.libDir, BUNDLE_ENTRYPOINT);
    const foreground = this.options.env.BEELINE_DAEMON_BACKGROUND !== '1';
    return launchRuntimeDaemon(configPath, { entrypoint, foreground });
  }

  /** Relaunch from a SPECIFIC release (rollback path). */
  async relaunchFromRelease(configPath: string, releaseId: string): Promise<number> {
    const entrypoint = join(this.options.layout.releasesRoot, releaseId, BUNDLE_ENTRYPOINT);
    const foreground = this.options.env.BEELINE_DAEMON_BACKGROUND !== '1';
    return launchRuntimeDaemon(configPath, { entrypoint, foreground });
  }

  async notifyRooms(text: string): Promise<void> {
    try {
      await this.notifyFn(text);
    } catch {
      // notices are best-effort by contract
    }
  }

  private busy(): boolean {
    if (this.attachedSupervisor) return !this.attachedSupervisor.isWorkspaceIdle();
    return !this.isIdle();
  }

  /** Public single tick — test/CLI synchronization point. */
  async tickOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.restartPending || this.applying) return;
    const now = this.options.now();
    let forced = false;
    try {
      let requested = false;
      for (const dir of this.options.watchRuntimeDirs) {
        const rawRequest = await readFile(updateRequestPath(dir), 'utf8').catch(() => undefined);
        if (rawRequest !== undefined) {
          await rm(updateRequestPath(dir), { force: true });
          requested = true;
        }
      }
      if (requested) {
        forced = true;
        this.log('[body] self-update: operator requested an update via `beeline update`');
      }
    } catch {
      return;
    }

    const disabled = this.options.env.BEELINE_UPDATE_DISABLE === '1';
    if (!forced) {
      if (disabled) return;
      if (now < this.nextCheckAllowedAt) return;
    }
    this.applying = true;
    try {
      await this.checkAndApply({ force: forced });
    } catch (error) {
      this.log(`[body] self-update check failed: ${error instanceof Error ? error.message : String(error)}`);
      const state = await readUpdateState(this.options.layout);
      await writeUpdateState(this.options.layout, {
        ...state,
        lastCheckAt: now,
        lastCheckResult: `failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
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
      this.log('[body] self-update: skipping automatic apply; run `beeline update --force` to apply anyway');
      return;
    }

    await this.apply(verdict.published, manifestUrl, { force: opts.force === true });
  }

  private async apply(
    published: PublishedBundle,
    manifestUrl: string,
    opts: { force: boolean },
  ): Promise<void> {
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
        this.log('[body] self-update: agent work is running; the restart waits until the daemon is idle');
        this.deferredBusyNotice = true;
      }
      const idle = await this.waitForIdle();
      if (!idle) {
        this.log('[body] self-update: still busy after the idle wait; deferring the restart to the next tick (staged bundle kept)');
        return;
      }
    }
    this.deferredBusyNotice = false;

    const { previousReleaseId } = await activateRelease(this.options.layout, releaseId);
    await writeUpdateState(this.options.layout, {
      ...state,
      lastCheckAt: now,
      lastCheckResult: 'applied',
      lastApplied: {
        releaseId,
        ...(previousReleaseId ? { previousReleaseId } : {}),
        identity: targetIdentity,
        at: now,
      },
    });
    const message = `Beeline bundle ${describeIdentity(installed)} -> ${describeIdentity(targetIdentity)} applied${this.restartHandover ? '; the daemon is restarting now' : ''} (previous release kept for rollback).`;
    if (!this.restartHandover) {
      // CLI-driven apply: swap recorded, nothing to hand over, nothing that
      // could ever need an automatic rollback.
      this.log(`[body] self-update: ${message}`);
      return;
    }
    await writePendingUpdate(this.options.layout, {
      from: installed ?? {},
      to: targetIdentity,
      releaseId,
      previousReleaseId,
      appliedAt: now,
    });
    this.unconfirmedReleaseId = releaseId;
    this.restartPending = true;
    this.log(`[body] self-update: ${message}`);
    await this.notifyRooms(message);
    this.requestRestartCb?.();
  }

  /** Poll the busy gate until idle or the idle wait budget is spent. */
  async waitForIdle(): Promise<boolean> {
    const deadline = this.options.now() + this.options.idleTimeoutMs;
    for (;;) {
      if (!this.busy()) return true;
      if (this.options.now() >= deadline) return false;
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(this.options.idlePollMs, 250)));
    }
  }
}
