import { execFile } from 'node:child_process';
import { lstat, readdir, rmdir, rm, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const CORNER_SCRATCH_BUDGET_BYTES = 5 * 1024 ** 3;
export const CORNER_SCRATCH_TTL_MS = 14 * 24 * 60 * 60_000;
export const SHARED_MODEL_CACHE_BUDGET_BYTES = 32 * 1024 ** 3;
const MODEL_CACHE_IDLE_MS = 24 * 60 * 60_000;

/** du counts allocated blocks once per inode and never follows symlinks. */
export async function allocatedDirectoryBytes(path: string): Promise<number> {
  if (!(await lstat(path).catch(() => undefined))) return 0;
  const output = await execFileAsync('du', ['-s', '-B1', '--', path], {
    maxBuffer: 1024 * 1024,
  }).then((result) => result.stdout);
  const bytes = Number(output.split(/\s+/)[0]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('scratch usage could not be measured');
  return bytes;
}

export function scratchBudgetMessage(usage: number, budget = CORNER_SCRATCH_BUDGET_BYTES): string {
  const mib = (bytes: number) => Math.ceil(bytes / 1024 ** 2);
  return `Scratch ${mib(usage)} / ${mib(budget)} MiB; files idle for 14 days expire. Use scratch_status and your shell to inspect, update or delete files. ${usage > budget ? 'OVER BUDGET: remove files before writing more.' : ''}`.trim();
}

/** Existing oversized scratch stays available for a cleanup turn. */
export function scratchGrowthExceedsBudget(
  usage: number,
  atTurnStart: number,
  budget = CORNER_SCRATCH_BUDGET_BYTES,
): boolean {
  return usage > budget && usage > atTurnStart;
}

export async function assertScratchWriteBudget(
  root: string,
  incomingBytes: number,
  budget = CORNER_SCRATCH_BUDGET_BYTES,
): Promise<void> {
  const usage = await allocatedDirectoryBytes(root);
  if (usage + incomingBytes > budget) {
    throw new Error(`${scratchBudgetMessage(usage, budget)} Requested write: ${incomingBytes} bytes.`);
  }
}

/**
 * Sweep old user scratch without touching harness/session state. Even an open
 * corner may be idle for weeks; file mtime gives its agent a rolling 14-day
 * chance to update a file it needs to keep. Symlinks are never followed.
 */
export async function sweepStaleCornerScratch(
  root: string,
  now = Date.now(),
  ttlMs = CORNER_SCRATCH_TTL_MS,
): Promise<{ files: number; bytes: number }> {
  const cutoff = now - ttlMs;
  let files = 0;
  let bytes = 0;
  const visit = async (dir: string, top: boolean): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (top && (entry.name === 'agent-home' || entry.name === '.git')) continue;
      const path = join(dir, entry.name);
      const info = await lstat(path).catch(() => undefined);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(path, false);
        if (!top) await rmdir(path).catch(() => undefined);
      } else if (info.isFile() && info.mtimeMs < cutoff) {
        await unlink(path);
        files++;
        bytes += info.size;
      }
    }
  };
  if ((await lstat(root).catch(() => undefined))?.isDirectory()) await visit(resolve(root), true);
  return { files, bytes };
}

/**
 * Prune only complete Hugging Face cache entries, and only after the machine
 * helper has no busy turns. Active model processes may hold files open. The
 * newest entries remain until the next idle pass when the cache exceeds cap.
 */
export async function pruneSharedModelCache(
  root: string,
  now = Date.now(),
  budget = SHARED_MODEL_CACHE_BUDGET_BYTES,
): Promise<string[]> {
  let usage = await allocatedDirectoryBytes(root);
  if (usage <= budget) return [];
  const candidates: Array<{ path: string; usedAt: number }> = [];
  for (const parent of [join(root, 'hub'), root]) {
    for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
      const eligible = parent === root
        ? entry.name === 'xet'
        : /^(?:models|datasets|spaces)--/.test(entry.name);
      if (!eligible || !entry.isDirectory()) continue;
      const path = join(parent, entry.name);
      const info = await stat(path);
      if (info.mtimeMs > now - MODEL_CACHE_IDLE_MS) continue;
      candidates.push({ path, usedAt: info.mtimeMs });
    }
  }
  candidates.sort((a, b) => a.usedAt - b.usedAt || a.path.localeCompare(b.path));
  const removed: string[] = [];
  for (const item of candidates) {
    if (usage <= budget) break;
    await rm(item.path, { recursive: true, force: true });
    usage = await allocatedDirectoryBytes(root);
    removed.push(item.path);
  }
  return removed;
}
