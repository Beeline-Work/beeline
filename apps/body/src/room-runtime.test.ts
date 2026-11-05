import { m16_access, m16_mkdtemp, m16_tmpdir, m16_resolve, m16_describe, m16_expect, m16_it, m16_cornerBranchIsSafeToDelete, m16_materializeCornerWorktree, m16_removeCornerWorktreeAndBranches, mergedDescribe16, m35_access, m35_mkdir, m35_mkdtemp, m35_rm, m35_writeFile, m35_tmpdir, m35_resolve, m35_expect, m35_it, m35_vi, m35_RoomRuntimeCoordinator, m35_materializeCornerWorktree, m35_MonolithCornerTurnLoop, m35_agentCornerCheckoutPaths, m35_readStorageOwners, m35_rememberStorageOwner, m35_markAgentStorageEnded, m35_pruneEndedOwnerStorage, m35_identityFromKey, mergedDescribe35, m36_mkdtemp, m36_tmpdir, m36_join, m36_describe, m36_expect, m36_it, m36_vi, m36_identityFromKey, m36_RoomRuntimeCoordinator, mergedDescribe36, m37_mkdtemp, m37_tmpdir, m37_resolve, m37_describe, m37_expect, m37_it, m37_vi, m37_DaemonApiError, m37_RoomRuntimeCoordinator, m37_identityFromKey, mergedDescribe37, m38_mkdtemp, m38_rm, m38_tmpdir, m38_resolve, m38_expect, m38_it, m38_vi, m38_RoomRuntimeCoordinator, m38_identityFromKey, mergedDescribe38, move2_resolve, move2_describe, move2_expect, move2_it, movedDescribe2, fixtureScope1, fixtureScope4, fixtureScope5, fixtureScope7, fixtureScope10, type m35_DaemonApiClient, type m35_AgentRuntimeRecord, type m36_DaemonApiClient, type m36_AgentRuntimeRecord, type m37_DaemonApiClient, type m37_AgentRuntimeRecord, type m38_CornerWorktree, type m38_AgentRuntimeRecord } from './room-runtime.test-support.js';

mergedDescribe16("corner-pr-branch-preservation.test.ts", () => {
const scope1 = fixtureScope1();
m16_describe('cornerBranchIsSafeToDelete', () => {
  m16_it('keeps the branch while a pull request is open (no merge stamp)', () => {
    m16_expect(
      m16_cornerBranchIsSafeToDelete({
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


  m16_it('deletes the branch once the pull request merged', () => {
    m16_expect(
      m16_cornerBranchIsSafeToDelete({
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


  m16_it('deletes a branch no pull request ever claimed', () => {
    m16_expect(m16_cornerBranchIsSafeToDelete(undefined)).toBe(true);
    m16_expect(
      m16_cornerBranchIsSafeToDelete({ lifecycle: 'working', checks: 'unknown', branch: scope1.FEATURE }),
    ).toBe(true);
  });
});
m16_describe('corner close cleanup', () => {
  m16_it('reaps the worktree but keeps an open pull request branch on GitHub', async () => {
    const { remote } = await scope1.remoteWithCornerBranch();
    const supervisorRoot = await m16_mkdtemp(m16_resolve(m16_tmpdir(), 'beeline-corner-preserve-'));
    scope1.roots.push(supervisorRoot);
    const worktree = await m16_materializeCornerWorktree({
      cornerId: 'corner-open-pr',
      remote,
      targetBranch: 'main',
      featureBranch: scope1.FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const bare = remote.slice('file://'.length);
    const cleanup = () =>
      m16_removeCornerWorktreeAndBranches(
        { ...worktree, cornerId: 'corner-open-pr', branch: scope1.FEATURE, token: 'unused' },
        { preserveRemoteBranch: true },
      );

    await cleanup();

    await m16_expect(m16_access(worktree.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await m16_expect(
      scope1.git(worktree.gitCommonDir, 'show-ref', '--verify', `refs/heads/${scope1.FEATURE}`),
    ).rejects.toThrow();
    // The artifact the pull request points at survives.
    await m16_expect(scope1.git(bare, 'show-ref', '--verify', `refs/heads/${scope1.FEATURE}`)).resolves.toBeTruthy();
    await m16_expect(scope1.git(bare, 'show-ref', '--verify', 'refs/heads/main')).resolves.toBeTruthy();

    // A retried preserved cleanup stays idempotent.
    await m16_expect(cleanup()).resolves.toBeUndefined();
    await m16_expect(scope1.git(bare, 'show-ref', '--verify', `refs/heads/${scope1.FEATURE}`)).resolves.toBeTruthy();
  });


  m16_it('an agent copy never deletes the shared remote branch during cleanup', async () => {
    const { remote } = await scope1.remoteWithCornerBranch();
    const supervisorRoot = await m16_mkdtemp(m16_resolve(m16_tmpdir(), 'beeline-corner-delete-'));
    scope1.roots.push(supervisorRoot);
    const worktree = await m16_materializeCornerWorktree({
      cornerId: 'corner-no-pr',
      remote,
      targetBranch: 'main',
      featureBranch: scope1.FEATURE,
      token: 'unused',
      supervisorRoot,
      committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
    });
    const bare = remote.slice('file://'.length);

    await m16_removeCornerWorktreeAndBranches(
      { ...worktree, cornerId: 'corner-no-pr', branch: scope1.FEATURE, token: 'unused' },
      { preserveRemoteBranch: false },
    );

    await m16_expect(scope1.git(bare, 'show-ref', '--verify', `refs/heads/${scope1.FEATURE}`)).resolves.toBeTruthy();
  });
});
});
mergedDescribe35("room-runtime.agent-checkout.test.ts", () => {
const scope4 = fixtureScope4();


m35_it('read-only assignments reuse the Room checkout, then select a private copy after a writable brief revision', async () => {
  const root = await m35_mkdtemp(m35_resolve(m35_tmpdir(), 'corner-readonly-'));
  const identity = m35_identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32) },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'fixture' } } as m35_AgentRuntimeRecord;
  let writable = false;
  let assignedBrief = true;
  const remote = m35_resolve(root, 'remote.git'), roomCheckout = m35_resolve(root, 'room');
  const execute = m35_vi.fn(async (name: string) => {
    if (name === 'getCornerRestoreState') return { cornerId: 'corner', objective: 'Read source', closeRequested: false,
      implementerAgentId: identity.publicKey, ...(assignedBrief ? { brief: { repositoryWork: writable } } : {}) };
    if (name === 'getRoomRepositoryState') return { resolution: 'repository', key: 'owner/repo', remote: `file://${remote}` };
    if (name === 'getRoomGitHubToken') return { token: 'fixture', expiresAt: Date.now() + 60_000 };
    return {};
  });
  const coordinator = new m35_RoomRuntimeCoordinator(runtime, m35_resolve(root, 'runtime.json'), { workspaceRoot: root } as never,
    { daemonApi: { execute } as unknown as m35_DaemonApiClient });
  let loop!: m35_MonolithCornerTurnLoop;
  const run = m35_vi.spyOn(m35_MonolithCornerTurnLoop.prototype, 'run').mockImplementation(function (this: m35_MonolithCornerTurnLoop) {
    loop = this;
    const signal = (this as unknown as { options: { signal: AbortSignal } }).options.signal;
    return new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
  });
  const internal = coordinator as unknown as { startCorner(input: { cornerId: string; parentRoomId: string }): Promise<void>;
    materializeRoomCheckout(): Promise<string>; grantRunnerEndpoint(): Promise<undefined> };
  m35_vi.spyOn(internal, 'materializeRoomCheckout').mockResolvedValue(roomCheckout);
  m35_vi.spyOn(internal, 'grantRunnerEndpoint').mockResolvedValue(undefined);
  try {
    await scope4.exec('git', ['init', '-b', 'main', roomCheckout]);
    await m35_writeFile(m35_resolve(roomCheckout, 'file'), 'source');
    await scope4.exec('git', ['-C', roomCheckout, 'add', '.']);
    await scope4.exec('git', ['-C', roomCheckout, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base']);
    await scope4.exec('git', ['clone', '--bare', roomCheckout, remote]);
    await internal.startCorner({ cornerId: 'corner', parentRoomId: 'parent' });
    m35_expect(run).toHaveBeenCalledOnce();
    const turn = loop as unknown as { withCheckout(work: () => Promise<void>): Promise<void>;
      options: { worktreePath: string; repository: { readOnly: boolean } } };
    const own = m35_agentCornerCheckoutPaths(root, 'corner', identity.publicKey);
    await turn.withCheckout(async () => {
      m35_expect(turn.options.worktreePath).toBe(roomCheckout);
      m35_expect(turn.options.repository.readOnly).toBe(true);
    });
    await m35_expect(m35_access(own.path)).rejects.toThrow();
    m35_expect(await m35_readStorageOwners(root)).toEqual([]);
    writable = true;
    await turn.withCheckout(async () => {
      m35_expect(turn.options.worktreePath).toBe(own.path);
      m35_expect(turn.options.repository.readOnly).toBe(false);
    });
    m35_expect(await m35_readStorageOwners(root)).toContainEqual(m35_expect.objectContaining({ roomId: 'corner', agentId: identity.publicKey }));
    writable = false;
    await turn.withCheckout(async () => m35_expect(turn.options.worktreePath).toBe(roomCheckout));
    assignedBrief = false;
    await turn.withCheckout(async () => {
      m35_expect(turn.options.worktreePath).toBe(own.path);
      m35_expect(turn.options.repository.readOnly).toBe(false);
    });
  } finally { run.mockRestore(); await coordinator.shutdown(); await m35_rm(root, { recursive: true, force: true }); }
});



m35_it('membership retirement preserves private copies without archive authority', async () => {
  const root = await m35_mkdtemp(m35_resolve(m35_tmpdir(), 'corner-leave-'));
  const identity = m35_identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32) },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'fixture' } } as m35_AgentRuntimeRecord;
  const execute = m35_vi.fn(async () => { throw new Error('membership revoked'); });
  const coordinator = new m35_RoomRuntimeCoordinator(runtime, m35_resolve(root, 'runtime.json'), { workspaceRoot: root } as never,
    { daemonApi: { execute } as unknown as m35_DaemonApiClient });
  try {
    const seed = m35_resolve(root, 'seed'), remote = m35_resolve(root, 'remote.git');
    await scope4.exec('git', ['init', '-b', 'main', seed]);
    await m35_writeFile(m35_resolve(seed, 'file'), 'published');
    await scope4.exec('git', ['-C', seed, 'add', '.']);
    await scope4.exec('git', ['-C', seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base']);
    await scope4.exec('git', ['clone', '--bare', seed, remote]);
    const input = { supervisorRoot: root, cornerId: 'corner', remote: `file://${remote}`,
      targetBranch: 'main', featureBranch: 'feature/corner', token: 'fixture' };
    const [mine, peer] = await Promise.all([identity.publicKey, 'b'.repeat(64)].map(publicKey =>
      m35_materializeCornerWorktree({ ...input, committer: { name: 'Bee', publicKey } })));
    await m35_rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'corner', kind: 'corners',
      itemId: mine!.path.split('/').pop()!, agentId: identity.publicKey });
    // The reviewer may have detached to the published branch head.
    await scope4.exec('git', ['-C', mine!.path, 'checkout', '--detach']);
    const internal = coordinator as unknown as { reapCornerWorktree(worktree: object): Promise<void> };
    await m35_expect(internal.reapCornerWorktree({ ...mine, cornerId: 'corner', branch: 'feature/corner', token: '' })).rejects.toThrow('membership revoked');
    await m35_expect(m35_access(mine!.path)).resolves.toBeUndefined();
    await m35_expect(m35_access(mine!.gitCommonDir)).resolves.toBeUndefined();
    await m35_expect(m35_access(peer!.path)).resolves.toBeUndefined();
    m35_expect(await m35_readStorageOwners(root)).toHaveLength(1);
    m35_expect(execute).toHaveBeenCalledTimes(1);
    // Whole-agent retirement is also not archive authority.
    const restarted = await m35_materializeCornerWorktree({ ...input, committer: { name: 'Bee', publicKey: identity.publicKey } });
    await m35_rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'corner', kind: 'corners',
      itemId: restarted.path.split('/').pop()!, agentId: identity.publicKey, ended: false });
    const peerRuntime = m35_resolve(root, 'beeline/agents', 'b'.repeat(64));
    await m35_mkdir(peerRuntime, { recursive: true });
    await m35_writeFile(m35_resolve(peerRuntime, 'runtime.json'), JSON.stringify({ communityId: 'workspace' }));
    await m35_markAgentStorageEnded(runtime);
    await m35_pruneEndedOwnerStorage(root, { inUse: async () => false });
    await m35_expect(m35_access(restarted.path)).resolves.toBeUndefined();
    await m35_expect(m35_access(restarted.gitCommonDir)).resolves.toBeUndefined();
    await m35_expect(m35_access(peer!.path)).resolves.toBeUndefined();
  } finally { await coordinator.shutdown(); await m35_rm(root, { recursive: true, force: true }); }
});



m35_it('a commander or tagged agent reads the Room checkout; an order gives it a private copy', async () => {
  const fixture = await scope4.cornerFixture('corner-commander-', () => 'c'.repeat(64));
  const { turn, own, roomCheckout } = fixture;
  try {
    // Activation and an ordinary turn of a non-implementer take no copy.
    await m35_expect(m35_access(own.path)).rejects.toThrow();
    await turn.withCheckout(async () => {
      m35_expect(turn.options.worktreePath).toBe(roomCheckout);
      m35_expect(turn.options.repository.readOnly).toBe(true);
    });
    await m35_expect(m35_access(own.path)).rejects.toThrow();
    // An order makes it a second writer with its own copy and branch checkout.
    turn.commandContext.current = { reason: 'order' };
    await turn.withCheckout(async () => {
      m35_expect(turn.options.worktreePath).toBe(own.path);
      m35_expect(turn.options.repository.readOnly).toBe(false);
    });
    m35_expect((await scope4.exec('git', ['-C', own.path, 'branch', '--show-current'])).stdout.trim()).toMatch(/^feature\/corner-/);
    // Its later turns keep that copy, so its edits are never stranded.
    turn.commandContext.current = { reason: 'agent_tag' };
    await turn.withCheckout(async () => m35_expect(turn.options.worktreePath).toBe(own.path));
  } finally { turn.commandContext.current = undefined; await fixture.close(); }
});
});
mergedDescribe36("room-runtime.config-change.test.ts", () => {
const scope5 = fixtureScope5();
m36_describe('RoomRuntimeCoordinator config-change wake', () => {
  m36_it('registers the config-changed listener and hot-restarts on it', async () => {
    const root = await m36_mkdtemp(m36_join(m36_tmpdir(), 'beeline-coordinator-config-wake-'));
    scope5.roots.push(root);
    const identity = m36_identityFromKey('11'.repeat(32), 'Bee');
    const runtime = {
      agent: {
        name: 'Bee',
        publicKey: identity.publicKey,
        secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
      },
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
    } as unknown as m36_AgentRuntimeRecord;

    let configChanged: (() => void) | undefined;
    const onConfigChanged = m36_vi.fn();
    const coordinator = new m36_RoomRuntimeCoordinator(
      runtime,
      m36_join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute: m36_vi.fn(),
          setRoomsChangedListener: m36_vi.fn(),
          setConfigChangedListener: (listener: () => void) => {
            configChanged = listener;
          },
        } as unknown as m36_DaemonApiClient,
        onConfigChanged,
      },
    );
    try {
      m36_expect(configChanged).toBeTypeOf('function');
      // The wake must be safe with nothing live: an empty scheduler is the
      // ordinary case for a daemon that has not started any Room yet.
      m36_expect(() => configChanged!()).not.toThrow();
      m36_expect(onConfigChanged).toHaveBeenCalledTimes(1);
      await m36_vi.waitFor(() =>
        m36_expect(coordinator.schedulerSnapshot().running).toBe(0),
      );
    } finally {
      await coordinator.shutdown();
    }
  });
});
});
mergedDescribe37("room-runtime.lazy-corners.test.ts", () => {
const scope7 = fixtureScope7();
m37_describe('idle corner discovery', () => {
  m37_it('mass pushed starts have no capacity ceiling or timed retry barrier', async () => {
    const supervisorRoot = await m37_mkdtemp(m37_resolve(m37_tmpdir(), 'beeline-corner-storm-'));
    scope7.roots.push(supervisorRoot);
    m37_vi.useFakeTimers();
    m37_vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reset = Date.now() + 600_000;
    let inFlight = 0;
    let peak = 0;
    const execute = m37_vi.fn(async (name: string) => {
      if (name === 'getRoomRepositoryState') return { resolution: 'none' };
      if (name === 'getCornerRestoreState') {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 300));
        inFlight--;
        throw new m37_DaemonApiError(`GitHub rate limit; checks readable again at ${new Date(reset).toISOString()}`, 502, true);
      }
      throw new Error(`unexpected ${name}`);
    });
    const identity = m37_identityFromKey('11'.repeat(32), 'Bee');
    const make = () => new m37_RoomRuntimeCoordinator({
      agent: { name: 'Bee', publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32) },
      rooms: [], communityId: 'workspace', supervisorRoot,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
    } as unknown as m37_AgentRuntimeRecord, m37_resolve(supervisorRoot, 'agent.json'),
      { workspaceRoot: supervisorRoot } as never, { daemonApi: { execute } as unknown as m37_DaemonApiClient });
    const coordinators = [make(), make()];
    const start = (id: number) => (coordinators[id % 2] as unknown as {
      startCorner(corner: { cornerId: string; parentRoomId: string }): Promise<void>;
    }).startCorner({ cornerId: `corner-${id}`, parentRoomId: 'parent' });
    const jobs = Array.from({ length: 80 }, (_, i) => start(i));
    await m37_vi.advanceTimersByTimeAsync(20_000);
    await Promise.all(jobs);
    m37_expect(peak).toBe(80);
    const reads = execute.mock.calls.filter(([name]) => name === 'getCornerRestoreState').length;
    m37_expect(reads).toBeGreaterThan(0);
    m37_expect(reads).toBe(80);
    const nextJobs=Array.from({length:80},(_,i)=>start(i));
    await m37_vi.advanceTimersByTimeAsync(1000);
    await Promise.all(nextJobs);
    m37_expect(execute.mock.calls.filter(([name]) => name === 'getCornerRestoreState')).toHaveLength(reads+80);
    // Failed startup leaves the authoritative pending commands untouched.
    m37_expect(execute.mock.calls.some(([name]) => name === 'postAgentTurnReceipt')).toBe(false);
    const wakes = coordinators.map(coordinator => {
      const listener = m37_vi.fn();
      coordinator.setDiscoveryWakeListener(listener);
      return listener;
    });
    await m37_vi.advanceTimersByTimeAsync(581_000);
    m37_expect(wakes.every(wake => wake.mock.calls.length === 0)).toBe(true);
    const resumed = start(0);
    await m37_vi.advanceTimersByTimeAsync(1000);
    await resumed;
    m37_expect(execute.mock.calls.filter(([name]) => name === 'getCornerRestoreState')).toHaveLength(reads + 81);
    await Promise.all(coordinators.map(coordinator => coordinator.shutdown()));
  });


  m37_it('forgets archived parent mappings after discovery requests active corners only', async () => {
    const supervisorRoot = await m37_mkdtemp(m37_resolve(m37_tmpdir(), 'beeline-active-corner-'));
    scope7.roots.push(supervisorRoot);
    const identity = m37_identityFromKey('11'.repeat(32), 'Bee');
    const execute = m37_vi.fn(async (name: string) => {
      if (name === 'getDaemonBootstrap')
        return { workspaceIds: ['workspace'], rooms: [{ roomId: 'parent', archived: false }] };
      if (name === 'listRoomCorners') return { corners: [] };
      throw new Error(`unexpected operation ${name}`);
    });
    const runtime = new m37_RoomRuntimeCoordinator(
      { agent: { name: 'Bee', publicKey: identity.publicKey,
          secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
        rooms: [], communityId: 'workspace', supervisorRoot,
        transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      } as unknown as m37_AgentRuntimeRecord,
      m37_resolve(supervisorRoot, 'agent.json'),
      { workspaceRoot: supervisorRoot } as never,
      { daemonApi: { execute, liveSubscribe: m37_vi.fn(() => () => undefined) } as unknown as m37_DaemonApiClient },
    );
    const subject = runtime as unknown as {
      monolithCornerParents: Map<string, string>;
      startRoom(roomId: string): Promise<void>;
    };
    subject.monolithCornerParents.set('old-archived-corner', 'parent');
    subject.startRoom = async () => undefined;
    m37_expect(await runtime.reconcile()).toBe('member');
    m37_expect(subject.monolithCornerParents.has('old-archived-corner')).toBe(false);
    m37_expect(execute).toHaveBeenCalledWith('listRoomCorners', { roomId: 'parent', activeOnly: true });
    await runtime.shutdown();
  });


  m37_it('Reproduction R1: starts a corner under its own parent when a DM also lists it', async () => {
    const supervisorRoot = await m37_mkdtemp(m37_resolve(m37_tmpdir(), 'beeline-dm-corner-'));
    scope7.roots.push(supervisorRoot);
    const identity = m37_identityFromKey('11'.repeat(32), 'Bee');
    const corner = { cornerId: 'corner-pr', parentRoomId: 'parent', archived: false,
      createdBy: identity.publicKey };
    const execute = m37_vi.fn(async (name: string, input?: { roomId?: string }) => {
      if (name === 'getDaemonBootstrap')
        return { workspaceIds: ['workspace'], rooms: [
          { roomId: 'parent', archived: false }, { roomId: 'dm', archived: false }] };
      // The server lists the agent's corners in every Room under a DM too.
      // The DM's answer lands last, as it did on the live helper.
      if (name === 'listRoomCorners') {
        if (input?.roomId === 'dm') await new Promise((done) => setTimeout(done, 10));
        return { corners: [corner] };
      }
      throw new Error(`unexpected operation ${name}`);
    });
    const runtime = new m37_RoomRuntimeCoordinator(
      { agent: { name: 'Bee', publicKey: identity.publicKey,
          secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
        rooms: [], communityId: 'workspace', supervisorRoot,
        transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      } as unknown as m37_AgentRuntimeRecord,
      m37_resolve(supervisorRoot, 'agent.json'),
      { workspaceRoot: supervisorRoot } as never,
      { daemonApi: { execute } as unknown as m37_DaemonApiClient },
    );
    const start = m37_vi.fn(async () => undefined);
    const subject = runtime as unknown as {
      monolithCornerParents: Map<string, string>;
      startRoom(roomId: string): Promise<void>;
      startCorner(corner: { cornerId: string; parentRoomId: string }): Promise<void>;
    };
    subject.startRoom = async () => undefined;
    subject.startCorner = start;
    m37_expect(await runtime.reconcile()).toBe('member');
    m37_expect(execute).toHaveBeenCalledWith('listRoomCorners', { roomId: 'dm', activeOnly: true });
    // The DM has no repository: a corner started under it runs repo-less.
    m37_expect(start).toHaveBeenCalledWith(m37_expect.objectContaining({ cornerId: 'corner-pr', parentRoomId: 'parent' }));
    m37_expect(start).not.toHaveBeenCalledWith(m37_expect.objectContaining({ parentRoomId: 'dm' }));
    m37_expect(subject.monolithCornerParents.get('corner-pr')).toBe('parent');
    await runtime.shutdown();
  });


  m37_it('Reproduction H-10: counts ten active corners of one parent once', () => {
    const runtime = new m37_RoomRuntimeCoordinator(
      {
        agent: { publicKey: m37_identityFromKey('11'.repeat(32), 'Bee').publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
        rooms: [],
        transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      } as unknown as m37_AgentRuntimeRecord,
      '/tmp/unused-agent.json',
      {} as never,
      { daemonApi: {} as m37_DaemonApiClient },
    );
    const subject = runtime as unknown as {
      running: Map<string, unknown>;
      monolithCornerParents: Map<string, string>;
    };
    for (let i = 0; i < 10; i++) {
      subject.running.set(`corner-${i}`, {});
      subject.monolithCornerParents.set(`corner-${i}`, 'parent');
    }
    m37_expect(runtime.activeRoomCount()).toBe(1);
    subject.monolithCornerParents.clear();
    m37_expect(runtime.activeRoomCount()).toBe(10);
  });


  m37_it('subscribes before checkout and hydrates only after a pending command arrives', async () => {
    const supervisorRoot = await m37_mkdtemp(m37_resolve(m37_tmpdir(), 'beeline-idle-corner-'));
    scope7.roots.push(supervisorRoot);
    const identity = m37_identityFromKey('11'.repeat(32), 'Bee');
    const execute = m37_vi.fn(async (name: string) => {
      if (name === 'getDaemonBootstrap') {
        return {
          workspaceIds: ['workspace'],
          rooms: [{ roomId: 'parent', archived: false }],
        };
      }
      if (name === 'listRoomCorners') {
        return {
          corners: [
            {
              cornerId: 'corner-idle',
              parentRoomId: 'parent',
              archived: false,
              createdBy: identity.publicKey,
            },
          ],
        };
      }
      throw new Error(`unexpected operation ${name}`);
    });
    let onCommands: ((commands: { id: string }[]) => void) | undefined;
    let onState: ((connected: boolean, capabilities?: { pushIntake: boolean }) => void) | undefined;
    const release = m37_vi.fn();
    const liveSubscribe = m37_vi.fn(
      (
        _roomId: string,
        _cursor: unknown,
        _onItems: unknown,
        state: typeof onState,
        _presence: unknown,
        commands: typeof onCommands,
      ) => {
        onState = state;
        onCommands = commands;
        return release;
      },
    );
    const runtime = new m37_RoomRuntimeCoordinator(
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
      } as unknown as m37_AgentRuntimeRecord,
      m37_resolve(supervisorRoot, 'agent.json'),
      { workspaceRoot: supervisorRoot } as never,
      { daemonApi: { execute, liveSubscribe } as unknown as m37_DaemonApiClient },
    );
    const start = m37_vi.fn(async () => undefined);
    const subject = runtime as unknown as {
      startRoom(roomId: string): Promise<void>;
      startCorner(corner: { cornerId: string }): Promise<void>;
    };
    subject.startRoom = async () => undefined;
    subject.startCorner = start;

    m37_expect(await runtime.reconcile()).toBe('member');
    m37_expect(liveSubscribe).toHaveBeenCalledWith(
      'corner-idle',
      undefined,
      undefined,
      m37_expect.any(Function),
      undefined,
      m37_expect.any(Function),
    );
    m37_expect(start).not.toHaveBeenCalled();
    m37_expect(execute.mock.calls.map(([name]) => name)).toEqual([
      'getDaemonBootstrap',
      'listRoomCorners',
    ]);
    onState?.(true, { pushIntake: true });
    m37_expect(start).not.toHaveBeenCalled();
    m37_expect(await runtime.reconcile()).toBe('member');
    m37_expect(start).not.toHaveBeenCalled();
    onCommands?.([{ id: 'pending' }]);
    await m37_vi.waitFor(() => m37_expect(start).toHaveBeenCalledOnce());
    await runtime.applyMembershipEvent({ roomId: 'corner-idle', removed: true });
    m37_expect(release).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });
});
});
mergedDescribe38("room-runtime.startup.test.ts", () => {


m38_it('background reaping leases inactive corners and wakes a start deferred by that lease', async () => {
  const root = await m38_mkdtemp(m38_resolve(m38_tmpdir(), 'beeline-reap-lease-'));
  const identity = m38_identityFromKey('11'.repeat(32), 'Bee');
  const execute = m38_vi.fn();
  const coordinator = new m38_RoomRuntimeCoordinator({
    agent: { publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test' },
  } as m38_AgentRuntimeRecord, m38_resolve(root, 'runtime.json'), { workspaceRoot: root } as never,
  { daemonApi: { execute } as never });
  const internal = coordinator as unknown as {
    reapIdleCornerWorktree(worktree: m38_CornerWorktree, desired: ReadonlySet<string>): Promise<void>;
    reapCornerWorktree(worktree: m38_CornerWorktree): Promise<void>;
    startCorner(corner: { cornerId: string; parentRoomId: string }): Promise<void>;
  };
  const worktree = { cornerId: 'corner', parentRoomId: 'room', path: m38_resolve(root, 'corner'),
    gitCommonDir: m38_resolve(root, 'repo.git'), branch: 'feature/corner', token: '' };
  let release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  const reap = m38_vi.spyOn(internal, 'reapCornerWorktree').mockReturnValue(blocked);
  const wake = m38_vi.fn();
  coordinator.setDiscoveryWakeListener(wake);
  let maintenance: Promise<void> | undefined;
  try {
    await internal.reapIdleCornerWorktree(worktree, new Set(['corner']));
    m38_expect(reap).not.toHaveBeenCalled();
    maintenance = internal.reapIdleCornerWorktree(worktree, new Set());
    await m38_vi.waitFor(() => m38_expect(reap).toHaveBeenCalledOnce());
    await internal.startCorner({ cornerId: 'corner', parentRoomId: 'room' });
    m38_expect(execute).not.toHaveBeenCalled();
    release(); await maintenance;
    m38_expect(wake).toHaveBeenCalledOnce();
  } finally {
    release(); await maintenance; reap.mockRestore();
    await coordinator.shutdown(); await m38_rm(root, { recursive: true, force: true });
  }
});



m38_it('establishes every corner subscription without waiting for pending legacy checkout migration', async () => {
  const root = await m38_mkdtemp(m38_resolve(m38_tmpdir(), 'beeline-migration-intake-'));
  const identity = m38_identityFromKey('11'.repeat(32), 'Bee');
  const corners = Array.from({ length: 20 }, (_, i) => ({ roomId: `corner-${i}`, parentRoomId: 'room' }));
  const execute = m38_vi.fn(async (name: string) => {
    if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'],
      rooms: [{ roomId: 'room' }], pendingRooms: corners };
    if (name === 'listRoomCorners') return { corners: corners.map(corner => ({ cornerId: corner.roomId, parentRoomId: 'room' })) };
    throw new Error(`unexpected operation ${name}`);
  });
  const subscribe = m38_vi.fn(() => () => undefined);
  const coordinator = new m38_RoomRuntimeCoordinator({
    agent: { publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test' },
  } as m38_AgentRuntimeRecord, m38_resolve(root, 'runtime.json'), { workspaceRoot: root } as never,
  { daemonApi: { execute, liveSubscribe: subscribe } as never });
  const internal = coordinator as unknown as {
    startRoom(id: string): Promise<void>;
    startCorner(input: { cornerId: string }): Promise<void>;
  };
  const room = m38_vi.spyOn(internal, 'startRoom').mockResolvedValue();
  let release!: () => void;
  const migrating = new Promise<void>(done => { release = done; });
  const start = m38_vi.spyOn(internal, 'startCorner').mockReturnValue(migrating);
  const serving = m38_vi.fn();
  let reconciled = false;
  const reconciliation = coordinator.reconcile(serving).then(() => { reconciled = true; });
  try {
    await m38_vi.waitFor(() => m38_expect(reconciled).toBe(true), { timeout: 1_000 });
    m38_expect(serving).toHaveBeenCalledOnce();
    m38_expect(room).toHaveBeenCalledWith('room');
    m38_expect(new Set(subscribe.mock.calls.map(call => (call as unknown[])[0])).size).toBe(20);
    m38_expect(start).toHaveBeenCalled();
  } finally {
    release(); await reconciliation; await coordinator.shutdown();
    room.mockRestore(); start.mockRestore();
    await m38_rm(root, { recursive: true, force: true });
  }
});



m38_it('starts Room and corner intake before waiting for archived cleanup', async () => {
  const root = await m38_mkdtemp(m38_resolve(m38_tmpdir(), 'beeline-intake-first-'));
  const identity = m38_identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
    communityId: 'workspace', supervisorRoot: root, rooms: [],
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test' },
  } as m38_AgentRuntimeRecord;
  const execute = m38_vi.fn(async (name: string) => {
    if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'], rooms: [{ roomId: 'room' }] };
    if (name === 'listRoomCorners') return { corners: [{ cornerId: 'corner', parentRoomId: 'room' }] };
    throw new Error(`unexpected operation ${name}`);
  });
  const coordinator = new m38_RoomRuntimeCoordinator(runtime, m38_resolve(root, 'runtime.json'),
    { workspaceRoot: root } as never, { daemonApi: { execute } as never });
  const internal = coordinator as unknown as {
    startRoom(id: string): Promise<void>;
    watchCorner(input: { cornerId: string }): Promise<void>;
    retryPendingCornerReaps(desired: ReadonlySet<string>): Promise<void>;
  };
  const start = m38_vi.spyOn(internal, 'startRoom').mockResolvedValue();
  const watch = m38_vi.spyOn(internal, 'watchCorner').mockResolvedValue();
  let release!: () => void;
  const cleanup = m38_vi.spyOn(internal, 'retryPendingCornerReaps')
    .mockImplementation(() => new Promise<void>(done => { release = done; }));
  const serving = m38_vi.fn();
  const reconciliation = coordinator.reconcile(serving);
  try {
    await m38_vi.waitFor(() => m38_expect(cleanup).toHaveBeenCalled());
    m38_expect(start).toHaveBeenCalledWith('room');
    m38_expect(watch).toHaveBeenCalledWith(m38_expect.objectContaining({ cornerId: 'corner' }));
    m38_expect(serving).toHaveBeenCalledOnce();
  } finally {
    release();
    await reconciliation;
    await coordinator.shutdown();
    await m38_rm(root, { recursive: true, force: true });
  }
});
});
movedDescribe2("corner-fetch-refspec.test.ts", () => {
const scope10 = fixtureScope10();
move2_describe('a corner checkout fetch refspec', () => {
  move2_it('moves origin/main on a plain fetch and is set idempotently', async () => {
    const supervisorRoot = await scope10.scratch('beeline-corner-refspec-');
    const { remote, seed } = await scope10.bareRemoteWithMain(supervisorRoot);

    const worktree = await scope10.materialize(supervisorRoot, remote, 'corner-refspec');

    move2_expect(await scope10.git(worktree.path, 'config', '--get', 'remote.origin.fetch')).toBe(
      scope10.WILDCARD_REFSPEC,
    );
    // AC-1: repeat prepares must not stack duplicate config entries.
    await scope10.materialize(supervisorRoot, remote, 'corner-refspec');
    move2_expect(await scope10.git(worktree.path, 'config', '--get-all', 'remote.origin.fetch')).toBe(
      scope10.WILDCARD_REFSPEC,
    );

    const before = await scope10.git(worktree.path, 'rev-parse', 'origin/main');
    const newHead = await scope10.advanceRemoteMain(seed, move2_resolve(supervisorRoot, 'remote.git'), 'second');
    move2_expect(newHead).not.toBe(before);

    await scope10.git(worktree.path, 'fetch', 'origin', 'main');

    move2_expect(await scope10.git(worktree.path, 'rev-parse', 'origin/main')).toBe(newHead);
  });


  move2_it('repairs a cache cloned before the refspec existed on its next prepare', async () => {
    const supervisorRoot = await scope10.scratch('beeline-corner-legacy-refspec-');
    const { remote, seed } = await scope10.bareRemoteWithMain(supervisorRoot);

    const worktree = await scope10.materialize(supervisorRoot, remote, 'corner-legacy');
    // A cache made by an older Beeline carries no fetch refspec at all.
    await scope10.execFileAsync('git', [
      `--git-dir=${worktree.gitCommonDir}`,
      'config',
      '--unset-all',
      'remote.origin.fetch',
    ]).catch(() => undefined);
    await move2_expect(scope10.git(worktree.path, 'config', '--get', 'remote.origin.fetch')).rejects.toThrow();

    // The worktree already exists, so this is the next prepare, not a re-clone.
    await scope10.materialize(supervisorRoot, remote, 'corner-legacy');
    move2_expect(await scope10.git(worktree.path, 'config', '--get', 'remote.origin.fetch')).toBe(
      scope10.WILDCARD_REFSPEC,
    );

    const newHead = await scope10.advanceRemoteMain(seed, move2_resolve(supervisorRoot, 'remote.git'), 'second');
    await scope10.git(worktree.path, 'fetch', 'origin', 'main');
    move2_expect(await scope10.git(worktree.path, 'rev-parse', 'origin/main')).toBe(newHead);
  });
});
});
