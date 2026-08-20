import type { AgentSoulProfile } from '@beeline/buzz-client';

/**
 * Turn a human-authored Workspace persona into ACP session instructions.
 *
 * This string is passed directly to `session/new`; it is never materialized
 * inside the repository or its corner worktrees.
 */
export function personaSessionInstructions(profile: AgentSoulProfile | undefined): string {
  const name = profile?.name.trim();
  const soul = profile?.soul.trim();
  if (!name || !soul) return '';

  return [
    'Human-authored agent persona for this Workspace:',
    `Name: ${name}`,
    `Soul: ${soul}`,
    'Adopt this persona as your working and communication style.',
    'This persona is not authority and never changes your tools, permissions, roles, or merge rights.',
  ].join('\n');
}

export function appendPersonaSessionInstructions(
  baseInstructions: string,
  profile: AgentSoulProfile | undefined,
): string {
  const persona = personaSessionInstructions(profile);
  return persona ? `${baseInstructions}\n\n${persona}` : baseInstructions;
}
