import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { syncCornerBranch } from './corner-branch-sync.js';
import {
  materializeCornerWorktree,
  removeCornerWorktreeAndBranches,
  RoomRuntimeCoordinator,
} from './room-runtime.js';

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
  it('deletes its worktree and exact local and remote branches on close', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-close-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-close',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });

    await removeCornerWorktreeAndBranches({
      ...worktree,
      cornerId: 'corner-close',
      branch: FEATURE,
      token: 'unused',
    });

    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      git(worktree.gitCommonDir, 'show-ref', '--verify', `refs/heads/${FEATURE}`),
    ).rejects.toThrow();
    await expect(
      git(remote.slice('file://'.length), 'show-ref', '--verify', `refs/heads/${FEATURE}`),
    ).rejects.toThrow();
    await expect(
      git(remote.slice('file://'.length), 'show-ref', '--verify', 'refs/heads/main'),
    ).resolves.toBeTruthy();
  });

  it('refuses to delete a branch that does not own the corner worktree', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-close-guard-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-guard',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });

    await expect(
      removeCornerWorktreeAndBranches({
        ...worktree,
        cornerId: 'corner-guard',
        branch: 'main',
        token: 'unused',
      }),
    ).rejects.toThrow(/branch mismatch/);
    await expect(
      git(remote.slice('file://'.length), 'show-ref', '--verify', 'refs/heads/main'),
    ).resolves.toBeTruthy();
    await expect(
      git(remote.slice('file://'.length), 'show-ref', '--verify', `refs/heads/${FEATURE}`),
    ).resolves.toBeTruthy();
  });

  it('refuses cleanup while the worktree has unpushed files', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-dirty-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-dirty',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    await writeFile(resolve(worktree.path, 'not-pushed.txt'), 'keep me\n');

    await expect(
      removeCornerWorktreeAndBranches({
        ...worktree,
        cornerId: 'corner-dirty',
        branch: FEATURE,
        token: 'unused',
      }),
    ).rejects.toThrow(/unpushed working-tree work/);
    await expect(access(resolve(worktree.path, 'not-pushed.txt'))).resolves.toBeUndefined();
  });

  it('refuses cleanup while HEAD has a commit no origin ref contains', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-ahead-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-ahead',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    await writeFile(resolve(worktree.path, 'not-pushed.txt'), 'keep me\n');
    await git(worktree.path, 'add', '.');
    await git(worktree.path, 'commit', '-m', 'not pushed');

    await expect(
      removeCornerWorktreeAndBranches({
        ...worktree,
        cornerId: 'corner-ahead',
        branch: FEATURE,
        token: 'unused',
      }),
    ).rejects.toThrow(/unpushed commits/);
    await expect(access(worktree.path)).resolves.toBeUndefined();
  });

  it('removes ignored build output because it is disposable, not unpushed work', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-build-output-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-build-output',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    await writeFile(resolve(worktree.path, '.gitignore'), 'target/\n');
    await git(worktree.path, 'add', '.gitignore');
    await git(worktree.path, 'commit', '-m', 'ignore build output');
    await git(worktree.path, 'push', 'origin', FEATURE);
    await mkdir(resolve(worktree.path, 'target', 'debug'), { recursive: true });
    await writeFile(resolve(worktree.path, 'target', 'debug', 'large-build'), 'derived\n');

    await removeCornerWorktreeAndBranches({
      ...worktree,
      cornerId: 'corner-build-output',
      branch: FEATURE,
      token: 'unused',
    });

    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reaps a recovered detached worktree after proving its HEAD was published', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-detached-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-detached',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    await git(worktree.path, 'checkout', '--detach');

    await removeCornerWorktreeAndBranches(
      {
        ...worktree,
        cornerId: 'corner-detached',
        branch: FEATURE,
        token: 'unused',
        recovered: true,
      },
      { preserveRemoteBranch: true },
    );

    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sweeps an archived worktree that predates the current process', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-stale-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-stale',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const identity = identityFromKey('11'.repeat(32), 'Bee');
    const execute = vi.fn(async (name: string) => {
      if (name === 'getCornerRestoreState') {
        return {
          cornerId: 'corner-stale',
          featureBranch: FEATURE,
          lifecycle: {
            lifecycle: 'done',
            checks: 'passing',
            pr: {
              number: 1,
              url: 'https://github.com/example/repo/pull/1',
              title: 'Done',
              targetBranch: 'main',
              headSha: 'a'.repeat(40),
              mergedAt: '2026-09-25T00:00:00Z',
            },
          },
        };
      }
      if (name === 'getRoomRepositoryState') {
        return {
          resolution: 'repository',
          key: 'example/repo',
          remote,
          targetBranch: 'main',
        };
      }
      if (name === 'getRoomGitHubToken') return { token: 'unused', expiresAt: Date.now() + 60_000 };
      return {};
    });
    const coordinator = new RoomRuntimeCoordinator(
      {
        agent: {
          name: 'Bee',
          publicKey: identity.publicKey,
          secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
        },
        rooms: [],
        communityId: 'workspace',
        supervisorRoot,
        transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      } as unknown as AgentRuntimeRecord,
      resolve(supervisorRoot, 'agent.json'),
      { workspaceRoot: supervisorRoot } as never,
      { daemonApi: { execute } as unknown as DaemonApiClient },
    );
    const recovery = coordinator as unknown as {
      sweepArchivedCornerWorktrees(
        corners: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>,
      ): Promise<void>;
    };

    await recovery.sweepArchivedCornerWorktrees(
      new Map([['corner-stale', { cornerId: 'corner-stale', parentRoomId: 'room-parent' }]]),
    );

    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(execute).toHaveBeenCalledWith('postCornerRemoteState', {
      cornerId: 'corner-stale',
      branch: FEATURE,
      state: 'gone',
      checks: 'unknown',
    });
    await coordinator.shutdown();
  });

  it('refuses a stale corner directory linked to the wrong repository cache', async () => {
    const [{ remote }, { remote: wrongRemote }] = await Promise.all([
      remoteWithCornerBranch(),
      remoteWithCornerBranch(),
    ]);
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-wrong-repo-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-wrong-repo',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const identity = identityFromKey('11'.repeat(32), 'Bee');
    const execute = vi.fn(async (name: string) => {
      if (name === 'getCornerRestoreState') {
        return { cornerId: 'corner-wrong-repo', featureBranch: FEATURE };
      }
      if (name === 'getRoomRepositoryState') {
        return {
          resolution: 'repository',
          key: 'example/wrong-repo',
          remote: wrongRemote,
          targetBranch: 'main',
        };
      }
      throw new Error(`unexpected operation ${name}`);
    });
    const coordinator = new RoomRuntimeCoordinator(
      {
        agent: {
          name: 'Bee',
          publicKey: identity.publicKey,
          secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
        },
        rooms: [],
        communityId: 'workspace',
        supervisorRoot,
        transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      } as unknown as AgentRuntimeRecord,
      resolve(supervisorRoot, 'agent.json'),
      { workspaceRoot: supervisorRoot } as never,
      { daemonApi: { execute } as unknown as DaemonApiClient },
    );
    const recovery = coordinator as unknown as {
      sweepArchivedCornerWorktrees(
        corners: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>,
      ): Promise<void>;
    };
    await recovery.sweepArchivedCornerWorktrees(
      new Map([
        ['corner-wrong-repo', { cornerId: 'corner-wrong-repo', parentRoomId: 'room-parent' }],
      ]),
    );

    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(coordinator.needsFastReconcile()).toBe(true);
    expect(execute).not.toHaveBeenCalledWith('getRoomGitHubToken', expect.anything());
    await coordinator.shutdown();
  });

  it('keeps the exact local ref when remote deletion fails, then retries successfully', async () => {
    const { remote, scratch } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-close-retry-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-retry',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const bare = remote.slice('file://'.length);
    const unavailable = resolve(scratch, 'remote-unavailable.git');
    await rename(bare, unavailable);

    await expect(
      removeCornerWorktreeAndBranches({
        ...worktree,
        cornerId: 'corner-retry',
        branch: FEATURE,
        token: 'expired',
      }),
    ).rejects.toThrow();
    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      git(worktree.gitCommonDir, 'show-ref', '--verify', `refs/heads/${FEATURE}`),
    ).resolves.toBeTruthy();

    await rename(unavailable, bare);
    await removeCornerWorktreeAndBranches({
      ...worktree,
      cornerId: 'corner-retry',
      branch: FEATURE,
      token: 'fresh',
    });
    await expect(
      git(worktree.gitCommonDir, 'show-ref', '--verify', `refs/heads/${FEATURE}`),
    ).rejects.toThrow();
    await expect(git(bare, 'show-ref', '--verify', `refs/heads/${FEATURE}`)).rejects.toThrow();
  });

  it('deletes the local ref when the exact remote ref is already gone', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-close-absent-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-absent',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const bare = remote.slice('file://'.length);
    await git(bare, 'update-ref', '-d', `refs/heads/${FEATURE}`);

    await removeCornerWorktreeAndBranches({
      ...worktree,
      cornerId: 'corner-absent',
      branch: FEATURE,
      token: 'fresh',
    });

    await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      git(worktree.gitCommonDir, 'show-ref', '--verify', `refs/heads/${FEATURE}`),
    ).rejects.toThrow();
  });

  it('treats a second cleanup after success as idempotent', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-close-twice-'));
    roots.push(supervisorRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-twice',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const cleanup = () =>
      removeCornerWorktreeAndBranches({
        ...worktree,
        cornerId: 'corner-twice',
        branch: FEATURE,
        token: 'fresh',
      });

    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });

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
  it('does not treat an auth failure as an unpushed branch', async () => {
    await expect(
      syncCornerBranch({
        worktreePath: '/unused',
        featureBranch: FEATURE,
        git: async (args) => {
          if (args[0] === 'fetch') throw new Error('fatal: Authentication failed');
          throw new Error('unexpected git command');
        },
      }),
    ).rejects.toThrow('Authentication failed');
  });

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

  it('realigns to the shared remote branch when two unpushed changes conflict', async () => {
    const { remote, worktree } = await helperWorktree('beeline-corner-sync-conflict-');
    await writeFile(resolve(worktree.path, 'shared.txt'), 'mine\n');
    await git(worktree.path, 'add', '.');
    await git(worktree.path, 'commit', '-m', 'my work');
    await pushToRemote(remote, 'peer work', { file: 'shared.txt', contents: 'theirs\n' });
    expect(await syncCornerBranch({ worktreePath: worktree.path, featureBranch: FEATURE })).toBe(
      'realigned',
    );
    expect(await git(worktree.path, 'log', '-1', '--format=%s')).toBe('peer work');
    expect(await git(worktree.path, 'show', 'HEAD:shared.txt')).toBe('theirs');
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
