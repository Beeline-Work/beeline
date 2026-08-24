import type { AgentSoulProfile } from '@beeline/buzz-client';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';

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

/**
 * The per-turn persona prefix for a session, or `undefined` when the harness
 * honors `session/new`'s `systemPrompt` (where `appendPersonaSessionInstructions`
 * already delivered it) or no persona is set.
 *
 * codex-acp and pi-acp drop the session `systemPrompt` entirely (measured
 * against their distributions — neither references the field), which is how a
 * set soul reached every surface EXCEPT the agent's own prompt. Turn message
 * content is the one channel no adapter can ignore, so harnesses that fail the
 * probe get the persona re-sent at the top of every turn instead.
 */
export function personaTurnPrefixForHarness(
  profile: AgentSoulProfile | undefined,
  agentCommand: string | undefined,
): string | undefined {
  const persona = personaSessionInstructions(profile);
  if (!persona) return undefined;
  return harnessHonorsSessionSystemPrompt(agentCommand) ? undefined : persona;
}
