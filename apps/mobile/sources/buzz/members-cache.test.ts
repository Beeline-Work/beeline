import { describe, expect, it } from 'vitest';
import type { Agent } from '@beeline/buzz-client';
import type { WorkspaceMemberDisplayItem } from '@/buzz/local-cache';

import { seedMembersFromWorkspaceCache } from './members-cache';

function agent(pubkey: string): Agent {
  return {
    agentId: `agent-${pubkey}`,
    communityId: 'workspace-1',
    pubkey,
    createdAt: 0,
  } as Agent;
}

describe('seedMembersFromWorkspaceCache', () => {
  it('splits a cached Workspace roster into agents and people', () => {
    const cachedAgent = agent('agent-pubkey');
    const members: WorkspaceMemberDisplayItem[] = [
      { peerPubkey: 'person-a', peerName: 'Alice', peerKind: 'person', role: 'owner' },
      { peerPubkey: 'person-b', peerName: 'Bob', peerKind: 'person', role: 'admin' },
      { peerPubkey: 'agent-pubkey', peerName: 'Sumo', peerKind: 'agent', peerAgent: cachedAgent },
    ];

    const seed = seedMembersFromWorkspaceCache(members);

    expect(seed.agents).toEqual([cachedAgent]);
    expect(seed.people).toEqual([
      { pubkey: 'person-a', role: 'owner' },
      { pubkey: 'person-b', role: 'admin' },
    ]);
  });

  it('defaults a person with no cached role to member, the least-privileged role', () => {
    const members: WorkspaceMemberDisplayItem[] = [
      { peerPubkey: 'person-a', peerName: 'Alice', peerKind: 'person' },
    ];

    expect(seedMembersFromWorkspaceCache(members).people).toEqual([
      { pubkey: 'person-a', role: 'member' },
    ]);
  });

  it('drops an agent entry that never carried its own Agent record', () => {
    const members: WorkspaceMemberDisplayItem[] = [
      { peerPubkey: 'agent-pubkey', peerName: 'Sumo', peerKind: 'agent' },
    ];

    expect(seedMembersFromWorkspaceCache(members).agents).toEqual([]);
  });

  it('returns empty lists for an empty roster', () => {
    expect(seedMembersFromWorkspaceCache([])).toEqual({ agents: [], people: [] });
  });
});
