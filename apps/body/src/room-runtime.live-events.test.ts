import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient, RoomMembershipChange } from './daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

describe('RoomRuntimeCoordinator live membership apply', () => {
  it('finishes an active turn before restarting for a repository revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-revision-mid-turn-'));
    roots.push(root);
    let revision = 'first';
    let busy = true;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getDaemonBootstrap') return { workspaceIds: ['workspace'],
        rooms: [{ roomId: 'room-1', archived: false, repositoryRevision: revision }] };
      if (name === 'listRoomCorners') return { corners: [] };
      return {};
    });
    const coordinator = new RoomRuntimeCoordinator(runtimeAt(root), join(root, 'agent.json'),
      { workspaceRoot: root } as never, { daemonApi: {
        execute, setRoomsChangedListener: vi.fn(),
      } as unknown as DaemonApiClient });
    const internal = coordinator as unknown as {
      running: Map<string, unknown>;
      notePoll(roomId: string): void;
      stopRunning(roomId: string, room: unknown): Promise<void>;
      startRoom(roomId: string): Promise<void>;
    };
    internal.running.set('room-1', {
      body: { isBusy: () => busy, requestReconciliation: vi.fn() },
      controller: new AbortController(), promise: Promise.resolve(),
      lastPollAt: 0, backoffUntil: 0, recovering: false,
    });
    const stop = vi.spyOn(internal, 'stopRunning').mockImplementation(async () => {
      internal.running.delete('room-1');
    });
    const start = vi.spyOn(internal, 'startRoom').mockResolvedValue();
    try {
      await coordinator.reconcile();
      revision = 'second';
      await coordinator.reconcile();
      expect(stop).not.toHaveBeenCalled();
      busy = false;
      internal.notePoll('room-1');
      await vi.waitFor(() => expect(start).toHaveBeenCalledWith('room-1'));
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await coordinator.shutdown();
    }
  });
  it('keeps a capable live socket after a discovery read fault and retains old-server fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-discovery-recovery-'));
    roots.push(root);
    const reconnectLive = vi.fn();
    const supportsDiscoveryWake = vi.fn(() => true);
    const coordinator = new RoomRuntimeCoordinator(runtimeAt(root), join(root, 'agent.json'),
      { workspaceRoot: root } as never, { daemonApi: {
        reconnectLive, supportsDiscoveryWake, setRoomsChangedListener: vi.fn(),
      } as unknown as DaemonApiClient });
    try {
      coordinator.reconnectAfterFailure();
      expect(reconnectLive).not.toHaveBeenCalled();
      supportsDiscoveryWake.mockReturnValue(false);
      coordinator.reconnectAfterFailure();
      expect(reconnectLive).toHaveBeenCalledOnce();
    } finally {
      await coordinator.shutdown();
    }
  });
  it('starts a Room from a membership push without listing corners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-room-'));
    roots.push(root);
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomRepositoryState') return { resolution: 'none' };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getWorkspaceRoster') return { members: [] };
      return {};
    });
    let membership: ((event?: RoomMembershipChange) => void) | undefined;
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          setRoomsChangedListener: (listener: (event?: RoomMembershipChange) => void) => {
            membership = listener;
          },
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    try {
      await coordinator.applyMembershipEvent({ roomId: 'room-1' });
      await vi.waitFor(() => expect(coordinator.activeRoomIds()).toContain('room-1'));
      expect(execute).not.toHaveBeenCalledWith('listRoomCorners', expect.anything());
      expect(execute).not.toHaveBeenCalledWith('getDaemonBootstrap', expect.anything());
      expect(membership).toBeTypeOf('function');
      membership?.({ roomId: 'room-1', removed: true });
      await vi.waitFor(() => expect(coordinator.activeRoomIds()).not.toContain('room-1'));
    } finally {
      await coordinator.shutdown();
    }
  });

  it('starts a corner from its membership push and closes it on corner-complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-corner-'));
    roots.push(root);
    const execute = vi.fn(async (name: string) => {
      if (name === 'getCornerRestoreState')
        return {
          cornerId: 'corner-1',
          objective: 'Fix the widget',
          closeRequested: false,
          lane: 'no_code',
        };
      if (name === 'getRoomRepositoryState') return { resolution: 'none' };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getWorkspaceRoster') return { members: [] };
      return {};
    });
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          setRoomsChangedListener: vi.fn(),
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    try {
      await coordinator.applyMembershipEvent({
        roomId: 'corner-1',
        parentRoomId: 'room-1',
        openedBy: identityFromKey('11'.repeat(32), 'Bee').publicKey,
      });
      await vi.waitFor(() => expect(coordinator.activeRoomIds()).toContain('corner-1'));
      expect(execute).not.toHaveBeenCalledWith('listRoomCorners', expect.anything());
      await coordinator.applyCornerComplete('corner-1');
      await vi.waitFor(() => expect(coordinator.activeRoomIds()).not.toContain('corner-1'));
    } finally {
      await coordinator.shutdown();
    }
  });

  it('serves a title-only human corner so a tagged command can wake the agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-human-corner-'));
    roots.push(root);
    const execute = vi.fn(async (name: string) => {
      if (name === 'getCornerRestoreState')
        return {
          cornerId: 'corner-human',
          objective: '',
          title: 'Release notes',
          kind: 'human',
          closeRequested: false,
          lane: 'no_code',
        };
      if (name === 'getRoomRepositoryState') return { resolution: 'none' };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getWorkspaceRoster') return { members: [] };
      return {};
    });
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          setRoomsChangedListener: vi.fn(),
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    try {
      await coordinator.applyMembershipEvent({
        roomId: 'corner-human',
        parentRoomId: 'room-1',
        openedBy: 'human-owner',
      });
      await vi.waitFor(() => expect(coordinator.activeRoomIds()).toContain('corner-human'));
      expect(execute).toHaveBeenCalledWith('getAgentCommands', { roomId: 'corner-human' });
    } finally {
      await coordinator.shutdown();
    }
  });

  it('reads nothing for an archived corner a membership push inherited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-archived-'));
    roots.push(root);
    const execute = vi.fn(async () => ({}));
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          setRoomsChangedListener: vi.fn(),
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    try {
      await coordinator.applyMembershipEvent({
        roomId: 'corner-old',
        parentRoomId: 'room-1',
        openedBy: identityFromKey('11'.repeat(32), 'Bee').publicKey,
        archived: true,
      });
      expect(coordinator.activeRoomIds()).not.toContain('corner-old');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await coordinator.shutdown();
    }
  });

  it('starts a Room once when two membership pushes arrive before checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-race-'));
    roots.push(root);
    let repositoryReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomRepositoryState') {
        repositoryReads += 1;
        return { resolution: 'none' };
      }
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getWorkspaceRoster') return { members: [] };
      return {};
    });
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          setRoomsChangedListener: vi.fn(),
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    try {
      await Promise.all([
        coordinator.applyMembershipEvent({ roomId: 'room-1' }),
        coordinator.applyMembershipEvent({ roomId: 'room-1' }),
      ]);
      await vi.waitFor(() => expect(coordinator.activeRoomIds()).toContain('room-1'));
      expect(repositoryReads).toBe(0);
      expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(1);
    } finally {
      await coordinator.shutdown();
    }
  });

  it('arms the recovery reconcile instead of starting a corner with no opener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-opener-'));
    roots.push(root);
    const execute = vi.fn(async () => ({}));
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          setRoomsChangedListener: vi.fn(),
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    try {
      await coordinator.applyMembershipEvent({ roomId: 'corner-1', parentRoomId: 'room-1' });
      expect(coordinator.activeRoomIds()).not.toContain('corner-1');
      expect(execute).not.toHaveBeenCalled();
      expect(coordinator.needsFastReconcile()).toBe(true);
    } finally {
      await coordinator.shutdown();
    }
  });

  it('arms the recovery reconcile when a pushed corner start fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-corner-fail-'));
    roots.push(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const execute = vi.fn(async (name: string) => {
      if (name === 'getCornerRestoreState') throw new Error('corner restore read failed');
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      return {};
    });
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          setRoomsChangedListener: vi.fn(),
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    try {
      expect(coordinator.needsFastReconcile()).toBe(false);
      await coordinator.applyMembershipEvent({
        roomId: 'corner-1',
        parentRoomId: 'room-1',
        openedBy: identityFromKey('11'.repeat(32), 'Bee').publicKey,
      });
      expect(coordinator.activeRoomIds()).not.toContain('corner-1');
      expect(coordinator.needsFastReconcile()).toBe(true);
    } finally {
      await coordinator.shutdown();
      vi.restoreAllMocks();
    }
  });

  it('serves a pushed Room before a repository lookup can fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-failed-apply-'));
    roots.push(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomRepositoryState') throw new Error('index.lock held by a sibling');
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getWorkspaceRoster') return { members: [] };
      return {};
    });
    let membership: ((event?: RoomMembershipChange) => void) | undefined;
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          setRoomsChangedListener: (listener: (event?: RoomMembershipChange) => void) => {
            membership = listener;
          },
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    try {
      expect(coordinator.needsFastReconcile()).toBe(false);
      membership?.({ roomId: 'room-1' });
      await vi.waitFor(() => expect(coordinator.activeRoomIds()).toContain('room-1'));
      expect(coordinator.needsFastReconcile()).toBe(false);
      expect(execute).not.toHaveBeenCalledWith('getRoomRepositoryState', { roomId: 'room-1' });
    } finally {
      await coordinator.shutdown();
      vi.restoreAllMocks();
    }
  });

  it('arms the recovery reconcile when a pushed Room start fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-failed-start-'));
    roots.push(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute: vi.fn(),
          setRoomsChangedListener: vi.fn(),
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    const startRoom = vi.spyOn(coordinator as never, 'startRoom').mockRejectedValueOnce(new Error('startup failed'));
    try {
      coordinator['queueMembershipEvent']({ roomId: 'room-1' });
      await vi.waitFor(() => expect(coordinator.needsFastReconcile()).toBe(true));
      expect(startRoom).toHaveBeenCalledWith('room-1');
      expect(coordinator.activeRoomIds()).not.toContain('room-1');
    } finally {
      await coordinator.shutdown();
      vi.restoreAllMocks();
    }
  });

  it('shutdown waits for a pushed apply instead of leaving its Room running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-shutdown-'));
    roots.push(root);
    let releaseCheckout!: () => void;
    const checkoutGate = new Promise<void>((release) => {
      releaseCheckout = release;
    });
    let checkoutStarted!: () => void;
    const startInFlight = new Promise<void>((started) => {
      checkoutStarted = started;
    });
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getWorkspaceRoster') return { members: [] };
      return {};
    });
    let membership: ((event?: RoomMembershipChange) => void) | undefined;
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute,
          setRoomsChangedListener: (listener: (event?: RoomMembershipChange) => void) => {
            membership = listener;
          },
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    vi.spyOn(coordinator as never, 'grantRunnerEndpoint').mockImplementation(async () => {
      checkoutStarted();
      await checkoutGate;
      return undefined;
    });
    // A pushed apply runs outside the run loop's signal, so a Room whose start
    // is in flight when shutdown begins must still be stopped by it.
    membership?.({ roomId: 'room-1' });
    await startInFlight;
    let settled = false;
    const stopping = coordinator.shutdown().then(() => {
      settled = true;
    });
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    expect(settled).toBe(false);
    releaseCheckout();
    await stopping;
    expect(coordinator.activeRoomIds()).toEqual([]);
    // And a push arriving after shutdown starts nothing at all.
    membership?.({ roomId: 'room-2' });
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    expect(execute).not.toHaveBeenCalledWith('getAgentCommands', { roomId: 'room-2' });
  });

  it('bounds the wait for a stalled pushed apply and drops what it started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-shutdown-deadline-'));
    roots.push(root);
    let releaseCheckout!: () => void;
    const checkoutGate = new Promise<void>((release) => {
      releaseCheckout = release;
    });
    let checkoutStarted!: () => void;
    const startInFlight = new Promise<void>((started) => {
      checkoutStarted = started;
    });
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      if (name === 'getRoomInbox') return { items: [], cursor: 'latest' };
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getWorkspaceRoster') return { members: [] };
      return {};
    });
    let membership: ((event?: RoomMembershipChange) => void) | undefined;
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        drainDeadlineMs: 20,
        daemonApi: {
          execute,
          setRoomsChangedListener: (listener: (event?: RoomMembershipChange) => void) => {
            membership = listener;
          },
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    vi.spyOn(coordinator as never, 'grantRunnerEndpoint').mockImplementation(async () => {
      checkoutStarted();
      await checkoutGate;
      return undefined;
    });
    // A stalled local endpoint start must not hold shutdown past the drain
    // deadline, and the Room it was starting must never end up running.
    membership?.({ roomId: 'room-1' });
    await startInFlight;
    await coordinator.shutdown();
    expect(coordinator.activeRoomIds()).toEqual([]);
    releaseCheckout();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('getAgentCommands', expect.anything()));
    expect(coordinator.activeRoomIds()).toEqual([]);
  });

  it('an unscoped rooms-changed still arms the recovery reconcile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-unscoped-'));
    roots.push(root);
    let membership: ((event?: RoomMembershipChange) => void) | undefined;
    const coordinator = new RoomRuntimeCoordinator(
      runtimeAt(root),
      join(root, 'agent.json'),
      { workspaceRoot: root } as never,
      {
        daemonApi: {
          execute: vi.fn(),
          setRoomsChangedListener: (listener: (event?: RoomMembershipChange) => void) => {
            membership = listener;
          },
          setCornerCompleteListener: vi.fn(),
          setConfigChangedListener: vi.fn(),
        } as unknown as DaemonApiClient,
      },
    );
    try {
      expect(coordinator.needsFastReconcile()).toBe(false);
      membership?.();
      expect(coordinator.needsFastReconcile()).toBe(true);
    } finally {
      await coordinator.shutdown();
    }
  });
});
