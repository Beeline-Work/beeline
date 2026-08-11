import type { Agent } from '@beeline/buzz-client';

const QUALITIES = [
  'Quiet',
  'Steady',
  'Silver',
  'Patient',
  'Keen',
  'Brisk',
  'True',
  'Still',
  'Swift',
  'Clear',
  'Deep',
  'Bright',
] as const;

const ROLES = [
  'Warden',
  'Scout',
  'Weaver',
  'Keeper',
  'Mason',
  'Pilot',
  'Smith',
  'Ranger',
  'Tinker',
  'Navigator',
  'Builder',
  'Sentry',
] as const;

export type AgentDisplayIdentity = {
  name: string;
  personality: string;
  avatarSeed: string;
  avatarUrl?: string;
  hasSoul: boolean;
};

/** FNV-1a is sufficient for stable presentation and carries no authority. */
function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Stable, friendly fallback with no raw-key fragments or acronym treatment. */
export function fallbackAgentName(pubkey: string): string {
  const hash = hash32(pubkey || 'unknown-agent');
  const quality = QUALITIES[hash % QUALITIES.length];
  const role = ROLES[(hash >>> 8) % ROLES.length];
  return `${quality} ${role}`;
}

/**
 * Resolve display-only identity. Human-authored overlays win; absent overlays
 * fall back to pubkey-derived copy and monochrome geometry. Nothing returned
 * here participates in role, approval, merge, or gate decisions.
 */
export function resolveAgentDisplayIdentity(
  pubkey: string,
  agent?: Pick<Agent, 'pubkey' | 'avatar' | 'soulProfile'> | null,
): AgentDisplayIdentity {
  const overlay = agent?.soulProfile;
  const overlayName = overlay?.name.trim();
  const overlayPersonality = overlay?.personality.trim();
  const avatarUrl = agent?.avatar?.trim();
  return {
    name: overlayName || fallbackAgentName(pubkey),
    personality: overlayPersonality || 'Steady, practical, and ready to help.',
    avatarSeed: overlay?.avatarSeed.trim() || pubkey || 'unknown-agent',
    ...(avatarUrl ? { avatarUrl } : {}),
    hasSoul: Boolean(overlayName),
  };
}
