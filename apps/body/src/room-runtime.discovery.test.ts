import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiError, type DaemonApiClient } from './daemon-api-client.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function coordinator(
  execute: ReturnType<typeof vi.fn>,
  discovery = true,
  existingRoot?: string,
) {
  const supervisorRoot = existingRoot ?? (await mkdtemp(resolve(tmpdir(), 'beeline-discovery-')));
  if (!existingRoot) roots.push(supervisorRoot);
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const api = {
    execute,
    agentDiscoveryAvailable: () => discovery,
    updateAgentDiscoveryCursor: vi.fn(),
  } as unknown as DaemonApiClient;
  const runtime = new RoomRuntimeCoordinator(
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
    { daemonApi: api },
  );
  return { runtime, api, supervisorRoot };
}

describe('agent-scoped discovery compatibility', () => {
  it('uses a saved cursor after process restart and applies its durable delta', async () => {
    const initial = vi.fn(async (name: string) => {
      if (name === 'getAgentDiscoverySnapshot') {
        return { cursor: 'c1', workspaceIds: ['workspace'], rooms: [] };
      }
      throw new Error(`unexpected ${name}`);
    });
    const first = await coordinator(initial);
    expect(await first.runtime.reconcile()).toBe('member');
    await first.runtime.shutdown();

    const resumed = vi.fn(async (name: string, input: { after?: string }) => {
      if (name === 'getAgentDiscoveryChanges') {
        expect(input.after).toBe('c1');
        return { cursor: 'c2', changes: [], hasMore: false };
      }
      throw new Error(`unexpected ${name}`);
    });
    const second = await coordinator(resumed, true, first.supervisorRoot);
    expect(await second.runtime.reconcile()).toBe('member');
    expect(resumed).toHaveBeenCalledTimes(1);
    await second.runtime.shutdown();
  });

  it('starts snapshot corners without a per-parent list and applies only changed descriptors', async () => {
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentDiscoverySnapshot') {
        return {
          cursor: 'c1',
          workspaceIds: ['workspace'],
          rooms: [
            { roomId: 'room-1', archived: false, repositoryRevision: 'r1' },
            { roomId: 'corner-1', parentRoomId: 'room-1', archived: false, openedBy: 'opener' },
            { roomId: 'corner-old', parentRoomId: 'room-1', archived: true },
          ],
        };
      }
      if (name === 'getAgentDiscoveryChanges') {
        return {
          cursor: 'c2',
          changes: [
            { roomId: 'corner-1', parentRoomId: 'room-1', archived: true },
            { roomId: 'corner-2', parentRoomId: 'room-1', archived: false, openedBy: 'opener' },
          ],
          hasMore: false,
        };
      }
      throw new Error(`unexpected ${name}`);
    });
    const { runtime } = await coordinator(execute);
    const startedRooms: string[] = [];
    const startedCorners: string[] = [];
    const subject = runtime as unknown as {
      startRoom(id: string): Promise<void>;
      startCorner(corner: { cornerId: string }): Promise<void>;
    };
    subject.startRoom = async (id) => {
      startedRooms.push(id);
    };
    subject.startCorner = async (corner) => {
      startedCorners.push(corner.cornerId);
    };

    expect(await runtime.reconcile()).toBe('member');
    expect(startedRooms).toEqual(['room-1']);
    expect(startedCorners).toEqual(['corner-1']);
    expect(await runtime.reconcile()).toBe('member');
    expect(startedCorners).toEqual(['corner-1', 'corner-2']);
    expect(execute.mock.calls.map(([name]) => name)).toEqual([
      'getAgentDiscoverySnapshot',
      'getAgentDiscoveryChanges',
    ]);
    await runtime.shutdown();
  });

  it('applies Workspace tombstones from the cursor without legacy bootstrap reads', async () => {
    let delta = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentDiscoverySnapshot') {
        return { cursor: 'c1', workspaceIds: ['workspace'], rooms: [] };
      }
      if (name === 'getAgentDiscoveryChanges') {
        delta += 1;
        return delta === 1
          ? {
              cursor: 'c2',
              changes: [{ workspaceId: 'workspace', removed: true }],
              hasMore: false,
            }
          : { cursor: 'c3', changes: [], hasMore: false };
      }
      throw new Error(`unexpected ${name}`);
    });
    const { runtime, api } = await coordinator(execute);
    expect(await runtime.reconcile()).toBe('member');
    expect(await runtime.reconcile()).toBe('unknown');
    expect(await runtime.reconcile()).toBe('not-member');
    expect(execute.mock.calls.map(([name]) => name)).toEqual([
      'getAgentDiscoverySnapshot',
      'getAgentDiscoveryChanges',
      'getAgentDiscoveryChanges',
    ]);
    expect(api.updateAgentDiscoveryCursor).toHaveBeenLastCalledWith('c3');
    await runtime.shutdown();
  });

  it('refreshes an expired cursor with one complete snapshot', async () => {
    let snapshot = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentDiscoverySnapshot') {
        snapshot += 1;
        return { cursor: `c${snapshot}`, workspaceIds: ['workspace'], rooms: [] };
      }
      if (name === 'getAgentDiscoveryChanges') {
        throw new DaemonApiError('cursor expired', 410, false, 'cursor_expired');
      }
      throw new Error(`unexpected ${name}`);
    });
    const { runtime } = await coordinator(execute);
    expect(await runtime.reconcile()).toBe('member');
    expect(await runtime.reconcile()).toBe('member');
    expect(snapshot).toBe(2);
    await runtime.shutdown();
  });

  it('replaces local state when the server asks for a reset', async () => {
    let snapshot = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentDiscoverySnapshot') {
        snapshot += 1;
        return { cursor: `c${snapshot}`, workspaceIds: ['workspace'], rooms: [] };
      }
      if (name === 'getAgentDiscoveryChanges') {
        return { resetRequired: true, cursor: '', changes: [], hasMore: false };
      }
      throw new Error(`unexpected ${name}`);
    });
    const { runtime } = await coordinator(execute);
    expect(await runtime.reconcile()).toBe('member');
    expect(await runtime.reconcile()).toBe('member');
    expect(snapshot).toBe(2);
    await runtime.shutdown();
  });

  it('keeps old servers and mixed HTTP peers on legacy discovery', async () => {
    for (const discovery of [false, true]) {
      const execute = vi.fn(async (name: string) => {
        if (name === 'getAgentDiscoverySnapshot') {
          throw new DaemonApiError('not found', 404, false);
        }
        if (name === 'getDaemonBootstrap') {
          return { workspaceIds: ['workspace'], rooms: [] };
        }
        throw new Error(`unexpected ${name}`);
      });
      const { runtime } = await coordinator(execute, discovery);
      expect(await runtime.reconcile()).toBe('member');
      expect(execute.mock.calls.map(([name]) => name)).toEqual(
        discovery ? ['getAgentDiscoverySnapshot', 'getDaemonBootstrap'] : ['getDaemonBootstrap'],
      );
      await runtime.shutdown();
    }
  });
});
