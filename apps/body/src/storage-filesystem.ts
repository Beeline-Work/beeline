/** Filesystem-only cleanup primitives. Keep this module independent of harness
 * setup: the small recovery bootstrap imports it when activating a bundle. */
import { chmod, lstat, readdir, realpath, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { trustySquireLegacyStorePaths } from './trusty-squire-storage.js';

/** macOS exposes /var and /tmp through OS-owned /private aliases. */
export function canonicalStoragePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'darwin' ? absolute.replace(/^\/(var|tmp|etc)(?=\/|$)/, '/private/$1') : absolute;
}

/** Refuse operator/agent links in every ancestor, including the runtime root. */
export async function ordinaryDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  return Boolean(info?.isDirectory() && canonicalStoragePath(await realpath(path)) === canonicalStoragePath(path));
}

export type TreeEntry = { dev: number; ino: number; blocks: number; links: number; directory: boolean; lastUsed: number };
// Node's directory APIs cannot request O_NOATIME. Linux's read-only inventory
// uses Python's fd-based listdir, so neither a dry run nor an eligibility scan
// changes the access dates it is deciding from. No file contents are read.
const TREE_INVENTORY = String.raw`
import os, sys, json, stat
root=sys.argv[1]
def visit(path):
    s=os.lstat(path)
    directory=stat.S_ISDIR(s.st_mode)
    print(json.dumps([path,s.st_dev,s.st_ino,s.st_blocks*512,s.st_nlink,directory,max(s.st_atime_ns,s.st_mtime_ns)/1000000]))
    if directory and not (os.path.basename(path) in ['.trusty-squire','squire-host-config'] or (os.path.basename(path)=='trusty-squire' and os.path.basename(os.path.dirname(path))!='skills')):
        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOATIME|os.O_NOFOLLOW)
        try: names=os.listdir(fd)
        finally: os.close(fd)
        for name in names: visit(os.path.join(path,name))
visit(root)

`;
export async function storageTree(root: string): Promise<Map<string, TreeEntry>> {
  if (process.platform === 'darwin') {
    const tree = new Map<string, TreeEntry>();
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path);
      tree.set(path, { dev: info.dev, ino: info.ino, blocks: info.blocks * 512, links: info.nlink,
        directory: info.isDirectory(), lastUsed: Math.max(info.atimeMs, info.mtimeMs) });
      if (info.isDirectory() && !isSquirePath(path))
        for (const name of await readdir(path)) await visit(resolve(path, name));
    };
    await visit(root);
    return tree;
  }
  const child = spawn('/usr/bin/python3', ['-c', TREE_INVENTORY, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tree = new Map<string, TreeEntry>();
  let pending = '', stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const completed = new Promise<void>((done, fail) => {
    child.once('error', fail);
    child.once('close', code => code === 0 ? done() : fail(new Error(`storage inventory failed (${code}): ${stderr}`)));
  });
  // Attach the rejection handler before consuming the pipe.
  void completed.catch(() => undefined);
  const add = (line: string) => {
    const [path, dev, ino, blocks, links, directory, lastUsed] = JSON.parse(line) as [string, number, number, number, number, boolean, number];
    tree.set(path, { dev, ino, blocks, links, directory, lastUsed });
  };
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      add(pending.slice(0, newline)); pending = pending.slice(newline + 1);
    }
  }
  await completed;
  if (pending) add(pending);
  return tree;
}
/** Hard exclusion at every depth, including the host/legacy Squire stores. */
export function isSquirePath(path: string): boolean {
  const absolute = resolve(path);
  return absolute.split(sep).some((part, index, parts) => ['.trusty-squire', 'squire-host-config'].includes(part) ||
    part === 'trusty-squire' && parts[index - 1] !== 'skills') ||
    trustySquireLegacyStorePaths().some(root => absolute === root || absolute.startsWith(`${root}${sep}`));
}

/** Downloaded tools often ship directories mode 0500/0555. Make only owned
 * directories in this disposable object writable; never follow a link or touch Squire. */
const squirePathsByTree = new WeakMap<Map<string, TreeEntry>, string[]>();
export async function removeStoragePath(root: string, knownTree?: Map<string, TreeEntry>): Promise<void> {
  const original = knownTree ?? await storageTree(root);
  let excluded = squirePathsByTree.get(original);
  if (!excluded) { excluded = [...original.keys()].filter(isSquirePath); squirePathsByTree.set(original, excluded); }
  if (excluded.some(path => path === root || path.startsWith(`${root}/`)))
    throw new Error('refusing removal of Trusty Squire storage');
  if (isSquirePath(root)) throw new Error('refusing removal of Trusty Squire storage');
  // Repair before starting rm: recursive rm runs sibling removals concurrently,
  // so after an EACCES its other children can still be disappearing. A second
  // inventory then races those removals (observed on macOS as ENOENT).
  for (const [path, item] of original) {
    if (!item.directory || path !== root && !path.startsWith(`${root}/`)) continue;
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) continue;
    if (info.isDirectory() && process.getuid?.() === info.uid && (info.mode & 0o700) !== 0o700)
      await chmod(path, info.mode | 0o700);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
