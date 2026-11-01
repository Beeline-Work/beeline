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

it('membership retirement preserves private copies without archive authority', async () => {
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
    await expect(internal.reapCornerWorktree({ ...mine, cornerId: 'corner', branch: 'feature/corner', token: '' })).rejects.toThrow('membership revoked');
    await expect(access(mine!.path)).resolves.toBeUndefined();
    await expect(access(mine!.gitCommonDir)).resolves.toBeUndefined();
    await expect(access(peer!.path)).resolves.toBeUndefined();
    expect(await readStorageOwners(root)).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    // Whole-agent retirement is also not archive authority.
    const restarted = await materializeCornerWorktree({ ...input, committer: { name: 'Bee', publicKey: identity.publicKey } });
    await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'corner', kind: 'corners',
      itemId: restarted.path.split('/').pop()!, agentId: identity.publicKey, ended: false });
    const peerRuntime = resolve(root, 'beeline/agents', 'b'.repeat(64));
    await mkdir(peerRuntime, { recursive: true });
    await writeFile(resolve(peerRuntime, 'runtime.json'), JSON.stringify({ communityId: 'workspace' }));
    await markAgentStorageEnded(runtime);
    await pruneEndedOwnerStorage(root, { inUse: async () => false });
    await expect(access(restarted.path)).resolves.toBeUndefined();
    await expect(access(restarted.gitCommonDir)).resolves.toBeUndefined();
    await expect(access(peer!.path)).resolves.toBeUndefined();
  } finally { await coordinator.shutdown(); await rm(root, { recursive: true, force: true }); }
});

async function cornerFixture(prefix: string, implementerAgentId: (self: string) => string) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32) },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'fixture' } } as AgentRuntimeRecord;
  const remote = resolve(root, 'remote.git'), roomCheckout = resolve(root, 'room');
  const posted: string[] = [];
  const execute = vi.fn(async (name: string, input: { text?: string }) => {
    if (name === 'getCornerRestoreState') return { cornerId: 'corner', objective: 'Fix it', closeRequested: false,
      implementerAgentId: implementerAgentId(identity.publicKey), brief: { repositoryWork: true } };
    if (name === 'getRoomRepositoryState') return { resolution: 'repository', key: 'owner/repo', remote: `file://${remote}` };
    if (name === 'getRoomGitHubToken') return { token: 'fixture', expiresAt: Date.now() + 60_000 };
    if (name === 'postRoomMessage') posted.push(input.text!);
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
  await exec('git', ['init', '-b', 'main', roomCheckout]);
  await writeFile(resolve(roomCheckout, 'file'), 'source');
  await exec('git', ['-C', roomCheckout, 'add', '.']);
  await exec('git', ['-C', roomCheckout, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base']);
  await exec('git', ['clone', '--bare', roomCheckout, remote]);
  await internal.startCorner({ cornerId: 'corner', parentRoomId: 'parent' });
  const turn = loop as unknown as {
    withCheckout(work: () => Promise<void>): Promise<void>;
    releaseImplementer(requestId: string): Promise<void>;
    retainBackgroundClient(client: unknown): Promise<void>;
    commandContext: { current?: { reason: string } };
    options: { worktreePath: string; repository: { readOnly: boolean } };
  };
  return {
    root, remote, roomCheckout, identity, turn, posted,
    own: agentCornerCheckoutPaths(root, 'corner', identity.publicKey),
    close: async () => { run.mockRestore(); await coordinator.shutdown(); await rm(root, { recursive: true, force: true }); },
  };
}

it('a commander or tagged agent reads the Room checkout; an order gives it a private copy', async () => {
  const fixture = await cornerFixture('corner-commander-', () => 'c'.repeat(64));
  const { turn, own, roomCheckout } = fixture;
  try {
    // Activation and an ordinary turn of a non-implementer take no copy.
    await expect(access(own.path)).rejects.toThrow();
    await turn.withCheckout(async () => {
      expect(turn.options.worktreePath).toBe(roomCheckout);
      expect(turn.options.repository.readOnly).toBe(true);
    });
    await expect(access(own.path)).rejects.toThrow();
    // An order makes it a second writer with its own copy and branch checkout.
    turn.commandContext.current = { reason: 'order' };
    await turn.withCheckout(async () => {
      expect(turn.options.worktreePath).toBe(own.path);
      expect(turn.options.repository.readOnly).toBe(false);
    });
    expect((await exec('git', ['-C', own.path, 'branch', '--show-current'])).stdout.trim()).toMatch(/^feature\/corner-/);
    // Its later turns keep that copy, so its edits are never stranded.
    turn.commandContext.current = { reason: 'agent_tag' };
    await turn.withCheckout(async () => expect(turn.options.worktreePath).toBe(own.path));
  } finally { turn.commandContext.current = undefined; await fixture.close(); }
});

it('a swapped-out implementer stops its background jobs, pushes unpushed work to a backup branch, and deletes its copy', async () => {
  const fixture = await cornerFixture('corner-swap-', self => self);
  const { turn, own, remote, posted } = fixture;
  try {
    await turn.withCheckout(async () => expect(turn.options.worktreePath).toBe(own.path));
    await writeFile(resolve(own.path, 'committed'), 'local commit');
    await exec('git', ['-C', own.path, 'add', '.']);
    await exec('git', ['-C', own.path, 'commit', '-m', 'unpushed']);
    await writeFile(resolve(own.path, 'edit'), 'uncommitted');
    const { EventEmitter } = await import('node:events');
    const job = Object.assign(new EventEmitter(), { hasBackgroundTools: true, stop: vi.fn(async () => undefined) });
    void turn.retainBackgroundClient(job);

    await turn.releaseImplementer('release-request');

    expect(job.stop).toHaveBeenCalledOnce();
    await expect(access(own.path)).rejects.toThrow();
    await expect(access(own.gitCommonDir)).rejects.toThrow();
    const backup = `beeline/backup/corner-${fixture.identity.publicKey.slice(0, 8)}`;
    const files = (await exec('git', [`--git-dir=${remote}`, 'ls-tree', '--name-only', backup])).stdout.split('\n');
    expect(files).toEqual(expect.arrayContaining(['committed', 'edit', 'file']));
    expect(posted).toEqual([expect.stringContaining(`to branch ${backup}`)]);
    expect(posted[0]).toContain('1 background job session');
    expect(posted[0]).toContain(`deleted my copy at ${own.path}`);
  } finally { await fixture.close(); }
});

it('a swap publishes every stash entry before deleting the old copy', async () => {
  const fixture = await cornerFixture('corner-swap-stashes-', self => self);
  const { turn, own, remote, posted } = fixture;
  try {
    await turn.withCheckout(async () => undefined);
    const stashes: string[] = [];
    for (const content of ['older stashed work', 'newer stashed work']) {
      await writeFile(resolve(own.path, 'file'), content);
      await exec('git', ['-C', own.path, 'stash', 'push', '-m', content]);
      stashes.push((await exec('git', ['-C', own.path, 'rev-parse', 'refs/stash'])).stdout.trim());
    }
    await turn.releaseImplementer('release-stashes');
    const backup = `beeline/backup/corner-${fixture.identity.publicKey.slice(0, 8)}`;
    for (const [index, sha] of stashes.entries()) {
      const ref = `${backup}-stash-${sha}`;
      expect((await exec('git', [`--git-dir=${remote}`, 'show', `${ref}:file`])).stdout)
        .toBe(index === 0 ? 'older stashed work' : 'newer stashed work');
    }
    await expect(access(own.path)).rejects.toThrow();
    await expect(access(own.gitCommonDir)).rejects.toThrow();
    expect(posted[0]).toContain(`deleted my copy at ${own.path}`);
  } finally { await fixture.close(); }
});
