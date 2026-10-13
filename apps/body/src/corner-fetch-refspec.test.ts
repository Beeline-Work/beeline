import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeCornerWorktree } from './room-runtime.js';

/**
 * A corner is cut from a bare cache, and a bare clone writes no
 * `remote.origin.fetch`. Without that refspec a plain `git fetch origin main`
 * only moves FETCH_HEAD, so `origin/main` stays stale and an agent rebases or
 * diffs against an old main. These cases run real git against a real bare
 * remote, because a fake would only prove the fake agrees.
 */
const execFileAsync = promisify(execFile);
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, ...COMMITTER },
  });
  return result.stdout.trim();
}

async function gitDir(gitCommonDir: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', [`--git-dir=${gitCommonDir}`, ...args], {
    env: { ...process.env, ...COMMITTER },
  });
  return result.stdout.trim();
}

const WILDCARD_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

/** A bare remote with one commit on `main`, plus the seed it was cloned from. */
async function bareRemoteWithMain(root: string): Promise<{ remote: string; seed: string }> {
  const seed = resolve(root, 'seed');
  await execFileAsync('git', ['init', '-b', 'main', seed]);
  await writeFile(resolve(seed, 'code.txt'), 'first\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'first');
  const bare = resolve(root, 'remote.git');
  await execFileAsync('git', ['clone', '--bare', seed, bare]);
  return { remote: `file://${bare}`, seed };
}

/** Advance the bare remote's `main` to a fresh commit in its seed. */
async function advanceRemoteMain(seed: string, bare: string, message: string): Promise<string> {
  await writeFile(resolve(seed, 'code.txt'), `${message}\n`);
  await git(seed, 'commit', '-am', message);
  const head = await git(seed, 'rev-parse', 'HEAD');
  await gitDir(bare, 'fetch', seed, 'main');
  await gitDir(bare, 'update-ref', 'refs/heads/main', head);
  return head;
}

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function materialize(supervisorRoot: string, remote: string, cornerId: string) {
  return materializeCornerWorktree({
    cornerId,
    remote,
    targetBranch: 'main',
    featureBranch: `feature/${cornerId}`,
    token: 'unused',
    supervisorRoot,
    committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
  });
}

describe('a corner checkout fetch refspec', () => {
  it('moves origin/main on a plain fetch and is set idempotently', async () => {
    const supervisorRoot = await scratch('beeline-corner-refspec-');
    const { remote, seed } = await bareRemoteWithMain(supervisorRoot);

    const worktree = await materialize(supervisorRoot, remote, 'corner-refspec');

    expect(await git(worktree.path, 'config', '--get', 'remote.origin.fetch')).toBe(
      WILDCARD_REFSPEC,
    );
    // AC-1: repeat prepares must not stack duplicate config entries.
    await materialize(supervisorRoot, remote, 'corner-refspec');
    expect(await git(worktree.path, 'config', '--get-all', 'remote.origin.fetch')).toBe(
      WILDCARD_REFSPEC,
    );

    const before = await git(worktree.path, 'rev-parse', 'origin/main');
    const newHead = await advanceRemoteMain(seed, resolve(supervisorRoot, 'remote.git'), 'second');
    expect(newHead).not.toBe(before);

    await git(worktree.path, 'fetch', 'origin', 'main');

    expect(await git(worktree.path, 'rev-parse', 'origin/main')).toBe(newHead);
  });

  it('repairs a cache cloned before the refspec existed on its next prepare', async () => {
    const supervisorRoot = await scratch('beeline-corner-legacy-refspec-');
    const { remote, seed } = await bareRemoteWithMain(supervisorRoot);

    const worktree = await materialize(supervisorRoot, remote, 'corner-legacy');
    // A cache made by an older Beeline carries no fetch refspec at all.
    await execFileAsync('git', [
      `--git-dir=${worktree.gitCommonDir}`,
      'config',
      '--unset-all',
      'remote.origin.fetch',
    ]).catch(() => undefined);
    await expect(git(worktree.path, 'config', '--get', 'remote.origin.fetch')).rejects.toThrow();

    // The worktree already exists, so this is the next prepare, not a re-clone.
    await materialize(supervisorRoot, remote, 'corner-legacy');
    expect(await git(worktree.path, 'config', '--get', 'remote.origin.fetch')).toBe(
      WILDCARD_REFSPEC,
    );

    const newHead = await advanceRemoteMain(seed, resolve(supervisorRoot, 'remote.git'), 'second');
    await git(worktree.path, 'fetch', 'origin', 'main');
    expect(await git(worktree.path, 'rev-parse', 'origin/main')).toBe(newHead);
  });
});
