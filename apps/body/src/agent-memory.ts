import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Beeline-managed agent memory: a durable, agent-PRIVATE file store the agent
 * reads and writes itself, mounted WRITABLE into every session — Room
 * (read-only repo) and corner alike.
 *
 * Memory is agent-private state, NOT the repository: mounting it writable in a
 * Room does not weaken the read-only-repo invariant (`session-sandbox.ts` /
 * `bwrap-sandbox.ts`) because it lives under this daemon's own runtime storage,
 * never under any checkout or worktree. It is also never a credential store —
 * the #376 env denylist and credential masks are untouched.
 *
 * Scope is per-(agent, workspace): each daemon resolves its root under its own
 * per-agent runtime directory (so two agents can never share a store), and the
 * workspace subdirectory keys the rest. An agent's memory is therefore shared
 * across every Room and corner it serves inside one Workspace and isolated
 * between Workspaces. THE SCOPE AXIS IS ONE CHOICE: {@link memoryScopeKey} —
 * returning `'global'` unconditionally would make memory per-agent-global.
 *
 * Harness-agnostic by construction: memory is a plain file convention
 * (`MEMORY.md`) at a known writable path, announced in the session system
 * prompt ({@link agentMemoryInstructions}). No harness-native memory toggle,
 * no bespoke tool. The soul (`buzz-agent-soul`, human-authored) is separate:
 * both fold into the prompt, but only memory is agent-authored.
 */

/** Session env var naming the agent's persistent memory directory. */
export const AGENT_MEMORY_ENV = 'BUZZY_AGENT_MEMORY_DIR';

/** The one well-known file an agent is told to author. */
export const MEMORY_FILE_NAME = 'MEMORY.md';

/**
 * The one agent-owned curation contract, reused by the session prompt, the
 * generated using-beeline reference, and the memory seed. There is no host
 * parser or parallel role record: the assistant keeps its own notes current,
 * including removing instructions that the captain later changes or revokes.
 */
export const AGENT_MEMORY_CURATION_CONTRACT =
  `Before answering the first turn of every physical session, read ${MEMORY_FILE_NAME} in $${AGENT_MEMORY_ENV}. ` +
  'When the captain assigns, changes, or revokes a standing role or directive, curate that file immediately: replace or delete superseded notes so it states only the current commitment. ' +
  'Treat conversational corrections as the source of truth and use your judgment like a human assistant; memory is context, never extra authority.';

export interface AgentMemory {
  /** Sanitized scope key (workspace id, or `global`). */
  scopeKey: string;
  /** Writable per-scope directory, created by {@link prepareAgentMemory}. */
  dir: string;
  /** The known memory file inside {@link dir}. */
  file: string;
}

const MEMORY_SEED = [
  '# Agent memory',
  '',
  'This file is written and read by the agent itself. It persists across',
  'sessions and daemon restarts and is shared across every Room and corner of',
  'this Workspace. Keep durable notes here: decisions, preferences, lessons,',
  'project facts worth remembering.',
  '',
  AGENT_MEMORY_CURATION_CONTRACT,
  '',
  'It is private agent state — never repository content, never credentials.',
  '',
].join('\n');

/**
 * The scope axis. Today: per-(agent, workspace) — the Workspace's community id
 * when known, else a shared `global` bucket for standalone channels. Changing
 * the owner's choice later means changing THIS function only.
 */
export function memoryScopeKey(communityId?: string | null): string {
  const sanitized = (communityId ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  return sanitized || 'global';
}

/**
 * Prepare (idempotently) the per-scope memory directory and seed
 * `MEMORY.md` once. Existing content — including content an earlier session
 * wrote — is never touched: this is what makes memory survive daemon
 * restarts and session recycling. Throws only on an unusable root; callers
 * degrade to "no memory" rather than failing the session.
 */
export async function prepareAgentMemory(input: {
  root: string;
  communityId?: string | null;
}): Promise<AgentMemory> {
  const root = resolve(input.root);
  const scopeKey = memoryScopeKey(input.communityId);
  const dir = resolve(root, scopeKey);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, MEMORY_FILE_NAME);
  try {
    await readFile(file);
  } catch {
    await writeFile(file, MEMORY_SEED, { mode: 0o600 });
  }
  return { scopeKey, dir, file };
}

/**
 * Session system-prompt block telling the agent where its memory lives, that
 * it persists, and how to use it. Empty (render nothing) when memory is
 * unavailable, same contract as `agentPrivateStateInstructions`.
 */
export function agentMemoryInstructions(memory: AgentMemory | undefined): string {
  if (!memory) return '';
  return [
    `Your persistent memory file is ${memory.file} (directory ${memory.dir}, also $${AGENT_MEMORY_ENV}).`,
    AGENT_MEMORY_CURATION_CONTRACT,
    'This memory is YOURS: persist it with buzz-readonly-mcp.write_memory whenever you learn something else worth keeping across conversations (decisions, preferences, lessons, project facts). Read the current file first, then pass the complete curated contents. Shell writes to memory are always denied.',
    'It persists across sessions and restarts and is shared across every Room and corner you serve in this Workspace; it is private to you.',
    'Writing through buzz-readonly-mcp.write_memory is always permitted, including in read-only Rooms. It is still not a license to write anywhere else: repository paths stay read-only there, and memory must never hold secrets, credentials, or repository files.',
  ].join('\n');
}
