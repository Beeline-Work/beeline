import { agentHandle, fallbackAgentName, resolveAgentName, type Agent } from '@beeline/buzz-client';

export { fallbackAgentName };

export type AgentDisplayIdentity = {
  name: string;
  handle: string;
  personality: string;
  avatarSeed: string;
  avatarUrl?: string;
  hasSoul: boolean;
};

/**
 * Resolve authority-free presentation. A valid human-authored soul overlay
 * name wins; otherwise the agent's own registered `displayName` wins; only
 * an agent with neither falls back to the stable pubkey-derived name.
 */
export function resolveAgentDisplayIdentity(
  pubkey: string,
  agent?: Pick<Agent, 'pubkey' | 'displayName' | 'avatar' | 'soulProfile'> | null,
): AgentDisplayIdentity {
  const overlay = agent?.soulProfile;
  const name = resolveAgentName(overlay?.name ?? agent?.displayName, pubkey);
  const overlayPersonality = overlay?.personality.trim();
  // Once a human soul exists, its absent avatar explicitly selects the generated mark.
  const avatarUrl = overlay ? overlay.avatar?.trim() : agent?.avatar?.trim();
  return {
    name,
    handle: agentHandle(name, pubkey),
    personality: overlayPersonality || 'Steady, practical, and ready to help.',
    avatarSeed: overlay?.avatarSeed.trim() || pubkey || 'unknown-agent',
    ...(avatarUrl ? { avatarUrl } : {}),
    hasSoul: Boolean(overlay && resolveAgentName(overlay.name, pubkey) === overlay.name.trim()),
  };
}

/**
 * Which Workspaces' agent rosters the transcript reads, in precedence order.
 *
 * Every agent name on screen comes from a roster: `listAgents(communityId)` is
 * what hydrates `Agent.displayName` and the human-authored `Agent.soulProfile`,
 * and `resolveAgentDisplayIdentity` falls back to the seed-derived placeholder
 * for any pubkey no roster contains. So an empty or wrong-Workspace roster does
 * not degrade the name — it replaces it with a confident fake.
 *
 * Reading exactly one community was the bug. Both halves of the registration
 * are community-scoped — the identity record is published into the community
 * channel (`#h`) and the soul overlay is keyed `communityId:agentPubkey` — so a
 * transcript that resolves the wrong community, or none at all, sees no agents
 * whatsoever. A Room whose kind:9007 predates the redundant `community` tag, a
 * local-only Room, a corner beneath either, or simply a Workspace other than
 * the one that authored the overlay all land there. That is why the transcript
 * showed a placeholder ("Alden") or a bare npub while the Members screen —
 * scoped to the viewer's own selected Workspace — showed the real soul name
 * ("Beebee") for the identical key.
 *
 * Reading every Workspace the viewer belongs to removes the guess. The order is
 * what keeps it honest: the channel's own Workspace names its agents first, the
 * viewer's selection next, and any other Workspace only fills a gap.
 */
export function agentRosterCommunityIds(
  channelCommunityId: string | null | undefined,
  viewerActiveCommunityId: string | null | undefined,
  memberCommunityIds: readonly string[] = [],
): string[] {
  const ordered = [channelCommunityId, viewerActiveCommunityId, ...memberCommunityIds];
  return [...new Set(ordered.filter((id): id is string => Boolean(id && id.trim())))];
}

type NameableAgent = Pick<Agent, 'pubkey' | 'displayName' | 'soulProfile'>;

/**
 * Whether this roster entry can actually name its agent, or is just a row.
 *
 * Pairing (`redeemAgentPairingCode`) registers every fresh agent with
 * `displayName: fallbackAgentName(pubkey)` — the identical seed placeholder
 * `resolveAgentDisplayIdentity` would produce with no roster entry at all.
 * Treating that as "named" defeats the whole point of the gap-filling merge
 * below: an agent registered (but never given a soul) in one Workspace the
 * viewer belongs to would permanently lock in its own placeholder and block a
 * later Workspace's real soul name for the same pubkey from ever winning.
 */
function namesItsAgent(agent: NameableAgent): boolean {
  if (agent.soulProfile?.name?.trim()) return true;
  const displayName = agent.displayName?.trim();
  return Boolean(displayName) && displayName !== fallbackAgentName(agent.pubkey);
}

/**
 * Fold rosters into one lookup, earlier rosters winning.
 *
 * Precedence is positional (see `agentRosterCommunityIds`), with one override:
 * an entry that cannot name its agent never blocks a later one that can. The
 * merge is safe by construction — an entry is only ever consulted for a pubkey
 * equal to the message signer's, so a roster from another Workspace cannot
 * rename anybody; it can only supply an overlay the app already had and the
 * transcript was missing.
 */
export function mergeAgentRosters<T extends NameableAgent>(
  rosters: readonly (readonly T[])[],
): Map<string, T> {
  const merged = new Map<string, T>();
  for (const roster of rosters) {
    for (const agent of roster) {
      if (!agent?.pubkey) continue;
      const incumbent = merged.get(agent.pubkey);
      if (!incumbent || (!namesItsAgent(incumbent) && namesItsAgent(agent))) {
        merged.set(agent.pubkey, agent);
      }
    }
  }
  return merged;
}

/**
 * A corner-status card's `agentPubkey` is declared data (an `agent` tag on
 * the body-control event) and can miss the registered-agent roster even when
 * the event's own signer is a known agent — e.g. a stale/legacy tag. Prefer
 * whichever candidate actually resolves to a registered agent, so the card
 * never falls back to a generated placeholder name when the corner's own
 * transcript (which always resolves messages by their signer pubkey) knows
 * exactly who this is.
 */
export function resolveCornerCardAgentPubkey(
  declaredAgentPubkey: string | undefined,
  messageSignerPubkey: string | undefined,
  isRegisteredAgent: (pubkey: string) => boolean,
): string | undefined {
  if (declaredAgentPubkey && isRegisteredAgent(declaredAgentPubkey)) return declaredAgentPubkey;
  if (messageSignerPubkey && isRegisteredAgent(messageSignerPubkey)) return messageSignerPubkey;
  return declaredAgentPubkey ?? messageSignerPubkey;
}
