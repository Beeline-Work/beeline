import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { RoomRuntimeCoordinator, materializeCornerWorktree } from './room-runtime.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { agentCornerCheckoutPaths } from './agent-corner-checkout.js';
import { readStorageOwners, rememberStorageOwner, markAgentStorageEnded, pruneEndedOwnerStorage } from './storage-owners.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

const exec = promisify(execFile);
it('read-only assignments reuse the Room checkout, then select a private copy after a writable brief revision', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'corner-readonly-'));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32) },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'fixture' } } as AgentRuntimeRecord;
  let writable = false;
  let assignedBrief = true;
  const remote = resolve(root, 'remote.git'), roomCheckout = resolve(root, 'room');
  const execute = vi.fn(async (name: string) => {
    if (name === 'getCornerRestoreState') return { cornerId: 'corner', objective: 'Read source', closeRequested: false,
      implementerAgentId: identity.publicKey, ...(assignedBrief ? { brief: { repositoryWork: writable } } : {}) };
    if (name === 'getRoomRepositoryState') return { resolution: 'repository', key: 'owner/repo', remote: `file://${remote}` };
    if (name === 'getRoomGitHubToken') return { token: 'fixture', expiresAt: Date.now() + 60_000 };
    return {};
  });
  const coordinator = new RoomRuntimeCoordinator(runtime, resolve(root, 'runtime.json'), { workspaceRoot: root } as never,
    { daemonApi: { execute } as unknown as DaemonApiClient });
  let loop!: MonolithCornerTurnLoop;
  const run = vi.spyOn(MonolithCornerTurnLoop.prototype, 'run').mockImplementation(function (this: MonolithCornerTurnLoop) {
    loop = this;
    const signal = (this as unknown as { options: { signal: AbortSignal } }).options.signal;
    return new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
  });
  const internal = coordinator as unknown as { startCorner(input: { cornerId: string; parentRoomId: string }): Promise<void>;
    materializeRoomCheckout(): Promise<string>; grantRunnerEndpoint(): Promise<undefined> };
  vi.spyOn(internal, 'materializeRoomCheckout').mockResolvedValue(roomCheckout);
  vi.spyOn(internal, 'grantRunnerEndpoint').mockResolvedValue(undefined);
  try {
    await exec('git', ['init', '-b', 'main', roomCheckout]);
    await writeFile(resolve(roomCheckout, 'file'), 'source');
    await exec('git', ['-C', roomCheckout, 'add', '.']);
    await exec('git', ['-C', roomCheckout, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base']);
    await exec('git', ['clone', '--bare', roomCheckout, remote]);
    await internal.startCorner({ cornerId: 'corner', parentRoomId: 'parent' });
    expect(run).toHaveBeenCalledOnce();
    const turn = loop as unknown as { withCheckout(work: () => Promise<void>): Promise<void>;
      options: { worktreePath: string; repository: { readOnly: boolean } } };
    const own = agentCornerCheckoutPaths(root, 'corner', identity.publicKey);
    await turn.withCheckout(async () => {
      expect(turn.options.worktreePath).toBe(roomCheckout);
      expect(turn.options.repository.readOnly).toBe(true);
    });
    await expect(access(own.path)).rejects.toThrow();
    expect(await readStorageOwners(root)).toEqual([]);
    writable = true;
    await turn.withCheckout(async () => {
      expect(turn.options.worktreePath).toBe(own.path);
      expect(turn.options.repository.readOnly).toBe(false);
    });
    expect(await readStorageOwners(root)).toContainEqual(expect.objectContaining({ roomId: 'corner', agentId: identity.publicKey }));
    writable = false;
    await turn.withCheckout(async () => expect(turn.options.worktreePath).toBe(roomCheckout));
    assignedBrief = false;
    await turn.withCheckout(async () => {
      expect(turn.options.worktreePath).toBe(own.path);
      expect(turn.options.repository.readOnly).toBe(false);
    });
  } finally { run.mockRestore(); await coordinator.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it('leaving reclaims only this agents published copy even when Room access has been revoked', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'corner-leave-'));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32) },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'fixture' } } as AgentRuntimeRecord;
  const execute = vi.fn(async () => { throw new Error('membership revoked'); });
  const coordinator = new RoomRuntimeCoordinator(runtime, resolve(root, 'runtime.json'), { workspaceRoot: root } as never,
    { daemonApi: { execute } as unknown as DaemonApiClient });
  try {
    const seed = resolve(root, 'seed'), remote = resolve(root, 'remote.git');
    await exec('git', ['init', '-b', 'main', seed]);
    await writeFile(resolve(seed, 'file'), 'published');
    await exec('git', ['-C', seed, 'add', '.']);
    await exec('git', ['-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base']);
    await exec('git', ['clone', '--bare', seed, remote]);
    const input = { supervisorRoot: root, cornerId: 'corner', remote: `file://${remote}`,
      targetBranch: 'main', featureBranch: 'feature/corner', token: 'fixture' };
    const [mine, peer] = await Promise.all([identity.publicKey, 'b'.repeat(64)].map(publicKey =>
      materializeCornerWorktree({ ...input, committer: { name: 'Bee', publicKey } })));
    await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'corner', kind: 'corners',
      itemId: mine!.path.split('/').pop()!, agentId: identity.publicKey });
    // The reviewer may have detached to the published branch head.
    await exec('git', ['-C', mine!.path, 'checkout', '--detach']);
    const internal = coordinator as unknown as { reapCornerWorktree(worktree: object): Promise<void> };
    await internal.reapCornerWorktree({ ...mine, cornerId: 'corner', branch: 'feature/corner', token: '' });
    await expect(access(mine!.path)).rejects.toThrow();
    await expect(access(mine!.gitCommonDir)).rejects.toThrow();
    await expect(access(peer!.path)).resolves.toBeUndefined();
    await expect(internal.reapCornerWorktree({ ...mine, cornerId: 'corner', branch: 'feature/corner', token: '' })).resolves.toBeUndefined();
    expect(await readStorageOwners(root)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    // Whole-agent retirement must reclaim its copies even while another agent
    // remains in this Workspace (the shared assets still belong to that peer).
    const restarted = await materializeCornerWorktree({ ...input, committer: { name: 'Bee', publicKey: identity.publicKey } });
    await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'corner', kind: 'corners',
      itemId: restarted.path.split('/').pop()!, agentId: identity.publicKey, ended: false });
    const peerRuntime = resolve(root, 'beeline/agents', 'b'.repeat(64));
    await mkdir(peerRuntime, { recursive: true });
    await writeFile(resolve(peerRuntime, 'runtime.json'), JSON.stringify({ communityId: 'workspace' }));
    await markAgentStorageEnded(runtime);
    await pruneEndedOwnerStorage(root, { inUse: async () => false });
    await expect(access(restarted.path)).rejects.toThrow();
    await expect(access(restarted.gitCommonDir)).rejects.toThrow();
    await expect(access(peer!.path)).resolves.toBeUndefined();
  } finally { await coordinator.shutdown(); await rm(root, { recursive: true, force: true }); }
});
