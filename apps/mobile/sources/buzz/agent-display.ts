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
 * Resolve authority-free presentation. A valid human-authored first name wins;
 * legacy compound overlays safely fall back to the stable pubkey-derived name.
 */
export function resolveAgentDisplayIdentity(
  pubkey: string,
  agent?: Pick<Agent, 'pubkey' | 'avatar' | 'soulProfile'> | null,
): AgentDisplayIdentity {
  const overlay = agent?.soulProfile;
  const name = resolveAgentName(overlay?.name, pubkey);
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
