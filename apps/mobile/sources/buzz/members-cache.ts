import type { Agent, CommunityMember } from '@beeline/buzz-client';
import type { WorkspaceMemberDisplayItem } from '@/buzz/local-cache';

export type MembersCacheSeed = {
  agents: Agent[];
  people: CommunityMember[];
};

/**
 * Derive an instant, best-effort Members-screen roster from the same
 * Workspace roster cache the Room list already warms (`channelLists`'
 * `workspaceMembers`). Agents carry their full registered/soul data via
 * `peerAgent`; a person's role rides along when the cache entry that wrote it
 * already knew one — an entry written before that field existed falls back
 * to 'member', the least-privileged role, so a stale seed can only ever
 * under-grant, never over-grant, admin-gated actions until the real read
 * lands.
 */
export function seedMembersFromWorkspaceCache(
  members: readonly WorkspaceMemberDisplayItem[],
): MembersCacheSeed {
  const agents: Agent[] = [];
  const people: CommunityMember[] = [];
  for (const member of members) {
    if (member.peerKind === 'agent') {
      if (member.peerAgent) agents.push(member.peerAgent);
      continue;
    }
    people.push({ pubkey: member.peerPubkey, role: member.role ?? 'member' });
  }
  return { agents, people };
}
