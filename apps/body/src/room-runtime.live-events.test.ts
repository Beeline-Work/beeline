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

  it('starts a Room once when two membership pushes race its checkout', async () => {
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
      expect(repositoryReads).toBe(1);
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

  it('arms the recovery reconcile when a pushed apply fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-failed-apply-'));
    roots.push(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomRepositoryState') throw new Error('index.lock held by a sibling');
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
      await vi.waitFor(() => expect(coordinator.needsFastReconcile()).toBe(true));
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
      if (name === 'getRoomRepositoryState') {
        checkoutStarted();
        await checkoutGate;
        return { resolution: 'none' };
      }
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
    expect(execute).not.toHaveBeenCalledWith('getRoomRepositoryState', { roomId: 'room-2' });
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
