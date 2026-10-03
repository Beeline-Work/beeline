import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import type { BodyConfig } from './config.js';
import type { SessionScheduler } from './session-scheduler.js';
import { DaemonApiError, type DaemonApiClient } from './daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import {
  CORNER_GIT_SYNC_TIMEOUT_MS,
  CORNER_GIT_SYNC_KILL_GRACE_MS,
  syncCornerBranch,
} from './corner-branch-sync.js';
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
  it('skips archived history with no local worktree before any restore read', async () => {
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-history-'));
    roots.push(supervisorRoot);
    const identity = identityFromKey('11'.repeat(32), 'Bee');
    const execute = vi.fn(async () => {
      throw new Error('archive history must not reach the server');
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
    const history = new Map(
      Array.from(
        { length: 446 },
        (_, index) =>
          [
            `corner-${index}`,
            { cornerId: `corner-${index}`, parentRoomId: 'room-parent' },
          ] as const,
      ),
    );

    await recovery.sweepArchivedCornerWorktrees(history);

    expect(execute).not.toHaveBeenCalled();
    await coordinator.shutdown();
  });

  it('starts a corner whose supervisor directory is reached through a symlink', async () => {
    const { remote, scratch } = await remoteWithCornerBranch();
    const realRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-real-'));
    roots.push(realRoot);
    const linkRoot = resolve(scratch, 'supervisor-link');
    await symlink(realRoot, linkRoot);
    const worktree = await materializeCornerWorktree({
      cornerId: 'corner-symlink',
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot: linkRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    expect(await realpath(worktree.path)).toBe(
      await realpath(resolve(realRoot, 'beeline', 'corners', 'corner-symlink')),
    );
    const top = await git(worktree.path, 'rev-parse', '--show-toplevel');
    expect(resolve(top)).not.toBe(resolve(worktree.path));
    expect(await realpath(top)).toBe(await realpath(worktree.path));
  });

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

  it.each([
    { protocol: 'old server archive list', listed: true, metadata: false, cleanup: true },
    { protocol: 'new server restore tombstone', listed: false, metadata: true, cleanup: true },
    {
      protocol: 'stale archived list',
      listed: true,
      metadata: true,
      archived: false,
      cleanup: false,
    },
    { protocol: 'no archive proof', listed: false, metadata: false, cleanup: false },
  ])(
    'recovers an old worktree with $protocol',
    async ({ listed, metadata, cleanup, ...scenario }) => {
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
            ...(metadata
              ? { archived: scenario.archived ?? true, parentRoomId: 'room-parent' }
              : {}),
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
        if (name === 'getRoomGitHubToken')
          return { token: 'unused', expiresAt: Date.now() + 60_000 };
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
        listed
          ? new Map([['corner-stale', { cornerId: 'corner-stale', parentRoomId: 'room-parent' }]])
          : new Map(),
      );

      if (cleanup) {
        await expect(access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(execute).toHaveBeenCalledWith('postCornerRemoteState', {
          cornerId: 'corner-stale',
          branch: FEATURE,
          state: 'gone',
          checks: 'unknown',
        });
      } else {
        await expect(access(worktree.path)).resolves.toBeUndefined();
        expect(execute).not.toHaveBeenCalledWith('getRoomRepositoryState', expect.anything());
      }
      await coordinator.shutdown();
    },
  );

  it('refuses a stale corner directory linked to the wrong repository cache', async () => {
    let now = 10_000;
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
      { daemonApi: { execute } as unknown as DaemonApiClient, now: () => now },
    );
    const discovery = vi.fn();
    coordinator.setDiscoveryWakeListener(discovery);
    const recovery = coordinator as unknown as {
      sweepArchivedCornerWorktrees(
        corners: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>,
      ): Promise<void>;
    };
    const archived = new Map([
      ['corner-wrong-repo', { cornerId: 'corner-wrong-repo', parentRoomId: 'room-parent' }],
    ]);
    await recovery.sweepArchivedCornerWorktrees(archived);
    await recovery.sweepArchivedCornerWorktrees(archived);
    expect(execute).toHaveBeenCalledTimes(2);
    now += 2_001;
    await recovery.sweepArchivedCornerWorktrees(archived);
    expect(execute).toHaveBeenCalledTimes(4);

    await expect(access(worktree.path)).resolves.toBeUndefined();
    // A stale checkout is background cleanup. It must not turn every failed
    // attempt into another full Room discovery and database read burst.
    expect(discovery).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalledWith('getRoomGitHubToken', expect.anything());
    await coordinator.shutdown();
  });

  it('does not keep asking for an unlisted worktree after membership is refused', async () => {
    let now = 10_000;
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-removed-'));
    roots.push(supervisorRoot);
    await materializeCornerWorktree({
      cornerId: 'corner-removed', remote, targetBranch: 'main', featureBranch: FEATURE,
      token: 'unused', supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const identity = identityFromKey('11'.repeat(32), 'Bee');
    const execute = vi.fn(async () => {
      throw new DaemonApiError('daemon room access denied', 403, false);
    });
    const coordinator = new RoomRuntimeCoordinator(
      {
        agent: { name: 'Bee', publicKey: identity.publicKey,
          secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
        rooms: [], communityId: 'workspace', supervisorRoot,
        transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      } as unknown as AgentRuntimeRecord,
      resolve(supervisorRoot, 'agent.json'),
      { workspaceRoot: supervisorRoot } as never,
      { daemonApi: { execute } as unknown as DaemonApiClient, now: () => now },
    );
    const recovery = coordinator as unknown as {
      sweepArchivedCornerWorktrees(
        corners: ReadonlyMap<string, { cornerId: string; parentRoomId: string }>,
      ): Promise<void>;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await recovery.sweepArchivedCornerWorktrees(new Map());
      now += 5 * 60_000;
      await recovery.sweepArchivedCornerWorktrees(new Map());
      expect(execute).toHaveBeenCalledTimes(1);
      await recovery.sweepArchivedCornerWorktrees(new Map([
        ['corner-removed', { cornerId: 'corner-removed', parentRoomId: 'room-parent' }],
      ]));
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
      await coordinator.shutdown();
    }
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
  it('R3: settles a git seam that never resolves at the deadline', async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const result = syncCornerBranch({
        worktreePath: '/unused',
        featureBranch: FEATURE,
        git: async () => { started(); return new Promise<string>(() => undefined); },
      });
      let settled = false;
      const observed = result.catch((error) => {
        settled = true;
        return error;
      });
      await ready;
      await vi.advanceTimersByTimeAsync(122_000);
      expect(settled).toBe(true);
      expect((await observed).message).toContain('corner git sync');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['merge-base', 'rebase', 'abort'])(
    'keeps interruption out of reset recovery at %s',
    async (command) => {
      vi.useFakeTimers();
      const calls: string[][] = [];
      try {
        const result = syncCornerBranch({
          worktreePath: '/unused',
          featureBranch: FEATURE,
          git: async (args) => {
            calls.push([...args]);
            if ((args[0] === command && args[1] !== '--abort') || (command === 'abort' && args[1] === '--abort'))
              return new Promise<string>(() => undefined);
            if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? 'local' : 'remote';
            if (args[0] === 'merge-base' || args[0] === 'rebase') throw new Error('conflict');
            return '';
          },
        });
        const observed = result.catch((error) => error);
        await vi.waitFor(() =>
          expect(
            calls.some((args) =>
              command === 'abort' ? args[1] === '--abort' : args[0] === command,
            ),
          ).toBe(true),
        );
        await vi.advanceTimersByTimeAsync(CORNER_GIT_SYNC_TIMEOUT_MS);
        expect((await observed).message).toContain('corner git sync');
        expect(calls.some((args) => args[0] === 'reset' || args[0] === 'clean')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['deadline', 'stop', 'turn deadline', 'structured stop'])(
    'R3: kills a real stalled git child on %s and preserves local commits',
    async (cause) => {
      const { worktree } = await helperWorktree('beeline-corner-stall-');
      await writeFile(resolve(worktree.path, 'mine.txt'), 'keep me\n');
      await git(worktree.path, 'add', '.');
      await git(worktree.path, 'commit', '-m', 'local commit survives');
      const head = await git(worktree.path, 'rev-parse', 'HEAD');
      const bin = await mkdtemp(resolve(tmpdir(), 'beeline-stalled-git-'));
      roots.push(bin);
      const marker = resolve(bin, 'started');
      // This executable is read here before it is run; it has no subprocesses.
      await writeFile(
        resolve(bin, 'git'),
        `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
      );
      const stop = new AbortController();
      vi.useFakeTimers();
      const receipts: Array<Record<string, unknown>> = [];
      const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
        if (name === 'getRoomGitHubToken') return { token: 'unused' };
        if (name === 'postAgentTurnReceipt') receipts.push(input);
        return {};
      });
      const identity = identityFromKey('11'.repeat(32), 'Sol');
      const loop = new MonolithCornerTurnLoop({
        cornerId: 'r3',
        parentRoomId: 'parent',
        workspaceId: 'workspace',
        objective: 'R3',
        worktreePath: worktree.path,
        repository: {
          featureBranch: FEATURE,
          targetBranch: 'main',
          gitCommonDir: worktree.gitCommonDir,
          githubToken: 'unused',
        },
        runtime: {
          supervisorRoot: worktree.path,
          agent: {
            name: 'Sol',
            publicKey: identity.publicKey,
            secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
          },
        } as AgentRuntimeRecord,
        config: { workspaceRoot: worktree.path } as BodyConfig,
        api: { execute } as unknown as DaemonApiClient,
        // Admit the real turn body without starting a model: the stall precedes its prompt.
        scheduler: {
          snapshot: () => ({}),
          run: async (_key: unknown, _lifecycle: unknown, work: () => Promise<void>) => work(),
        } as unknown as SessionScheduler,
      });
      const turn = loop as unknown as {
        prompt(id: string, trigger: string): Promise<void>;
        stopTurn(id: string): void;
      };
      vi.stubEnv('PATH', bin + ':' + process.env.PATH);
      const observed = (
        cause.includes('turn') || cause === 'structured stop'
          ? turn.prompt('r3-request', 'Fetch the corner branch')
          : syncCornerBranch({
              worktreePath: worktree.path,
              featureBranch: FEATURE,
              signal: stop.signal,
            })
      ).catch((error) => error);
      try {
        await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBeTruthy());
        const pid = Number(await readFile(marker, 'utf8'));
        if (cause === 'structured stop') {
          turn.stopTurn('r3-request');
          await vi.advanceTimersByTimeAsync(25);
        } else if (cause === 'stop') stop.abort();
        else await vi.advanceTimersByTimeAsync(CORNER_GIT_SYNC_TIMEOUT_MS);
        expect(() => process.kill(pid, 0)).not.toThrow();
        await vi.advanceTimersByTimeAsync(CORNER_GIT_SYNC_KILL_GRACE_MS);
        vi.useRealTimers();
        const result = await observed;
        if (cause === 'structured stop') {
          expect(result).toBeUndefined();
          expect(receipts.some((receipt) => receipt.status === 'failed')).toBe(false);
          console.log(
            'R3 demonstrated: structured stop released the turn; server cancellation remains authoritative.',
          );
        } else {
          expect(result.message).toContain(cause === 'stop' ? 'stopped' : 'timed out');
          if (cause === 'turn deadline') {
            expect(receipts).toContainEqual(
              expect.objectContaining({
                status: 'failed',
                reason: 'corner git sync fetch timed out after 120000ms',
              }),
            );
            console.log(
              'R3 demonstrated: failed receipt — corner git sync fetch timed out after 120000ms; local commit preserved.',
            );
          }
        }
        expect(() => process.kill(pid, 0)).toThrow();
        vi.unstubAllEnvs();
        expect(await git(worktree.path, 'rev-parse', 'HEAD')).toBe(head);
        expect(await readFile(resolve(worktree.path, 'mine.txt'), 'utf8')).toBe('keep me\n');
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        stop.abort();
      }
    },
  );

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

  it.each(['interrupt', 'leftover'])('Reproduction F1-10: %s rebase preserves local commits', async mode => {
    const { remote, worktree } = await helperWorktree('beeline-f1-rebase-');
    await writeFile(resolve(worktree.path, 'mine.txt'), 'mine\n');
    await git(worktree.path, 'add', '.');
    await git(worktree.path, 'commit', '-m', 'my work');
    await pushToRemote(remote, 'peer work');
    await git(worktree.path, 'fetch', 'origin');
    const stop = new AbortController();
    const stalledRebase = async () => {
      await git(worktree.path, '-c', 'sequence.editor=true', 'rebase', '-i', '--exec', 'false', `origin/${FEATURE}`).catch(() => undefined);
    };
    if (mode === 'leftover') await stalledRebase();
    else await expect(syncCornerBranch({ worktreePath: worktree.path, featureBranch: FEATURE, signal: stop.signal, git: async args => {
      if (args[0] === 'rebase' && args[1] !== '--abort') { await stalledRebase(); stop.abort(); return new Promise<string>(() => undefined); }
      return git(worktree.path, ...args);
    } })).rejects.toThrow('stopped');
    const rebasePath = await git(worktree.path, 'rev-parse', '--git-path', 'rebase-merge');
    if (mode === 'interrupt') await expect(access(rebasePath)).rejects.toThrow();
    const result = await syncCornerBranch({ worktreePath: worktree.path, featureBranch: FEATURE });
    const history = await git(worktree.path, 'log', '-2', '--format=%s');
    console.info(`Reproduction F1-10: wrong=active rebase/lost commit; right=my work + peer work; observed=${result}: ${history.replaceAll('\n', ', ')}`);
    expect(history).toBe('my work\npeer work');
    await expect(access(rebasePath)).rejects.toThrow();
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
