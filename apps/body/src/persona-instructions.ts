import type { AgentSoulProfile } from '@beeline/buzz-client';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeIsolatedHarnessFile } from './agent-home.js';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';

const MANAGED_PERSONA_HEADER = '<!-- Beeline-managed Workspace persona. -->';

interface NativePersonaTarget {
  home: 'claude' | 'codex' | 'grok';
  file: 'AGENTS.md' | 'CLAUDE.md';
}

/**
 * Native, user-scope instruction file each verified harness discovers when its
 * isolated config home is active. These paths are adapter/runtime contracts:
 * Codex reads the global `$CODEX_HOME/AGENTS.md`, Claude reads
 * `$CLAUDE_CONFIG_DIR/CLAUDE.md`, and Grok scans `$GROK_HOME/AGENTS.md` before
 * repository rules. pi-acp has no isolated home/native instruction contract,
 * so it deliberately falls through to per-turn delivery.
 */
function nativePersonaTarget(agentCommand: string | undefined): NativePersonaTarget | undefined {
  if (!agentCommand) return undefined;
  if (/(^|[/\\])codex-acp(\.[a-z]+)?$/i.test(agentCommand)) {
    return { home: 'codex', file: 'AGENTS.md' };
  }
  if (/(^|[/\\])claude-(agent|code)-acp(\.[a-z]+)?$/i.test(agentCommand)) {
    return { home: 'claude', file: 'CLAUDE.md' };
  }
  if (/(^|[/\\])grok(\.[a-z]+)?$/i.test(agentCommand)) {
    return { home: 'grok', file: 'AGENTS.md' };
  }
  return undefined;
}

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

/**
 * The rendered name and @handle come from the daemon-refreshed agent
 * declaration. Keep this separate from the human-authored persona so every
 * harness receives the same addressing fact, even without a soul.
 */
export function renderedAgentIdentityInstructions(name: string, handle: string): string {
  return [
    `Your Beeline Room identity is ${name} (@${handle}).`,
    `A message mentioning @${handle} is addressed to you. Answer it; never decline because a local runtime label differs.`,
  ].join('\n');
}

export function appendPersonaSessionInstructions(
  baseInstructions: string,
  profile: AgentSoulProfile | undefined,
  nativeInstructionsPrepared = false,
): string {
  if (nativeInstructionsPrepared) return baseInstructions;
  const persona = personaSessionInstructions(profile);
  return persona ? `${baseInstructions}\n\n${persona}` : baseInstructions;
}

/**
 * Materialize the Workspace persona in a verified harness's native global
 * instruction file. The root is always Beeline's per-Room agent home, never
 * the operator's real home. Returns true only after the file is safely on
 * disk, so any write failure automatically keeps the older session/per-turn
 * delivery path alive.
 */
export async function prepareNativePersonaInstructions(input: {
  agentHomeRoot: string | undefined;
  agentCommand: string | undefined;
  profile: AgentSoulProfile | undefined;
}): Promise<boolean> {
  const target = nativePersonaTarget(input.agentCommand);
  if (!input.agentHomeRoot || !target) return false;

  const path = resolve(input.agentHomeRoot, target.home, target.file);
  const persona = personaSessionInstructions(input.profile);
  if (!persona) {
    await removeManagedPersonaFile(path);
    return false;
  }

  try {
    await writeIsolatedHarnessFile(path, `${MANAGED_PERSONA_HEADER}\n\n${persona}\n`);
    return true;
  } catch (error) {
    console.warn(`[body] native persona instructions unavailable at ${path}:`, error);
    return false;
  }
}

async function removeManagedPersonaFile(path: string): Promise<void> {
  try {
    const current = await readFile(path, 'utf8');
    if (current.startsWith(MANAGED_PERSONA_HEADER)) await unlink(path);
  } catch {
    // Missing/unreadable is already the desired no-persona state.
  }
}

/**
 * The per-turn persona prefix for a session, or `undefined` when native
 * instructions or ACP `session/new` already delivered it, or no persona is
 * set.
 *
 * codex-acp and pi-acp drop the session `systemPrompt` entirely (measured
 * against their distributions — neither references the field), which is how a
 * set soul reached every surface EXCEPT the agent's own prompt. Turn message
 * content is the one channel no adapter can ignore, so harnesses that have
 * neither delivery path get the persona re-sent at the top of every turn.
 */
export function personaTurnPrefixForHarness(
  profile: AgentSoulProfile | undefined,
  agentCommand: string | undefined,
  nativeInstructionsPrepared = false,
): string | undefined {
  const persona = personaSessionInstructions(profile);
  if (!persona || nativeInstructionsPrepared) return undefined;
  return harnessHonorsSessionSystemPrompt(agentCommand) ? undefined : persona;
}
