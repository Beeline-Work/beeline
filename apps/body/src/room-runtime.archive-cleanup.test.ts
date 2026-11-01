import { readlinkSync, readFileSync, readdirSync } from 'node:fs';
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util');
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mocked = (...args: any[]) => {
    if (args[0] === '/usr/bin/python3' && args[1][1].includes('KERN_PROCARGS2')) {
      const callback = args.at(-1);
      try { callback(null, JSON.stringify(Object.fromEntries(JSON.parse(args[1][2]).flatMap((pid: number) => {
        try { return [[pid, readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)]]; } catch { return []; }
      }))), ''); }
      catch (error) { callback(error, '', ''); }
      return;
    }
    if (args[0] === '/sbin/mount') args[0] = '/bin/mount';
    if (args[0] === '/usr/sbin/lsof') {
      const callback = args.at(-1);
      try {
        const pids = args[1].includes('-p') ? [args[1][2]] : readdirSync('/proc').filter(pid => /^\d+$/.test(pid));
        const paths = pids.flatMap((pid: string) => {
          const base = `/proc/${pid}`;
          try { return ['p' + pid, ...['cwd', ...readdirSync(base + '/fd').map(fd => 'fd/' + fd)].flatMap(name => {
            try { return ['n/private' + readlinkSync(base + '/' + name)]; } catch { return []; }
          })]; } catch { return []; }
        });
        callback(null, paths.join('\n'), '');
      }
      catch (error) { callback(error, '', ''); }
      return;
    }
    return (actual.execFile as Function)(...args);
  };
  Object.defineProperty(mocked, promisify.custom, { value: (...args: any[]) => !['/usr/sbin/lsof', '/sbin/mount', '/usr/bin/python3'].includes(args[0]) ? (promisify(actual.execFile) as Function)(...args) : new Promise((resolve, reject) => mocked(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))) });
  return { ...actual, execFile: mocked };
});
import { execFile, spawn } from 'node:child_process';
import { mkdir, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { materializeCornerWorktree, RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { declareCornerProofOutput } from './corner-proof-output.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); },
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
  it('deletes declared proof after confirmed archive and persists its tombstone', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-proof-reap-'));
    roots.push(root);
    const path = resolve(root, 'beeline/corners/proof-corner');
    await mkdir(path, { recursive: true });
    await declareCornerProofOutput(path, 'proof-corner');
    const execute = vi.fn(async () => ({ archived: true }));
    const coordinator = new RoomRuntimeCoordinator(runtimeAt(root), resolve(root, 'agent.json'),
      { workspaceRoot: root } as never, { daemonApi: { execute } as unknown as DaemonApiClient });
    const internal = coordinator as unknown as { reapCornerWorktree(worktree: object): Promise<void> };
    const worktree = { cornerId: 'proof-corner', path, branch: FEATURE, parentRoomId: 'parent', gitCommonDir: resolve(root, 'repo.git'), token: '' };
    try {
      await internal.reapCornerWorktree(worktree);
      const ownerPath = resolve(root, 'beeline/storage-owners/corners-proof-corner.json');
      const first = JSON.parse(await readFile(ownerPath, 'utf8'));
      expect(first.ended).toBe(true);
      expect(first.endedAt).toEqual(expect.any(Number));
      await internal.reapCornerWorktree(worktree);
      expect(JSON.parse(await readFile(ownerPath, 'utf8')).endedAt).toBe(first.endedAt);
      expect(execute).toHaveBeenCalledWith('getCornerRestoreState', { cornerId: 'proof-corner' });
      await expect(lstat(path)).rejects.toThrow();
    } finally { await coordinator.shutdown(); }
  });

  it('switches new shared activations off for two Rooms in the same Workspace', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-shared-toggle-'));
    roots.push(root);
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root), resolve(root, 'agent.json'),
      { workspaceRoot: root } as never,
      { daemonApi: { execute: vi.fn() } as unknown as DaemonApiClient },
    );
    const internal = coordinator as unknown as { roomConfig(roomId: string, workspaceRoot: string): { agentSharedAssetRoot?: string } };
    try {
      const first = internal.roomConfig('room-a', resolve(root, 'rooms/room-a'));
      const second = internal.roomConfig('room-b', resolve(root, 'rooms/room-b'));
      expect(first.agentSharedAssetRoot).toBe(second.agentSharedAssetRoot);
    } finally { await coordinator.shutdown(); }
  });

  it.skipIf(process.platform !== 'linux').each(['linux', 'darwin'])('removes repository-free private state and live child after authoritative archive (%s)', async (platform) => {
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-private-retention-'));
    roots.push(supervisorRoot);
    const cornerId = 'chat-corner';
    const scratch = resolve(supervisorRoot, 'rooms', cornerId, 'scratch');
    await mkdir(resolve(scratch, 'agent-home/codex/sessions'), { recursive: true });
    await mkdir(resolve(scratch, 'agent-private'), { recursive: true });
    await writeFile(resolve(scratch, 'agent-home/codex/sessions/history.json'), 'conversation');
    await writeFile(resolve(scratch, 'agent-private/pending.json'), 'approval');
    await writeFile(resolve(scratch, 'work.txt'), 'scratch');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: scratch, stdio: 'ignore' });
    await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
    const execute = vi.fn().mockResolvedValue({ archived: true });
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(supervisorRoot), resolve(supervisorRoot, 'agent.json'),
      { workspaceRoot: supervisorRoot } as never,
      { daemonApi: { execute } as unknown as DaemonApiClient },
    );
    vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? platform : Reflect.get(target, key) }));
    try {
      const internal = coordinator as unknown as {
        cleanupArchivedCornerLocalState(id: string): Promise<boolean>;
      };
      for (const state of [undefined, { archived: false }]) {
        execute.mockImplementationOnce(() => state ? Promise.resolve(state) : Promise.reject(new Error('unknown')));
        expect(await internal.cleanupArchivedCornerLocalState(cornerId)).toBe(false);
        expect(child.signalCode).toBe(null);
        expect(await readFile(resolve(scratch, 'work.txt'), 'utf8')).toBe('scratch');
      }
      expect(await internal.cleanupArchivedCornerLocalState(cornerId)).toBe(true);
      await expect.poll(() => child.signalCode !== null || child.exitCode !== null).toBe(true);
      await expect(readFile(resolve(scratch, 'agent-home/codex/sessions/history.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(resolve(scratch, 'agent-private/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(resolve(scratch, 'work.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllGlobals(); child.kill('SIGKILL'); await coordinator.shutdown(); }
  });

  it('deletes unpublished commits after authoritative archive', async () => {
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
        return { cornerId, archived: true, lifecycle: { lifecycle: 'working', checks: 'unknown' } };
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
      expect(errors).not.toHaveBeenCalled();
      expect(internal.pendingCornerReaps.has(cornerId)).toBe(false);
      await expect(lstat(worktree.path)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalledWith('getRoomGitHubToken', expect.anything());
    } finally {
      errors.mockRestore();
      await coordinator.shutdown();
    }
  });

  it('deletes untracked work after authoritative archive', async () => {
    const { remote } = await remoteWithCornerBranch();
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-corner-abandon-worktree-'));
    roots.push(supervisorRoot);
    const cornerId = 'corner-abandoned-worktree';
    const worktree = await materializeCornerWorktree({
      cornerId,
      remote,
      targetBranch: 'main',
      featureBranch: FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    // No commit at all — just an uncommitted file nothing will ever push.
    await writeFile(resolve(worktree.path, 'never-committed.txt'), 'local only\n');

    let now = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomGitHubToken') return { token: 'unused', expiresAt: now + 60_000 };
      if (name === 'getCornerRestoreState')
        return { cornerId, archived: true, lifecycle: { lifecycle: 'working', checks: 'unknown' } };
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
      expect(errors).not.toHaveBeenCalled();
      expect(internal.pendingCornerReaps.has(cornerId)).toBe(false);
      await expect(lstat(worktree.path)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalledWith('getRoomGitHubToken', expect.anything());
    } finally {
      errors.mockRestore();
      await coordinator.shutdown();
    }
  });
});
