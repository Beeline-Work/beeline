import { lstat, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { resolve, sep, relative } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { trustySquireLegacyStorePaths } from './trusty-squire-storage.js';
import { SHARED_CREDENTIALS, writeBackRoomClaudeLogin } from './agent-home.js';

export const STORAGE_ITEM_UNUSED_MS = 7 * 24 * 60 * 60_000;
export interface StorageRoomState { roomId: string; archived: boolean; workspaceId?: string }
export interface StorageReclaimEntry {
  roomId: string;
  path: string;
  kind: 'archived' | 'open';
  allocatedBytes: number;
  freedBytes: number;
}

/** Refuse links in every ancestor, including the runtime root. */
export async function ordinaryDirectory(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  return Boolean(info?.isDirectory() && await realpath(path) === resolve(path));
}

type TreeEntry = { dev: number; ino: number; blocks: number; links: number; directory: boolean; lastUsed: number };
type Inode = { blocks: number; links: number; paths: string[]; directory: boolean; lastUsed: number };

// Node's directory APIs cannot request O_NOATIME. Linux's read-only inventory
// uses Python's fd-based listdir, so neither a dry run nor an eligibility scan
// changes the access dates it is deciding from. No file contents are read.
const TREE_INVENTORY = String.raw`
import os, sys, json, stat
root=sys.argv[1]
rows=[]
def visit(path):
    s=os.lstat(path)
    directory=stat.S_ISDIR(s.st_mode)
    rows.append([path,s.st_dev,s.st_ino,s.st_blocks*512,s.st_nlink,directory,max(s.st_atime_ns,s.st_mtime_ns)/1000000])
    if directory and os.path.basename(path) not in ['.trusty-squire','trusty-squire','squire-host-config']:
        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOATIME|os.O_NOFOLLOW)
        try: names=os.listdir(fd)
        finally: os.close(fd)
        for name in names: visit(os.path.join(path,name))
visit(root)
print(json.dumps(rows))
`;
export async function storageTree(root: string): Promise<Map<string, TreeEntry>> {
  const { stdout } = await execFileAsync('/usr/bin/python3', ['-c', TREE_INVENTORY, root], { maxBuffer: 128 * 1024 * 1024 });
  const rows = JSON.parse(stdout) as Array<[string, number, number, number, number, boolean, number]>;
  return new Map(rows.map(([path, dev, ino, blocks, links, directory, lastUsed]) =>
    [path, { dev, ino, blocks, links, directory, lastUsed }]));
}
const sortedInventoryPaths = new WeakMap<Map<string, TreeEntry>, string[]>();
function inventory(path: string, tree: Map<string, TreeEntry>): Map<string, Inode> {
  const inodes = new Map<string, Inode>();
  let paths = sortedInventoryPaths.get(tree);
  if (!paths) { paths = [...tree.keys()].sort(); sortedInventoryPaths.set(tree, paths); }
  const add = (current: string) => {
    const info = tree.get(current)!;
    const key = `${info.dev}:${info.ino}`;
    const inode = inodes.get(key) ?? { blocks: info.blocks, links: info.links, paths: [], directory: info.directory, lastUsed: info.lastUsed };
    inode.paths.push(current);
    inodes.set(key, inode);
  };
  if (tree.has(path)) add(path);
  const prefix = `${path}/`;
  let low = 0, high = paths.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (paths[middle]! < prefix) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < paths.length && paths[index]!.startsWith(prefix); index++) add(paths[index]!);
  return inodes;
}

// The fallback is this fixed, read-only /proc collector. It cannot signal a
// process, write a file, or accept an arbitrary command. sudo is noninteractive;
// hosts without permission preserve storage when same-user evidence is hidden.
const PROCESS_INVENTORY = String.raw`
import os,sys,json
uid=int(sys.argv[1]); paths=[]; uncertain=False
for pid in os.listdir('/proc'):
    if not pid.isdigit(): continue
    proc='/proc/'+pid
    try:
        if os.stat(proc).st_uid!=uid: continue
        with open(proc+'/environ','rb') as f:
            for value in f.read().decode(errors='replace').split('\0'):
                value=value.partition('=')[2]
                if value.startswith('/'): paths.append(value)
        with open(proc+'/cmdline','rb') as f:
            for value in f.read().decode(errors='replace').split('\0'):
                value=value.partition('=')[2] if '=' in value else value
                if value.startswith('/'): paths.append(value)
        for link in ['cwd','root','exe']:
            try: paths.append(os.readlink(proc+'/'+link))
            except FileNotFoundError: pass
        for fd in os.listdir(proc+'/fd'):
            try: paths.append(os.readlink(proc+'/fd/'+fd))
            except FileNotFoundError: pass
        with open(proc+'/maps') as f:
            for line in f:
                if '/' in line: paths.append(line[line.index('/'):].strip())
    except (OSError,ValueError) as error:
        if getattr(error,"errno",None)==3: continue # ESRCH: exited/zombie process
        if os.path.exists(proc): uncertain=True
print(json.dumps({'paths':paths,'uncertain':uncertain}))
`;

/** Capture OS evidence once per pass. Unreadable same-user evidence fails closed.
 * No signals are sent and no process or helper lifecycle is changed. */
export async function capturePrivateProcessUse(): Promise<(root: string) => boolean> {
  if (process.platform !== 'linux' || !process.getuid) return () => true;
  const paths: string[] = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const proc = `/proc/${pid}`;
    try {
      if ((await lstat(proc)).uid !== process.getuid()) continue;
      const environment = await readFile(`${proc}/environ`, 'utf8');
      paths.push(...environment.split('\0').map(value => value.slice(value.indexOf('=') + 1)));
      const command = await readFile(`${proc}/cmdline`, 'utf8');
      paths.push(...command.split('\0'));
      for (const link of ['cwd', 'root', 'exe']) {
        paths.push(await readlink(`${proc}/${link}`).catch(error => {
          if (error.code === 'ENOENT') return '';
          throw error;
        }));
      }
      for (const fd of await readdir(`${proc}/fd`)) {
        paths.push(await readlink(`${proc}/fd/${fd}`).catch(error => {
          if (error.code === 'ENOENT') return '';
          throw error;
        }));
      }
      const maps = await readFile(`${proc}/maps`, 'utf8');
      for (const line of maps.split('\n')) {
        const start = line.indexOf('/');
        if (start >= 0) paths.push(line.slice(start));
      }
    } catch {
      if (await lstat(proc).catch(() => undefined)) {
        try {
          const { stdout } = await execFileAsync('sudo', ['-n', '/usr/bin/python3', '-c', PROCESS_INVENTORY, String(process.getuid())], { maxBuffer: 16 * 1024 * 1024 });
          const snapshot = JSON.parse(stdout) as { paths: string[]; uncertain: boolean };
          if (snapshot.uncertain) return () => true;
          return processPathIndex(snapshot.paths);
        } catch { return () => true; }
      }
    }
  }
  return processPathIndex(paths);
}

/** Prefix lookup avoids rescanning every live process path for every Room. */
function processPathIndex(values: string[]): (root: string) => boolean {
  const paths = [...new Set(values.map(value => {
    const path = value.startsWith('/') ? value : value.slice(value.indexOf('=') + 1);
    return path.replace(/ \(deleted\)$/, '');
  }).filter(path => path.startsWith('/')))].sort();
  const exact = new Set(paths);
  return root => {
    if (exact.has(root)) return true;
    const prefix = `${root}${sep}`;
    let low = 0, high = paths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (paths[middle]! < prefix) low = middle + 1;
      else high = middle;
    }
    return paths[low]?.startsWith(prefix) === true;
  };
}

/** The machine lease owns a private instance before the emulator opens files.
 * Even a stale or unreadable lease defers cleanup; its owner handles retirement. */
async function emulatorLeased(root: string, leaseRoot?: string): Promise<boolean> {
  if (!leaseRoot) return false;
  let entries: string[];
  try { entries = await readdir(leaseRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  for (const entry of entries) {
    if (!entry.endsWith('.lease')) continue;
    const text = await readFile(resolve(leaseRoot, entry), 'utf8');
    if (!text || text.includes(`${root}/`) || root === resolve(leaseRoot, '..', '..') || root === resolve(leaseRoot, '..', '..', '..')) return true;
  }
  return false;
}

/** Durable conversation stores are kept as objects, including SQLite sidecars.
 * Their indexes/maps are part of resumption, not disposable caches. */
const HISTORY_TREES = [
  'claude/projects', 'codex/sessions', 'codex/archived_sessions', 'pi/sessions',
  'grok/sessions', 'grok/conversations', 'cursor/chats', 'user/.cursor/chats',
  'goose/data', 'goose/state', 'state/goose', 'user/.local/share/goose/sessions',
  'user/.local/share/opencode/storage/session',
  'user/.local/share/opencode/storage/message',
  'user/.local/share/opencode/storage/part',
] as const;
const HISTORY_FILES = /^(?:codex\/(?:history\.jsonl|session_index\.jsonl|(?:state_\d+|thread_history_\d+)\.sqlite(?:-wal|-shm)?)|user\/\.local\/share\/opencode\/opencode\.db(?:-wal|-shm)?)$/;
const RESUME_FILES = ['user/.pi/pi-acp/session-map.json'];

function retainedPaths(root: string, archived: boolean): string[] {
  const homes = ['agent-home', 'scratch/agent-home'];
  return homes.flatMap(home => {
    const paths = [...HISTORY_TREES].map(path => resolve(root, home, path));
    paths.push(...RESUME_FILES.map(path => resolve(root, home, path)));
    if (!archived) {
      paths.push(...SHARED_CREDENTIALS.map(item => resolve(root, home, item.dir, item.target)));
    }
    return paths;
  });
}

// These are whole cache/download objects, never individual old files.
const HOME_DISPOSABLE = [
  'cache', 'tmp', 'codex/cache', 'codex/plugins/cache',
  'user/.cache', 'user/.npm/_cacache', 'user/.npm/_logs', 'user/.gradle/caches', 'user/.gradle/wrapper/dists',
  'user/.m2/repository', 'user/.cargo/registry', 'user/.cargo/git',
  'user/.rustup/downloads', 'user/.rustup/tmp', 'user/.rustup/toolchains',
  'user/.local/share/pnpm/store', 'user/.yarn/cache', 'user/.node-gyp',
  'android-instances', 'user/.android/avd', 'user/.android/cache',
  // prepareRoomAgentHome -> provisionManagedSkillsDir rebuilds these exact
  // managed trees on activation. Ambient/operator skill trees are untouched.
  'claude/skills', 'codex/skills', 'grok/skills', 'pi/skills', 'cursor/skills', 'opencode/skills',
];
const BUILD_OBJECTS = ['aab-build', 'apk', 'build', 'dist', 'target', 'build-logs'];
const OPEN_SETTINGS = [
  'claude/.claude.json', 'claude/settings.json', 'codex/config.toml', 'grok/config.toml',
  'pi/settings.json', 'pi/mcp.json', 'pi/models.json', 'pi/models-store.json',
  'cursor/mcp.json', 'user/.cursor/mcp.json', 'goose/config', 'state/gh',
  'user/.expo', 'user/.npmrc', 'user/.gradle/gradle.properties',
  'user/.android/adbkey', 'user/.android/adbkey.pub', 'user/.ssh', 'user/.aws',
  'user/.netrc', 'user/.git-credentials', 'user/.cargo/credentials', 'user/.cargo/credentials.toml',
  'user/.trusty-squire/chrome-profile', 'user/.config/chromium',
  'user/.config/google-chrome', 'user/.config/microsoft-edge', 'user/.mozilla',
];

function disposalObjects(root: string, archived: boolean, tree: Map<string, TreeEntry>): string[] {
  if (archived) return wholeObjectsExceptSquire(root, tree);
  const keep = retainedPaths(root, archived);
  const squirePaths = [...tree.keys()].filter(isSquirePath);
  const homes = ['agent-home', 'scratch/agent-home'];
  const disposable = homes.flatMap(home => HOME_DISPOSABLE.map(path => resolve(root, home, path)));
  disposable.push(...['', 'scratch', 'agent-home/user', 'scratch/agent-home/user'].flatMap(prefix =>
    BUILD_OBJECTS.map(path => resolve(root, prefix, path))));
  if (!archived) {
    keep.push(...homes.flatMap(home => OPEN_SETTINGS.map(path => resolve(root, home, path))));
    keep.push(resolve(root, 'agent-private'), resolve(root, 'scratch/agent-private'));
    keep.push(resolve(root, '.expo'), resolve(root, 'scratch/.expo'), resolve(root, '.beeline-corner.json'));
  }
  const containers = new Set<string>();
  for (const known of [...keep, ...disposable]) {
    for (let dir = resolve(known, '..'); dir !== root && dir.startsWith(`${root}/`); dir = resolve(dir, '..')) containers.add(dir);
  }
  keep.push(...[...tree.keys()].filter(path => /(?:^|\/)(?:config\.toml|settings\.json|mcp\.json|models\.json|\.claude\.json)$/.test(path)));
  const browserProfiles = [...tree.keys()].filter(path =>
    /(?:^|\/)(?:(?:chrome|chromium|browser|firefox)[-_]?profiles?|\.expo)$/.test(path));
  const protectedPaths = [...new Set([...keep, ...squirePaths, ...browserProfiles])].sort();
  const protectedExact = new Set(protectedPaths);
  const containsProtected = (path: string) => {
    const prefix = `${path}/`;
    let low = 0, high = protectedPaths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (protectedPaths[middle]! < prefix) low = middle + 1;
      else high = middle;
    }
    return protectedPaths[low]?.startsWith(prefix) === true;
  };
  const objects: string[] = [];
  const children = new Map<string, string[]>();
  for (const path of tree.keys()) {
    const parent = resolve(path, '..');
    const values = children.get(parent) ?? [];
    values.push(path);
    children.set(parent, values);
  }
  const visit = (dir: string): void => {
    for (const path of children.get(dir) ?? []) {
      const rel = relative(root, path).replaceAll('\\', '/');
      const homeRelative = rel.replace(/^(?:scratch\/)?agent-home\//, '');
      if (isSquirePath(path) || protectedExact.has(path) || (homeRelative !== rel && HISTORY_FILES.test(homeRelative))) continue;
      const info = tree.get(path)!;
      const splitInstances = /(?:user\/\.android\/avd|android-instances)$/.test(rel);
      if (info.directory && (containers.has(path) || splitInstances)) visit(path);
      else if (!containsProtected(path)) objects.push(path);
    }
  };
  visit(root);
  return objects;
}

/** Removal must not lose a refreshed detached login when write-back is busy,
 * unreadable, or has no operator source. Those outcomes defer the Room. */
export async function settleClaudeLogin(root: string, operatorHome: string): Promise<boolean> {
  for (const home of ['agent-home', 'scratch/agent-home']) {
    const path = resolve(root, home, 'claude/.credentials.json');
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    // Validate the parent first: the write-back intentionally accesses only
    // the operator's exact shared login, never an agent-controlled ancestor link.
    if (!await ordinaryDirectory(resolve(root, home, 'claude'))) return false;
    const outcome = await writeBackRoomClaudeLogin({ root: resolve(root, home), operatorHome });
    if (outcome === 'busy') return false;
  }
  return true;
}

/** A live bind mount must never turn private cleanup into shared-cache cleanup. */
export async function hasMount(path: string): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  return mounts.split('\n').some(line => {
    const mount = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    return mount === path || mount?.startsWith(`${path}/`);
  });
}

/** Decisions come only from explicit server state. The lease prevents new harness
 * launches throughout measurement/removal; OS evidence also protects orphan children.
 * Unknown/read-failed state and shared corners/ are never candidates. */
export async function reclaimHelperStorage(input: {
  runtimeDir: string;
  readStates(): Promise<readonly StorageRoomState[]>;
  withIdleRoom(roomId: string, task: () => Promise<void>): Promise<boolean>;
  relatedRoots?: (roomId: string) => readonly string[];
  progress?: () => Promise<void>;
  inUse?: (root: string) => Promise<boolean>;
  dryRun?: boolean;
  operatorHome?: string;
  emulatorLeaseRoot?: string;
  log?: (entry: StorageReclaimEntry) => void;
  unknown?: (roomId: string, path: string) => void;
  now?: number;
  onError?: (roomId: string, error: unknown) => void;
}): Promise<StorageReclaimEntry[]> {
  const states = await input.readStates().catch(() => []);
  const stateById = new Map(states.map(state => [state.roomId, state]));
  const rooms = resolve(input.runtimeDir, 'rooms');
  if (!await ordinaryDirectory(rooms)) return [];
  const entries: StorageReclaimEntry[] = [];
  let capturedAt = -Infinity;
  let capturedUse: (root: string) => boolean = () => true;
  const observedUse = input.inUse ?? (async (root: string) => {
    if (Date.now() - capturedAt >= 1_000) {
      capturedUse = await capturePrivateProcessUse();
      capturedAt = Date.now();
    }
    return capturedUse(root);
  });
  for (const room of await readdir(rooms, { withFileTypes: true })) {
    await input.progress?.();
    if (!room.isDirectory() || !/^[a-zA-Z0-9-]{1,80}$/.test(room.name)) continue;
    const state = stateById.get(room.name);
    if (!state || typeof state.archived !== 'boolean') continue;
    const root = resolve(rooms, room.name);
    if (!await ordinaryDirectory(root)) continue;
    const ownerInUse = async () => (await Promise.all([root, ...(input.relatedRoots?.(room.name) ?? [])].map(observedUse))).some(Boolean);
    await input.withIdleRoom(room.name, async () => {
      if (await ownerInUse() || await emulatorLeased(root, input.emulatorLeaseRoot)) return;
      if (!input.dryRun && !await settleClaudeLogin(root, input.operatorHome ?? homedir())) return;
      const tree = await storageTree(root);
      const grouped = new Map<string, string[]>();
      for (const path of disposalObjects(root, state.archived, tree)) {
        const databaseKey = path.replace(/\.(sqlite|db)(?:-wal|-shm)$/, '.$1');
        const key = /\/avd\/[^/]+\.ini$/.test(databaseKey) ? databaseKey.replace(/\.ini$/, '.avd') : databaseKey;
        const paths = grouped.get(key) ?? [];
        paths.push(path);
        grouped.set(key, paths);
      }
      const removedLinks = new Map<string, number>();
      for (const [path, objectPaths] of grouped) {
        await input.progress?.();
        if ((await Promise.all(objectPaths.map(hasMount))).some(Boolean)) continue;
        const before = new Map<string, Inode>();
        for (const objectPath of objectPaths) {
          for (const [key, inode] of inventory(objectPath, tree)) {
            const known = before.get(key);
            if (known) known.paths.push(...inode.paths);
            else before.set(key, inode);
          }
        }
        if (!state.archived && [...before.values()].some(inode =>
          !Number.isFinite(inode.lastUsed) || (input.now ?? Date.now()) - inode.lastUsed < STORAGE_ITEM_UNUSED_MS)) {
          input.unknown?.(room.name, path);
          continue;
        }
        const allocatedBytes = [...before.values()].reduce((sum, inode) => sum + inode.blocks, 0);
        // Recheck orphan activity after the potentially long filesystem walk.
        if (await ownerInUse() || await emulatorLeased(root, input.emulatorLeaseRoot)) return;
        let freedBytes = 0;
        if (!input.dryRun) for (const objectPath of objectPaths) await rm(objectPath, { recursive: true });
        // Only a successfully removed object contributes. Charge a shared
        // inode on its last removed link, including links across whole items;
        // operator/shared-checkout links outside these objects are never charged.
        for (const [key, inode] of before) {
          const removed = (removedLinks.get(key) ?? 0) + inode.paths.length;
          removedLinks.set(key, removed);
          if (inode.directory || removed >= inode.links) freedBytes += inode.blocks;
        }
        const entry: StorageReclaimEntry = { roomId: room.name, path, kind: state.archived ? 'archived' : 'open', allocatedBytes, freedBytes };
        entries.push(entry);
        input.log?.(entry);
      }
    }).catch(error => {
      if (input.onError) input.onError(room.name, error);
      else console.error(`[body] private storage cleanup deferred for Room ${room.name}; inventory, login or removal did not settle`);
    });
  }
  return entries;
}

/** Hard exclusion at every depth, including the host/legacy Squire stores. */
export function isSquirePath(path: string): boolean {
  const absolute = resolve(path);
  return absolute.split(sep).some(part => ['.trusty-squire', 'trusty-squire', 'squire-host-config'].includes(part)) ||
    trustySquireLegacyStorePaths().some(root => absolute === root || absolute.startsWith(`${root}${sep}`));
}

const squireTreeIndex = new WeakMap<Map<string, TreeEntry>, { ancestors: Set<string>; children: Map<string, string[]> }>();
function wholeObjectsExceptSquire(root: string, tree: Map<string, TreeEntry>): string[] {
  if (isSquirePath(root)) return [];
  let index = squireTreeIndex.get(tree);
  if (!index) {
    const excluded = [...tree.keys()].filter(isSquirePath);
    const ancestors = new Set<string>();
    const children = new Map<string, string[]>();
    for (const path of excluded) {
      for (let dir = path; tree.has(dir); dir = resolve(dir, '..')) ancestors.add(dir);
    }
    if (excluded.length) for (const path of tree.keys()) {
      const parent = resolve(path, '..');
      const values = children.get(parent) ?? [];
      values.push(path);
      children.set(parent, values);
    }
    index = { ancestors, children };
    squireTreeIndex.set(tree, index);
  }
  if (!index.ancestors.has(root)) return [root];
  return (index.children.get(root) ?? []).flatMap(path => wholeObjectsExceptSquire(path, tree));
}

export interface WholeStorageOptions {
  dryRun?: boolean;
  now?: number;
  inUse?: (path: string) => Promise<boolean>;
  operatorHome?: string;
  emulatorLeaseRoot?: string;
  log?: (entry: StorageReclaimEntry) => void;
  beforeRemove?: () => Promise<boolean>;
  onError?: (path: string, error: unknown) => void;
}

/** An ended owner removes all non-Squire bytes. An idle object is atomic:
 * any recent descendant, process, mount or Squire descendant preserves it. */
export async function reclaimWholeStorageObject(
  root: string, ended: boolean, options: WholeStorageOptions = {},
): Promise<StorageReclaimEntry[]> {
  if (isSquirePath(root) || !await ordinaryDirectory(resolve(root, '..'))) return [];
  const info = await lstat(root).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return [];
  const inUse = options.inUse ?? (async (path: string) => (await capturePrivateProcessUse())(path));
  if (await inUse(root) || await hasMount(root) || await emulatorLeased(root, options.emulatorLeaseRoot)) return [];
  const tree = await storageTree(root).catch(error => {
    options.onError?.(root, error);
    return undefined;
  });
  if (!tree) return [];
  if (!ended && [...tree.keys()].some(path => isSquirePath(path) || /(?:^|\/)(?:(?:chrome|chromium|browser|firefox)[-_]?profiles?|\.expo)$/.test(path))) return [];
  if (!ended && [...tree.values()].some(item => !Number.isFinite(item.lastUsed) ||
      (options.now ?? Date.now()) - item.lastUsed < STORAGE_ITEM_UNUSED_MS)) return [];
  if (options.beforeRemove && !await options.beforeRemove()) return [];
  if (!options.dryRun) {
    // Finds every detached Room login before deleting any part of an owner.
    for (const path of tree.keys()) {
      if (/(?:^|\/)rooms\/[^/]+$/.test(path) && !await settleClaudeLogin(path, options.operatorHome ?? homedir())) return [];
    }
  }
  const entries: StorageReclaimEntry[] = [];
  const links = new Map<string, number>();
  for (const path of ended ? wholeObjectsExceptSquire(root, tree) : [root]) {
    if (await inUse(root) || await hasMount(path) || await emulatorLeased(root, options.emulatorLeaseRoot)) break;
    const before = inventory(path, tree);
    try {
      if (!options.dryRun) await rm(path, { recursive: true });
      let freedBytes = 0;
      for (const [key, inode] of before) {
        const removed = (links.get(key) ?? 0) + inode.paths.length;
        links.set(key, removed);
        if (inode.directory || removed >= inode.links) freedBytes += inode.blocks;
      }
      const entry: StorageReclaimEntry = { roomId: '', path, kind: ended ? 'archived' : 'open',
        allocatedBytes: [...before.values()].reduce((sum, inode) => sum + inode.blocks, 0), freedBytes };
      entries.push(entry);
      options.log?.(entry);
    } catch (error) { console.warn(`[helper] storage object retained ${path}:`, error); }
  }
  return entries;
}

/** Squire-only ancestors are exempt; an empty non-Squire directory is still
 * orphan storage. Stop at the first owned byte without reading file contents. */
export async function hasNonSquirePayload(root: string): Promise<boolean> {
  if (isSquirePath(root)) return false;
  const info = await lstat(root).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return false;
  const script = String.raw`
import os,sys,stat
excluded={'.trusty-squire','trusty-squire','squire-host-config'}
def payload(path):
    if os.path.basename(path) in excluded: return False
    if not stat.S_ISDIR(os.lstat(path).st_mode): return True
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOATIME|os.O_NOFOLLOW)
    try: names=os.listdir(fd)
    finally: os.close(fd)
    return not names or any(payload(os.path.join(path,name)) for name in names)
print('true' if payload(sys.argv[1]) else 'false')
`;
  const { stdout } = await execFileAsync('/usr/bin/python3', ['-c', script, root]);
  return JSON.parse(stdout) as boolean;
}
