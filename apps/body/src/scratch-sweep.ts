/**
 * Deletes stale files under the per-session attach scratch roots
 * (`<runtimeDir>/rooms/<roomId>/agent-home`, `BEELINE_ATTACH_SCRATCH_ROOT` —
 * `room-session.ts`, `room-runtime.ts`'s `roomAgentHomeRoot`). `attach_file`
 * and `write_scratch_file` (`read-only-mcp.ts`) both resolve anywhere inside
 * this same root, and `attach_file` reads + uploads a file synchronously
 * within one MCP call — nothing is left "pending" past that call returning,
 * so a file younger than the TTL is the only guard a still-running turn
 * needs.
 *
 * The root also holds every harness's own state/credential directories
 * (`HOME_SUBDIRS` in `agent-home.ts`: `user`/`claude`/`codex`/`goose`/`grok`/
 * `pi`/`state`/`cache` — the very things `harnessStateDirsFromEnv` and
 * `harnessHomeStateDirs` protect from the OS sandbox). Only `tmp` — the one
 * subdir env-mapped to `TMPDIR`, where deliveries and scratch writes actually
 * land — is swept; every other top-level name is skipped outright, whole,
 * before ever touching mtimes.
 */
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HOME_SUBDIRS } from './agent-home.js';

export const DEFAULT_SCRATCH_TTL_HOURS = 72;

const NEVER_SWEEP_SUBDIR_NAMES = new Set<string>(HOME_SUBDIRS.filter((name) => name !== 'tmp'));

export function scratchTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BEELINE_SCRATCH_TTL_HOURS?.trim();
  const hours = raw ? Number(raw) : DEFAULT_SCRATCH_TTL_HOURS;
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SCRATCH_TTL_HOURS) * 60 * 60 * 1000;
}

/** Every existing `<runtimeDir>/rooms/<roomId>/agent-home` directory, whatever
 *  the daemon's current room membership says — an abandoned room's leftover
 *  scratch still needs sweeping. Never follows a symlinked room or home
 *  entry. */
export async function discoverAttachScratchRoots(runtimeDir: string): Promise<string[]> {
  const roomsDir = resolve(runtimeDir, 'rooms');
  let entries;
  try {
    entries = await readdir(roomsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const home = resolve(roomsDir, entry.name, 'agent-home');
    const stats = await lstat(home).catch(() => undefined);
    if (stats?.isDirectory()) roots.push(home);
  }
  return roots;
}

async function removeStaleFiles(
  dir: string,
  cutoffMs: number,
  protectNamesHere: boolean,
): Promise<{ removedFiles: number; removedBytes: number }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { removedFiles: 0, removedBytes: 0 };
  }
  let removedFiles = 0;
  let removedBytes = 0;
  for (const entry of entries) {
    if (protectNamesHere && NEVER_SWEEP_SUBDIR_NAMES.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    const stats = await lstat(path).catch(() => undefined);
    if (!stats || stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      const nested = await removeStaleFiles(path, cutoffMs, false);
      removedFiles += nested.removedFiles;
      removedBytes += nested.removedBytes;
      const remaining = await readdir(path).catch(() => undefined);
      if (remaining && remaining.length === 0) await rmdir(path).catch(() => undefined);
      continue;
    }
    if (!stats.isFile() || stats.mtimeMs >= cutoffMs) continue;
    await unlink(path).catch(() => undefined);
    removedFiles += 1;
    removedBytes += stats.size;
  }
  return { removedFiles, removedBytes };
}

export interface ScratchSweepSummary {
  removedFiles: number;
  removedBytes: number;
  roots: number;
}

export async function sweepAttachScratchRoots(
  roots: readonly string[],
  ttlMs: number,
  now: number = Date.now(),
): Promise<ScratchSweepSummary> {
  const cutoffMs = now - ttlMs;
  let removedFiles = 0;
  let removedBytes = 0;
  for (const root of roots) {
    const stats = await lstat(root).catch(() => undefined);
    if (!stats?.isDirectory()) continue;
    const result = await removeStaleFiles(root, cutoffMs, true);
    removedFiles += result.removedFiles;
    removedBytes += result.removedBytes;
  }
  return { removedFiles, removedBytes, roots: roots.length };
}

/** Discover + sweep every attach scratch root under `runtimeDir`, logging one
 *  summary line. Called once at daemon start (after the layout is settled)
 *  and every `BEELINE_SCRATCH_SWEEP_INTERVAL_MS` (default 6h) thereafter. */
export async function runScratchSweep(
  runtimeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScratchSweepSummary> {
  const roots = await discoverAttachScratchRoots(runtimeDir);
  const ttlMs = scratchTtlMs(env);
  const summary = await sweepAttachScratchRoots(roots, ttlMs);
  console.log(
    `[body] scratch sweep: removed ${summary.removedFiles} files (${summary.removedBytes} bytes) ` +
      `older than ${Math.round(ttlMs / (60 * 60 * 1000))}h under ${summary.roots} roots`,
  );
  return summary;
}
