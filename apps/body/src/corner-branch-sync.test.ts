import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CornerBranchDivergedError, syncCornerBranch } from './corner-branch-sync.js';
import { materializeCornerWorktree } from './room-runtime.js';

/**
 * Two agents, one corner, one branch — proved against real git.
 *
 * The corner's branch on GitHub is the shared artifact, so these run through
 * the real git path with a bare repository standing in for the remote: a
 * fake would prove only that the fake agrees with the code.
 */
const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const FEATURE = 'feature/corner-shared';

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
async function remoteWithCornerBranch(): Promise<{ remote: string; scratch: string }> {
  const scratch = await mkdtemp(resolve(tmpdir(), 'beeline-corner-remote-'));
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
  return { remote: `file://${bare}`, scratch };
}

describe('a helper joining a corner it did not open', () => {
  it('cuts its first worktree from the corner branch, not from the target branch', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-helper-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-shared',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused-for-a-file-remote',
      supervisorRoot,
      committer: { name: 'Goosy', publicKey: 'c'.repeat(64) },
    });
    expect(await git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(FEATURE);
    // The opener's commit is the point: a worktree cut from `main` would have
    // silently dropped the work this helper was asked to carry on.
    expect(await git(worktree.path, 'log', '-1', '--format=%s')).toBe('opener work');
  });

  it('starts a never-pushed corner from the target branch, exactly as before', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-fresh-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-fresh',
      remote,
      targetBranch: 'main',
      featureBranch: 'feature/corner-never-pushed',
      token: 'unused-for-a-file-remote',
      supervisorRoot,
      committer: { name: 'Bee', publicKey: 'b'.repeat(64) },
    });
    expect(await git(worktree.path, 'log', '-1', '--format=%s')).toBe('objective');
  });
});

describe('syncCornerBranch — two agents pushing to one branch', () => {
  async function helperWorktree(prefix: string, featureBranch = FEATURE) {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), prefix));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-shared',
      remote,
      targetBranch: 'main',
      featureBranch,
      token: 'unused-for-a-file-remote',
      supervisorRoot,
      committer: { name: 'Goosy', publicKey: 'c'.repeat(64) },
    });
    return { remote, worktree };
  }

  it('leaves a worktree that already has the remote head alone', async () => {
    const { worktree } = await helperWorktree('beeline-corner-sync-same-');
    expect(await syncCornerBranch({ worktreePath: worktree.path, featureBranch: FEATURE })).toBe(
      'unchanged',
    );
  });

  it('says nothing to do when this worktree is the one that is ahead', async () => {
    const { worktree } = await helperWorktree('beeline-corner-sync-ahead-');
    await writeFile(resolve(worktree.path, 'mine.txt'), 'mine\n');
    await git(worktree.path, 'add', '.');
    await git(worktree.path, 'commit', '-m', 'my work');
    expect(await syncCornerBranch({ worktreePath: worktree.path, featureBranch: FEATURE })).toBe(
      'unchanged',
    );
    expect(await git(worktree.path, 'log', '-1', '--format=%s')).toBe('my work');
  });

  it('fast-forwards onto what another agent pushed while this one was idle', async () => {
    const { remote, worktree } = await helperWorktree('beeline-corner-sync-ff-');
    await pushToRemote(remote, 'peer work');
    expect(await syncCornerBranch({ worktreePath: worktree.path, featureBranch: FEATURE })).toBe(
      'fast-forwarded',
    );
    expect(await git(worktree.path, 'log', '-1', '--format=%s')).toBe('peer work');
  });

  it('rebases this worktree onto the other agent’s push instead of clobbering it', async () => {
    const { remote, worktree } = await helperWorktree('beeline-corner-sync-rebase-');
    await writeFile(resolve(worktree.path, 'mine.txt'), 'mine\n');
    await git(worktree.path, 'add', '.');
    await git(worktree.path, 'commit', '-m', 'my work');
    await pushToRemote(remote, 'peer work');
    expect(await syncCornerBranch({ worktreePath: worktree.path, featureBranch: FEATURE })).toBe(
      'rebased',
    );
    expect(await git(worktree.path, 'log', '-2', '--format=%s')).toBe('my work\npeer work');
  });

  it('fails loudly and leaves no rebase in progress when the two pushes conflict', async () => {
    const { remote, worktree } = await helperWorktree('beeline-corner-sync-conflict-');
    await writeFile(resolve(worktree.path, 'shared.txt'), 'mine\n');
    await git(worktree.path, 'add', '.');
    await git(worktree.path, 'commit', '-m', 'my work');
    await pushToRemote(remote, 'peer work', { file: 'shared.txt', contents: 'theirs\n' });
    await expect(
      syncCornerBranch({ worktreePath: worktree.path, featureBranch: FEATURE }),
    ).rejects.toBeInstanceOf(CornerBranchDivergedError);
    await expect(
      syncCornerBranch({ worktreePath: worktree.path, featureBranch: FEATURE }),
    ).rejects.toThrow(/another agent pushed to this corner's branch/);
    // The abort matters: a worktree left mid-rebase would fail every later
    // turn for a reason that has nothing to do with the work.
    expect(await git(worktree.path, 'log', '-1', '--format=%s')).toBe('my work');
    expect(await git(worktree.path, 'status', '--porcelain')).toBe('');
  });

  /** Another member agent's push, made through its own clone of the remote. */
  async function pushToRemote(
    remote: string,
    subject: string,
    file: { file: string; contents: string } = { file: 'peer.txt', contents: 'peer\n' },
  ): Promise<void> {
    const peer = await mkdtemp(resolve(tmpdir(), 'beeline-corner-peer-'));
    roots.push(peer);
    const clone = resolve(peer, 'clone');
    await execFileAsync('git', ['clone', '--branch', FEATURE, remote, clone]);
    await writeFile(resolve(clone, file.file), file.contents);
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-m', subject);
    await git(clone, 'push', 'origin', FEATURE);
  }
});
