/**
 * Per-room-instance harness state directories.
 *
 * Beeline isolates every Room and corner at its own layer — separate `Body`,
 * durable inbox, relay socket, presence record, ACP session and worktree — but
 * the ACP *child processes* all shared one `$HOME`, so an external harness
 * (`claude`, `codex`, `pi`, …) that keeps per-project state under its own home
 * directory could still remember another Room. That is below Beeline's
 * per-channel isolation and is the one plausible mechanism for real cross-room
 * context bleed.
 *
 * The captain's decision (D2 in the agent-instance scout report) is: **isolate
 * state, share credentials.** So `$HOME` itself is never overridden — harness
 * auth lives there and re-authenticating per Room is not acceptable — and only
 * the harness *state* directories are pointed at a per-room path. Credential
 * files are symlinked back into the isolated state dir so a login made once
 * keeps working in every Room, and a token refresh written through the link is
 * visible to every other Room.
 */
import { existsSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { AGENT_PRIVATE_STATE_ENV } from './agent-private-state.js';

/**
 * Credential files shared back into an isolated harness state directory,
 * keyed by the state directory the harness was pointed at. `source` is
 * relative to the operator's real `$HOME`; `target` to the isolated dir.
 */
const SHARED_CREDENTIALS: Array<{
  dir: 'claude' | 'codex' | 'grok';
  source: string;
  target: string;
}> = [
  // Claude Code relocates ~/.claude wholesale via CLAUDE_CONFIG_DIR; the OAuth
  // credentials live inside it, so an isolated dir needs them linked back.
  { dir: 'claude', source: '.claude/.credentials.json', target: '.credentials.json' },
  // Codex CLI relocates ~/.codex via CODEX_HOME; auth.json holds its login.
  { dir: 'codex', source: '.codex/auth.json', target: 'auth.json' },
  // Grok relocates ~/.grok via GROK_HOME; auth.json holds its login (same
  // shape as codex).
  { dir: 'grok', source: '.grok/auth.json', target: 'auth.json' },
];

/** Subdirectories created under a room-instance's agent home. */
const HOME_SUBDIRS = ['claude', 'codex', 'grok', 'state', 'cache', 'tmp'] as const;

export interface RoomAgentHomeInput {
  /** Per-room agent home root, e.g. `<roomRoot>/agent-home`. */
  root: string;
  /** Operator's real home directory; defaults to the daemon's. */
  operatorHome?: string;
}

/**
 * Create the room-instance's harness state directories, share the operator's
 * credentials into them, and return the env overlay that points the harness at
 * them. Never throws: an unwritable or already-populated path degrades to the
 * daemon's ambient state rather than failing the Room.
 */
export async function prepareRoomAgentHome(
  input: RoomAgentHomeInput,
): Promise<Record<string, string>> {
  const root = resolve(input.root);
  const operatorHome = input.operatorHome ?? homedir();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const subdir of HOME_SUBDIRS) {
      await mkdir(resolve(root, subdir), { recursive: true, mode: 0o700 });
    }
  } catch (error) {
    console.error(`[body] per-room agent home unavailable at ${root}; using daemon state:`, error);
    return {};
  }

  for (const credential of SHARED_CREDENTIALS) {
    const source = resolve(operatorHome, credential.source);
    const target = resolve(root, credential.dir, credential.target);
    if (!existsSync(source) || existsSync(target)) continue;
    // Symlink, not copy: a refreshed token written through the link stays
    // shared with every other room-instance and with the operator's own CLI.
    await symlink(source, target).catch(() => undefined);
  }

  return roomAgentHomeEnv(root);
}

/**
 * The env overlay alone, without touching the filesystem. `HOME` is
 * deliberately absent — see the module comment.
 */
export function roomAgentHomeEnv(root: string): Record<string, string> {
  const resolved = resolve(root);
  return {
    CLAUDE_CONFIG_DIR: resolve(resolved, 'claude'),
    CODEX_HOME: resolve(resolved, 'codex'),
    GROK_HOME: resolve(resolved, 'grok'),
    XDG_STATE_HOME: resolve(resolved, 'state'),
    XDG_CACHE_HOME: resolve(resolved, 'cache'),
    TMPDIR: resolve(resolved, 'tmp'),
  };
}

/**
 * Harness state/credential directories in a prepared env, and the temp
 * directory, split apart because the OS sandbox treats them differently: a
 * Room keeps the state dirs read-only but still needs a writable temp
 * (`bwrap-sandbox.ts`). Reads whatever the env actually carries, so it is
 * correct both for a Room with its own agent home and for one still on the
 * daemon's ambient state.
 */
export const HARNESS_STATE_ENV_VARS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GROK_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  AGENT_PRIVATE_STATE_ENV,
] as const;

export function harnessStateDirsFromEnv(env: Record<string, string | undefined>): {
  stateDirs: string[];
  tmpDir?: string;
} {
  const stateDirs: string[] = [];
  for (const name of HARNESS_STATE_ENV_VARS) {
    const value = env[name];
    if (value) stateDirs.push(resolve(value));
  }
  const tmp = env.TMPDIR;
  return { stateDirs, ...(tmp ? { tmpDir: resolve(tmp) } : {}) };
}
