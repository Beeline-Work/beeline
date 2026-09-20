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
      await coordinator.applyMembershipEvent({ roomId: 'room-1', operation: 'INSERT' });
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
        operation: 'INSERT',
      });
      await vi.waitFor(() => expect(coordinator.activeRoomIds()).toContain('corner-1'));
      expect(execute).not.toHaveBeenCalledWith('listRoomCorners', expect.anything());
      await coordinator.applyCornerComplete('corner-1');
      await vi.waitFor(() => expect(coordinator.activeRoomIds()).not.toContain('corner-1'));
    } finally {
      await coordinator.shutdown();
    }
  });

  it('does not start an archived corner a membership push inherited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-live-archived-'));
    roots.push(root);
    const execute = vi.fn(async (name: string) => {
      if (name === 'getCornerRestoreState')
        return {
          cornerId: 'corner-old',
          objective: 'Landed already',
          closeRequested: true,
          lane: 'code',
        };
      if (name === 'getRoomRepositoryState')
        return { resolution: 'repository', remote: 'https://github.example/x.git', key: 'x' };
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
        roomId: 'corner-old',
        parentRoomId: 'room-1',
        openedBy: identityFromKey('11'.repeat(32), 'Bee').publicKey,
        operation: 'INSERT',
      });
      expect(coordinator.activeRoomIds()).not.toContain('corner-old');
      expect(execute).not.toHaveBeenCalledWith('getRoomGitHubToken', expect.anything());
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
      await coordinator.applyMembershipEvent({
        roomId: 'corner-1',
        parentRoomId: 'room-1',
        operation: 'INSERT',
      });
      expect(coordinator.activeRoomIds()).not.toContain('corner-1');
      expect(execute).not.toHaveBeenCalled();
      expect(coordinator.needsFastReconcile()).toBe(true);
    } finally {
      await coordinator.shutdown();
    }
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
