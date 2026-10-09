import { execFile } from 'node:child_process';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const DELETED_RUNTIME_TTL_MS = 30 * 24 * 60 * 60_000;
export const REPOSITORY_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;

/** Run only when the machine helper is idle. Names are the helper's own tombstones. */
export async function pruneDeletedRuntimes(supervisorRoot: string, now = Date.now()): Promise<string[]> {
  const root = resolve(supervisorRoot, 'beeline', 'deleted-runtimes');
  const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const match = /^([a-f0-9]{64})-(\d{13})$/.exec(entry.name);
    if (!entry.isDirectory() || !match || now - Number(match[2]) < DELETED_RUNTIME_TTL_MS) continue;
    const path = join(root, entry.name);
    if (!(await lstat(path)).isDirectory()) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

/** Expire an unused bare clone only after git confirms it has no linked worktrees. */
export async function pruneRepositoryCaches(supervisorRoot: string, now = Date.now()): Promise<string[]> {
  const root = resolve(supervisorRoot, 'beeline', 'repositories');
  const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}\.git$/.test(entry.name)) continue;
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (!info.isDirectory() || now - info.mtimeMs < REPOSITORY_CACHE_TTL_MS) continue;
    const listing = await execFileAsync('git', [`--git-dir=${path}`, 'worktree', 'list', '--porcelain'])
      .then((result) => result.stdout, () => undefined);
    if (listing === undefined) continue;
    const attached = listing.split('\n').some((line) =>
      line.startsWith('worktree ') && resolve(line.slice('worktree '.length)) !== path);
    if (attached) continue;
    const refs = await execFileAsync('git', [
      `--git-dir=${path}`, 'for-each-ref', '--format=%(refname) %(objectname)',
    ]).then((result) => result.stdout, () => undefined);
    if (refs === undefined) continue;
    const byName = new Map<string, string>();
    for (const line of refs.trim().split('\n')) {
      const match = /^(refs\/\S+) ([a-f0-9]{40,64})$/.exec(line);
      if (match) byName.set(match[1]!, match[2]!);
    }
    // Bare clones hold their initial remote branches in refs/heads. A local
    // branch is safe only when a fetched origin ref confirms the same commit.
    const unpublishedHead = [...byName].some(([name, oid]) =>
      name.startsWith('refs/heads/') &&
      byName.get(name.replace('refs/heads/', 'refs/remotes/origin/')) !== oid);
    if (unpublishedHead) continue;
    const unreachable = await execFileAsync('git', [
      `--git-dir=${path}`, 'fsck', '--unreachable', '--no-reflogs', '--no-progress',
    ]).then((result) => result.stdout, () => undefined);
    if (unreachable === undefined || /unreachable commit /.test(unreachable)) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
