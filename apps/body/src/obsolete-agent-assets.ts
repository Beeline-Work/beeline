import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runningHelperPid } from './runtime.js';
import { SHARED_LAYOUT_MARKER, workspaceAssetPaths, workspaceAssetRoot } from './workspace-assets.js';

const COPIES = [
  ['codex/cache', 'cache/codex/download'],
  ['codex/plugins/cache', 'cache/codex/plugins'],
  ['user/.npm/_cacache', 'cache/npm/_cacache'],
  ['user/.local/share/pnpm/store', 'cache/pnpm'],
  ['user/.cargo/registry', 'cache/cargo/registry'],
  ['cache/uv', 'cache/uv'],
  ['cache/ms-playwright', 'cache/browser/playwright'],
  ['user/.cache/ms-playwright', 'cache/browser/playwright'],
  ['cache/puppeteer', 'cache/browser/puppeteer'],
  ['user/.cache/puppeteer', 'cache/browser/puppeteer'],
] as const;

export interface ObsoleteAssetCopy {
  source: string;
  shared: string;
  apparentBytes: number;
  uniqueBytes: number;
  digest: string;
}

async function fileDigest(path: string): Promise<{ digest: string; apparentBytes: number; uniqueBytes: number }> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('unknown cache entry type');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return {
    digest: hash.digest('hex'), apparentBytes: info.size,
    uniqueBytes: info.nlink === 1 ? info.blocks * 512 : 0,
  };
}

async function ordinaryDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

/** Never traverse links; leave unrecognized entries in the old home. */
async function duplicateFiles(source: string, target: string): Promise<ObsoleteAssetCopy[]> {
  const result: ObsoleteAssetCopy[] = [];
  const walk = async (oldDir: string, newDir: string): Promise<void> => {
    for (const entry of await readdir(oldDir, { withFileTypes: true })) {
      const oldPath = resolve(oldDir, entry.name);
      const newPath = resolve(newDir, entry.name);
      if (entry.isDirectory()) {
        if (await ordinaryDirectory(newPath)) await walk(oldPath, newPath);
      } else if (entry.isFile()) {
        const counterpart = await lstat(newPath).catch(() => undefined);
        if (!counterpart?.isFile()) continue;
        const oldInfo = await lstat(oldPath);
        if (oldInfo.size !== counterpart.size) continue;
        try {
          const old = await fileDigest(oldPath);
          if (old.digest !== (await fileDigest(newPath)).digest) continue;
          result.push({ source: oldPath, shared: newPath, ...old });
        } catch { /* A changing or unreadable file stays in the old home. */ }
      }
    }
  };
  await walk(source, target);
  return result;
}

/** Dry-run inventory. A candidate is reclaimable only if its shared copy is byte-identical. */
export async function findObsoleteAssetCopies(supervisorRoot: string): Promise<ObsoleteAssetCopy[]> {
  const agents = resolve(supervisorRoot, 'beeline/agents');
  const result: ObsoleteAssetCopy[] = [];
  for (const agent of await readdir(agents).catch(() => [])) {
    const runtimeDir = resolve(agents, agent);
    if (!/^[0-9a-f]{64}$/i.test(agent) || !(await ordinaryDirectory(runtimeDir))) continue;
    let runtime: { communityId?: string; supervisorRoot?: string };
    try {
      runtime = JSON.parse(await readFile(resolve(runtimeDir, 'runtime.json'), 'utf8'));
    } catch { continue; } // Malformed or unknown state is never cleanup input.
    if (!runtime.communityId || resolve(runtime.supervisorRoot ?? '') !== resolve(supervisorRoot)) continue;
    const shared = workspaceAssetPaths(workspaceAssetRoot(supervisorRoot, runtime.communityId));
    let marker: { version?: number };
    try {
      marker = JSON.parse(await readFile(resolve(shared.root, SHARED_LAYOUT_MARKER), 'utf8'));
    } catch { continue; }
    if (marker.version !== 1) continue;
    const rooms = resolve(runtimeDir, 'rooms');
    for (const room of await readdir(rooms).catch(() => [])) {
      const roomDir = resolve(rooms, room);
      const home = resolve(roomDir, 'agent-home');
      if (!(await ordinaryDirectory(roomDir)) || !(await ordinaryDirectory(home))) continue;
      for (const [oldRelative, sharedRelative] of COPIES) {
        const source = resolve(home, oldRelative);
        const target = resolve(shared.root, sharedRelative);
        if (!(await ordinaryDirectory(source)) || !(await ordinaryDirectory(target))) continue;
        result.push(...await duplicateFiles(source, target));
      }
    }
  }
  return result.sort((a, b) => a.source.localeCompare(b.source));
}

/** Called only by the helper's startup hook, before it spawns any child. */
async function assertQuiescent(supervisorRoot: string): Promise<void> {
  if (await runningHelperPid(supervisorRoot)) throw new Error('machine helper is running; stop it before cleanup apply');
}

/** Operator-only apply; inventories twice, then deletes only exact cache files. */
export async function removeObsoleteAssetCopiesAtStartup(supervisorRoot: string): Promise<ObsoleteAssetCopy[]> {
  const first = await findObsoleteAssetCopies(supervisorRoot);
  await assertQuiescent(supervisorRoot);
  const second = await findObsoleteAssetCopies(supervisorRoot);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('old cache inventory changed during cleanup');
  await assertQuiescent(supervisorRoot);
  const removed: ObsoleteAssetCopy[] = [];
  for (const item of second) {
    // Recheck each file immediately before unlinking; a conservative omission
    // costs disk space, while an incorrect removal could lose local data.
    try {
      const old = await fileDigest(item.source);
      const shared = await fileDigest(item.shared);
      if (old.digest === item.digest && shared.digest === item.digest) {
        await rm(item.source);
        removed.push(item);
      }
    } catch { /* A file changed or vanished: leave it to the next inventory. */ }
  }
  return removed;
}
