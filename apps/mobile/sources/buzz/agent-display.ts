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
