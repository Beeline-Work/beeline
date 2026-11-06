import { waitForPathRemoval } from './filesystem-change.js';
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
 * record. Shared skills are validated and copied as private ordinary
 * files, preserving owner execution permission for launchers; ambient
 * directories are never inherited. Ordinary operator MCP server
 * declarations are COPIED into the harness home so every Room/corner session
 * has the tools the host offers — without them a harness boots with a login but
 * nothing to advertise over ACP. Codex-acp
 * MERGES session MCP servers into `$CODEX_HOME/config.toml`, so a symlink
 * there would let a session write into the operator's real config. Only MCP
 * declarations pass through: model/sandbox/approval settings stay out because
 * they fight the daemon's own agent-mode flags. Codex's native web search is
 * enabled explicitly (`[features] standalone_web_search`); Claude Code gets a
 * generated `settings.json` allowing its native `WebSearch` tool. Pi's
 * harness MCP inventory is `$PI_CODING_AGENT_DIR/mcp.json` (operator
 * `~/.pi/agent/mcp.json`); local servers are copied and granted host routes
 * are rewritten there like Claude's `.claude.json`. The Pi installer chooses
 * that native inventory only when the executable proves it can load it;
 * otherwise `pi-mcp-bridge.ts` republishes the filtered stdio inventory.
 * Isolated homes exclude operator `settings.json`; Pi receives generated
 * stream-liveness settings. This does NOT touch the #376
 * credential armor: masked stores (`~/.ssh`, `~/.netrc`, `~/.config/gh`,
 * `~/.config/trusty-squire`, `~/.git-credentials`) are never linked. Imported
 * MCP declarations are classified `local` (copied as-is) or `host` (rewritten
 * into a route only after an owner grant; otherwise kept out). Squire is
 * code-owned as host.
 *
 * Pi uses `PI_CODING_AGENT_DIR` and the isolated `$HOME`, preventing its
 * otherwise-implicit reads from the operator's `~/.pi` and `~/.agents` trees.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DRAW_AVATAR_SKILL_NAME } from './draw-avatar-skill.js';
import { AGENT_BEHAVIORS, SHARED_CREDENTIALS, agentBehavior, type AgentKind } from './agent-command.js';
import { BEELINE_REVIEW_SKILL_NAME, BEELINE_SPEC_SKILL_NAME, BEELINE_ONBOARDING_SKILL_NAME, BEELINE_TRIAGE_SKILL_NAME, runningBeelineReleaseId, SITUATIONAL_SKILL_NAMES } from './beeline-skill.js';
import { type OpenRouterRoutingHomeInput } from './openrouter-routing.js';
import { isMissingPathError, assertRealContainedDirectory, roomSessionTmpDir, roomAgentHomeEnv } from './agent-home-plan-managed-skills.js';
import { provisionAgentSkillsAndMcp } from './agent-home-provision-agent-skills-and-mcp.js';
export { AGENT_PRIVATE_STATE_ENV } from './agent-private-state-env.js';



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
export const GOOSE_SHARED_CONFIG_FILES = ['config.yaml', 'secrets.yaml'] as const;


/**
 * Operator skills directories shared (linked per entry) into an isolated
 * harness home's Beeline-managed skills directory, keyed by the state
 * directory the harness was pointed at. A missing source dir is skipped, not
 * fatal — not every host has every harness installed.
 */
export const BEELINE_DEFAULT_SKILL_NAMES = [
  BEELINE_REVIEW_SKILL_NAME,
  BEELINE_SPEC_SKILL_NAME,
  BEELINE_ONBOARDING_SKILL_NAME,
  BEELINE_TRIAGE_SKILL_NAME,
  DRAW_AVATAR_SKILL_NAME,
  ...SITUATIONAL_SKILL_NAMES,
] as const;


/**
 * Operator skill directories shared by default into an isolated harness
 * home's Beeline-managed skills directory. Every entry that passes the same
 * validation as an explicit share is provisioned; a runtime record may still
 * narrow this per agent by listing explicit `sharedSkills` names. A missing
 * source dir is skipped, not fatal - not every host has every harness.
 */
export const OPERATOR_SKILL_SOURCE_DIRS = [
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
export const AGENT_SKILL_DIRS = ['claude', 'codex', 'grok', 'pi', 'cursor', 'opencode'] as const;

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


export class AgentHomeSecurityError extends Error {}

export const agentHomeProvisionQueues = new Map<string, Promise<void>>();


export const EXPIRED_LOGIN_PATTERNS = [
  /\boauth session expired\b/i,
  /\b(?:oauth|login|session|token)\b.{0,80}\bcould not be refreshed\b/i,
  /\b(?:failed|unable) to refresh\b.{0,80}\b(?:oauth|login|session|token)\b/i,
  /\brefresh token\b.{0,80}\b(?:expired|invalid|revoked)\b/i,
] as const;


/** A harness login failed in the one shape a credential re-link can repair. */
export function isExpiredHarnessLoginError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    const text =
      current instanceof Error
        ? current.message
        : typeof current === 'string'
          ? current
          : typeof current === 'object' && 'message' in current
            ? String((current as { message: unknown }).message)
            : String(current);
    if (EXPIRED_LOGIN_PATTERNS.some((pattern) => pattern.test(text))) return true;
    current =
      current instanceof Error
        ? current.cause
        : typeof current === 'object' && current && 'cause' in current
          ? (current as { cause: unknown }).cause
          : undefined;
  }
  return false;
}


export const HARNESS_LOGIN_NAMES: Partial<Record<AgentKind, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  pi: 'Pi',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};


/** The only user-visible answer after a repaired link proves the source login is stale too. */
export function freshHarnessLoginLine(kind: AgentKind | undefined, machine: string): string {
  const harness = (kind && HARNESS_LOGIN_NAMES[kind]) || 'The agent provider';
  return `${harness} on ${machine.trim() || 'this machine'} needs a fresh login.`;
}


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
 *   - `pi`: the same JSON `mcpServers` object lives in `~/.pi/agent/mcp.json`
 *     and is written as `mcp.json` inside the isolated `PI_CODING_AGENT_DIR`.
 *
 * Everything else in those files (models, sandbox modes, approval policy) and
 * every ungranted host-classified server (`mcp-route-class.ts`) stay behind.
 * An owner-granted host route is rewritten into the isolated home so the
 * next session fingerprint includes it.
 * The generated Codex config also disables its internal multi-agent tools:
 * Beeline must own all parallel work through its visible Room/corner
 * primitive.
 */
export const HARNESS_MCP_CONFIGS = [
  { dir: 'codex' as const, toml: '.codex/config.toml', roomDefaults: AGENT_BEHAVIORS.codex.roomTomlDefaults },
  { dir: 'grok' as const, toml: '.grok/config.toml', roomDefaults: AGENT_BEHAVIORS.grok.roomTomlDefaults },
];


/**
 * Pi custom providers live outside auth.json and may carry inline API keys.
 * Copy only this exact file into PI_CODING_AGENT_DIR. `settings.json` is
 * deliberately excluded: Body applies the paired or human-selected model via
 * ACP, while Pi's theme, package, extension, and default behavior are ambient
 * operator preferences rather than credentials required by that selection.
 */
export const PI_CUSTOM_MODEL_CONFIG = {
  source: '.pi/agent/models.json',
  target: 'models.json',
} as const;


/** Pi's harness MCP inventory. Isolated homes write local copies + granted host routes here. */
export const PI_MCP_CONFIG = {
  source: '.pi/agent/mcp.json',
  target: 'mcp.json',
} as const;


/**
 * Codex's supported per-home switch for its internal delegation surface.
 * This removes spawn, follow-up, wait, and message controls without changing
 * ordinary turn tools or the explicitly copied MCP server configuration.
 */
export const CODEX_ROOM_AGENT_LOCKDOWN_TOML = '[agents]\nenabled = false\n';


/**
 * Codex's native web search. `standalone_web_search` is the current feature
 * flag (`codex features list`); the older `tools.web_search` spelling is
 * deprecated. Network access is governed by the bwrap sandbox, not this flag.
 */
export const CODEX_ROOM_WEB_SEARCH_TOML = '[features]\nstandalone_web_search = true\n';


/**
 * Subdirectories created under a room-instance's agent home. Every one of
 * these except `tmp` is a harness state/credential root (see
 * `roomAgentHomeEnv`). Private reclamation is governed by lifecycle, whole
 * object use, and the preservation paths in `helper-storage.ts`.
 */
export const HOME_SUBDIRS = [
  'user',
  'user/.config',
  'user/.local/share',
  'claude',
  'codex',
  'goose',
  'grok',
  'pi',
  'cursor',
  'opencode',
  'state',
  'cache',
  'tmp',
] as const;


export interface RoomAgentHomeInput {
  /** Per-room agent home root, e.g. `<roomRoot>/agent-home`. */
  root: string;
  /** Server-provided identity of the agent and this Room. */
  squireScope?: { readonly agentId: string; readonly roomId: string; readonly relay?: { readonly url: string; readonly token: string; readonly contextFile: string } };
  /** Operator's real home directory; defaults to the daemon's. */
  operatorHome?: string;
  failClosed?: boolean;
  /**
   * Release id stamped into the managed Beeline skills. Defaults to
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
   * This activation runs as the parent Room's configured reviewer. Only a
   * reviewer's home carries the `beeline-review` skill: an implementer that
   * reads the review procedure mistakes its reviewer-never-merge rule for
   * its own.
   */
  isReviewer?: boolean;
  /**
   * The OpenRouter model this activation will run, when there is one. Its
   * live-derived provider set (`openrouter-routing.ts`, cached under
   * `cacheDir` for 24h) is pinned on that one model's pi `models.json` entry.
   */
  openRouterRouting?: OpenRouterRoutingHomeInput;
  /**
   * Owner-granted host MCP server names. Each matching host declaration is
   * rewritten into this isolated home; revoking the grant omits it on the
   * next prepare so the session fingerprint changes.
   */
  grantedHostRoutes?: readonly string[];
  /** Beeline-owned dynamic host routes (Registry MCP), already scoped by the server. */
  extraHostRoutes?: Record<string, Record<string, unknown>>;
  resourceAuthFile?: string;
}


export function claudeLoginExpiresAt(text: string): number | undefined {
  try {
    const expiresAt = (JSON.parse(text) as { claudeAiOauth?: { expiresAt?: unknown } } | null)
      ?.claudeAiOauth?.expiresAt;
    return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : undefined;
  } catch {
    return undefined;
  }
}


export const CLAUDE_LOGIN_LOCK_WAIT_MS = 2_000;

export const CLAUDE_LOGIN_LOCK_STALE_MS = 30_000;


/**
 * Run `write` while holding an exclusive lock file beside the shared Claude
 * login. Every Room's body process takes the same lock, so two write-backs
 * cannot interleave. A lock older than the stale bound belongs to a process
 * that died mid-write and is removed. Returns undefined when the lock stays
 * busy; the caller keeps its detached login for the next pass.
 */
export async function withSharedClaudeLoginLock<T>(
  shared: string,
  write: () => Promise<T>,
): Promise<T | undefined> {
  const lock = `${shared}.beeline-lock`;
  const deadline = Date.now() + CLAUDE_LOGIN_LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await lstat(lock).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > CLAUDE_LOGIN_LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      await waitForPathRemoval(lock);
    }
  }
  try {
    return await write();
  } finally {
    await rm(lock, { force: true });
  }
}


/**
 * Write a Room's detached Claude login back to the operator's shared file
 * when it expires later, then restore the Room's link.
 *
 * Claude Code persists a refresh with rename(2), which replaces the Room's
 * symlink and leaves the rotated refresh token in that Room alone. When the
 * old refresh token is single-use, the shared file then holds a spent token
 * and every other Room (and the operator CLI) fails its next refresh. Writing
 * the newer login back keeps one current token for everyone. The shared file is
 * replaced atomically (temp file, mode 0600, rename) under a lock, and only
 * when the shared login still expires earlier, so a concurrent refresh by
 * another Room or the operator is never overwritten. A detached file without
 * a readable `claudeAiOauth.expiresAt` is never written back.
 */
export async function writeBackDetachedClaudeLogin(
  target: string,
  source: string,
): Promise<'linked' | 'not-newer' | 'busy'> {
  const detached = await readFile(target, 'utf8');
  const detachedExpiresAt = claudeLoginExpiresAt(detached);
  if (detachedExpiresAt === undefined) return 'not-newer';
  const shared = await realpath(source);
  const isNewer = async (): Promise<boolean> => {
    const sharedExpiresAt = claudeLoginExpiresAt(await readFile(shared, 'utf8'));
    return sharedExpiresAt !== undefined && detachedExpiresAt > sharedExpiresAt;
  };
  if (!(await isNewer())) return 'not-newer';
  const written = await withSharedClaudeLoginLock(shared, async () => {
    if (!(await isNewer())) return false;
    const temp = `${shared}.beeline-${randomUUID()}`;
    try {
      await writeFile(temp, detached, { flag: 'wx', mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, shared);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return true;
  });
  if (written === undefined) return 'busy';
  if (!written) return 'not-newer';
  // The harness may have refreshed again since the read; keep that file for
  // the next pass rather than linking over it.
  if ((await readFile(target, 'utf8')) !== detached) return 'busy';
  const link = `${target}.beeline-link-${randomUUID()}`;
  await symlink(source, link);
  await rename(link, target);
  return 'linked';
}


/**
 * Restore shared login links, writing a newer detached Claude login back first.
 *
 * Harnesses commonly persist refreshed tokens with rename(2). When they do
 * that through an isolated path, the rename replaces the symlink itself and
 * leaves one Room holding a detached regular file. A failed-login retry
 * quarantines that file and restores the link; activation writes a newer
 * Claude login back to the operator's file (see
 * `writeBackDetachedClaudeLogin`) and relinks the Room.
 */
export async function repairRoomAgentCredentialLinks(input: {
  root: string;
  operatorHome?: string;
  writeBackNewerClaudeLogin?: boolean;
}): Promise<void> {
  const root = resolve(input.root);
  const operatorHome = input.operatorHome ?? homedir();
  for (const credential of SHARED_CREDENTIALS) {
    const source = resolve(operatorHome, credential.source);
    if (!existsSync(source)) continue;
    const target = resolve(root, credential.dir, credential.target);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const stats = await lstat(target).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (stats?.isSymbolicLink()) {
      const linked = await readlink(target);
      if (resolve(dirname(target), linked) === source) continue;
    }
    if (stats) {
      // A successful Claude refresh can replace the isolated symlink. Share
      // that login with every Room before the old refresh token is spent.
      // Failure retries use the shared source instead, so a failed detached
      // refresh cannot trap the session. A busy lock keeps the detached login
      // here until the next pass.
      if (input.writeBackNewerClaudeLogin && credential.writeBack && stats.isFile()) {
        const outcome = await writeBackDetachedClaudeLogin(target, source);
        if (outcome !== 'not-newer') continue;
      }
      const quarantine = `${target}.beeline-quarantine-${Date.now()}-${randomUUID()}`;
      await rename(target, quarantine);
    }
    await symlink(source, target);
  }
}


/**
 * Write a Claude login this Room refreshed back to the operator's file.
 *
 * Runs after each prompt settles, the point where Claude Code may have
 * refreshed and detached the Room's link, so the rotated token reaches other
 * Rooms before their next turn rather than at this Room's next activation.
 * Touches only the Claude credential and never quarantines.
 */
export async function writeBackRoomClaudeLogin(input: {
  root: string;
  operatorHome?: string;
}): Promise<'linked' | 'not-newer' | 'busy' | 'absent'> {
  const claude = SHARED_CREDENTIALS.find((credential) => credential.writeBack)!;
  const source = resolve(input.operatorHome ?? homedir(), claude.source);
  if (!existsSync(source)) return 'busy';
  const target = resolve(input.root, claude.dir, claude.target);
  const stats = await lstat(target).catch(() => undefined);
  if (!stats?.isFile()) return 'absent';
  return writeBackDetachedClaudeLogin(target, source);
}


/**
 * Write a Claude login back the moment this Room's link detaches.
 *
 * A warm Claude Code process can refresh its login while its Room is idle.
 * The after-prompt write-back then waits for this Room's next turn, and every
 * other Room fails meanwhile on the spent shared token. Watching the Room's
 * Claude directory shares the rotated login at once. Passes run one at a time
 * through the same locked, expiry-checked write-back; a pass that finds the
 * link restored does nothing. Returns undefined when there is nothing to watch.
 */
export function watchRoomClaudeLogin(input: {
  root: string;
  operatorHome?: string;
}): FSWatcher | undefined {
  const claude = SHARED_CREDENTIALS.find((credential) => credential.writeBack)!;
  if (!existsSync(resolve(input.operatorHome ?? homedir(), claude.source))) return undefined;
  const dir = resolve(input.root, claude.dir);
  let pass = Promise.resolve();
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename !== claude.target) return;
      pass = pass
        .then(async () => { await writeBackRoomClaudeLogin(input); })
        .catch((error: unknown) => {
          console.error(`[body] could not write back a refreshed Claude login under ${dir}:`, error);
        });
    });
  } catch (error) {
    console.error(`[body] could not watch the Claude login under ${dir}:`, error);
    return undefined;
  }
  watcher.on('error', (error) => {
    console.error(`[body] stopped watching the Claude login under ${dir}:`, error);
    watcher.close();
  });
  watcher.unref();
  return watcher;
}


/**
 * Point Claude Code's login store at the operator's own `~/.claude`.
 *
 * Claude Code keeps one refresh lock per login store and re-reads the store
 * under that lock, so processes that share a store never spend the same
 * single-use refresh token twice. Each Room has its own `CLAUDE_CONFIG_DIR`,
 * which by default gives each Room its own lock and a linked file that the
 * first refresh replaces. Rooms then refresh in parallel with one token; the
 * provider rejects the reuse and the login is lost, most often when a restart
 * starts many Rooms at once. `CLAUDE_SECURESTORAGE_CONFIG_DIR` moves only the
 * login store and its lock, so every Room and the operator's terminal share
 * one store and one lock. Set only when the operator signed in to the
 * plaintext store; the linked file stays for Claude Code builds without it.
 */
export function sharedClaudeLoginEnv(operatorHome: string): Record<string, string> {
  const claude = SHARED_CREDENTIALS.find((credential) => credential.writeBack)!;
  const source = resolve(operatorHome, claude.source);
  return existsSync(source) ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: dirname(source) } : {};
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
  let tmpLinkReady = false;
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
    // `TMPDIR` is the short symlink `roomAgentHomeEnv` reports, so a session's
    // Unix sockets stay inside `sun_path`; the bytes live in `root/tmp`. A
    // failure here must not cost the whole isolated home, so it degrades to
    // the long real path below.
    try {
      const tmpLink = roomSessionTmpDir(root);
      const tmpTarget = resolve(root, 'tmp');
      if ((await readlink(tmpLink).catch(() => undefined)) !== tmpTarget) {
        await rm(tmpLink, { recursive: true, force: true });
        await symlink(tmpTarget, tmpLink);
      }
      tmpLinkReady = true;
    } catch (error) {
      console.error(`[body] short TMPDIR link unavailable under ${root}:`, error);
    }
  } catch (error) {
    if (input.failClosed || input.resourceAuthFile || error instanceof AgentHomeSecurityError)
      throw error;
    console.error(`[body] per-room agent home unavailable at ${root}; using daemon state:`, error);
    return {};
  }

  try {
    await repairRoomAgentCredentialLinks({
      root,
      operatorHome,
      writeBackNewerClaudeLogin: agentBehavior(input.agentKind).sharedLoginWriteBack === true,
    });
  } catch (error) {
    if (input.failClosed || input.resourceAuthFile) throw error;
    console.error(`[body] could not repair shared credentials under ${root}:`, error);
  }

  const prior = agentHomeProvisionQueues.get(root) ?? Promise.resolve();
  const provision = prior
    .catch(() => undefined)
    .then(() =>
      provisionAgentSkillsAndMcp(
        root,
        operatorHome,
        input.skillReleaseId ?? runningBeelineReleaseId(),
        input.failClosed === true || Boolean(input.resourceAuthFile),
        input.sharedSkills ?? [],
        agentSkillDir(input.agentKind),
        input.openRouterRouting,
        input.isReviewer ?? false,
        input.grantedHostRoutes ?? [],
        input.extraHostRoutes ?? {},
        input.agentKind,
        input.resourceAuthFile,
        input.squireScope,
      ),
    );
  agentHomeProvisionQueues.set(root, provision);
  try {
    await provision;
  } finally {
    if (agentHomeProvisionQueues.get(root) === provision) agentHomeProvisionQueues.delete(root);
  }

  const env = tmpLinkReady
    ? roomAgentHomeEnv(root)
    : { ...roomAgentHomeEnv(root), TMPDIR: resolve(root, 'tmp') };
  return {
    ...env,
    ...(agentBehavior(input.agentKind).sharedLoginWriteBack === true ? sharedClaudeLoginEnv(operatorHome) : {}),
  };
}
export { SHARED_CREDENTIALS } from './agent-command.js';
export { mountedImportedMcpServerNames } from './agent-home-provision-agent-skills-and-mcp.js';
export { hostImportedMcpDeclarations } from './agent-home-provision-agent-skills-and-mcp.js';
export { hostImportedMcpServerNames } from './agent-home-provision-agent-skills-and-mcp.js';
export { grantedSquireHostBindPaths } from './agent-home-provision-agent-skills-and-mcp.js';
export { expectedMountedImportedMcpServerNames } from './agent-home-provision-agent-skills-and-mcp.js';
export { writeIsolatedHarnessFile } from './agent-home-plan-managed-skills.js';
export { roomSessionTmpDir } from './agent-home-plan-managed-skills.js';
export { roomAgentHomeEnv } from './agent-home-plan-managed-skills.js';
export { HARNESS_STATE_ENV_VARS } from './agent-home-plan-managed-skills.js';
export { harnessStateDirsFromEnv } from './agent-home-plan-managed-skills.js';
