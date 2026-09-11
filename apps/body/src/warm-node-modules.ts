/**
 * Warm npm starts for corner worktrees: one shared package cache, and a
 * lockfile-keyed `node_modules` store hardlinked into every new worktree.
 *
 * A corner worktree is cut from a bare canonical clone and therefore arrives
 * with no `node_modules` at all, while `agent-home.ts` hands every corner its
 * own `$HOME` — so npm's default cache (`$HOME/.npm`) is private to that one
 * corner too. The result before this module: every corner on a host downloads
 * and unpacks the same dependency tree from the network, from scratch, once.
 *
 * Two host-wide directories fix that, both under `<supervisorRoot>/beeline`
 * beside `corners/` and `repositories/`:
 *
 *   - `npm-cache/` is handed to every corner session as `npm_config_cache`,
 *     so the *first* install on a host is the only one that pays the network.
 *     npm's cache is content-addressed and concurrency-safe by design
 *     (`cacache` locks per entry), which is what makes one cache shared by
 *     parallel corners correct rather than merely convenient.
 *   - `node-modules/<key>/` holds complete dependency trees keyed by the
 *     lockfile that produced them. A new worktree whose lockfile matches an
 *     entry gets that tree HARDLINKED in, which costs no additional disk and
 *     no unpacking — the second corner on a lockfile skips install entirely.
 *
 * **An install is not always one directory.** npm hoists a workspace tree to
 * the root `node_modules`, but a version conflict leaves packages in a
 * workspace's own `node_modules` as well, and a store that carried only the
 * root would hand every later corner a tree npm considers finished and Node
 * cannot resolve. A store entry therefore mirrors the worktree: every
 * `node_modules` directory the lockfile names, at its own relative path. Those
 * paths come from the repository under work, so each one is checked to be a
 * contained relative path before anything is read or written through it.
 *
 * **The key is the lockfile plus this host's build identity** — platform,
 * architecture and the Node ABI version — because a tree containing compiled
 * native addons is only valid for the runtime that built it. It is the same
 * key shape a CI cache uses, and it carries the same assumption: sessions run
 * the same `node` the daemon does. A session that switches Node major versions
 * by hand gets a tree built for another ABI, exactly as it would from a CI
 * cache restore, and `npm rebuild` is the same remedy.
 *
 * **Only a COMPLETE tree is stored.** A corner that installed with `--omit=dev`
 * or interrupted an install would otherwise poison every later corner on that
 * lockfile with a half tree that npm considers satisfied. {@link
 * harvestWarmNodeModules} compares npm's own hidden lockfile
 * (`node_modules/.package-lock.json`) against every non-optional entry the
 * repository lockfile requires and stores nothing when any of them is missing.
 *
 * **Why the store is copied out and hardlinked in, not hardlinked both ways.**
 * Harvest COPIES (reflinked where the filesystem supports it), so the corner
 * that warmed the store keeps an ordinary private tree and the store's inodes
 * are never shared with a live worktree. Seeding then hardlinks, so every later
 * worktree shares the store's inodes — and those files are stored without write
 * bits, so an in-place write through a shared inode fails instead of silently
 * rewriting a dependency for every other corner on the host. npm itself never
 * needs that write: it replaces packages by unlinking and recreating them,
 * which a writable parent directory permits regardless of file mode. The one
 * file npm does rewrite in place is its hidden lockfile at the root of
 * `node_modules`, so each tree's own top-level files are copied writable
 * rather than linked.
 *
 * Stated plainly: read-only modes are hygiene, not confinement. A session can
 * `chmod` its own hardlink and write through it, the same way the bwrap
 * denylist keeps sibling work pristine without pretending to confine a
 * determined process. The blast radius is a derived, disposable directory —
 * delete `<supervisorRoot>/beeline/node-modules` and the next corner rebuilds
 * it — and the store itself sits under the read-only supervisor root that a
 * corner session cannot reach at all.
 *
 * Nothing here may fail a corner. Every entry point reports an outcome instead
 * of throwing: a cold store, an unreadable lockfile, a cross-filesystem store
 * and a crashed harvest all degrade to the install the corner would have run
 * anyway.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Bumped when the on-disk shape of a store entry changes. It is part of the
 * key, so old entries simply stop matching instead of needing a migration.
 */
const STORE_FORMAT = 'v1';

/** Staged trees, mid-clone. Named so a crashed run is sweepable. */
const STAGING_PREFIX = '.beeline-warm-';

/** A staging directory older than this was left by a process that died. */
export const STAGING_SWEEP_MS = 24 * 60 * 60 * 1000;

/**
 * How many lockfile keys the store keeps, most-recently-used first.
 *
 * An entry is a whole dependency tree — this repository's is ~600MB — and a
 * lockfile changes on any PR that touches a dependency, so an unbounded store
 * would fill the operator's disk with trees no corner will ask for again. The
 * working set is small by nature: the target branch's lockfile, plus whatever
 * a branch under work has changed it to.
 *
 * Dropping an entry never breaks a worktree seeded from it. Those are
 * hardlinks, so the inodes live until the last link goes — the store is giving
 * up its own reference, not the files.
 */
export const WARM_STORE_MAX_ENTRIES = 3;

/** The one npm cache every corner session on this host shares. */
export function sharedNpmCacheDir(supervisorRoot: string): string {
  return resolve(supervisorRoot, 'beeline', 'npm-cache');
}

/** The host-wide warm `node_modules` store, one entry per lockfile key. */
export function warmNodeModulesStoreDir(supervisorRoot: string): string {
  return resolve(supervisorRoot, 'beeline', 'node-modules');
}

/**
 * What a warm start for one checkout is keyed to and made of, or the reason
 * this checkout has none.
 */
export interface WarmPlan {
  key: string;
  /** Worktree-relative `node_modules` directories, sorted and deduplicated. */
  trees: string[];
}

export type PlanFailure = 'no-lockfile' | 'unsafe-lockfile';

export interface PlanRefusal {
  failure: PlanFailure;
  detail?: string;
}

export function isPlanRefusal(value: WarmPlan | PlanRefusal): value is PlanRefusal {
  return 'failure' in value;
}

/**
 * Read a checkout's lockfile into the store key and the set of directories an
 * install of it materializes.
 *
 * An absent, unparseable or dependency-free lockfile is `no-lockfile`: there
 * is nothing a warm start could be keyed to, which is an ordinary answer and
 * not an error. A lockfile naming a path that leaves the checkout is
 * `unsafe-lockfile` and stops every read and write this module would do
 * through it.
 */
export async function readWarmPlan(worktreePath: string): Promise<WarmPlan | PlanRefusal> {
  const lockfile = await readFile(resolve(worktreePath, 'package-lock.json')).catch(
    () => undefined,
  );
  if (!lockfile) return { failure: 'no-lockfile' };
  const packages = parseLockfilePackages(lockfile);
  if (!packages) return { failure: 'no-lockfile' };
  const trees = nodeModulesTreePaths(packages);
  if (trees.length === 0) return { failure: 'no-lockfile' };
  const unsafe = trees.find((tree) => !isContainedTreePath(tree));
  if (unsafe) return { failure: 'unsafe-lockfile', detail: unsafe };
  const key = createHash('sha256')
    .update(`${STORE_FORMAT}\0${process.platform}\0${process.arch}\0${process.versions.modules}\0`)
    .update(lockfile)
    .digest('hex')
    .slice(0, 32);
  return { key, trees };
}

/**
 * Every `node_modules` directory an install of these lockfile entries would
 * create, worktree-relative and deduplicated.
 *
 * A package nested inside another package (`node_modules/a/node_modules/b`)
 * belongs to the tree it is nested in, so only the FIRST `node_modules`
 * segment of a path names a tree. The match is on a whole path SEGMENT: a
 * workspace directory merely ending in `node_modules` is an ordinary
 * directory, and reading one as a tree would refuse the whole lockfile.
 */
export function nodeModulesTreePaths(packages: Record<string, unknown>): string[] {
  const trees = new Set<string>();
  for (const path of Object.keys(packages)) {
    const segments = path.split('/');
    const index = segments.indexOf('node_modules');
    // A trailing `node_modules` names no package, so it names no tree either.
    if (index < 0 || index === segments.length - 1) continue;
    trees.add(segments.slice(0, index + 1).join('/'));
  }
  return [...trees].sort();
}

export type SeedReason = 'seeded' | 'present' | PlanFailure | 'cold' | 'cross-device' | 'failed';

export interface SeedOutcome {
  reason: SeedReason;
  key?: string;
  /** Operator-facing detail for every reason that is not a plain answer. */
  detail?: string;
}

export type HarvestReason =
  | 'stored'
  | 'already-warm'
  | PlanFailure
  | 'no-node-modules'
  | 'incomplete'
  | 'changed'
  | 'failed';

export interface HarvestOutcome {
  reason: HarvestReason;
  key?: string;
  /** Operator-facing detail for every reason that is not a plain answer. */
  detail?: string;
}

/**
 * Hardlink the stored trees for this checkout's lockfile into the checkout.
 *
 * A checkout that already has any of them is left exactly as it is: this seeds
 * a new worktree, it never reconciles an existing tree. Placement is one
 * `rename` per tree out of a fully materialized staging directory, and a
 * failure part-way through puts back what it already moved — a half-seeded
 * checkout would be worse than a cold one, because npm would believe it.
 */
export async function seedWarmNodeModules(input: {
  worktreePath: string;
  storeRoot: string;
  now?: () => number;
}): Promise<SeedOutcome> {
  const plan = await readWarmPlan(input.worktreePath);
  if (isPlanRefusal(plan)) {
    return { reason: plan.failure, ...(plan.detail ? { detail: plan.detail } : {}) };
  }
  // Asked before the store is: a checkout that already has an install is not
  // this function's business whether the store is warm or not, and `present`
  // is the answer that says so.
  for (const tree of plan.trees) {
    if (await pathExists(resolve(input.worktreePath, tree))) {
      return { reason: 'present', key: plan.key };
    }
  }
  const entry = resolve(input.storeRoot, plan.key);
  if (!(await isDirectory(entry))) return { reason: 'cold', key: plan.key };
  // A hardlink cannot cross a filesystem. Asking costs one `stat` each; not
  // asking costs a whole tree's worth of linking before the final `rename`
  // fails, on every new corner, forever.
  const [storeDevice, checkoutDevice] = await Promise.all([
    deviceOf(entry),
    deviceOf(input.worktreePath),
  ]);
  if (storeDevice === undefined || storeDevice !== checkoutDevice) {
    return { reason: 'cross-device', key: plan.key };
  }
  // Staged in the STORE, not the worktree: the hardlinks already require one
  // filesystem for both, and residue from a killed daemon belongs where the
  // sweeper looks rather than in a checkout, where it would surface as an
  // untracked directory in the corner's own `git status`.
  const staging = resolve(input.storeRoot, `${STAGING_PREFIX}${process.pid}.${randomUUID()}`);
  const placed: string[] = [];
  const now = (input.now ?? Date.now)();
  try {
    await sweepStaleStaging(input.storeRoot, now);
    // Marked used BEFORE it is read, so an entry being seeded right now is the
    // newest one in the store and a concurrent prune cannot choose it.
    await utimes(entry, now / 1000, now / 1000).catch(() => undefined);
    for (const tree of plan.trees) {
      await cloneTree(resolve(entry, tree), resolve(staging, tree), seedFile);
    }
    for (const tree of plan.trees) {
      const target = resolve(input.worktreePath, tree);
      await mkdir(dirname(target), { recursive: true });
      await rename(resolve(staging, tree), target);
      placed.push(target);
    }
    return { reason: 'seeded', key: plan.key };
  } catch (error) {
    for (const target of placed) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
    return { reason: 'failed', key: plan.key, detail: describe(error) };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Store this checkout's dependency trees under its lockfile key, when the
 * store has no entry for that key yet and what is on disk is a complete
 * install.
 *
 * Called at the end of a corner turn, where the common case is the one-`stat`
 * `already-warm` answer. The first corner on a lockfile pays a copy nobody
 * waits on; every corner after it pays nothing at all.
 */
export async function harvestWarmNodeModules(input: {
  worktreePath: string;
  storeRoot: string;
  now?: () => number;
  /** Seam for tests; the one moment a concurrent install would land. */
  onCopied?: () => Promise<void> | void;
}): Promise<HarvestOutcome> {
  const plan = await readWarmPlan(input.worktreePath);
  if (isPlanRefusal(plan)) {
    return { reason: plan.failure, ...(plan.detail ? { detail: plan.detail } : {}) };
  }
  const entry = resolve(input.storeRoot, plan.key);
  if (await pathExists(entry)) return { reason: 'already-warm', key: plan.key };
  for (const tree of plan.trees) {
    if (!(await isDirectory(resolve(input.worktreePath, tree)))) {
      return { reason: 'no-node-modules', key: plan.key, detail: tree };
    }
  }
  const missing = await missingInstalledPackages(input.worktreePath);
  if (missing.length > 0) {
    return {
      reason: 'incomplete',
      key: plan.key,
      detail: `${missing.length} absent, e.g. ${missing.slice(0, 3).join(', ')}`,
    };
  }
  const staging = resolve(input.storeRoot, `${STAGING_PREFIX}${process.pid}.${randomUUID()}`);
  try {
    await mkdir(input.storeRoot, { recursive: true, mode: 0o755 });
    await sweepStaleStaging(input.storeRoot, (input.now ?? Date.now)());
    for (const tree of plan.trees) {
      await cloneTree(resolve(input.worktreePath, tree), resolve(staging, tree), harvestFile);
    }
    await input.onCopied?.();
    // The corner's next turn may begin while this copy is still running, and
    // an install during it would leave a torn tree that passed its
    // completeness check before the tearing. npm rewrites the hidden lockfile
    // on every install, so a staged copy that no longer matches the checkout
    // was taken across a change and is not a tree to hand anyone.
    if (!(await stagedTreeStillMatches(input.worktreePath, staging, plan.key))) {
      return { reason: 'changed', key: plan.key };
    }
    // First writer wins: `rename` onto a populated directory fails, which is
    // the whole of the concurrency story between two corners on one lockfile.
    await rename(staging, entry);
    await pruneWarmStore(input.storeRoot, WARM_STORE_MAX_ENTRIES);
    return { reason: 'stored', key: plan.key };
  } catch (error) {
    if (await pathExists(entry)) return { reason: 'already-warm', key: plan.key };
    return { reason: 'failed', key: plan.key, detail: describe(error) };
  } finally {
    // A no-op once the rename has moved it; the only path that leaves one
    // behind is a process that died before reaching here.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Whether the checkout is still, byte for byte, the install that was copied. */
async function stagedTreeStillMatches(
  worktreePath: string,
  staging: string,
  key: string,
): Promise<boolean> {
  const settled = await readWarmPlan(worktreePath);
  if (isPlanRefusal(settled) || settled.key !== key) return false;
  const hidden = join('node_modules', '.package-lock.json');
  const [copied, current] = await Promise.all([
    readFile(resolve(staging, hidden)).catch(() => undefined),
    readFile(resolve(worktreePath, hidden)).catch(() => undefined),
  ]);
  return Boolean(copied && current && copied.equals(current));
}

/**
 * Every package the repository lockfile requires that npm's hidden lockfile
 * does not record as installed.
 *
 * npm writes `node_modules/.package-lock.json` to mirror the tree it actually
 * built, so this compares what was asked for against what was done. Entries
 * npm may legitimately skip are not required: workspace links (symlinks into
 * the checkout, not installs), `optional` dependencies, and anything
 * constrained to another `os`/`cpu`.
 */
export async function missingInstalledPackages(worktreePath: string): Promise<string[]> {
  const wanted = parseLockfilePackages(
    await readFile(resolve(worktreePath, 'package-lock.json')).catch(() => undefined),
  );
  const installed = parseLockfilePackages(
    await readFile(resolve(worktreePath, 'node_modules', '.package-lock.json')).catch(
      () => undefined,
    ),
  );
  if (!wanted) return ['package-lock.json is unreadable'];
  if (!installed) return ['node_modules/.package-lock.json is absent'];
  const missing: string[] = [];
  for (const [path, entry] of Object.entries(wanted)) {
    if (!path.includes('node_modules/')) continue;
    if (entry.link === true || entry.optional === true) continue;
    if (entry.os !== undefined || entry.cpu !== undefined) continue;
    if (!(path in installed)) missing.push(path);
  }
  return missing.sort();
}

interface LockfilePackage {
  link?: boolean;
  optional?: boolean;
  os?: unknown;
  cpu?: unknown;
}

function parseLockfilePackages(
  source: Buffer | undefined,
): Record<string, LockfilePackage> | undefined {
  if (!source) return undefined;
  try {
    const parsed = JSON.parse(source.toString('utf8')) as {
      packages?: Record<string, LockfilePackage>;
    };
    const packages = parsed.packages;
    if (!packages || typeof packages !== 'object' || Array.isArray(packages)) return undefined;
    return packages;
  } catch {
    return undefined;
  }
}

/**
 * A tree path is only usable when it stays inside the checkout. Lockfile keys
 * are repository content, so `../` and absolute paths are refused here rather
 * than resolved into a write outside the worktree or a read outside the store.
 */
export function isContainedTreePath(value: string): boolean {
  const segments = value.split('/');
  if (segments.pop() !== 'node_modules') return false;
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\'),
  );
}

/** A file materialized into a cloned tree, given its source and destination. */
type CloneFile = (source: string, target: string, topLevel: boolean) => Promise<void>;

/**
 * Walk one dependency tree, recreating its shape at `target`.
 *
 * Directories are real directories and symlinks are recreated as symlinks —
 * `node_modules/.bin` is nothing but symlinks, a workspace package is one too,
 * and a hardlink to either would bind the link's inode rather than reproduce
 * it. Only ordinary files reach `file`, which is where the copy-vs-hardlink
 * difference lives.
 */
async function cloneTree(
  source: string,
  target: string,
  file: CloneFile,
  topLevel = true,
): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o755 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(from), to);
      continue;
    }
    if (entry.isDirectory()) {
      await cloneTree(from, to, file, false);
      continue;
    }
    // Sockets, fifos and devices are not dependencies; a tree containing one
    // is not a tree worth reproducing.
    if (entry.isFile()) await file(from, to, topLevel);
  }
}

/** Into the store: a private copy, then the write bits stripped. */
const harvestFile: CloneFile = async (source, target) => {
  await copyFile(source, target, fsConstants.COPYFILE_FICLONE);
  const info = await stat(source);
  await chmod(target, info.mode & 0o7777 & ~0o222);
};

/**
 * Out of the store: a hardlink, except for npm's own bookkeeping at the root
 * of a tree (`.package-lock.json`), which npm rewrites in place and which
 * therefore has to be this worktree's own writable file.
 */
const seedFile: CloneFile = async (source, target, topLevel) => {
  if (!topLevel) {
    await link(source, target);
    return;
  }
  await copyFile(source, target);
  await chmod(target, 0o644);
};

/**
 * Keep the `keep` most recently used entries and delete the rest.
 *
 * Recency is the entry's own mtime: set when it was stored, and refreshed by
 * {@link seedWarmNodeModules} each time a worktree is cut from it. Run after a
 * store, which is the only moment the store grows.
 */
export async function pruneWarmStore(storeRoot: string, keep: number): Promise<string[]> {
  const names = (await readdir(storeRoot).catch(() => [] as string[])).filter(
    (name) => !name.startsWith(STAGING_PREFIX),
  );
  const entries: Array<{ name: string; usedAt: number }> = [];
  for (const name of names) {
    const info = await lstat(join(storeRoot, name)).catch(() => undefined);
    if (info?.isDirectory()) entries.push({ name, usedAt: info.mtimeMs });
  }
  const dropped = entries
    .sort((a, b) => b.usedAt - a.usedAt || a.name.localeCompare(b.name))
    .slice(keep);
  for (const entry of dropped) {
    await rm(join(storeRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
  }
  return dropped.map((entry) => entry.name);
}

/**
 * Remove staging trees left behind by a process that died mid-clone. A live
 * clone's staging directory is younger than the window by construction, so
 * this never races a sibling daemon on the same host.
 */
async function sweepStaleStaging(storeRoot: string, now: number): Promise<void> {
  const entries = await readdir(storeRoot).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const path = join(storeRoot, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info || now - info.mtimeMs < STAGING_SWEEP_MS) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function deviceOf(path: string): Promise<number | undefined> {
  return stat(path).then(
    (info) => info.dev,
    () => undefined,
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
