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

    const seed = seedMembersFromWorkspaceCache(members, undefined);

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

    expect(seedMembersFromWorkspaceCache(members, undefined).people).toEqual([
      { pubkey: 'person-a', role: 'member' },
    ]);
  });

  it('drops an agent entry that never carried its own Agent record', () => {
    const members: WorkspaceMemberDisplayItem[] = [
      { peerPubkey: 'agent-pubkey', peerName: 'Sumo', peerKind: 'agent' },
    ];

    expect(seedMembersFromWorkspaceCache(members, undefined).agents).toEqual([]);
  });

  it('returns empty lists for an empty roster', () => {
    expect(seedMembersFromWorkspaceCache([], undefined)).toEqual({ agents: [], people: [] });
  });
});


/**
 * The Workspace roster cache this seed reads is built for the Rooms screen,
 * where it answers "who ELSE is here" — `loadWorkspaceRoster` filters on
 * `member.pubkey !== viewerPubkey`, correctly, because nobody direct-messages
 * themselves. The Members directory asks who is IN the Workspace. Reusing one
 * derived list for both questions painted the reader out of their own
 * Workspace's membership, and in a Personal Workspace — where the owner is the
 * only person — out of the section entirely: "People 0 — No people in this
 * Workspace yet", shown to the sole member, who is also the owner.
 */
describe('the viewer belongs in their own Workspace', () => {
  it('seeds the sole member of a Personal Workspace instead of an empty list', () => {
    // Exactly what the cache holds for a Personal Workspace: the agent, and
    // no people at all, because the only person is the viewer.
    const cached = [
      {
        peerPubkey: 'lena-agent',
        peerKind: 'agent' as const,
        peerAgent: { pubkey: 'lena-agent', displayName: 'Lena' } as never,
      },
    ];
    expect(seedMembersFromWorkspaceCache(cached, undefined).people).toEqual([]);

    const seed = seedMembersFromWorkspaceCache(cached, { pubkey: 'owner' });
    expect(seed.people).toEqual([{ pubkey: 'owner', role: 'member' }]);
    expect(seed.agents).toHaveLength(1);
  });

  it('puts the viewer first, ahead of everyone else', () => {
    const seed = seedMembersFromWorkspaceCache(
      [{ peerPubkey: 'someone', peerKind: 'person' as const, role: 'member' as const }],
      { pubkey: 'owner', role: 'owner' },
    );
    expect(seed.people).toEqual([
      { pubkey: 'owner', role: 'owner' },
      { pubkey: 'someone', role: 'member' },
    ]);
  });

  it('never lists the viewer twice if a cache entry already has them', () => {
    const seed = seedMembersFromWorkspaceCache(
      [{ peerPubkey: 'owner', peerKind: 'person' as const, role: 'owner' as const }],
      { pubkey: 'owner' },
    );
    expect(seed.people).toEqual([{ pubkey: 'owner', role: 'owner' }]);
  });

  it('defaults an unknown viewer role to the least-privileged one', () => {
    // Same rule the cached entries follow: a seed may under-grant an
    // admin-gated action until the real read lands, never over-grant it.
    expect(seedMembersFromWorkspaceCache([], { pubkey: 'owner' }).people[0]!.role).toBe('member');
  });

  it('keeps an agent viewer out of the people list', () => {
    expect(seedMembersFromWorkspaceCache([], undefined).people).toEqual([]);
  });
});
