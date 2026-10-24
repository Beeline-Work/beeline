import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { repositoryCacheDamagedFault } from '@beeline/api-contract/daemon';
import { withKernelLock } from './kernel-lock.js';

const GIT_BUFFER = 4 * 1024 * 1024;

/**
 * Git does not fsync loose objects by default, so after a power loss ext4 can
 * keep an object's name with none of its bytes. `committed` syncs objects,
 * packs and refs before a fetch or commit reports success.
 */
const CRASH_SAFE_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.fsync', 'committed'],
  ['core.fsyncMethod', 'fsync'],
];

/** `git clone` arguments that apply the crash-safe settings before any object is written. */
export const CRASH_SAFE_CLONE_ARGS: readonly string[] = CRASH_SAFE_GIT_CONFIG.flatMap(
  ([key, value]) => ['-c', `${key}=${value}`],
);

/** Left by the helper-start check so the next fetch also restores lost history. */
const REPAIR_PENDING_FILE = 'beeline-repair-pending';

/** The kernel lock materialize already holds while it fetches into a corner cache. */
async function cornerRepositoryLockKey(gitCommonDir: string): Promise<string> {
  return `corner-repository:${resolve(await realpath(dirname(gitCommonDir)), basename(gitCommonDir))}`;
}

/** Git's errors for an object store with empty, corrupt or missing objects. */
function isRepositoryCacheCorruption(error: unknown): boolean {
  return /object file .* is empty|bad object|loose object .* is corrupt|did not send all necessary objects/i.test(
    diagnosticText(error),
  );
}

/** A cache the helper could not repair. Carries no git stderr, only the plain line. */
export class RepositoryCacheDamagedError extends Error {
  constructor(label: string, readonly diagnostic: string) {
    super(repositoryCacheDamagedFault(label, hostname()));
    this.name = 'RepositoryCacheDamagedError';
  }
}

function diagnosticText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const message = error instanceof Error ? error.message : '';
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  return `${message}\n${stderr}`;
}

function git(gitDir: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return new Promise<string>((done, fail) => {
    const child = execFile(
      'git',
      [`--git-dir=${gitDir}`, ...args],
      { ...(options.env ? { env: options.env } : {}), maxBuffer: GIT_BUFFER },
      (error, stdout, stderr) => {
        if (error) fail(Object.assign(error, { stderr }));
        else done(stdout);
      },
    );
    child.stdin?.end(options.input ?? '');
  });
}

/** Loose objects with a name and no bytes. Only hex-named files; temp files are never touched. */
async function emptyLooseObjects(gitDir: string): Promise<string[]> {
  const objects = resolve(gitDir, 'objects');
  const fanouts = await readdir(objects).catch(() => [] as string[]);
  const empty: string[] = [];
  for (const fanout of fanouts) {
    if (!/^[0-9a-f]{2}$/.test(fanout)) continue;
    for (const name of await readdir(resolve(objects, fanout)).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{38}$|^[0-9a-f]{62}$/.test(name)) continue;
      const stats = await lstat(resolve(objects, fanout, name)).catch(() => undefined);
      if (stats?.isFile() && stats.size === 0) empty.push(`${fanout}${name}`);
    }
  }
  return empty;
}

async function missingObjects(gitDir: string, oids: readonly string[]): Promise<Set<string>> {
  if (!oids.length) return new Set();
  const output = await git(gitDir, ['cat-file', '--batch-check'], { input: `${oids.join('\n')}\n` });
  return new Set(
    output
      .split('\n')
      .map((line) => line.match(/^([0-9a-f]{40,64}) missing$/)?.[1])
      .filter((oid): oid is string => Boolean(oid)),
  );
}

interface RepositoryCacheRepair {
  readonly removedObjects: readonly string[];
  readonly removedRefs: readonly string[];
}

/**
 * Remove empty (and git-named corrupt) loose objects, then the remote-tracking
 * refs and FETCH_HEAD that point at objects no longer present. Local branches
 * are never touched: corner worktrees live on them, and the cache is never
 * re-cloned because every corner worktree hangs off it.
 */
async function repairRepositoryCache(
  gitDir: string,
  diagnostic = '',
): Promise<RepositoryCacheRepair> {
  const corrupt = [...diagnostic.matchAll(/loose object ([0-9a-f]{40,64}) \(stored in [^)]*\) is corrupt/gi)]
    .map((match) => match[1]!.toLowerCase());
  const removedObjects = [...new Set([...(await emptyLooseObjects(gitDir)), ...corrupt])];
  for (const oid of removedObjects)
    await rm(resolve(gitDir, 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });

  const refs = (await git(gitDir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes']))
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter((parts): parts is [string, string] => parts.length === 2);
  const missing = await missingObjects(gitDir, refs.map(([oid]) => oid));
  const removedRefs: string[] = [];
  for (const [oid, ref] of refs) {
    if (!missing.has(oid)) continue;
    // Old-value guarded: a concurrent fetch that just healed this ref wins.
    await git(gitDir, ['update-ref', '-d', ref, oid]).then(
      () => removedRefs.push(ref),
      () => undefined,
    );
  }
  const fetchHead = resolve(gitDir, 'FETCH_HEAD');
  const fetched = (await readFile(fetchHead, 'utf8').catch(() => ''))
    .split('\n')
    .map((line) => line.match(/^([0-9a-f]{40,64})\b/)?.[1])
    .filter((oid): oid is string => Boolean(oid));
  if ((await missingObjects(gitDir, fetched)).size) {
    await rm(fetchHead, { force: true });
    removedRefs.push('FETCH_HEAD');
  }
  return { removedObjects, removedRefs };
}

/** Destination refs of explicit fetch refspecs; wildcard destinations become globs. */
function fetchedRefs(args: readonly string[]): string[] {
  return args
    .filter((arg) => !arg.startsWith('-') && arg.includes(':'))
    .map((refspec) => refspec.slice(refspec.indexOf(':') + 1))
    .map((ref) => (ref.includes('*') ? `--glob=${ref}` : ref));
}

async function fetchedHistoryIsComplete(gitDir: string, args: readonly string[]): Promise<boolean> {
  const refs = fetchedRefs(args);
  if (!refs.length) return true;
  const present: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith('--glob=')) present.push(ref);
    else if (await git(gitDir, ['rev-parse', '--verify', '-q', ref]).then(() => true, () => false))
      present.push(ref);
  }
  if (!present.length) return true;
  const listed = await git(gitDir, ['rev-list', '--objects', '--missing=print', ...present]);
  return !/^\?/m.test(listed);
}

/**
 * One cache fetch that survives a crash-damaged object store: on git's
 * corruption errors it repairs the cache and retries once. When a live branch
 * still claims history the cache lost, the fetch is repeated with
 * `--refetch` so the remote sends that history again. A failure that is still
 * corruption becomes `RepositoryCacheDamagedError`; any other failure (a
 * network error, a missing remote branch) is rethrown unchanged.
 */
export async function fetchRepositoryCache(input: {
  gitDir: string;
  /** How the plain failure line names this cache, e.g. `repositories/<hash>.git`. */
  label: string;
  /** Arguments after `git fetch`, e.g. `['--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main']`. */
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { gitDir, label, args } = input;
  const fetch = (extra: readonly string[] = []) =>
    git(gitDir, ['fetch', ...extra, ...args], input.env ? { env: input.env } : {});
  const damaged = (error: unknown): never => {
    if (!isRepositoryCacheCorruption(error)) throw error;
    console.error(`[thin-core] repo cache ${label} could not be repaired:`, diagnosticText(error).trim());
    throw new RepositoryCacheDamagedError(label, diagnosticText(error));
  };
  const marker = resolve(gitDir, REPAIR_PENDING_FILE);
  let repaired = existsSync(marker);
  try {
    await fetch();
  } catch (error) {
    if (!isRepositoryCacheCorruption(error)) throw error;
    const repair = await repairRepositoryCache(gitDir, diagnosticText(error));
    console.warn(
      `[thin-core] repo cache ${label} damaged; removed ${repair.removedObjects.length} empty or corrupt objects and ${repair.removedRefs.length} refs, retrying fetch`,
    );
    await fetch().catch(damaged);
    repaired = true;
  }
  if (!repaired) return;
  if (!(await fetchedHistoryIsComplete(gitDir, args))) {
    console.warn(`[thin-core] repo cache ${label} still lacks fetched history; refetching it`);
    await fetch(['--refetch']).catch(damaged);
    if (!(await fetchedHistoryIsComplete(gitDir, args)))
      damaged(new Error(`${label}: fetched refs still have missing objects after refetch`));
  }
  await rm(marker, { force: true });
}

/** Every repo the helper fetches into: corner caches and Room checkouts. */
async function helperRepositories(
  supervisorRoot: string,
): Promise<Array<{ gitDir: string; label: string; lock: boolean }>> {
  const root = resolve(supervisorRoot, 'beeline');
  const found: Array<{ gitDir: string; label: string; lock: boolean }> = [];
  for (const name of await readdir(resolve(root, 'repositories')).catch(() => [] as string[])) {
    const gitDir = resolve(root, 'repositories', name);
    if (name.endsWith('.git') && existsSync(resolve(gitDir, 'HEAD')))
      found.push({ gitDir, label: `repositories/${name}`, lock: true });
  }
  for (const name of await readdir(resolve(root, 'room-checkouts')).catch(() => [] as string[])) {
    const gitDir = resolve(root, 'room-checkouts', name, '.git');
    if (existsSync(resolve(gitDir, 'HEAD')))
      found.push({ gitDir, label: `room-checkouts/${name}`, lock: false });
  }
  return found;
}

async function checkRepository(gitDir: string, label: string): Promise<void> {
  for (const [key, value] of CRASH_SAFE_GIT_CONFIG) {
    const current = await git(gitDir, ['config', '--get', key]).then((out) => out.trim(), () => '');
    if (current !== value) await git(gitDir, ['config', key, value]);
  }
  if (!(await emptyLooseObjects(gitDir)).length) return;
  const repair = await repairRepositoryCache(gitDir);
  // The next fetch checks that the history it lands is whole again.
  await writeFile(resolve(gitDir, REPAIR_PENDING_FILE), `${new Date().toISOString()}\n`);
  console.warn(
    `[thin-core] repo cache ${label} had crash damage; removed ${repair.removedObjects.length} empty objects and ${repair.removedRefs.length} refs`,
  );
}

/**
 * Helper start: turn on crash-safe writes for every existing repo, and repair
 * any repo a crash left with empty loose objects before a corner uses it.
 * Never fatal; a cache this cannot fix is repaired again by its next fetch.
 */
export async function checkRepositoryCaches(supervisorRoot: string): Promise<void> {
  for (const { gitDir, label, lock } of await helperRepositories(supervisorRoot)) {
    try {
      if (lock) await withKernelLock(await cornerRepositoryLockKey(gitDir), () => checkRepository(gitDir, label));
      else await checkRepository(gitDir, label);
    } catch (error) {
      console.error(`[thin-core] repo cache ${label} check failed:`, error);
    }
  }
}

const checked = new Map<string, Promise<void>>();

/** `checkRepositoryCaches` once per helper process and supervisor root. */
export function checkRepositoryCachesOnce(supervisorRoot: string): Promise<void> {
  let check = checked.get(supervisorRoot);
  if (!check) {
    check = checkRepositoryCaches(supervisorRoot);
    checked.set(supervisorRoot, check);
  }
  return check;
}
