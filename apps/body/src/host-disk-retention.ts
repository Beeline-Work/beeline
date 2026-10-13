import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { reclaimWholeStorageObject, type WholeStorageOptions } from './helper-storage.js';

/** Tombstone creation already records a settled ended-agent answer. */
export async function pruneDeletedRuntimes(supervisorRoot: string, _now = Date.now(), options: WholeStorageOptions = {}): Promise<string[]> {
  const root = resolve(supervisorRoot, 'beeline', 'deleted-runtimes');
  const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^([a-f0-9]{64})-(\d{13})$/.test(entry.name)) continue;
    removed.push(...(await reclaimWholeStorageObject(join(root, entry.name), true, options)).map(item => item.path));
  }
  return removed;
}

/** Expire an unused bare clone only after git confirms it has no linked worktrees. */
export async function pruneRepositoryCaches(supervisorRoot: string, now = Date.now(), options: WholeStorageOptions = {}): Promise<string[]> {
  const root = resolve(supervisorRoot, 'beeline', 'repositories');
  const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}\.git$/.test(entry.name)) continue;
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (!info.isDirectory()) continue;
    const published = async (): Promise<boolean> => {
    const listing = await execFileAsync('git', [`--git-dir=${path}`, 'worktree', 'list', '--porcelain'])
      .then((result) => result.stdout, () => undefined);
    if (listing === undefined) return false;
    const attached = listing.split('\n').some((line) =>
      line.startsWith('worktree ') && resolve(line.slice('worktree '.length)) !== path);
    if (attached) return false;
    const refs = await execFileAsync('git', [
      `--git-dir=${path}`, 'for-each-ref', '--format=%(refname) %(objectname)',
    ]).then((result) => result.stdout, () => undefined);
    if (refs === undefined) return false;
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
    if (unpublishedHead) return false;
    const unreachable = await execFileAsync('git', [
      `--git-dir=${path}`, 'fsck', '--unreachable', '--no-reflogs', '--no-progress',
    ]).then((result) => result.stdout, () => undefined);
    if (unreachable === undefined || /unreachable commit /.test(unreachable)) return false;
      return true;
    };
    removed.push(...(await reclaimWholeStorageObject(path, false, { ...options, now, beforeRemove: published })).map(item => item.path));
  }
  return removed;
}

/** Machine caches have no credential/session data. One immediate child is one
 * complete cache generation; npm/turbo/cargo caches are indivisible stores. */
export async function pruneMachineStorage(supervisorRoot: string, options: WholeStorageOptions = {}): Promise<string[]> {
  const root = resolve(supervisorRoot, 'beeline');
  const objects = ['npm-cache', 'turbo-cache', 'cargo-target'].map(name => resolve(root, name));
  for (const category of ['node-modules', 'node-modules-mobile', 'model-cache']) {
    const parent = resolve(root, category);
    for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
      // Hugging Face hub entries each own an entire model, including snapshots.
      if (category === 'model-cache' && entry.name === 'hub') {
        for (const model of await readdir(resolve(parent, entry.name)).catch(() => []))
          objects.push(resolve(parent, entry.name, model));
      } else objects.push(resolve(parent, entry.name));
    }
  }
  for (const workspace of await readdir(resolve(root, 'workspaces')).catch(() => [])) {
    if (!/^[a-f0-9]{24}$/.test(workspace)) continue;
    const home = resolve(root, 'workspaces', workspace, 'shared-home');
    for (const category of ['cache', 'tools', 'avd-base', 'staging']) {
      for (const entry of await readdir(resolve(home, category)).catch(() => [])) {
        if (category === 'cache' && entry === 'android-leases') continue;
        objects.push(resolve(home, category, entry));
      }
    }
  }
  const removed: string[] = [];
  for (const path of objects) {
    const workspace = /^(.+\/workspaces\/[a-f0-9]{24}\/shared-home)\//.exec(path)?.[1];
    removed.push(...(await reclaimWholeStorageObject(path, false, { ...options,
      ...(workspace ? { emulatorLeaseRoot: resolve(workspace, 'cache/android-leases') } : {}),
    })).map(item => item.path));
  }
  return removed;
}
