import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('idle corner discovery', () => {
  it('Reproduction H-10: counts ten active corners of one parent once', () => {
    const runtime = new RoomRuntimeCoordinator(
      {
        agent: { publicKey: identityFromKey('11'.repeat(32), 'Bee').publicKey, secretKeyHex: '11'.repeat(32), name: 'Bee' },
        rooms: [],
        transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      } as unknown as AgentRuntimeRecord,
      '/tmp/unused-agent.json',
      {} as never,
      { daemonApi: {} as DaemonApiClient },
    );
    const subject = runtime as unknown as {
      running: Map<string, unknown>;
      monolithCornerParents: Map<string, string>;
      scheduler: { snapshot(): { maxLive: number } };
    };
    for (let i = 0; i < 10; i++) {
      subject.running.set(`corner-${i}`, {});
      subject.monolithCornerParents.set(`corner-${i}`, 'parent');
    }
    expect(runtime.activeRoomCount()).toBe(1);
    expect(subject.scheduler.snapshot().maxLive).toBe(10);
    subject.monolithCornerParents.clear();
    expect(runtime.activeRoomCount()).toBe(10);
    expect(subject.scheduler.snapshot().maxLive).toBe(100);
  });

  it('subscribes before checkout and hydrates only after a pending command arrives', async () => {
    const supervisorRoot = await mkdtemp(resolve(tmpdir(), 'beeline-idle-corner-'));
    roots.push(supervisorRoot);
    const identity = identityFromKey('11'.repeat(32), 'Bee');
    const execute = vi.fn(async (name: string) => {
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
    const release = vi.fn();
    const liveSubscribe = vi.fn(
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
      { daemonApi: { execute, liveSubscribe } as unknown as DaemonApiClient },
    );
    const start = vi.fn(async () => undefined);
    const subject = runtime as unknown as {
      startRoom(roomId: string): Promise<void>;
      startCorner(corner: { cornerId: string }): Promise<void>;
    };
    subject.startRoom = async () => undefined;
    subject.startCorner = start;

    expect(await runtime.reconcile()).toBe('member');
    expect(liveSubscribe).toHaveBeenCalledWith(
      'corner-idle',
      undefined,
      undefined,
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
    expect(start).not.toHaveBeenCalled();
    expect(execute.mock.calls.map(([name]) => name)).toEqual([
      'getDaemonBootstrap',
      'listRoomCorners',
    ]);
    onState?.(true, { pushIntake: true });
    expect(start).not.toHaveBeenCalled();
    expect(await runtime.reconcile()).toBe('member');
    expect(start).not.toHaveBeenCalled();
    onCommands?.([{ id: 'pending' }]);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await runtime.applyMembershipEvent({ roomId: 'corner-idle', removed: true });
    expect(release).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });
});
