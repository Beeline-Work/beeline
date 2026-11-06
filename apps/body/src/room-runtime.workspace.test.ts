import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandActivationInput, CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import type { CommandExecutionContext } from './server-command-intake.js';

type RoomInternals = {
  commandContext: CommandExecutionContext;
  commandActivation(): Promise<CommandActivationSnapshot>;
};

const roots: string[] = [];
const coordinators: RoomRuntimeCoordinator[] = [];

afterEach(async () => {
  await Promise.all(coordinators.splice(0).map(coordinator => coordinator.shutdown()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function startRoom(workspaceId: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-room-workspace-'));
  roots.push(root);
  const agent = identityFromKey('11'.repeat(32), 'Bee');
  const source = { connectionId: 'connection', epoch: 1 };
  const readCommandActivation = vi.fn(async (input: CommandActivationInput): Promise<CommandActivationSnapshot> => ({
    ...input, v: 1, capturedAt: Date.now() / 1000,
    authority: { generation: 'a'.repeat(32), revision: 1, commandRevision: 'b'.repeat(64) },
    configuration: { commands: [], yoloMode: false, isReviewer: false },
    roster: { members: [] }, grants: { grants: [] }, repository: { resolution: 'none' },
  }));
  const execute = vi.fn(async (name: string) => {
    if (name === 'getRoomAuthority') return { workspaceId, member: true, archived: false };
    throw new Error(`unexpected operation ${name}`);
  });
  let room!: RoomInternals;
  vi.spyOn(MonolithRoomTurnLoop.prototype, 'run').mockImplementation(function () {
    room = this as unknown as RoomInternals;
    const signal = (this as unknown as { options: { signal: AbortSignal } }).options.signal;
    return new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
  });
  const coordinator = new RoomRuntimeCoordinator({
    agent: { name: agent.name, publicKey: agent.publicKey, secretKeyHex: '11'.repeat(32) },
    rooms: [], communityId: 'pairing-workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
  } as AgentRuntimeRecord, resolve(root, 'agent.json'), { workspaceRoot: root } as BodyConfig, {
    daemonApi: {
      execute, readCommandActivation,
      channel: { isOpen: () => true,
        activationScope: () => ({ origin: 'https://server.example', source, generation: 1 }) },
    } as unknown as DaemonApiClient,
  });
  coordinators.push(coordinator);
  const internal = coordinator as unknown as {
    grantRunnerEndpoint(): Promise<undefined>;
    startRoom(roomId: string): Promise<void>;
  };
  vi.spyOn(internal, 'grantRunnerEndpoint').mockResolvedValue(undefined);
  await internal.startRoom('room');
  room.commandContext.current = { id: 'command' } as CommandExecutionContext['current'];
  return { room, execute, readCommandActivation, agentId: agent.publicKey };
}

describe('Room activation Workspace', () => {
  it.each(['pairing-workspace', 'other-workspace'])('uses the server Room Workspace %s for command activation', async workspaceId => {
    const { room, execute, readCommandActivation, agentId } = await startRoom(workspaceId);
    await expect(room.commandActivation()).resolves.toMatchObject({ workspaceId, roomId: 'room' });
    expect(execute).toHaveBeenCalledWith('getRoomAuthority', { roomId: 'room', principalId: agentId });
    expect(readCommandActivation).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, roomId: 'room', agentId }));
  });

  it('preserves server activation membership refusals', async () => {
    const { room, readCommandActivation } = await startRoom('other-workspace');
    readCommandActivation.mockRejectedValue(new Error('Activation context refused'));
    await expect(room.commandActivation()).rejects.toThrow('Activation context refused');
    expect(readCommandActivation).toHaveBeenCalledTimes(1);
  });
});
