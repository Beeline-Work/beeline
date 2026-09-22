import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cornerBranchIsSafeToDelete,
  materializeCornerWorktree,
  removeCornerWorktreeAndBranches,
} from './room-runtime.js';

/**
 * A corner's branch is the shared artifact its pull request points at. Close
 * cleanup may take the worktree, but never an open pull request's head branch:
 * deleting that closes the pull request and leaves the commits reachable only
 * through `refs/pull/<n>/head`. These run against a real bare repository so the
 * proof is git's own answer, not a mock that agrees with the code.
 */
const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const FEATURE = 'feature/corner-open-pr';

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

/** A bare repository with `main` and a corner branch one commit ahead of it. */
async function remoteWithCornerBranch(): Promise<{ remote: string }> {
  const scratch = await mkdtemp(resolve(tmpdir(), 'beeline-corner-preserve-remote-'));
  roots.push(scratch);
  const seed = resolve(scratch, 'seed');
  await execFileAsync('git', ['init', '-b', 'main', seed]);
  await writeFile(resolve(seed, 'README.md'), 'objective\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'objective');
  await git(seed, 'checkout', '-b', FEATURE);
  await writeFile(resolve(seed, 'opener.txt'), 'work the opener pushed\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'opener work');
  await git(seed, 'checkout', 'main');
  const bare = resolve(scratch, 'remote.git');
  await execFileAsync('git', ['clone', '--bare', seed, bare]);
  return { remote: `file://${bare}` };
}

describe('cornerBranchIsSafeToDelete', () => {
  it('keeps the branch while a pull request is open (no merge stamp)', () => {
    expect(
      cornerBranchIsSafeToDelete({
        lifecycle: 'in-review',
        checks: 'passing',
        pr: {
          number: 1610,
          url: 'https://github.com/beeline/buzzy/pull/1610',
          title: 'Ship the thing',
          targetBranch: 'main',
          headSha: 'a'.repeat(40),
        },
      }),
    ).toBe(false);
  });

  it('deletes the branch once the pull request merged', () => {
    expect(
      cornerBranchIsSafeToDelete({
        lifecycle: 'done',
        checks: 'passing',
        pr: {
          number: 1610,
          url: 'https://github.com/beeline/buzzy/pull/1610',
          title: 'Ship the thing',
          targetBranch: 'main',
          headSha: 'a'.repeat(40),
          mergedAt: '2026-09-23T01:00:00Z',
        },
      }),
    ).toBe(true);
  });

  it('deletes a branch no pull request ever claimed', () => {
    expect(cornerBranchIsSafeToDelete(undefined)).toBe(true);
    expect(
      cornerBranchIsSafeToDelete({ lifecycle: 'working', checks: 'unknown', branch: FEATURE }),
    ).toBe(true);
  });
});

describe('corner close cleanup', () => {
  it('reaps the worktree but keeps an open pull request branch on GitHub', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-preserve-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-open-pr',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const bare = remote.slice('file://'.length);
    const cleanup = () =>
      removeCornerWorktreeAndBranches(
        { ...worktree, cornerId: 'corner-open-pr', branch: FEATURE, token: 'unused' },
        { preserveRemoteBranch: true },
      );

    await cleanup();

    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      git(worktree.gitCommonDir, 'show-ref', '--verify', `refs/heads/${FEATURE}`),
    ).rejects.toThrow();
    // The artifact the pull request points at survives.
    await expect(git(bare, 'show-ref', '--verify', `refs/heads/${FEATURE}`)).resolves.toBeTruthy();
    await expect(git(bare, 'show-ref', '--verify', 'refs/heads/main')).resolves.toBeTruthy();

    // A retried preserved cleanup stays idempotent.
    await expect(cleanup()).resolves.toBeUndefined();
    await expect(git(bare, 'show-ref', '--verify', `refs/heads/${FEATURE}`)).resolves.toBeTruthy();
  });

  it('still deletes a branch no open pull request points at', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-delete-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-no-pr',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const bare = remote.slice('file://'.length);

    await removeCornerWorktreeAndBranches(
      { ...worktree, cornerId: 'corner-no-pr', branch: FEATURE, token: 'unused' },
      { preserveRemoteBranch: false },
    );

    await expect(git(bare, 'show-ref', '--verify', `refs/heads/${FEATURE}`)).rejects.toThrow();
  });
});