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
 *
 * **The cache deliberately omits the viewer, and this screen must not.** That
 * roster is built for the Rooms screen, where it answers "who else is here" —
 * so `loadWorkspaceRoster` filters on `member.pubkey !== viewerPubkey`
 * (`channels.tsx`), correctly, because nobody direct-messages themselves. The
 * Members directory asks a different question: who is IN this Workspace. Two
 * consumers, one derived list, opposite requirements — and reusing it here
 * painted the reader out of their own Workspace's membership. In a Personal
 * Workspace, where the owner is the only person, that is the whole section:
 * "People 0 — No people in this Workspace yet", shown to the sole member.
 *
 * `viewer` is therefore required rather than optional: the omission is a
 * property of the input, so every caller has to say who was left out. Passing
 * `undefined` is the explicit way to say "the viewer is an agent identity, not
 * a person in this list".
 */
export function seedMembersFromWorkspaceCache(
  members: readonly WorkspaceMemberDisplayItem[],
  viewer: { pubkey: string; role?: CommunityMember['role'] } | undefined,
): MembersCacheSeed {
  const agents: Agent[] = [];
  const people: CommunityMember[] = [];
  // First, so the reader sees themself at the top of their own Workspace
  // rather than appended after everyone else.
  if (viewer?.pubkey && !members.some((member) => member.peerPubkey === viewer.pubkey)) {
    people.push({ pubkey: viewer.pubkey, role: viewer.role ?? 'member' });
  }
  for (const member of members) {
    if (member.peerKind === 'agent') {
      if (member.peerAgent) agents.push(member.peerAgent);
      continue;
    }
    people.push({ pubkey: member.peerPubkey, role: member.role ?? 'member' });
  }
  return { agents, people };
}
