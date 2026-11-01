import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cornerRepositoryCacheDir, materializeCornerWorktree } from './room-runtime.js';
import {
  checkRepositoryCaches,
  RepositoryCacheDamagedError,
} from './repository-cache-repair.js';
import { distillTurnFailureReason, TURN_FAILURE_REASON_MAX } from './turn-failure-reason.js';

/**
 * A reboot mid-fetch leaves zero-byte loose objects in the shared bare cache,
 * and every corner on the machine then dies in its first fetch. These run real
 * git against a bare repository standing in for GitHub.
 */
// Hosted runner names can push the private-cache diagnostic past the receipt
// budget. Exercise that boundary on every host rather than depending on CI.
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  hostname: () => 'repository-cache-ci-host-with-a-long-name',
}));

const execFileAsync = promisify(execFile);
// Each prepare is several real git processes; four of them run per case.
vi.setConfig({ testTimeout: 120_000 });
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const COMMITTER = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const COMMITTER_KEY = { name: 'Bee', publicKey: 'ab'.repeat(32) };

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', cwd ? ['-C', cwd, ...args] : args, {
    env: { ...process.env, ...COMMITTER },
  });
  return result.stdout.trim();
}

async function scratchDir(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  roots.push(path);
  return path;
}

/** A remote with `main`, and a seed clone that can push more commits to it. */
async function remoteWithMain(): Promise<{ remote: string; seed: string }> {
  const scratch = await scratchDir('beeline-cache-remote-');
  const seed = resolve(scratch, 'seed');
  await git(['init', '-b', 'main', seed]);
  await writeFile(resolve(seed, 'README.md'), 'objective\n');
  await git(['add', '.'], seed);
  await git(['commit', '-m', 'objective'], seed);
  const bare = resolve(scratch, 'remote.git');
  await git(['clone', '--bare', seed, bare]);
  await git(['remote', 'add', 'upstream', bare], seed);
  return { remote: `file://${bare}`, seed };
}

async function pushCommit(seed: string, file: string): Promise<void> {
  await writeFile(resolve(seed, file), `${file}\n`);
  await git(['add', '.'], seed);
  await git(['commit', '-m', file], seed);
  await git(['push', 'upstream', 'main'], seed);
}

function prepare(supervisorRoot: string, remote: string, cornerId: string) {
  return materializeCornerWorktree({
    cornerId,
    remote,
    targetBranch: 'main',
    featureBranch: `feature/${cornerId}`,
    token: 'unused',
    supervisorRoot,
    workspaceId: 'workspace',
    committer: COMMITTER_KEY,
  });
}

function loosePath(gitDir: string, oid: string): string {
  return resolve(gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
}

/** What a power loss leaves behind: the object's name with none of its bytes. */
async function emptyLooseObject(gitDir: string, oid: string): Promise<void> {
  const path = loosePath(gitDir, oid);
  expect((await stat(path)).size).toBeGreaterThan(0);
  await rm(path);
  await writeFile(path, '');
}

async function exists(gitDir: string, oid: string): Promise<boolean> {
  return git([`--git-dir=${gitDir}`, 'cat-file', '-e', oid]).then(
    () => true,
    () => false,
  );
}

/**
 * The cache after one prepare, plus a second fetch so `origin/main` and its
 * newest file arrive as loose objects, the way small fetches land them.
 */
async function cacheWithLooseMain() {
  const { remote, seed } = await remoteWithMain();
  const supervisorRoot = await scratchDir('beeline-cache-supervisor-');
  await prepare(supervisorRoot, remote, 'corner-a');
  await pushCommit(seed, 'second.txt');
  const { gitCommonDir, path } = await prepare(supervisorRoot, remote, 'corner-b');
  const main = await git([`--git-dir=${gitCommonDir}`, 'rev-parse', 'refs/remotes/origin/main']);
  const blob = await git([`--git-dir=${gitCommonDir}`, 'rev-parse', `${main}:second.txt`]);
  return { remote, seed, supervisorRoot, gitCommonDir, main, blob, path };
}

describe('a repo cache damaged by a crash', () => {
  it('repairs an empty origin/main object during corner prepare and carries on', async () => {
    const { remote, seed, supervisorRoot, gitCommonDir, main } = await cacheWithLooseMain();
    await emptyLooseObject(gitCommonDir, main);
    await pushCommit(seed, 'third.txt');

    const worktree = await prepare(supervisorRoot, remote, 'corner-b');

    const upstream = await git(['rev-parse', 'main'], seed);
    expect(await git([`--git-dir=${gitCommonDir}`, 'rev-parse', 'refs/remotes/origin/main'])).toBe(
      upstream,
    );
    expect(await git(['rev-parse', 'HEAD'], worktree.path)).toBe(main);
    expect(await exists(gitCommonDir, main)).toBe(true);
    // The same fetch that failed after the crash now exits 0.
    await expect(
      git([
        `--git-dir=${gitCommonDir}`,
        'fetch',
        '--prune',
        'origin',
        '+refs/heads/main:refs/remotes/origin/main',
      ]),
    ).resolves.toBeDefined();
  });

  it('refetches a file whose object a live corner branch still points past', async () => {
    const { remote, supervisorRoot, gitCommonDir, blob } = await cacheWithLooseMain();
    // Only a file object is lost. Every ref tip is intact, so a plain fetch
    // succeeds and the remote is told the cache already has that file.
    await emptyLooseObject(gitCommonDir, blob);
    await checkRepositoryCaches(supervisorRoot);
    expect(await exists(gitCommonDir, blob)).toBe(false);

    const worktree = await prepare(supervisorRoot, remote, 'corner-b');

    expect(await exists(gitCommonDir, blob)).toBe(true);
    expect(await git(['cat-file', '-p', 'HEAD:second.txt'], worktree.path)).toBe('second.txt');
    expect(await git(['status', '--porcelain'], worktree.path)).toBe('');
  });
});

it('a damaged immutable seed never prevents a different agent from starting', async () => {
  const { remote, supervisorRoot, path: existing } = await cacheWithLooseMain();
  const seed = cornerRepositoryCacheDir(supervisorRoot, remote);
  const tree = await git([`--git-dir=${seed}`, 'rev-parse', 'main^{tree}']);
  const blob = await git([`--git-dir=${seed}`, 'commit-tree', tree, '-m', 'damaged seed-only commit']);
  await git([`--git-dir=${seed}`, 'update-ref', 'refs/heads/damaged-seed', blob]);
  await emptyLooseObject(seed, blob);
  const kernel = await import('./kernel-lock.js');
  const acquire = vi.spyOn(kernel, 'withKernelLock').mockImplementation(async () => { throw new Error('unexpected checkout lock'); });
  try {
    const fresh = await prepare(supervisorRoot, remote, 'corner-c');
    expect(await git(['show', 'HEAD:README.md'], fresh.path)).toBe('objective');
    expect(await git(['show', 'HEAD:README.md'], existing)).toBe('objective');
    expect(acquire).not.toHaveBeenCalled();
    expect((await stat(loosePath(seed, blob))).size).toBe(0);
  } finally { acquire.mockRestore(); }
});

describe('crash-safe repo cache writes', () => {
  it('turns on fsync for a new cache and for an existing cache at helper start', async () => {
    const { remote } = await remoteWithMain();
    const supervisorRoot = await scratchDir('beeline-cache-supervisor-');
    const { gitCommonDir } = await prepare(supervisorRoot, remote, 'corner-a');
    expect(await git([`--git-dir=${gitCommonDir}`, 'config', '--get', 'core.fsync'])).toBe(
      'committed',
    );
    expect(await git([`--git-dir=${gitCommonDir}`, 'config', '--get', 'core.fsyncMethod'])).toBe(
      'fsync',
    );

    // A cache cloned by an older helper carries no fsync setting.
    const older = cornerRepositoryCacheDir(supervisorRoot, `${remote}-older`);
    await git(['clone', '--bare', remote, older]);
    await expect(git([`--git-dir=${older}`, 'config', '--get', 'core.fsync'])).rejects.toThrow();

    await checkRepositoryCaches(supervisorRoot);

    for (const gitDir of [gitCommonDir, older]) {
      expect(await git([`--git-dir=${gitDir}`, 'config', '--get', 'core.fsync'])).toBe('committed');
      expect(await git([`--git-dir=${gitDir}`, 'config', '--get', 'core.fsyncMethod'])).toBe(
        'fsync',
      );
    }
  });
});

describe('the helper-start repo cache check', () => {
  it('removes empty objects and keeps healthy objects and live worktree refs', async () => {
    const { supervisorRoot, gitCommonDir, main, path: cornerB } = await cacheWithLooseMain();
    // corner-b has local work: a loose commit only its branch points at.
    await writeFile(resolve(cornerB, 'local.txt'), 'local work\n');
    await git(['add', '.'], cornerB);
    await git(['commit', '-m', 'local work'], cornerB);
    const local = await git(['rev-parse', 'HEAD'], cornerB);
    const healthy = await git(['rev-parse', 'HEAD:local.txt'], cornerB);
    await emptyLooseObject(gitCommonDir, main);

    await checkRepositoryCaches(supervisorRoot);

    await expect(stat(loosePath(gitCommonDir, main))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      git([`--git-dir=${gitCommonDir}`, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main']),
    ).rejects.toThrow();
    expect(await exists(gitCommonDir, healthy)).toBe(true);
    expect(await exists(gitCommonDir, local)).toBe(true);
    expect(
      await git([`--git-dir=${gitCommonDir}`, 'rev-parse', 'refs/heads/feature/corner-b']),
    ).toBe(local);
    await expect(git([`--git-dir=${gitCommonDir}`, 'show-ref', '--verify', 'refs/heads/feature/corner-a'])).rejects.toThrow();
    expect(await git(['status', '--porcelain'], cornerB)).toBe('');
  });
});

describe('a repo cache the helper cannot repair', () => {
  it('fails corner prepare with one plain line naming the machine and the cache', async () => {
    const { remote, supervisorRoot, gitCommonDir, path: cornerA } = await cacheWithLooseMain();
    // corner-a's own branch lost its only copy of a commit. Its worktree is
    // live, so the repair must not delete that branch, and fetch cannot work.
    await writeFile(resolve(cornerA, 'local.txt'), 'local work\n');
    await git(['add', '.'], cornerA);
    await git(['commit', '-m', 'local work'], cornerA);
    const local = await git(['rev-parse', 'HEAD'], cornerA);
    await emptyLooseObject(gitCommonDir, local);

    const failure = await prepare(supervisorRoot, remote, 'corner-b').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RepositoryCacheDamagedError);
    const cache = `repositories/${basename(gitCommonDir)}`;
    const line = `The repo cache ${cache} on ${hostname()} is damaged and automatic repair failed. The machine's owner needs to repair it`;
    expect((failure as Error).message).toBe(line);
    expect(failure).not.toHaveProperty('stderr');
    // The complete diagnostic stays in the journal; turn receipts have a
    // fixed wire budget even when a runner's hostname makes this line longer.
    const receipt = distillTurnFailureReason(failure).text;
    expect(line.length).toBeGreaterThan(TURN_FAILURE_REASON_MAX);
    expect(receipt.length).toBe(TURN_FAILURE_REASON_MAX);
    expect(receipt).toContain(cache);
    expect(receipt).toContain(hostname());
    expect(receipt.endsWith('…')).toBe(true);
    expect(line.startsWith(receipt.slice(0, -1))).toBe(true);
    expect(await git([`--git-dir=${gitCommonDir}`, 'rev-parse', 'refs/heads/feature/corner-b'])).toBe(
      local,
    );
  });
});
