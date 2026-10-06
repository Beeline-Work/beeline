import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { materializeCornerWorktree, RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

/**
 * An archived corner whose worktree has commits no origin ref contains can
 * never be cleaned up automatically - nothing will push them later. Retrying
 * it on every reconciliation only slows discovery down; it must be reported
 * once and then left alone, with the checkout and its commits kept.
 */
const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const FEATURE = 'feature/corner-abandoned';
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

async function remoteWithCornerBranch(): Promise<{ remote: string }> {
  const scratch = await mkdtemp(resolve(tmpdir(), 'beeline-corner-abandon-remote-'));
  roots.push(scratch);
  const seed = resolve(scratch, 'seed');
  await execFileAsync('git', ['init', '-b', 'main', seed]);
  await writeFile(resolve(seed, 'README.md'), 'objective\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'objective');
  await git(seed, 'checkout', '-b', FEATURE);
  await git(seed, 'checkout', 'main');
  const bare = resolve(scratch, 'remote.git');
  await execFileAsync('git', ['clone', '--bare', seed, bare]);
  return { remote: `file://${bare}` };
}

function runtimeAt(root: string): AgentRuntimeRecord {
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  return {
    agent: {
      name: 'Bee',
      publicKey: identity.publicKey,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    },
    rooms: [],
    communityId: 'workspace',
    supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
  } as unknown as AgentRuntimeRecord;
}

describe('archived corner branch cleanup', () => {
  it('reports commits no origin ref contains once, then stops retrying and keeps them', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-abandon-'));
    roots.push(supervisorRoot);
    const cornerId = 'corner-abandoned';
    const worktree = await materializeCornerWorktree({
      cornerId,
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    // The opener's commit never reached origin.
    await writeFile(resolve(worktree.path, 'unpushed.txt'), 'local only\n');
    await git(worktree.path, 'add', '.');
    await git(worktree.path, 'commit', '-m', 'unpushed work');

    let now = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomGitHubToken') return { token: 'unused', expiresAt: now + 60_000 };
      if (name === 'getCornerRestoreState')
        return { cornerId, lifecycle: { lifecycle: 'working', checks: 'unknown' } };
      throw new Error(`unexpected operation ${name}`);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(supervisorRoot),
      resolve(supervisorRoot, 'agent.json'),
      { workspaceRoot: supervisorRoot } as never,
      { now: () => now, daemonApi: { execute } as unknown as DaemonApiClient },
    );
    const internal = coordinator as unknown as {
      pendingCornerReaps: Map<string, typeof worktree & { cornerId: string; branch: string }>;
      retryPendingCornerReaps(desired: ReadonlySet<string>): Promise<void>;
    };
    internal.pendingCornerReaps.set(cornerId, {
      ...worktree,
      cornerId,
      branch: FEATURE,
      parentRoomId: 'room-1',
      token: '',
    });

    try {
      await internal.retryPendingCornerReaps(new Set());
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('branch cleanup abandoned'),
        expect.anything(),
      );
      expect(execute).not.toHaveBeenCalledWith('postCornerRemoteState', expect.anything());
      errors.mockClear();
      execute.mockClear();

      // Well past any transient backoff window, and still desired by nobody.
      now += 10 * 60_000;
      await internal.retryPendingCornerReaps(new Set());
      expect(execute).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();

      // The checkout and its commit were never touched.
      await expect(
        git(worktree.gitCommonDir, 'show-ref', '--verify', `refs/heads/${FEATURE}`),
      ).resolves.toBeTruthy();
      await expect(git(worktree.path, 'log', '-1', '--format=%s')).resolves.toBe('unpushed work');
    } finally {
      errors.mockRestore();
      await coordinator.shutdown();
    }
  });
});
