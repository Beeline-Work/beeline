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
 * they fight the daemon's own agent-mode flags. Codex's native web search is
 * enabled explicitly (`[features] standalone_web_search`); Claude Code gets a
 * generated `settings.json` allowing its native `WebSearch` tool. Pi ships no
 * native web-search tool (web access there is extension-package territory,
 * deliberately out of the isolated home). This does NOT touch the #376
 * credential armor: masked stores (`~/.ssh`, `~/.netrc`, `~/.config/gh`,
 * `~/.config/trusty-squire`, `~/.git-credentials`) are never linked. Squire is
 * omitted from ambient declarations and mounted only through its host broker.
 *
 * Pi uses `PI_CODING_AGENT_DIR` and the isolated `$HOME`, preventing its
 * otherwise-implicit reads from the operator's `~/.pi` and `~/.agents` trees.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { AgentKind } from './agent-command.js';
import {
  runningBeelineReleaseId,
  USING_BEELINE_SKILL_NAME,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';
import { isTrustySquireMcpLaunch } from './external-mcp-capabilities.js';
import {
  resolveOpenRouterRouting,
  withOpenRouterModelRouting,
  type OpenRouterRoutingDecision,
  type OpenRouterRoutingHomeInput,
} from './openrouter-routing.js';
import { extractTomlSections, tomlChildTableNames } from './toml-section.js';
import { trustySquireLegacyStorePaths } from './trusty-squire-storage.js';

const AGENT_PRIVATE_STATE_ENV = 'BUZZY_AGENT_PRIVATE_DIR';

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
 * Goose keeps no auth.json: its provider, its model and its keys all live in
 * the config directory `GOOSE_PATH_ROOT` relocates wholesale (verified against
 * goose 1.41 — `GOOSE_PATH_ROOT=<root>` reads `<root>/config/config.yaml` and
 * writes `<root>/data`, `<root>/state`). `connect` skips the provider and key
 * questions for a Goose that already holds a provider of its own, so the
 * isolated home has to carry that configuration; without it the daemon would
 * answer with a Goose configured by nobody.
 *
 * COPIED, never symlinked, and regenerated on every activation like the MCP
 * files: Goose persists a session's selected model back into its own config,
 * and a Room must not rewrite the operator's default through a shared link.
 */
const GOOSE_SHARED_CONFIG_FILES = ['config.yaml', 'secrets.yaml'] as const;

/**
 * Operator skills directories shared (linked per entry) into an isolated
 * harness home's Beeline-managed skills directory, keyed by the state
 * directory the harness was pointed at. A missing source dir is skipped, not
 * fatal — not every host has every harness installed.
 */
export const BEELINE_DEFAULT_SKILL_NAMES = [USING_BEELINE_SKILL_NAME] as const;

/**
 * Operator skill directories shared by default into an isolated harness
 * home's Beeline-managed skills directory. Every entry that passes the same
 * validation as an explicit share is provisioned; a runtime record may still
 * narrow this per agent by listing explicit `sharedSkills` names. A missing
 * source dir is skipped, not fatal - not every host has every harness.
 */
const OPERATOR_SKILL_SOURCE_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.pi/agent/skills',
] as const;

/**
 * The harness homes that can carry a Beeline-managed skills directory.
 *
 * A session runs ONE harness, so only that harness's tree is provisioned
 * (C104): materializing all four cost three recursive copies nobody read on
 * every activation. `agentSkillDir` is the single mapping from the selected
 * harness to its tree, and the read-only MCP surface resolves the skill root
 * through the same function so a session can never be pointed at a tree that
 * was not provisioned.
 */
export const AGENT_SKILL_DIRS = ['claude', 'codex', 'grok', 'pi'] as const;
export type AgentSkillDir = (typeof AGENT_SKILL_DIRS)[number];

/** The skills tree the selected harness reads. Anything else lands on codex's. */
export function agentSkillDir(kind: AgentKind | undefined): AgentSkillDir {
  return (AGENT_SKILL_DIRS as readonly string[]).includes(kind ?? '')
    ? (kind as AgentSkillDir)
    : 'codex';
}
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

/**
 * Codex's native web search. `standalone_web_search` is the current feature
 * flag (`codex features list`); the older `tools.web_search` spelling is
 * deprecated. Network access is governed by the bwrap sandbox, not this flag.
 */
const CODEX_ROOM_WEB_SEARCH_TOML = '[features]\nstandalone_web_search = true\n';

/** Subdirectories created under a room-instance's agent home. */
const HOME_SUBDIRS = [
  'user',
  'claude',
  'codex',
  'goose',
  'grok',
  'pi',
  'state',
  'cache',
  'tmp',
] as const;

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
  /**
   * The harness this activation will spawn. Only ITS skills tree is
   * provisioned; omitting it provisions codex's, the same tree
   * `readOnlyMcpServer` falls back to for an unrecognised harness.
   */
  agentKind?: AgentKind;
  /**
   * The OpenRouter model this activation will run, when there is one. Its
   * live-derived provider set (`openrouter-routing.ts`, cached under
   * `cacheDir` for 24h) is pinned on that one model's pi `models.json` entry.
   */
  openRouterRouting?: OpenRouterRoutingHomeInput;
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
        agentSkillDir(input.agentKind),
        input.openRouterRouting,
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
  skillDir: AgentSkillDir,
  openRouterRouting: RoomAgentHomeInput['openRouterRouting'],
): Promise<void> {
  const managedSkills = [
    { name: USING_BEELINE_SKILL_NAME, content: usingBeelineSkillMarkdown(skillReleaseId) },
  ];
  const shared = await resolveSharedSkillSources(operatorHome, sharedSkills);
  await provisionManagedSkillsDir(
    resolve(root, skillDir, 'skills'),
    managedSkills,
    shared,
    sharedSkills.length === 0,
  );

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
          ? [CODEX_ROOM_AGENT_LOCKDOWN_TOML, CODEX_ROOM_WEB_SEARCH_TOML, mcpSection]
              .filter(Boolean)
              .join('\n')
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
    const gooseConfigDir = resolve(root, 'goose', 'config');
    await mkdir(gooseConfigDir, { recursive: true, mode: 0o700 });
    for (const name of GOOSE_SHARED_CONFIG_FILES) {
      const source = resolve(operatorHome, '.config', 'goose', name);
      const target = resolve(gooseConfigDir, name);
      // Regeneration is deletion too: a config the operator removed must not
      // keep answering in a Room.
      if (existsSync(source)) {
        await writeIsolatedHarnessFile(target, readFileSync(source, 'utf8'));
      } else {
        await unlink(target).catch(() => undefined);
      }
    }
  } catch (error) {
    if (failClosed) throw error;
    console.warn('[body] operator Goose configuration passthrough failed:', error);
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

  // Native web search for Claude Code: the tool is permission-gated, so the
  // generated isolated settings allow it explicitly. Regenerated on every
  // activation like every other Beeline-owned file in the harness home.
  try {
    const settings = { permissions: { allow: ['WebSearch'] } };
    await writeIsolatedHarnessFile(
      resolve(root, 'claude', 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  } catch (error) {
    if (failClosed) throw error;
    console.warn('[body] claude web-search settings provisioning failed:', error);
  }

  await provisionPiCustomModelConfig(root, operatorHome, failClosed, openRouterRouting);
}

async function provisionPiCustomModelConfig(
  root: string,
  operatorHome: string,
  failClosed: boolean,
  openRouterRouting: RoomAgentHomeInput['openRouterRouting'],
): Promise<void> {
  const source = resolve(operatorHome, PI_CUSTOM_MODEL_CONFIG.source);
  const target = resolve(root, 'pi', PI_CUSTOM_MODEL_CONFIG.target);
  // One decision per activation, one log line; never a failed activation.
  let decision: OpenRouterRoutingDecision | undefined;
  if (openRouterRouting) {
    decision = await resolveOpenRouterRouting(openRouterRouting);
    console.log(decision.line);
    openRouterRouting.onDecision?.(decision);
    // The answer probe never blocks an activation; its own line lands when the
    // probe does, and the pin it produces is read by the NEXT activation.
    void decision.refresh
      ?.then((next) => {
        if (next) console.log(next.line);
      })
      .catch(() => undefined);
  }
  const pin = decision
    ? {
        model: decision.model,
        routing: decision.routing,
        // The model's live input modalities ride with the routing pin: a
        // custom-model entry replaces pi's catalog record and defaults it to
        // text, which strips every image from the prompt (C87).
        ...(decision.input ? { input: decision.input } : {}),
      }
    : undefined;
  try {
    const sourceStats = await lstat(source).catch(() => undefined);
    if (!sourceStats) {
      await writeIsolatedHarnessFile(
        target,
        `${JSON.stringify(withOpenRouterModelRouting({}, pin), null, 2)}\n`,
      );
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
    const sourceValue = JSON.parse(readFileSync(resolvedSource, 'utf8')) as unknown;
    await writeIsolatedHarnessFile(
      target,
      `${JSON.stringify(withOpenRouterModelRouting(sourceValue, pin), null, 2)}\n`,
    );
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
  optionalShares: boolean,
): Promise<void> {
  const parent = dirname(target);
  await assertRealContainedDirectory(parent, dirname(parent));
  const plan = await planManagedSkills(managedSkills, sharedSkills, optionalShares);
  // The reuse test is content, on BOTH sides. The destination is agent-writable,
  // so its own existence, mtime or a receipt file it could have written are all
  // worthless as proof: the only evidence that matters is that every byte still
  // under it is the byte this plan would put there, and that nothing there is a
  // link or a shared inode a session could mutate underneath the harness.
  if ((await materializedSkillManifest(target)) === plan.manifest) return;
  const staged = resolve(parent, `.skills.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staged, { mode: 0o700 });
  try {
    for (const entry of plan.entries) {
      if (entry.kind === 'managed') {
        const skillDir = resolve(staged, entry.name);
        await mkdir(skillDir, { recursive: true });
        await writeIsolatedHarnessFile(resolve(skillDir, 'SKILL.md'), entry.content);
      } else {
        await copySafeSkillTree(entry.source, resolve(staged, entry.name), entry.source);
      }
    }
    const existing = await lstat(target).catch(() => undefined);
    if (existing) await rm(target, { recursive: existing.isDirectory(), force: true });
    await rename(staged, target);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

type PlannedSkill =
  | { kind: 'managed'; name: string; content: string }
  | { kind: 'shared'; name: string; source: string };

/**
 * Everything this activation would materialize, plus the exact manifest of the
 * tree it would produce.
 *
 * The plan is settled BEFORE anything is written, so the reuse test and the
 * rebuild are the same decision read twice — a share that fails validation is
 * skipped here (for an implicit share) or thrown here (for an explicit one),
 * and therefore never appears in a manifest that a materialized tree is asked
 * to match.
 */
async function planManagedSkills(
  managedSkills: Array<{ name: string; content: string }>,
  sharedSkills: Array<{ name: string; source: string }>,
  optionalShares: boolean,
): Promise<{ entries: PlannedSkill[]; manifest: string }> {
  const entries: PlannedSkill[] = [];
  const lines: string[] = [];
  const names = new Set(managedSkills.map((skill) => skill.name));
  for (const skill of managedSkills) {
    entries.push({ kind: 'managed', name: skill.name, content: skill.content });
    lines.push(`d ${skill.name}`, `f ${skill.name}/SKILL.md ${sha256(skill.content)}`);
  }
  for (const shared of sharedSkills) {
    if (names.has(shared.name)) {
      throw new Error(`shared skill collides with Beeline-owned skill: ${shared.name}`);
    }
    names.add(shared.name);
    try {
      const tree: string[] = [];
      await walkSafeSkillTree(shared.source, shared.source, {
        directory: async (rel) => void tree.push(`d ${join(shared.name, rel)}`),
        file: async (rel, realPath) =>
          void tree.push(`f ${join(shared.name, rel)} ${sha256(await readFile(realPath))}`),
      });
      entries.push({ kind: 'shared', name: shared.name, source: shared.source });
      lines.push(...tree);
    } catch (error) {
      // Default (implicit) shares degrade to fewer skills rather than
      // failing the Room; an explicitly named share still fails loudly.
      if (!optionalShares) throw error;
      console.warn(`[body] skipping shared skill ${shared.name}:`, error);
    }
  }
  return { entries, manifest: lines.sort().join('\n') };
}

/**
 * The manifest of a skills tree that already exists, or `undefined` when it
 * cannot be read as one. A symlink, a device node, or a file sharing its inode
 * with something outside the tree makes the whole tree unusable rather than
 * merely different: those are the shapes a writable home could use to keep a
 * mutable handle on what the harness reads, so a provision is never reused
 * over them.
 */
async function materializedSkillManifest(target: string): Promise<string | undefined> {
  const stats = await lstat(target).catch(() => undefined);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) return undefined;
  const lines: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<boolean> => {
    for (const entry of await readdir(directory)) {
      const path = resolve(directory, entry);
      const rel = prefix ? join(prefix, entry) : entry;
      const entryStats = await lstat(path);
      if (entryStats.isSymbolicLink()) return false;
      if (entryStats.isDirectory()) {
        lines.push(`d ${rel}`);
        if (!(await visit(path, rel))) return false;
        continue;
      }
      if (!entryStats.isFile() || entryStats.nlink !== 1) return false;
      lines.push(`f ${rel} ${sha256(await readFile(path))}`);
    }
    return true;
  };
  try {
    if (!(await visit(target, ''))) return undefined;
  } catch {
    return undefined;
  }
  return lines.sort().join('\n');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The skill shares for one activation. Non-empty explicit names narrow the
 * share per agent (the previous behavior, validated fail-closed). Otherwise
 * EVERY entry across the operator's skill directories is shared by default:
 * each entry is validated with the same boundary as an explicit share, but an
 * entry that cannot be validated safely is skipped with a warning, and a name
 * present in several directories resolves first-dir-wins instead of failing.
 */
async function resolveSharedSkillSources(
  operatorHome: string,
  names: string[],
): Promise<Array<{ name: string; source: string }>> {
  if (names.length > 0) return resolveExplicitSkillSources(operatorHome, names);
  const seen = new Set<string>();
  const resolved: Array<{ name: string; source: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const relativeRoot of OPERATOR_SKILL_SOURCE_DIRS) {
    const sourceRoot = resolve(operatorHome, relativeRoot);
    const rootStats = await lstat(sourceRoot).catch(() => undefined);
    if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) continue;
    for (const entry of await readdir(sourceRoot)) {
      if (!isSharedSkillName(entry) || seen.has(entry)) continue;
      const candidate = resolve(sourceRoot, entry);
      try {
        const candidateStats = await lstat(candidate);
        if (candidateStats.isSymbolicLink()) {
          const reason = await realpath(candidate).then(
            () => 'symlinked directory',
            (error: unknown) =>
              isMissingPathError(error) ? 'dangling symlink' : 'symlinked directory',
          );
          skipped.push({
            path: candidate,
            reason,
          });
          continue;
        }
        if (!candidateStats.isDirectory()) {
          skipped.push({ path: candidate, reason: 'not an ordinary directory' });
          continue;
        }
        assertContained(sourceRoot, candidate);
        const skillMd = resolve(candidate, 'SKILL.md');
        const skillStats = await lstat(skillMd).catch((error: unknown) => {
          if (isMissingPathError(error)) {
            skipped.push({ path: candidate, reason: 'missing SKILL.md' });
            return undefined;
          }
          throw error;
        });
        if (!skillStats) continue;
        if (!skillStats.isFile() || skillStats.isSymbolicLink() || skillStats.nlink !== 1) {
          skipped.push({ path: candidate, reason: 'SKILL.md is not an ordinary file' });
          continue;
        }
        seen.add(entry);
        resolved.push({ name: entry, source: candidate });
      } catch (error) {
        if (isMissingPathError(error)) {
          skipped.push({ path: candidate, reason: 'missing during discovery' });
          continue;
        }
        // Unexpected filesystem errors remain loud: operators need their
        // stack traces to distinguish a bad skill from a broken home volume.
        console.warn(`[body] skipping operator skill ${entry}:`, error);
      }
    }
  }
  logSkippedOperatorSkills(skipped);
  return resolved;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Expected bad shapes in an operator's ambient skills directory are not daemon
 * failures. Keep each diagnosis to one journal line, then give repeated
 * reasons a per-activation total so a stale symlink farm does not hide real
 * warnings later in the same activation.
 */
function logSkippedOperatorSkills(skipped: Array<{ path: string; reason: string }>): void {
  const totals = new Map<string, number>();
  for (const { path, reason } of skipped) {
    console.warn(`[body] skipping operator skill ${path}: ${reason}`);
    totals.set(reason, (totals.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of totals) {
    if (count > 1) console.warn(`[body] ${count} skill entries skipped: ${reason}`);
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
    for (const relativeRoot of OPERATOR_SKILL_SOURCE_DIRS) {
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

interface SkillTreeVisitor {
  /** A directory the copy would create, by its path relative to the skill root. */
  directory(rel: string): Promise<void>;
  /** An ordinary file the copy would carry, with the real path to read it from. */
  file(rel: string, realPath: string): Promise<void>;
}

/**
 * Walk one shared skill under its whole safety boundary, once.
 *
 * Copying and hashing are the same walk with different visitors deliberately:
 * the reuse test only means anything while the manifest it compares against is
 * produced by exactly the rules the copy obeys, and a second walker written
 * beside this one would drift out of that agreement silently.
 */
async function walkSafeSkillTree(
  source: string,
  sourceRoot: string,
  visitor: SkillTreeVisitor,
  rel = '',
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
    await visitor.directory(rel);
    for (const entry of await readdir(resolvedSource)) {
      if (entry === '.' || entry === '..') throw new Error('invalid shared skill entry');
      await walkSafeSkillTree(
        resolve(source, entry),
        sourceRoot,
        visitor,
        rel ? join(rel, entry) : entry,
      );
    }
    return;
  }
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error(`shared skill contains a nonordinary file: ${source}`);
  }
  await visitor.file(rel, resolvedSource);
}

async function copySafeSkillTree(
  source: string,
  target: string,
  sourceRoot: string,
): Promise<void> {
  await walkSafeSkillTree(source, sourceRoot, {
    directory: async (rel) => {
      await mkdir(resolve(target, rel), { mode: 0o700 });
    },
    file: async (rel, realPath) => {
      const destination = resolve(target, rel);
      await copyFile(realPath, destination);
      await chmod(destination, 0o600);
    },
  });
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
    GOOSE_PATH_ROOT: resolve(resolved, 'goose'),
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
  'GOOSE_PATH_ROOT',
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
