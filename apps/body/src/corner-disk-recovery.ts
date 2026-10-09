import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { writePrivateFileAtomically } from './atomic-private-file.js';

const execFileAsync = promisify(execFile);
const GENERATED_DIRS = new Set([
  'node_modules', 'target', 'build', 'dist', '.next', '.turbo', '.expo',
]);
const MAX_DIRECTORY_DEPTH = 4;
const MAX_VISITED_DIRECTORIES = 5_000;

export interface UnpublishedCornerWorktree {
  path: string;
  cornerId: string;
  branch: string;
}

/** A local pointer survives process restarts without copying unpublished code. */
export function cornerRecoveryPointerPath(worktree: UnpublishedCornerWorktree): string {
  const checkout = resolve(worktree.path);
  if (
    basename(checkout) !== worktree.cornerId ||
    basename(dirname(checkout)) !== 'corners' ||
    basename(dirname(dirname(checkout))) !== 'beeline' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(worktree.cornerId)
  ) {
    throw new Error('refusing recovery pointer outside a Beeline corner checkout');
  }
  return resolve(dirname(dirname(checkout)), 'recovery', 'corners', `${worktree.cornerId}.json`);
}

async function git(checkout: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', checkout, ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function ignoredAndUntracked(checkout: string, path: string): Promise<boolean> {
  const rel = relative(checkout, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return false;
  const ignored = await git(checkout, ['check-ignore', '-q', '--', `${rel}/`]).then(
    () => true,
    () => false,
  );
  if (!ignored) return false;
  return !(await git(checkout, ['ls-files', '--', rel])).trim();
}

/**
 * Preserve the exact checkout and HEAD when git cannot prove work was pushed.
 * Only well-known, wholly ignored generated directories are removed; every
 * tracked or non-ignored path remains available at the recovery pointer.
 */
export async function preserveUnpublishedCornerWorktree(
  worktree: UnpublishedCornerWorktree,
  reason: string,
): Promise<{ pointer: string; pruned: string[] }> {
  const checkout = resolve(worktree.path);
  const pointer = cornerRecoveryPointerPath(worktree);
  const info = await lstat(checkout);
  if (!info.isDirectory() || (await realpath(checkout)) !== checkout) {
    throw new Error('refusing to prune a non-canonical corner checkout');
  }
  const head = (await git(checkout, ['rev-parse', '--verify', 'HEAD'])).trim();
  const record = {
    cornerId: worktree.cornerId,
    checkout,
    branch: worktree.branch,
    head,
    reason,
    recordedAt: new Date().toISOString(),
  };
  await writePrivateFileAtomically(pointer, `${JSON.stringify(record, null, 2)}\n`);

  const pruned: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: checkout, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.shift()!;
    if (++visited > MAX_VISITED_DIRECTORIES) break;
    if (current.depth >= MAX_DIRECTORY_DEPTH) continue;
    for (const entry of await readdir(current.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const path = join(current.path, entry.name);
      if (GENERATED_DIRS.has(entry.name)) {
        if (await ignoredAndUntracked(checkout, path)) {
          await rm(path, { recursive: true, force: true });
          pruned.push(relative(checkout, path));
        }
        continue;
      }
      pending.push({ path, depth: current.depth + 1 });
    }
  }
  return { pointer, pruned };
}
