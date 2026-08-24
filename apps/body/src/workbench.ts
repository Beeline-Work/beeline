import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SessionMode } from './config.js';

/** Session env var naming the Room-instance's ephemeral scratch directory. */
export const WORKBENCH_ENV = 'BUZZY_WORKBENCH_DIR';

/** The workbench is deliberately useful for artifacts, but never an unbounded cache. */
export const WORKBENCH_MAX_BYTES = 512 * 1024 * 1024;
export const WORKBENCH_TTL_MS = 7 * 24 * 60 * 60_000;
export const WORKBENCH_SWEEP_INTERVAL_MS = 10 * 60_000;
export const WORKBENCH_SWEEP_MAX_ENTRIES = 10_000;
export const WORKBENCH_SWEEP_MAX_DELETES = 256;

export interface SessionWorkbench {
  /** Agent-private writable scratch directory, shared by this Room and its corners. */
  dir: string;
}

export interface WorkbenchSweepResult {
  scannedFiles: number;
  deletedFiles: number;
  bytesBefore: number;
  bytesAfter: number;
  truncated: boolean;
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

/** Create the one named scratch directory under this Room instance's private state. */
export async function prepareSessionWorkbench(agentPrivateRoot: string): Promise<SessionWorkbench> {
  const root = resolve(agentPrivateRoot);
  const dir = resolve(root, 'workbench');
  if (!isInside(root, dir)) throw new Error(`invalid workbench path outside ${root}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return { dir };
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
  const root = resolve(workbench.dir);
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

/** Stable system-prompt guidance shared by Room and corner sessions. */
export function workbenchInstructions(
  workbench: SessionWorkbench | undefined,
  mode: SessionMode,
): string {
  if (!workbench) return '';
  const surface = mode === 'edit' ? 'corner' : 'Room';
  return [
    `Your scratch workbench is ${workbench.dir} (also $${WORKBENCH_ENV}).`,
    `It is writable in this ${surface} (and shared with this Room's other surface), but it is NOT the repository, is never committed, is capped near 512 MB, and files older than about 7 days are garbage-collected.`,
    'Boundary rule: Will this produce a repository change someone should review? Use a corner. Scratch, serve, and fetch work belongs in the workbench and can be shared with [[buzz-attachment:<absolute-workbench-file>]]. Never open a corner merely to serve a file or build a tunnel.',
    'Room network access remains available for fetches; that does not grant repository writes.',
    'Serving is single-file v1: inline assets into one HTML file. Directory bundles are not supported.',
  ].join('\n');
}
