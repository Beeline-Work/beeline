import { lstat, mkdir, readFile, readdir, rm, statfs } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SessionMode } from './config.js';

/** Session env var naming the Room-instance's ephemeral scratch directory. */
export const WORKBENCH_ENV = 'BUZZY_WORKBENCH_DIR';

/**
 * The workbench is an artifact tray, not a second checkout. These are kernel
 * filesystem limits, not advisory sweeper thresholds: every writer sees the
 * same ENOSPC result, including a shell `cp -r` that never calls an ACP file
 * tool. The tmpfs root and the reserved `.git` guard consume two inodes, which
 * leaves fourteen artifact file/directory slots.
 */
export const WORKBENCH_MAX_BYTES = 25 * 1024 * 1024;
export const WORKBENCH_MAX_INODES = 16;
export const WORKBENCH_TTL_MS = 3 * 24 * 60 * 60_000;
export const WORKBENCH_SWEEP_INTERVAL_MS = 10 * 60_000;
export const WORKBENCH_SWEEP_MAX_ENTRIES = WORKBENCH_MAX_INODES;
export const WORKBENCH_SWEEP_MAX_DELETES = WORKBENCH_MAX_INODES;

export interface SessionWorkbench {
  /** Stable path shown inside every Room/corner sandbox. */
  dir: string;
  /** Host-visible /proc/<sandbox-child>/root view, resolved after ACP starts. */
  storageDir: string;
}

export interface WorkbenchSweepResult {
  scannedFiles: number;
  deletedFiles: number;
  bytesBefore: number;
  bytesAfter: number;
  truncated: boolean;
}

export interface WorkbenchScratchLeak {
  paths: string[];
  reason: 'source-files' | 'repository-tree';
}

interface WorkbenchFile {
  path: string;
  size: number;
  modifiedAt: number;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Create the stable mountpoint under this Room instance's private state. */
async function prepareWorkbenchMountpoint(agentPrivateRoot: string): Promise<string> {
  const root = resolve(agentPrivateRoot);
  const dir = resolve(root, 'workbench');
  if (!isInside(root, dir)) throw new Error(`invalid workbench path outside ${root}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Prepare the stable path that bubblewrap replaces with a quota tmpfs for each
 * physical ACP session. The per-session mount is intentional: it disappears
 * with the sandbox process, so a retired Room cannot leave scratch behind for
 * a later process to mistake for durable state.
 */
export async function prepareSessionWorkbench(agentPrivateRoot: string): Promise<SessionWorkbench> {
  const dir = await prepareWorkbenchMountpoint(agentPrivateRoot);
  return { dir, storageDir: dir };
}

async function descendantPids(rootPid: number): Promise<number[]> {
  const found: number[] = [];
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length > 0 && found.length < 32) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    const raw = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '');
    for (const child of raw.trim().split(/\s+/)) {
      if (/^\d+$/.test(child)) pending.push(Number(child));
    }
  }
  return found;
}

/** Resolve Body's view of the live session's quota mount after bwrap starts. */
export async function bindSessionWorkbenchStorage(
  workbench: SessionWorkbench,
  processPid: number | undefined,
): Promise<boolean> {
  if (!processPid || process.platform !== 'linux') return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pids = await descendantPids(processPid);
    for (const pid of pids.reverse()) {
      const candidate = `/proc/${pid}/root${workbench.dir}`;
      const filesystem = await statfs(candidate).catch(() => undefined);
      if (
        filesystem &&
        filesystem.files === WORKBENCH_MAX_INODES &&
        filesystem.blocks * filesystem.bsize === WORKBENCH_MAX_BYTES
      ) {
        workbench.storageDir = candidate;
        return true;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return false;
}

/**
 * One bounded maintenance pass. Symlinks are never followed: old symlinks may
 * be removed, but their targets are outside the sweep by construction.
 *
 * The entry/delete bounds keep a pathological scratch tree from monopolizing
 * the Room maintenance tick. A truncated tree is revisited on the next tick.
 */
export async function sweepSessionWorkbench(
  workbench: SessionWorkbench,
  options: {
    now?: number;
    ttlMs?: number;
    maxBytes?: number;
    maxEntries?: number;
    maxDeletes?: number;
  } = {},
): Promise<WorkbenchSweepResult> {
  const root = resolve(workbench.storageDir);
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? WORKBENCH_TTL_MS;
  const maxBytes = options.maxBytes ?? WORKBENCH_MAX_BYTES;
  const maxEntries = options.maxEntries ?? WORKBENCH_SWEEP_MAX_ENTRIES;
  const maxDeletes = options.maxDeletes ?? WORKBENCH_SWEEP_MAX_DELETES;
  const files: WorkbenchFile[] = [];
  const directories = [root];
  let entries = 0;
  let truncated = false;

  while (directories.length > 0 && !truncated) {
    const directory = directories.pop()!;
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      // Reserved mountpoint used by the sandbox's read-only /dev/null guard.
      // It is infrastructure, not an artifact, and must survive every sweep.
      if (child.name === '.git') continue;
      entries += 1;
      if (entries > maxEntries) {
        truncated = true;
        break;
      }
      const path = resolve(directory, child.name);
      if (!isInside(root, path)) continue;
      if (child.isDirectory()) {
        directories.push(path);
        continue;
      }
      const details = await lstat(path).catch(() => undefined);
      if (!details) continue;
      // Regular files count toward the cap. Other leaf entries (including
      // symlinks) count as zero bytes but remain TTL-eligible.
      files.push({
        path,
        size: details.isFile() ? details.size : 0,
        modifiedAt: details.mtimeMs,
      });
    }
  }

  files.sort((a, b) => a.modifiedAt - b.modifiedAt || a.path.localeCompare(b.path));
  const bytesBefore = files.reduce((total, file) => total + file.size, 0);
  let bytesAfter = bytesBefore;
  let deletedFiles = 0;
  const deleted = new Set<string>();
  const remove = async (file: WorkbenchFile): Promise<void> => {
    if (deletedFiles >= maxDeletes || deleted.has(file.path)) return;
    await rm(file.path, { force: true });
    deleted.add(file.path);
    deletedFiles += 1;
    bytesAfter -= file.size;
  };

  for (const file of files) {
    if (deletedFiles >= maxDeletes) break;
    if (now - file.modifiedAt > ttlMs) await remove(file);
  }
  for (const file of files) {
    if (bytesAfter <= maxBytes || deletedFiles >= maxDeletes) break;
    await remove(file);
  }

  return {
    scannedFiles: files.length,
    deletedFiles,
    bytesBefore,
    bytesAfter: Math.max(0, bytesAfter),
    truncated,
  };
}

const SOURCE_FILE =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|php|scala|cs|c|cc|cpp|cxx|h|hh|hpp|hxx|vue|svelte|sh|bash|zsh|fish|sql)$/i;
const REPOSITORY_DIRECTORY = /^(?:src|lib|packages|apps|services|crates|cmd|internal)$/i;
const REPOSITORY_MANIFEST =
  /^(?:package\.json|pnpm-workspace\.yaml|cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt)$/i;

/**
 * Best-effort visibility backstop for small implementation attempts that fit
 * under the hard quota. It never blocks a legitimate artifact; callers emit
 * the result through the ordinary typed activity ledger and nudge the agent
 * toward a corner.
 */
export async function detectWorkbenchScratchLeak(
  workbench: SessionWorkbench,
): Promise<WorkbenchScratchLeak | undefined> {
  const root = resolve(workbench.storageDir);
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const sourcePaths: string[] = [];
  let repositoryShape = false;
  let inspected = 0;

  while (pending.length > 0 && inspected < WORKBENCH_MAX_INODES) {
    const current = pending.pop()!;
    const children = await readdir(current.path, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (inspected >= WORKBENCH_MAX_INODES) break;
      inspected += 1;
      if (child.name === '.git') {
        // The root guard is a /dev/null device. A directory with this name can
        // only be a nested repository-shaped attempt that should be surfaced.
        if (child.isDirectory()) repositoryShape = true;
        continue;
      }
      const absolute = resolve(current.path, child.name);
      if (!isInside(root, absolute)) continue;
      const display = relative(root, absolute);
      if (child.isDirectory()) {
        if (REPOSITORY_DIRECTORY.test(child.name) || current.depth >= 2) repositoryShape = true;
        pending.push({ path: absolute, depth: current.depth + 1 });
        continue;
      }
      if (SOURCE_FILE.test(child.name)) sourcePaths.push(display);
      if (REPOSITORY_MANIFEST.test(child.name)) repositoryShape = true;
    }
  }

  if (sourcePaths.length === 0 && !repositoryShape) return undefined;
  return {
    paths: sourcePaths.slice(0, 6),
    reason: repositoryShape ? 'repository-tree' : 'source-files',
  };
}

/** Translate the stable in-sandbox workbench path to Body's keeper view. */
export function workbenchStoragePath(
  workbench: SessionWorkbench,
  candidate: string,
): string | undefined {
  const logicalRoot = resolve(workbench.dir);
  const logicalCandidate = resolve(candidate);
  if (!isInside(logicalRoot, logicalCandidate)) return undefined;
  return resolve(workbench.storageDir, relative(logicalRoot, logicalCandidate));
}

/** Stable system-prompt guidance shared by Room and corner sessions. */
export function workbenchInstructions(
  workbench: SessionWorkbench | undefined,
  mode: SessionMode,
): string {
  if (!workbench) return '';
  const surface = mode === 'edit' ? 'corner' : 'Room';
  return [
    `Your scratch workbench is ${workbench.dir} (also $${WORKBENCH_ENV}).`,
    `It is writable only for this physical ${surface} session, but it is NOT the repository, is never committed, has a hard 25 MB / roughly-dozen-entry filesystem quota, cannot contain .git, and files older than about 3 days are garbage-collected while the session remains live.`,
    'Use it only for ephemeral artifacts to SHOW a human: a self-contained HTML mockup, rendered image, screenshot, or small extracted dataset. Share one with [[buzz-attachment:<absolute-workbench-file>]].',
    'Any change meant to land — implementation, edits, tests, builds, generated repository files, or branch work — belongs in a corner. Open the corner yourself in one step; never copy or reconstruct the repository in scratch.',
    'Browsing uses the Trusty Squire MCP session in its own vault-backed process. Do not install or run a browser in this sandbox; only small exported artifacts belong here.',
    'Room network access remains available for fetches; that does not grant repository writes or expand the workbench quota.',
    'Serving is single-file v1: inline assets into one HTML file. Directory bundles are not supported.',
  ].join('\n');
}
