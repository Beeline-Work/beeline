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
 *
 * **Skills + MCP passthrough (owner decision 2026-08-23).** The operator's
 * skills directories are symlinked into each harness home and ordinary operator
 * MCP server declarations are COPIED into it, so every Room/corner session has
 * the tools the host offers — without them a harness boots
 * with a login but nothing to advertise over ACP. Two shapes, deliberately:
 * skills are LINKED (read-only reference data; edits through the link would be
 * the operator's own business anyway) while MCP config is COPIED — codex-acp
 * MERGES session MCP servers into `$CODEX_HOME/config.toml`, so a symlink
 * there would let a session write into the operator's real config. Only MCP
 * declarations pass through: model/sandbox/approval settings stay out because
 * they fight the daemon's own agent-mode flags. This does NOT touch the #376
 * credential armor: masked stores (`~/.ssh`, `~/.netrc`, `~/.config/gh`,
 * `~/.config/trusty-squire`, `~/.git-credentials`) are never linked. Squire is
 * omitted from ambient declarations and mounted only through its host broker.
 *
 * `pi` needs none of this: it never reads the `mcpServers` it is handed and
 * loads the operator's global `~/.pi/agent` extensions/skills from `$HOME`
 * itself, which is never overridden here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { AGENT_PRIVATE_STATE_ENV } from './agent-private-state.js';
import { isTrustySquireMcpLaunch } from './external-mcp-capabilities.js';
import { extractTomlSections, tomlChildTableNames } from './toml-section.js';
import { trustySquireLegacyStorePaths } from './trusty-squire-storage.js';

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

/**
 * Operator skills directories shared (linked) into an isolated harness home,
 * keyed by the state directory the harness was pointed at. A missing source
 * dir is skipped, not fatal — not every host has every harness installed.
 */
const SHARED_SKILLS: Array<{ dir: 'claude' | 'codex' | 'grok'; source: string }> = [
  { dir: 'claude', source: '.claude/skills' },
  { dir: 'codex', source: '.codex/skills' },
  { dir: 'grok', source: '.grok/skills' },
];

/**
 * Harness MCP declarations copied from the operator's real home into the
 * isolated home, per that harness's own layout:
 *
 *   - `codex` / `grok`: only the `[mcp_servers.*]` tables of the harness's
 *     `config.toml` are carried over, as a REAL file (never a symlink — see
 *     the module comment).
 *   - `claude`: Claude Code's user-scope MCP lives under the top-level
 *     `mcpServers` key of `~/.claude.json`; the same object is written as a
 *     minimal `.claude.json` inside the isolated `CLAUDE_CONFIG_DIR`.
 *
 * Everything else in those files (models, sandbox modes, approval policy) and
 * the reserved `squire` server deliberately stay behind.
 */
const HARNESS_MCP_CONFIGS = [
  { dir: 'codex' as const, toml: '.codex/config.toml' },
  { dir: 'grok' as const, toml: '.grok/config.toml' },
];

/** Subdirectories created under a room-instance's agent home. */
const HOME_SUBDIRS = ['claude', 'codex', 'grok', 'state', 'cache', 'tmp'] as const;

export interface RoomAgentHomeInput {
  /** Per-room agent home root, e.g. `<roomRoot>/agent-home`. */
  root: string;
  /** Operator's real home directory; defaults to the daemon's. */
  operatorHome?: string;
  failClosed?: boolean;
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
    if (input.failClosed) throw error;
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

  await provisionOperatorSkillsAndMcp(root, operatorHome, input.failClosed ?? false).catch(
    (error) => {
      if (input.failClosed) throw error;
      console.warn(`[body] operator skills/MCP passthrough incomplete for ${root}:`, error);
    },
  );

  return roomAgentHomeEnv(root);
}

/**
 * Link the operator's skills dirs into each harness home and copy the
 * operator's MCP declarations into it. Best-effort end to end: a missing
 * source is the common case (not every host has every harness), and any
 * failure degrades to a session with fewer skills rather than failing the
 * Room. Unlike credentials, the MCP copies are REGENERATED on every prepare
 * call so a daemon restart picks up operator config edits; the skills links
 * are repaired when they point somewhere else.
 */
async function provisionOperatorSkillsAndMcp(
  root: string,
  operatorHome: string,
  failClosed: boolean,
): Promise<void> {
  for (const skills of SHARED_SKILLS) {
    const source = resolve(operatorHome, skills.source);
    const target = resolve(root, skills.dir, 'skills');
    await linkOperatorDir(source, target).catch((error) => {
      console.warn(`[body] operator skills unavailable at ${target}:`, error);
    });
  }

  for (const config of HARNESS_MCP_CONFIGS) {
    try {
      const source = resolve(operatorHome, config.toml);
      const target = resolve(root, config.dir, 'config.toml');
      const section = existsSync(source) ? filteredHarnessMcpToml(readFileSync(source, 'utf8')) : undefined;
      // Regeneration is also deletion: if the operator removes the config or
      // its last MCP table, do not leave stale servers active in a Room.
      if (!section) {
        await unlink(target).catch(() => undefined);
        continue;
      }
      await writeIsolatedHarnessFile(target, section);
    } catch (error) {
      if (failClosed) throw error;
      console.warn(`[body] operator MCP passthrough failed for ${config.dir}:`, error);
    }
  }

  try {
    const claudeJson = resolve(operatorHome, '.claude.json');
    const claudeTarget = resolve(root, 'claude', '.claude.json');
    const mcpServers = existsSync(claudeJson)
      ? readClaudeUserScopeMcpServers(claudeJson)
      : undefined;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      await writeIsolatedHarnessFile(
        claudeTarget,
        `${JSON.stringify({ mcpServers }, null, 2)}\n`,
      );
    } else {
      await unlink(claudeTarget).catch(() => undefined);
    }
  } catch (error) {
    if (failClosed) throw error;
    console.warn('[body] operator MCP passthrough failed for claude:', error);
  }
}

export function hasLocalTrustySquireState(
  operatorHome = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return trustySquireLegacyStorePaths(operatorHome, env).some(existsSync);
}

export function hasAmbientTrustySquireConfiguration(operatorHome = homedir()): boolean {
  for (const relativePath of ['.codex/config.toml', '.grok/config.toml']) {
    const path = resolve(operatorHome, relativePath);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    for (const name of tomlChildTableNames(source, ['mcp_servers'])) {
      const section = extractTomlSections(source, ['mcp_servers', name]);
      if (name === 'squire' || (section && isTrustySquireMcpLaunch(section))) return true;
    }
  }
  const claudePath = resolve(operatorHome, '.claude.json');
  if (!existsSync(claudePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(claudePath, 'utf8')) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
    return Object.entries(servers).some(([name, value]) => {
      if (name === 'squire') return true;
      const server = value as Record<string, unknown> | null;
      return Boolean(
        server &&
          typeof server.command === 'string' &&
          isTrustySquireMcpLaunch(
            server.command,
            Array.isArray(server.args) && server.args.every((arg) => typeof arg === 'string')
              ? (server.args as string[])
              : [],
          ),
      );
    });
  } catch {
    return false;
  }
}

function readClaudeUserScopeMcpServers(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null) {
      return Object.fromEntries(
        Object.entries(parsed.mcpServers as Record<string, unknown>).filter(([name, value]) => {
          if (name === 'squire') return false;
          const server = value as Record<string, unknown> | null;
          if (!server || typeof server.command !== 'string') return true;
          const args =
            Array.isArray(server.args) && server.args.every((arg) => typeof arg === 'string')
              ? (server.args as string[])
              : [];
          return !isTrustySquireMcpLaunch(server.command, args);
        }),
      );
    }
  } catch {
    // Malformed operator config: skip rather than fail the Room.
  }
  return undefined;
}

function filteredHarnessMcpToml(source: string): string | undefined {
  const excluded = tomlChildTableNames(source, ['mcp_servers']).filter((name) => {
    const section = extractTomlSections(source, ['mcp_servers', name]);
    return name === 'squire' || Boolean(section && isTrustySquireMcpLaunch(section));
  });
  return extractTomlSections(source, ['mcp_servers'], excluded);
}

async function linkOperatorDir(source: string, target: string): Promise<void> {
  if (!existsSync(source)) {
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) await unlink(target).catch(() => undefined);
    return;
  }
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(target);
  } catch {
    // Target absent: create the link.
    await symlink(source, target).catch(() => undefined);
    return;
  }
  if (!stats.isSymbolicLink()) return; // Never replace real data with a link.
  const current = await readlinkSafe(target);
  if (current && resolve(dirname(target), current) === source) return;
  // Repair a stale link left by an earlier layout.
  await unlink(target).catch(() => undefined);
  await symlink(source, target).catch(() => undefined);
}

/**
 * Replace one generated harness file without ever following a symlink already
 * occupying the target. A session can write its isolated state directory, so
 * plain `writeFile(target)` would let a stale/malicious symlink redirect the
 * daemon's next regeneration into another file. The temporary file is private
 * from creation and `rename` replaces the directory entry itself.
 */
export async function writeIsolatedHarnessFile(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  const parentStats = await lstat(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error(`isolated harness parent is not a real directory: ${parent}`);
  }
  const temporary = resolve(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readlinkSafe(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch {
    return undefined;
  }
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
