import { agentHandle, fallbackAgentName, resolveAgentName, type Agent } from '@beeline/buzz-client';

export { fallbackAgentName };

export type AgentDisplayIdentity = {
  name: string;
  handle: string;
  personality: string;
  avatarSeed: string;
  avatarUrl?: string;
  hasSoul: boolean;
  /**
   * The creature the SERVER assigned this agent (`identities.face_id`, via
   * `RoomViewIdentity.face`). Absent → the tile falls back to
   * `defaultFaceForSeed(pubkey)`.
   *
   * It has to travel with the name. An agent's animal is not decoration: the
   * server picks the first animal no member of the Workspace already wears
   * (`assignSeededAgentIdentity`) and derives the agent's NAME and SOUL from
   * that same animal — "Foxy the fox". The seed default is only a hash, so a
   * tile that drops the assigned face draws a whale beside the name Foxy, and
   * two agents in one Workspace can wear one creature the dedup existed to
   * prevent. Every surface already resolves the name through here; the face
   * rides along so both halves of one identity can never disagree.
   */
  face?: string;
};

/** What a surface must know about an agent to present it. Its `face` is the
 *  server's assignment, carried on the Room/Workspace view identity. */
export type DisplayableAgent = Pick<Agent, 'pubkey' | 'displayName' | 'avatar' | 'soulProfile'> & {
  face?: string;
  handle?: string;
};

/**
 * Resolve authority-free presentation from the agent's one self-signed
 * declaration. A soul may shape personality and artwork, but never supplies
 * a competing name or @handle.
 */
export function resolveAgentDisplayIdentity(
  pubkey: string,
  agent?: DisplayableAgent | null,
): AgentDisplayIdentity {
  const overlay = agent?.soulProfile;
  const name = resolveAgentName(agent?.displayName, pubkey);
  const overlayPersonality = overlay?.soul.trim();
  // Once a human soul exists, its absent avatar explicitly selects the generated mark.
  const avatarUrl = overlay ? overlay.avatar?.trim() : agent?.avatar?.trim();
  const face = agent?.face?.trim();
  return {
    name,
    // Keep the established call shape while a local mobile install may still
    // expose the previous two-argument declaration bundle.
    handle: agent?.handle?.trim() || agentHandle(name, pubkey),
    personality: overlayPersonality || 'Steady, practical, and ready to help.',
    avatarSeed: overlay?.avatarSeed.trim() || pubkey || 'unknown-agent',
    ...(avatarUrl ? { avatarUrl } : {}),
    hasSoul: Boolean(overlay),
    ...(face ? { face } : {}),
  };
}

/**
 * The transcript/corner-header identity while the roster is still loading.
 *
 * `resolveAgentDisplayIdentity` always resolves to *some* confident name —
 * that is correct once the roster has loaded and simply found nothing, but
 * calling it before the roster read has even completed shows the identical
 * fallback placeholder for a beat, then visibly snaps to the
 * real registered/soul name ("Beebee") once hydration lands. A wrong name
 * that corrects itself reads worse than showing nothing: this returns `null`
 * until `hydrated` is true, so callers fall back to a neutral placeholder
 * (a short handle) instead of a specific, momentarily-wrong one.
 */
export function resolvePendingAgentDisplay(
  pubkey: string,
  agent: DisplayableAgent | undefined,
  hydrated: boolean,
): AgentDisplayIdentity | null {
  return hydrated ? resolveAgentDisplayIdentity(pubkey, agent) : null;
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
