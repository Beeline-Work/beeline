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
 * Room harnesses receive a Beeline-owned `$HOME` as well as their harness
 * state roots. Known login files are linked into the harness-specific state
 * directory, preserving one operator login without inheriting `$HOME/.agents`,
 * plugins, configuration, or personal memory. Pi's credential-bearing custom
 * provider catalog is copied as a private ordinary file into only its config
 * directory and regenerated on activation; operator UI/default settings stay
 * isolated.
 *
 * **Skills.** Every `<harness-home>/skills` is rebuilt on activation with the
 * explicit default allowlist plus narrow names stored on this agent's runtime
 * record. Shared skills are validated and copied as non-executable ordinary
 * files; ambient directories are never inherited. Ordinary operator MCP server
 * declarations are COPIED into the harness home so every Room/corner session
 * has the tools the host offers — without them a harness boots with a login but
 * nothing to advertise over ACP. Codex-acp
 * MERGES session MCP servers into `$CODEX_HOME/config.toml`, so a symlink
 * there would let a session write into the operator's real config. Only MCP
 * declarations pass through: model/sandbox/approval settings stay out because
 * they fight the daemon's own agent-mode flags. This does NOT touch the #376
 * credential armor: masked stores (`~/.ssh`, `~/.netrc`, `~/.config/gh`,
 * `~/.config/trusty-squire`, `~/.git-credentials`) are never linked. Squire is
 * omitted from ambient declarations and mounted only through its host broker.
 *
 * Pi uses `PI_CODING_AGENT_DIR` and the isolated `$HOME`, preventing its
 * otherwise-implicit reads from the operator's `~/.pi` and `~/.agents` trees.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import {
  runningBeelineReleaseId,
  USING_BEELINE_SKILL_NAME,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';
import { MISSION_BRIEF_SKILL_NAME, missionBriefSkillMarkdown } from './mission-skill.js';
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
  dir: 'claude' | 'codex' | 'grok' | 'pi';
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
  { dir: 'pi', source: '.pi/agent/auth.json', target: 'auth.json' },
];

/**
 * Operator skills directories shared (linked per entry) into an isolated
 * harness home's Beeline-managed skills directory, keyed by the state
 * directory the harness was pointed at. A missing source dir is skipped, not
 * fatal — not every host has every harness installed.
 */
export const BEELINE_DEFAULT_SKILL_NAMES = [
  USING_BEELINE_SKILL_NAME,
  MISSION_BRIEF_SKILL_NAME,
] as const;

/** Owned operator locations from which one named skill may be explicitly shared. */
const EXPLICIT_SKILL_SOURCE_DIRS = ['.agents/skills'] as const;

/** Every supported Room harness consumes the same exact materialized inventory. */
export const AGENT_SKILL_DIRS = ['claude', 'codex', 'grok', 'pi'] as const;
export const SHARED_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSharedSkillName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SHARED_SKILL_NAME_PATTERN.test(value) &&
    !(BEELINE_DEFAULT_SKILL_NAMES as readonly string[]).includes(value)
  );
}

class AgentHomeSecurityError extends Error {}
const agentHomeProvisionQueues = new Map<string, Promise<void>>();

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
 * the reserved `squire` server deliberately stay behind. The generated Codex
 * config also disables its internal multi-agent tools: Beeline must own all
 * parallel work through its visible Room/corner primitive.
 */
const HARNESS_MCP_CONFIGS = [
  { dir: 'codex' as const, toml: '.codex/config.toml' },
  { dir: 'grok' as const, toml: '.grok/config.toml' },
];

/**
 * Pi custom providers live outside auth.json and may carry inline API keys.
 * Copy only this exact file into PI_CODING_AGENT_DIR. `settings.json` is
 * deliberately excluded: Body applies the paired or human-selected model via
 * ACP, while Pi's theme, package, extension, and default behavior are ambient
 * operator preferences rather than credentials required by that selection.
 */
const PI_CUSTOM_MODEL_CONFIG = {
  source: '.pi/agent/models.json',
  target: 'models.json',
} as const;

/**
 * Codex's supported per-home switch for its internal delegation surface.
 * This removes spawn, follow-up, wait, and message controls without changing
 * ordinary turn tools or the explicitly copied MCP server configuration.
 */
const CODEX_ROOM_AGENT_LOCKDOWN_TOML = '[agents]\nenabled = false\n';

/** Subdirectories created under a room-instance's agent home. */
const HOME_SUBDIRS = ['user', 'claude', 'codex', 'grok', 'pi', 'state', 'cache', 'tmp'] as const;

export interface RoomAgentHomeInput {
  /** Per-room agent home root, e.g. `<roomRoot>/agent-home`. */
  root: string;
  /** Operator's real home directory; defaults to the daemon's. */
  operatorHome?: string;
  failClosed?: boolean;
  /**
   * Release id stamped into the managed `using-beeline` skill. Defaults to
   * the RUNNING release (`runningBeelineReleaseId`); tests inject explicit
   * ids to prove regeneration on version change.
   */
  skillReleaseId?: string;
  /** Narrow, runtime-owned names explicitly shared with this one agent. */
  sharedSkills?: string[];
}

/**
 * Create the room-instance's harness state directories, share the operator's
 * harness login into them, and return the env overlay that points the harness at
 * them. Normally an unwritable or already-populated path degrades to the
 * daemon's ambient state; `failClosed` propagates setup errors for governed
 * credential sessions that may not fall back to ambient state.
 */
export async function prepareRoomAgentHome(
  input: RoomAgentHomeInput,
): Promise<Record<string, string>> {
  const root = resolve(input.root);
  const operatorHome = input.operatorHome ?? homedir();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new AgentHomeSecurityError(`agent home root is not an ordinary directory: ${root}`);
    }
    for (const subdir of HOME_SUBDIRS) {
      const path = resolve(root, subdir);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await assertRealContainedDirectory(path, root);
    }
  } catch (error) {
    if (input.failClosed || error instanceof AgentHomeSecurityError) throw error;
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

  const prior = agentHomeProvisionQueues.get(root) ?? Promise.resolve();
  const provision = prior
    .catch(() => undefined)
    .then(() =>
      provisionAgentSkillsAndMcp(
        root,
        operatorHome,
        input.skillReleaseId ?? runningBeelineReleaseId(),
        input.failClosed ?? false,
        input.sharedSkills ?? [],
      ),
    );
  agentHomeProvisionQueues.set(root, provision);
  try {
    await provision;
  } finally {
    if (agentHomeProvisionQueues.get(root) === provision) agentHomeProvisionQueues.delete(root);
  }

  return roomAgentHomeEnv(root);
}

/**
 * Provision each harness home's Beeline-managed skills directory and copy the
 * operator's MCP declarations into the home. Best-effort end to end: a missing
 * source is the common case (not every host has every harness), and any
 * failure degrades to a session with fewer skills rather than failing the
 * Room. Unlike credentials, BOTH the MCP copies and the managed skill are
 * REGENERATED on every prepare call so a daemon restart picks up operator
 * config edits and release upgrades; per-entry operator-skill links are
 * repaired when they point somewhere else.
 */
async function provisionAgentSkillsAndMcp(
  root: string,
  operatorHome: string,
  skillReleaseId: string,
  failClosed: boolean,
  sharedSkills: string[],
): Promise<void> {
  const managedSkills = [
    { name: USING_BEELINE_SKILL_NAME, content: usingBeelineSkillMarkdown(skillReleaseId) },
    // Mission Charter v2 M1: the chief-of-staff skill ships through the same
    // release-owned, regenerate-on-activation channel as using-beeline.
    { name: MISSION_BRIEF_SKILL_NAME, content: missionBriefSkillMarkdown(skillReleaseId) },
  ];
  const shared = await resolveExplicitSkillSources(operatorHome, sharedSkills);
  for (const dir of AGENT_SKILL_DIRS) {
    const target = resolve(root, dir, 'skills');
    await provisionManagedSkillsDir(target, managedSkills, shared);
  }

  for (const config of HARNESS_MCP_CONFIGS) {
    try {
      const source = resolve(operatorHome, config.toml);
      const target = resolve(root, config.dir, 'config.toml');
      const mcpSection = existsSync(source)
        ? filteredHarnessMcpToml(readFileSync(source, 'utf8'))
        : undefined;
      // A Codex Room needs this config even when the operator shares no MCP
      // servers: Codex otherwise enables internal collaboration by default.
      const section =
        config.dir === 'codex'
          ? [CODEX_ROOM_AGENT_LOCKDOWN_TOML, mcpSection].filter(Boolean).join('\n')
          : mcpSection;
      // Regeneration is also deletion: if the operator removes the config or
      // its last MCP table, do not leave stale servers active in a Room. Codex
      // retains its required delegation lockdown without shared MCP config.
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
      await writeIsolatedHarnessFile(claudeTarget, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
    } else {
      await unlink(claudeTarget).catch(() => undefined);
    }
  } catch (error) {
    if (failClosed) throw error;
    console.warn('[body] operator MCP passthrough failed for claude:', error);
  }

  await provisionPiCustomModelConfig(root, operatorHome, failClosed);
}

async function provisionPiCustomModelConfig(
  root: string,
  operatorHome: string,
  failClosed: boolean,
): Promise<void> {
  const source = resolve(operatorHome, PI_CUSTOM_MODEL_CONFIG.source);
  const target = resolve(root, 'pi', PI_CUSTOM_MODEL_CONFIG.target);
  try {
    const sourceStats = await lstat(source).catch(() => undefined);
    if (!sourceStats) {
      await unlink(target).catch(() => undefined);
      return;
    }
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.nlink !== 1) {
      throw new AgentHomeSecurityError(
        `Pi custom model config is not an ordinary private source file: ${source}`,
      );
    }
    const resolvedSource = await realpath(source);
    if (resolvedSource !== source) {
      throw new AgentHomeSecurityError(`Pi custom model config resolves through a link: ${source}`);
    }
    await writeIsolatedHarnessFile(target, readFileSync(resolvedSource, 'utf8'));
  } catch (error) {
    // Never retain a stale credential-bearing copy when its current source is
    // unsafe or unreadable. A governed activation may choose to fail closed;
    // ordinary Rooms continue without the custom provider and log the cause.
    await unlink(target).catch(() => undefined);
    if (failClosed) throw error;
    console.warn('[body] operator Pi custom model passthrough failed:', error);
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

/**
 * Atomically rebuild `target` with the exact release-owned defaults plus the
 * already-validated per-agent shares. No pre-existing destination entry is
 * followed or retained.
 */
async function provisionManagedSkillsDir(
  target: string,
  managedSkills: Array<{ name: string; content: string }>,
  sharedSkills: Array<{ name: string; source: string }>,
): Promise<void> {
  const parent = dirname(target);
  await assertRealContainedDirectory(parent, dirname(parent));
  const staged = resolve(parent, `.skills.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staged, { mode: 0o700 });
  const names = new Set(managedSkills.map((skill) => skill.name));
  try {
    for (const skill of managedSkills) {
      const skillDir = resolve(staged, skill.name);
      await mkdir(skillDir, { recursive: true });
      await writeIsolatedHarnessFile(resolve(skillDir, 'SKILL.md'), skill.content);
    }
    for (const shared of sharedSkills) {
      if (names.has(shared.name)) {
        throw new Error(`shared skill collides with Beeline-owned skill: ${shared.name}`);
      }
      names.add(shared.name);
      await copySafeSkillTree(shared.source, resolve(staged, shared.name), shared.source);
    }
    const existing = await lstat(target).catch(() => undefined);
    if (existing) await rm(target, { recursive: existing.isDirectory(), force: true });
    await rename(staged, target);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

async function resolveExplicitSkillSources(
  operatorHome: string,
  names: string[],
): Promise<Array<{ name: string; source: string }>> {
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!isSharedSkillName(name)) throw new Error(`invalid shared skill name: ${name}`);
  }
  const resolved: Array<{ name: string; source: string }> = [];
  for (const name of unique) {
    const matches: string[] = [];
    for (const relativeRoot of EXPLICIT_SKILL_SOURCE_DIRS) {
      const sourceRoot = resolve(operatorHome, relativeRoot);
      const candidate = resolve(sourceRoot, name);
      const rootStats = await lstat(sourceRoot).catch(() => undefined);
      const candidateStats = await lstat(candidate).catch(() => undefined);
      if (!candidateStats) continue;
      if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error(`shared skill source root is not an ordinary directory: ${sourceRoot}`);
      }
      if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
        throw new Error(`shared skill source is not an ordinary directory: ${candidate}`);
      }
      assertContained(sourceRoot, candidate);
      matches.push(candidate);
    }
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `shared skill is unavailable: ${name}`
          : `shared skill source is ambiguous: ${name}`,
      );
    }
    const skillMd = resolve(matches[0]!, 'SKILL.md');
    const skillStats = await lstat(skillMd).catch(() => undefined);
    if (!skillStats?.isFile() || skillStats.isSymbolicLink() || skillStats.nlink !== 1) {
      throw new Error(`shared skill requires an ordinary SKILL.md: ${name}`);
    }
    resolved.push({ name, source: matches[0]! });
  }
  return resolved;
}

/** Pair-time preflight for the same source boundary activation will enforce. */
export async function validateSharedSkills(operatorHome: string, names: string[]): Promise<void> {
  await resolveExplicitSkillSources(resolve(operatorHome), names);
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== resolve(candidate)) {
    throw new Error(`path escapes the agent skill boundary: ${candidate}`);
  }
}

async function assertRealContainedDirectory(path: string, root: string): Promise<void> {
  assertContained(root, path);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new AgentHomeSecurityError(
      `agent skill destination is not an ordinary directory: ${path}`,
    );
  }
}

const BLOCKED_SHARED_FILENAMES =
  /^(?:\.env(?:\..*)?|auth\.json|\.credentials\.json|config\.toml|settings(?:\.local)?\.json|\.mcp\.json|credentials?|secrets?|plugins?|\.codex-plugin|\.claude-plugin|memory(?:\.md)?|\.netrc|\.git-credentials|.*\.(?:pem|key))$/i;

async function copySafeSkillTree(
  source: string,
  target: string,
  sourceRoot: string,
): Promise<void> {
  assertContained(sourceRoot, source);
  const resolvedSource = await realpath(source);
  if (resolvedSource !== resolve(source)) {
    throw new Error(`shared skill path resolves through a link: ${source}`);
  }
  assertContained(sourceRoot, resolvedSource);
  const stats = await lstat(resolvedSource);
  if (stats.isSymbolicLink()) throw new Error(`shared skill contains a symlink: ${source}`);
  if (BLOCKED_SHARED_FILENAMES.test(basename(source))) {
    throw new Error(`shared skill contains credential or configuration material: ${source}`);
  }
  if (stats.isDirectory()) {
    await mkdir(target, { mode: 0o700 });
    for (const entry of await readdir(resolvedSource)) {
      if (entry === '.' || entry === '..') throw new Error('invalid shared skill entry');
      await copySafeSkillTree(resolve(source, entry), resolve(target, entry), sourceRoot);
    }
    return;
  }
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error(`shared skill contains a nonordinary file: ${source}`);
  }
  await copyFile(resolvedSource, target);
  await chmod(target, 0o600);
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

/**
 * The env overlay alone, without touching the filesystem.
 */
export function roomAgentHomeEnv(root: string): Record<string, string> {
  const resolved = resolve(root);
  return {
    HOME: resolve(resolved, 'user'),
    CLAUDE_CONFIG_DIR: resolve(resolved, 'claude'),
    CODEX_HOME: resolve(resolved, 'codex'),
    GROK_HOME: resolve(resolved, 'grok'),
    PI_CODING_AGENT_DIR: resolve(resolved, 'pi'),
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
  'PI_CODING_AGENT_DIR',
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
