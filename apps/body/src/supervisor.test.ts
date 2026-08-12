import { describe, expect, it, vi } from 'vitest';
import { newIdentity } from '@beeline/gate';
import type { BodyConfig } from './config.js';
import type { AgentRuntimeRecord } from './runtime.js';

const mocks = vi.hoisted(() => ({
  createBuzzClient: vi.fn(),
}));

vi.mock('@beeline/buzz-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@beeline/buzz-client')>()),
  createBuzzClient: mocks.createBuzzClient,
}));

import { directMessageRepositoryRoom, WorkspaceSupervisor } from './supervisor.js';

function storedIdentity(name: string) {
  const identity = newIdentity(name);
  return {
    identity,
    stored: {
      name,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
      publicKey: identity.publicKey,
    },
  };
}

describe('WorkspaceSupervisor removal lease', () => {
  it('returns agent-removed when the Workspace membership projection drops the agent', async () => {
    const agent = storedIdentity('agent');
    const body = storedIdentity('body');
    const disconnect = vi.fn();
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(false),
      disconnect,
    });
    const runtime: AgentRuntimeRecord = {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [],
      supervisorRoot: '/tmp/beeline-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${agent.identity.publicKey}/runtime.json`,
      {} as BodyConfig,
    );

    await expect(supervisor.run({ pollMs: 1 })).resolves.toBe('agent-removed');
    expect(supervisor.activeRoomIds()).toEqual([]);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe('WorkspaceSupervisor direct messages', () => {
  it('uses the oldest paired repository Room as stable DM context', () => {
    const older = {
      channelId: 'older',
      membershipSince: 10,
      discoveredAt: new Date(0).toISOString(),
      repo: {} as never,
    };
    const newer = {
      channelId: 'newer',
      membershipSince: 20,
      discoveredAt: new Date(0).toISOString(),
      repo: {} as never,
    };
    expect(directMessageRepositoryRoom({ rooms: [newer, older] })).toBe(older);
    expect(directMessageRepositoryRoom({ rooms: [] })).toBeUndefined();
  });
});
