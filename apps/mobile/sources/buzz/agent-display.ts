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
  const overlayPersonality = overlay?.soul.trim();
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
 * The transcript/corner-header identity while the roster is still loading.
 *
 * `resolveAgentDisplayIdentity` always resolves to *some* confident name —
 * that is correct once the roster has loaded and simply found nothing, but
 * calling it before the roster read has even completed shows the identical
 * pubkey-derived placeholder ("Alden") for a beat, then visibly snaps to the
 * real registered/soul name ("Beebee") once hydration lands. A wrong name
 * that corrects itself reads worse than showing nothing: this returns `null`
 * until `hydrated` is true, so callers fall back to a neutral placeholder
 * (a short handle) instead of a specific, momentarily-wrong one.
 */
export function resolvePendingAgentDisplay(
  pubkey: string,
  agent: Pick<Agent, 'pubkey' | 'displayName' | 'avatar' | 'soulProfile'> | undefined,
  hydrated: boolean,
): AgentDisplayIdentity | null {
  return hydrated ? resolveAgentDisplayIdentity(pubkey, agent) : null;
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
 * Whether this record can actually name its agent — a soul name, or a
 * registered displayName that is not the seed placeholder. Shared by the
 * Workspace-roster union above and the device-wide agent-name cache
 * (`agent-name-cache.ts`), which must apply identical rules.
 */
export function canIdentifyAgent(agent: NameableAgent): boolean {
  return namesItsAgent(agent);
}

/**
 * Fold rosters into one lookup, earlier rosters winning — per FIELD, not per
 * whole entry.
 *
 * A single physical agent can appear in more than one Workspace's roster with
 * a different piece of its identity known in each: a Workspace where it was
 * merely paired (registered, never given a soul) and the one Workspace where
 * a human actually authored its soul overlay. Picking one whole incoming
 * object per pubkey — the original approach — let whichever roster was
 * consulted first for that pubkey win outright, including its *absence* of a
 * soul, silently discarding a later roster's soulProfile even though nothing
 * else about the earlier roster's data was actually better. This is what
 * still showed the seed placeholder in the transcript: the pairing-only entry
 * (no soulProfile) from an earlier-consulted Workspace was kept in full, and
 * the later Workspace's `{ soulProfile: { name: 'Beebee' } }` was dropped
 * whole, never merged in.
 *
 * Once any roster supplies a soulProfile for a pubkey, later rosters can no
 * longer displace it — matching `agentRosterCommunityIds`' positional
 * precedence — but a soulProfile discovered on a *later* roster is always
 * carried onto the merged entry rather than lost with the rest of that
 * roster's (otherwise losing) object.
 */
export function mergeAgentRosters<T extends NameableAgent>(
  rosters: readonly (readonly T[])[],
): Map<string, T> {
  const merged = new Map<string, T>();
  for (const roster of rosters) {
    for (const agent of roster) {
      if (!agent?.pubkey) continue;
      const incumbent = merged.get(agent.pubkey);
      if (!incumbent) {
        merged.set(agent.pubkey, agent);
        continue;
      }
      if (incumbent.soulProfile) continue; // already has the best data available
      if (agent.soulProfile) {
        // Adopt the newly found soul. Never regress a real registered name
        // the incumbent already had down to this roster's own (possibly
        // placeholder) copy of the same field.
        merged.set(agent.pubkey, {
          ...agent,
          displayName: namesItsAgent(incumbent) ? incumbent.displayName : agent.displayName,
        });
        continue;
      }
      // Neither the incumbent nor this roster's entry carries a soul; let a
      // real registered name fill a placeholder gap.
      if (!namesItsAgent(incumbent) && namesItsAgent(agent)) {
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
