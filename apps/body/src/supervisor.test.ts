import { afterEach, describe, expect, it, vi } from 'vitest';
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

import { WorkspaceSupervisor } from './supervisor.js';

afterEach(() => {
  vi.restoreAllMocks();
  mocks.createBuzzClient.mockReset();
});

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

describe('WorkspaceSupervisor unbound channel policy', () => {
  function runtimeWithExistingRepo(): AgentRuntimeRecord {
    const agent = storedIdentity('policy-agent');
    const body = storedIdentity('policy-body');
    return {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'a'.repeat(64),
      agent: agent.stored,
      body: body.stored,
      rooms: [
        {
          channelId: 'oldest-repository-room',
          repo: { root: '/tmp/oldest-repo' } as never,
          membershipSince: 10,
          discoveredAt: new Date(0).toISOString(),
        },
      ],
      supervisorRoot: '/tmp/beeline-policy-test',
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };
  }

  it('serves a DM as strictly read-only without borrowing an existing repository Room', async () => {
    const runtime = runtimeWithExistingRepo();
    const disconnect = vi.fn();
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi
        .fn()
        .mockResolvedValue([{ channelId: 'dm-channel', event: { created_at: 20 } }]),
      getChannelCommunityId: vi.fn().mockResolvedValue(runtime.communityId),
      getParentChannelId: vi.fn().mockResolvedValue(null),
      getChannelRepositoryBinding: vi.fn().mockResolvedValue(null),
      getDirectMessage: vi.fn().mockResolvedValue({
        participants: [runtime.agent.publicKey, 'b'.repeat(64)],
      }),
      disconnect,
    });
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const startConversation = vi
      .spyOn(supervisor as never, 'startConversationRoom' as never)
      .mockImplementation(() => undefined as never);
    const startRepository = vi
      .spyOn(supervisor as never, 'startRepositoryRoom' as never)
      .mockImplementation(() => undefined as never);

    await expect(supervisor.reconcile()).resolves.toBe(true);

    expect(startConversation).toHaveBeenCalledWith('dm-channel', 'direct-message');
    expect(startRepository).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('serves an ordinary repo-less Room with named-repository corner capability', async () => {
    const runtime = runtimeWithExistingRepo();
    mocks.createBuzzClient.mockReturnValue({
      isMember: vi.fn().mockResolvedValue(true),
      listMyChannels: vi
        .fn()
        .mockResolvedValue([{ channelId: 'repo-less-room', event: { created_at: 20 } }]),
      getChannelCommunityId: vi.fn().mockResolvedValue(runtime.communityId),
      getParentChannelId: vi.fn().mockResolvedValue(null),
      getChannelRepositoryBinding: vi.fn().mockResolvedValue(null),
      getDirectMessage: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn(),
    });
    const supervisor = new WorkspaceSupervisor(
      runtime,
      `/tmp/beeline/agents/${runtime.agent.publicKey}/runtime.json`,
      {} as BodyConfig,
    );
    const startConversation = vi
      .spyOn(supervisor as never, 'startConversationRoom' as never)
      .mockImplementation(() => undefined as never);

    await expect(supervisor.reconcile()).resolves.toBe(true);

    expect(startConversation).toHaveBeenCalledWith('repo-less-room', 'named-repository');
  });
});
