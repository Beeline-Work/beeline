import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeNsec, getPublicKey } from '@beeline/nostr';
import { newIdentity, type Identity } from '@beeline/gate';
import type {
  RedeemAgentPairingResult,
  RepositoryBinding,
  RepositoryRoomResult,
} from '@beeline/buzz-client';
import { DEFAULT_AGENT_IDENTITY_NAME, DEFAULT_BODY_IDENTITY_NAME } from '@beeline/buzz-client';
import { AGENT_KINDS, type AgentCommand, type AgentKind } from './agent-command.js';

const execFileAsync = promisify(execFile);
import {
  DEFAULT_ACCESS_POLICY,
  isAgentAccessPolicy,
  LEGACY_ACCESS_POLICY,
  type AgentAccessPolicy,
} from './access-policy.js';
import { isSandboxPolicy, type SandboxPolicy } from './bwrap-sandbox.js';
import {
  isExternalMcpCapability,
  type ExternalMcpCapability,
} from './external-mcp-capabilities.js';

export interface LocalRepositoryBinding {
  root: string;
  gitCommonDir: string;
  remoteName?: string;
  targetBranch: string;
  repository: RepositoryBinding;
  relayRepo?: { ownerHex: string; repo: string };
}

interface StoredIdentity {
  name: string;
  secretKeyHex: string;
  publicKey: string;
}

export interface AgentRuntimeRecord {
  version: 2;
  communityId: string;
  pairedBy: string;
  agent: StoredIdentity;
  body: StoredIdentity;
  /** Repository Rooms currently known to this Workspace supervisor. */
  rooms: RoomRuntimeRecord[];
  /** Git common dir that owns the one machine-local supervisor record. */
  supervisorRoot: string;
  relayBaseUrl: string;
  relayHost?: string;
  llmEnvFile?: string;
  /**
   * Who may drive this agent, set by the inviter at pairing time. Absent on
   * pre-policy records; readers treat that as `everyone` (see access-policy.ts).
   */
  accessPolicy?: AgentAccessPolicy;
  /** Optional custom auto-response for a non-permitted questioner. */
  accessAutoResponse?: string;
  /** Explicit external MCP grants. Profiles contain no credential material. */
  externalMcpCapabilities?: ExternalMcpCapability[];
  /**
   * Pair-time default model/effort, set by `--model`/`--effort` and applied
   * by `Body.applyModelConfigForSession` (`body.ts`) whenever no human has
   * yet set an explicit in-app selection (#223) for this agent — the same
   * `session/set_config_option` mechanism, just seeded before any picker
   * write exists. Never validated again after pairing; the pairing CLI
   * already checked it against the agent's live advertised catalog.
   */
  modelSelection?: { model?: string; effort?: string };
  /**
   * OS sandbox policy for this agent's ACP children (`bwrap-sandbox.ts`).
   * Absent means `bwrap` — wrap when a working bubblewrap is detected, spawn
   * unwrapped with one advisory line when it is not. `off` is the escape hatch
   * for a host where bubblewrap misbehaves; it disables the wrapper entirely
   * and leaves `session-sandbox.ts`'s permission handler as the only boundary.
   */
  sandbox?: SandboxPolicy;
  /**
   * Owner-configured extra credential-mask paths (`bwrap-sandbox.ts`), unioned
   * with the built-in known list at spawn time. Absolute or `$HOME`-relative.
   */
  sandboxMaskPaths?: string[];
  agentKind?: AgentKind;
  agentCommand?: string;
  agentArgs?: string[];
  /** Legacy field retained so pre-picker runtimes and integrations keep working. */
  agentBinary: string;
  mcpBinary: string;
  createdAt: string;
}

export interface RoomRuntimeRecord {
  channelId: string;
  repo: LocalRepositoryBinding;
  /**
   * This Room's own storage directory (durable inbox, per-room agent home,
   * corner worktrees). Explicit so a Room can live anywhere and, crucially, so
   * a Room provisioned before the runtime root moved keeps resolving to the
   * exact directory it already occupies: `git worktree` writes absolute paths
   * into `.git/worktrees/<name>/gitdir`, so relocating a live Room's
   * directory silently breaks every open corner in it.
   *
   * Absent on records written before this field existed; readers fall back to
   * `<dirname(configPath)>/rooms/<channelId>`, which is where those Rooms are.
   */
  root?: string;
  /** Dedicated Room-admin identity used only by this Room's approval gate. */
  mergeWorker?: StoredIdentity;
  membershipSince: number;
  discoveredAt: string;
}

/**
 * Pointer left at the old repo-anchored runtime path so `beeline start` keeps
 * working from inside the paired checkout after the real runtime moved to the
 * agent state home.
 */
interface RuntimeLinkRecord {
  version: 3;
  link: string;
}

interface LegacyAgentRuntimeRecord {
  version: 1;
  communityId: string;
  channelId: string;
  pairedBy: string;
  agent: StoredIdentity;
  body: StoredIdentity;
  mergeWorker?: StoredIdentity;
  repo: LocalRepositoryBinding;
  relayBaseUrl: string;
  relayHost?: string;
  llmEnvFile?: string;
  agentBinary: string;
  mcpBinary: string;
  createdAt: string;
}

export interface PairRuntimeResult {
  pairing: RedeemAgentPairingResult;
  /**
   * The repository Room resolved at pair time. Absent when the agent paired
   * with no repository binding — the daemon then discovers and materializes
   * every Room it is invited to from that Room's own published repository.
   */
  room?: RepositoryRoomResult;
  runtime: AgentRuntimeRecord;
  configPath: string;
  pid: number;
}

export function runtimeAgentCommand(
  runtime: Pick<AgentRuntimeRecord, 'agentKind' | 'agentCommand' | 'agentArgs' | 'agentBinary'>,
): AgentCommand {
  const command = runtime.agentCommand ?? runtime.agentBinary;
  const inferredKind: AgentKind =
    command.endsWith('/buzz-agent') || command === 'buzz-agent' ? 'reference' : 'custom';
  return {
    kind: runtime.agentKind ?? inferredKind,
    command,
    args: [...(runtime.agentArgs ?? [])],
  };
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });
  return result.status === 0 ? (result.stdout ?? '').trim() : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Normalize common HTTPS/SSH/scp clone forms without retaining credentials. */
export function canonicalizeOrigin(raw: string, repoRoot: string): string {
  const value = raw.trim();
  if (!value) throw new Error('origin URL is empty');

  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !value.includes('://')) {
    const path = scp[2]!
      .replace(/^\/+/, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '');
    return `git://${scp[1]!.toLowerCase()}/${path}`;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'file:') {
      const path = parsed.pathname.replace(/\/$/, '').replace(/\.git$/, '');
      return `file://${resolve(path)}`;
    }
    const path = decodeURIComponent(parsed.pathname)
      .replace(/^\/+/, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '');
    const port = parsed.port ? `:${parsed.port}` : '';
    return `git://${parsed.hostname.toLowerCase()}${port}/${path}`;
  } catch {
    const absolute = isAbsolute(value) ? value : resolve(repoRoot, value);
    return `file://${absolute.replace(/\/$/, '').replace(/\.git$/, '')}`;
  }
}

function nameFromCanonicalRemote(remote: string, fallback: string): string {
  const path = remote.slice(remote.lastIndexOf('/') + 1).trim();
  return path || fallback;
}

function relayRepoFromOrigin(raw: string): { ownerHex: string; repo: string } | undefined {
  let path: string;
  try {
    path = new URL(raw).pathname;
  } catch {
    return undefined;
  }
  const match = path.match(/\/git\/([0-9a-fA-F]{64})\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  return { ownerHex: match[1]!.toLowerCase(), repo: decodeURIComponent(match[2]!) };
}

/**
 * Inspect the git repository at cwd and derive its immutable Room binding,
 * or `null` when cwd is not inside a git repository at all.
 *
 * Since room-owns-repo, a repository is a property of a ROOM (resolved from
 * published Room state and materialized on demand by the daemon), not of the
 * agent — so pairing with no local repository is a valid configuration and
 * "no repository here" is an ordinary answer, not a failure.
 */
export function tryInspectLocalRepository(cwd: string): LocalRepositoryBinding | null {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitCommonDir = common
    ? resolve(root, common)
    : resolve(root, git(root, ['rev-parse', '--git-common-dir']) ?? '.git');
  const configuredTarget = git(root, ['config', '--get', 'beeline.targetBranch']);
  const remoteHead = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const currentBranch = git(root, ['branch', '--show-current']);
  const targetBranch = (
    configuredTarget ||
    remoteHead?.replace(/^origin\//, '') ||
    (git(root, ['show-ref', '--verify', '--quiet', 'refs/heads/main']) !== null
      ? 'main'
      : currentBranch || 'main')
  ).replace(/^refs\/heads\//, '');
  const remoteUrl = git(root, ['remote', 'get-url', 'origin']) ?? undefined;

  if (!remoteUrl) {
    const name = basename(root);
    return {
      root,
      gitCommonDir,
      targetBranch,
      repository: {
        // Stable for this checkout/git-common-dir, intentionally different
        // for an unrelated clone on another machine.
        key: sha256(`local:${gitCommonDir}`),
        name,
        localOnly: true,
      },
    };
  }

  const canonicalRemote = canonicalizeOrigin(remoteUrl, root);
  return {
    root,
    gitCommonDir,
    remoteName: 'origin',
    targetBranch,
    repository: {
      key: sha256(`remote:${canonicalRemote}`),
      name: nameFromCanonicalRemote(canonicalRemote, basename(root)),
      remote: canonicalRemote,
      localOnly: false,
    },
    ...(relayRepoFromOrigin(remoteUrl) ? { relayRepo: relayRepoFromOrigin(remoteUrl) } : {}),
  };
}

/**
 * `tryInspectLocalRepository` for callers that genuinely require a repository
 * at this path (the supervisor's checkout resolution, and `--repo <path>`,
 * where the operator named the directory explicitly).
 */
export function inspectLocalRepository(cwd: string): LocalRepositoryBinding {
  const binding = tryInspectLocalRepository(cwd);
  if (!binding) {
    throw new Error(`not a git repository; pass --repo <path> to specify one (checked: ${cwd})`);
  }
  return binding;
}

export function identityFromKey(value: string | undefined, name: string): Identity {
  if (!value) return newIdentity(name);
  const secretKey = value.startsWith('nsec1')
    ? decodeNsec(value)
    : Uint8Array.from(Buffer.from(value, 'hex'));
  if (secretKey.length !== 32) throw new Error(`${name} key must be 32-byte hex or nsec`);
  return { name, secretKey, publicKey: getPublicKey(secretKey) };
}

/**
 * The only identity factory allowed on the `beeline pair` path. It accepts no
 * key material by design, so an ambient human `BUZZ_PRIVATE_KEY` can never be
 * mistaken for the new agent again.
 */
export function mintAgentIdentityForPairing(): Identity {
  return newIdentity(DEFAULT_AGENT_IDENTITY_NAME);
}

function storeIdentity(identity: Identity, defaultName: string): StoredIdentity {
  return {
    name: identity.name ?? defaultName,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    publicKey: identity.publicKey,
  };
}

export function runtimeIdentity(identity: StoredIdentity): Identity {
  const secretKey = Uint8Array.from(Buffer.from(identity.secretKeyHex, 'hex'));
  if (secretKey.length !== 32 || getPublicKey(secretKey) !== identity.publicKey) {
    throw new Error('stored runtime identity is invalid');
  }
  return { name: identity.name, secretKey, publicKey: identity.publicKey };
}

function agentsDirectory(supervisorRoot: string): string {
  return resolve(supervisorRoot, 'beeline', 'agents');
}

export function runtimeDirectory(supervisorRoot: string, agentPubkey: string): string {
  return resolve(agentsDirectory(supervisorRoot), agentPubkey);
}

/**
 * Whether a machine-local runtime already exists for this agent pubkey.
 *
 * Runtime storage is keyed by agent pubkey, so a prior pairing of the *same*
 * identity — the reused-key hazard — is exactly a pre-existing `runtime.json`
 * here. Fresh keypairs (the default; `identityFromKey(undefined)`) never
 * collide, so N fresh-key agents coexist while a reused key is detectable.
 */
export async function agentRuntimeExists(
  supervisorRoot: string,
  agentPubkey: string,
): Promise<boolean> {
  try {
    await stat(resolve(runtimeDirectory(supervisorRoot, agentPubkey), 'runtime.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * S0 — fail-closed multi-identity guard, as a standalone precondition so
 * `beeline pair` can check it BEFORE asking the operator any interactive
 * question. `pairRepositoryAgent` re-checks it immediately before consuming
 * the one-shot pairing code, so the guard holds for direct callers too.
 */
export async function assertAgentIdentityUnpaired(
  supervisorRoot: string,
  agentPubkey: string,
): Promise<void> {
  if (!(await agentRuntimeExists(supervisorRoot, agentPubkey))) return;
  throw new Error(
    `agent identity ${agentPubkey} is already paired on this host; ` +
      'every agent needs its own fresh keypair. Restart the existing one with ' +
      '`beeline start --agent <pubkey>`, or run the Members-page pairing command to mint a new identity.',
  );
}

/**
 * Default machine-local root for a paired agent's runtime.
 *
 * Historically this was the first paired repository's git common dir, which
 * put every *other* repository's clone, every Room's durable inbox and every
 * open corner's worktree inside repo A's `.git` — so deleting or moving repo A
 * destroyed the whole Workspace agent, and a repo-less Workspace still needed a
 * git repository to exist and stay put. Nothing in the supervisor or Body reads
 * a repository out of this root; the per-Room repository binding is
 * `RoomRuntimeRecord.repo`.
 */
export function defaultSupervisorRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdgState = env.XDG_STATE_HOME;
  if (xdgState && isAbsolute(xdgState)) return resolve(xdgState);
  return resolve(env.HOME ?? homedir(), '.local', 'state');
}

export async function writeRuntimeRecord(record: AgentRuntimeRecord): Promise<string> {
  const directory = runtimeDirectory(record.supervisorRoot, record.agent.publicKey);
  const path = resolve(directory, 'runtime.json');
  const temporary = resolve(directory, `runtime-${process.pid}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return path;
}

export function normalizeRelayBaseUrl(value: string): {
  relayBaseUrl: string;
  relayHost: string;
} {
  let relay: URL;
  try {
    relay = new URL(value.trim());
  } catch {
    throw new Error('relay URL must be a valid HTTP or HTTPS origin');
  }
  if (relay.protocol !== 'https:' && relay.protocol !== 'http:') {
    throw new Error('relay URL must use HTTP or HTTPS');
  }
  if (
    relay.username ||
    relay.password ||
    (relay.pathname && relay.pathname !== '/') ||
    relay.search ||
    relay.hash
  ) {
    throw new Error('relay URL must be an origin without credentials, a path, query, or fragment');
  }
  return { relayBaseUrl: relay.origin, relayHost: relay.host };
}

/** Atomically repoint one explicitly-selected stored runtime. Never runs implicitly. */
export async function updateRuntimeRelay(
  pathOrPointer: string,
  relayUrl: string,
): Promise<{ configPath: string; runtime: AgentRuntimeRecord }> {
  const configPath = await resolveRuntimeConfigPath(pathOrPointer);
  const runtime = await readRuntimeRecord(configPath);
  const relay = normalizeRelayBaseUrl(relayUrl);
  const expectedConfigPath = resolve(
    runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey),
    'runtime.json',
  );
  if (resolve(configPath) !== expectedConfigPath) {
    throw new Error(`refusing to update a runtime outside its canonical path: ${configPath}`);
  }
  const updated: AgentRuntimeRecord = {
    ...runtime,
    relayBaseUrl: relay.relayBaseUrl,
    relayHost: relay.relayHost,
  };
  const writtenPath = await writeRuntimeRecord(updated);
  if (resolve(writtenPath) !== expectedConfigPath) throw new Error('runtime relay update failed');
  return { configPath, runtime: updated };
}

/**
 * Fail BEFORE the one-shot pairing code is consumed if this host cannot
 * actually store the runtime.
 *
 * `writeRuntimeRecord` is the last irreversible step of pairing that can still
 * throw after the agent has already registered itself in the Workspace, and a
 * throw there is exactly the half-created ghost this preflight exists to
 * prevent: an unusable directory (missing parent, read-only mount, wrong
 * owner) is a property of the host, knowable before any relay write.
 */
export async function assertRuntimeStorageWritable(
  supervisorRoot: string,
  agentPubkey: string,
): Promise<void> {
  const directory = runtimeDirectory(supervisorRoot, agentPubkey);
  const probe = resolve(directory, `write-probe-${process.pid}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(probe, '', { mode: 0o600 });
  } catch (error) {
    throw new Error(
      `cannot write agent runtime state at ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

/**
 * Leave a pointer at the repo-anchored path the runtime used to occupy, so
 * `beeline start` inside the paired checkout still finds this agent.
 */
export async function writeRuntimePointer(
  gitCommonDir: string,
  agentPubkey: string,
  targetConfigPath: string,
): Promise<string | undefined> {
  const directory = runtimeDirectory(gitCommonDir, agentPubkey);
  const path = resolve(directory, 'runtime.json');
  if (resolve(targetConfigPath) === path) return undefined;
  const link: RuntimeLinkRecord = { version: 3, link: resolve(targetConfigPath) };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch (error) {
    // A read-only or missing git dir must never fail pairing: the runtime
    // itself is already written, and `beeline start --agent` still works.
    console.error(`[beeline] could not write runtime pointer at ${path}:`, error);
    return undefined;
  }
}

function parseRuntimeLink(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const candidate = parsed as Partial<RuntimeLinkRecord> | null;
  if (!candidate || typeof candidate.link !== 'string' || !candidate.link) return undefined;
  return resolve(candidate.link);
}

/** Follow a repo-anchored pointer to the real runtime record path (one hop). */
export async function resolveRuntimeConfigPath(path: string): Promise<string> {
  const resolved = resolve(path);
  let text: string;
  try {
    text = await readFile(resolved, 'utf8');
  } catch {
    return resolved;
  }
  return parseRuntimeLink(text) ?? resolved;
}

export async function readRuntimeRecord(path: string): Promise<AgentRuntimeRecord> {
  const configPath = await resolveRuntimeConfigPath(path);
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as
    AgentRuntimeRecord | LegacyAgentRuntimeRecord;
  if (parsed.version === 1) {
    runtimeIdentity(parsed.agent);
    runtimeIdentity(parsed.body);
    return {
      version: 2,
      communityId: parsed.communityId,
      pairedBy: parsed.pairedBy,
      agent: parsed.agent,
      body: parsed.body,
      rooms: [
        {
          channelId: parsed.channelId,
          repo: parsed.repo,
          ...(parsed.mergeWorker ? { mergeWorker: parsed.mergeWorker } : {}),
          membershipSince: Math.floor(new Date(parsed.createdAt).getTime() / 1000) || 0,
          discoveredAt: parsed.createdAt,
        },
      ],
      supervisorRoot: parsed.repo.gitCommonDir,
      relayBaseUrl: parsed.relayBaseUrl,
      ...(parsed.relayHost ? { relayHost: parsed.relayHost } : {}),
      ...(parsed.llmEnvFile ? { llmEnvFile: parsed.llmEnvFile } : {}),
      agentBinary: parsed.agentBinary,
      mcpBinary: parsed.mcpBinary,
      createdAt: parsed.createdAt,
    };
  }
  if (
    parsed.version !== 2 ||
    !parsed.communityId ||
    !parsed.supervisorRoot ||
    !Array.isArray(parsed.rooms) ||
    parsed.rooms.some(
      (room) =>
        !room.channelId ||
        !room.repo?.root ||
        (room.root !== undefined && (typeof room.root !== 'string' || !room.root)),
    ) ||
    (parsed.agentKind !== undefined && !AGENT_KINDS.includes(parsed.agentKind)) ||
    (parsed.accessPolicy !== undefined && !isAgentAccessPolicy(parsed.accessPolicy)) ||
    (parsed.accessAutoResponse !== undefined && typeof parsed.accessAutoResponse !== 'string') ||
    (parsed.externalMcpCapabilities !== undefined &&
      (!Array.isArray(parsed.externalMcpCapabilities) ||
        parsed.externalMcpCapabilities.some((capability) => !isExternalMcpCapability(capability)) ||
        parsed.accessPolicy !== 'creator')) ||
    (parsed.sandbox !== undefined && !isSandboxPolicy(parsed.sandbox)) ||
    (parsed.sandboxMaskPaths !== undefined &&
      (!Array.isArray(parsed.sandboxMaskPaths) ||
        parsed.sandboxMaskPaths.some(
          (path) => typeof path !== 'string' || !path.trim(),
        ))) ||
    (parsed.modelSelection !== undefined &&
      (typeof parsed.modelSelection !== 'object' ||
        parsed.modelSelection === null ||
        (parsed.modelSelection.model !== undefined &&
          typeof parsed.modelSelection.model !== 'string') ||
        (parsed.modelSelection.effort !== undefined &&
          typeof parsed.modelSelection.effort !== 'string'))) ||
    (parsed.agentCommand !== undefined && !parsed.agentCommand) ||
    (parsed.agentArgs !== undefined &&
      (!Array.isArray(parsed.agentArgs) ||
        parsed.agentArgs.some((argument) => typeof argument !== 'string')))
  ) {
    throw new Error(`invalid agent runtime config: ${configPath}`);
  }
  runtimeIdentity(parsed.agent);
  runtimeIdentity(parsed.body);
  return parsed;
}

/**
 * One-time, idempotent access-policy migration for pre-policy runtime records.
 *
 * `DEFAULT_ACCESS_POLICY` used to be `everyone`: any Room member could drive a
 * paired agent. When the default became `creator`, every record carrying no
 * explicit policy would silently have been re-gated at read time
 * (`runtime.accessPolicy ?? …`) — an already-paired agent would have stopped
 * answering the very senders it has always answered. This stamps the frozen
 * pre-policy behaviour (`LEGACY_ACCESS_POLICY`, i.e. `everyone`) onto such a
 * record so the behaviour becomes durable on disk and independent of whatever
 * the constant says later. A record with ANY explicit policy — including one
 * deliberately set to `creator` — is never touched, so running this twice
 * changes nothing the second time.
 */
export async function migrateRuntimeRecordAccessPolicy(
  pathOrPointer: string,
): Promise<{ configPath: string; runtime: AgentRuntimeRecord; migrated: boolean }> {
  const configPath = await resolveRuntimeConfigPath(pathOrPointer);
  const runtime = await readRuntimeRecord(configPath);
  if (runtime.accessPolicy) return { configPath, runtime, migrated: false };
  // Only rewrite a canonical record. A pointer or stray copy may be read to
  // serve the daemon, but nothing is written behind it — mirroring
  // `updateRuntimeRelay`'s guard.
  const canonicalConfigPath = resolve(
    runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey),
    'runtime.json',
  );
  if (resolve(configPath) !== canonicalConfigPath) {
    return { configPath, runtime, migrated: false };
  }
  const updated: AgentRuntimeRecord = { ...runtime, accessPolicy: LEGACY_ACCESS_POLICY };
  await writeRuntimeRecord(updated);
  return { configPath, runtime: updated, migrated: true };
}

/**
 * Retire one paired agent without destroying its identity.
 *
 * The runtime directory contains the agent's Nostr secret key, so teardown is
 * a recoverable rename into the state root's `deleted-runtimes` directory,
 * never a recursive delete. Repo-anchored link records contain no key and are
 * removed after the archive succeeds so `beeline start` does not advertise a
 * retired runtime.
 */
export async function removeAgentRuntime(
  configPath: string,
  expectedAgentPubkey: string,
  pointerRoots: string[] = [],
): Promise<string> {
  const resolvedConfig = resolve(configPath);
  const directory = dirname(resolvedConfig);
  if (
    basename(resolvedConfig) !== 'runtime.json' ||
    basename(directory) !== expectedAgentPubkey ||
    basename(dirname(directory)) !== 'agents'
  ) {
    throw new Error(`refusing to remove unexpected agent runtime path: ${resolvedConfig}`);
  }
  const stateRoot = dirname(dirname(dirname(directory)));
  const trashRoot = resolve(stateRoot, 'deleted-runtimes');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivedDirectory = resolve(trashRoot, `${expectedAgentPubkey}-${timestamp}`);
  await mkdir(trashRoot, { recursive: true, mode: 0o700 });
  await rename(directory, archivedDirectory);
  // A restored archive must not inherit the retired daemon's PID and mistake
  // an unrelated future process for an already-running agent.
  await rm(resolve(archivedDirectory, 'daemon.pid'), { force: true });
  // Repo-anchored pointers would otherwise keep advertising a runtime that no
  // longer exists to `beeline start`.
  for (const pointerRoot of pointerRoots) {
    const pointerDirectory = runtimeDirectory(pointerRoot, expectedAgentPubkey);
    if (pointerDirectory === directory) continue;
    const pointer = await readFile(resolve(pointerDirectory, 'runtime.json'), 'utf8').catch(
      () => undefined,
    );
    if (pointer && parseRuntimeLink(pointer)) {
      await rm(pointerDirectory, { recursive: true, force: true });
    }
  }
  return archivedDirectory;
}

async function runtimeConfigPathsIn(agentsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }
  return Promise.all(
    entries.map((entry) => resolveRuntimeConfigPath(resolve(agentsDir, entry, 'runtime.json'))),
  );
}

/**
 * Runtimes reachable from a checkout. The repo-anchored path is now usually a
 * pointer to the agent state home; a runtime paired before the move still has
 * its real record there and resolves to itself.
 */
export async function findRuntimeConfigPaths(cwd: string): Promise<string[]> {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error('beeline start must be run inside a paired git repository');
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitCommonDir = common
    ? resolve(root, common)
    : resolve(root, git(root, ['rev-parse', '--git-common-dir']) ?? '.git');
  return runtimeConfigPathsIn(agentsDirectory(gitCommonDir));
}

/**
 * Runtimes reachable for host-scoped commands: the machine-local state home,
 * legacy records in the optional current checkout, and repositories bound to
 * a discovered runtime's Rooms. Passing no cwd preserves a state-home-only
 * library scan for callers that do not have a command checkout.
 */
export async function findAgentRuntimeConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Promise<string[]> {
  // The machine-local state home is the canonical location for new records,
  // but older agents still own their record in a paired checkout's git common
  // dir. Start from the state home, then use each stored Room binding to find
  // those legacy records. Include the checkout the command was run from too:
  // an all-legacy fleet has no state record from which to learn its repo.
  const configs = new Set(await runtimeConfigPathsIn(agentsDirectory(defaultSupervisorRoot(env))));
  const configQueue = [...configs];
  const inspectedConfigs = new Set<string>();
  const gitCommonDirs = new Set<string>();
  const gitCommonDirQueue: string[] = [];
  const addGitCommonDir = (gitCommonDir: string) => {
    if (!gitCommonDirs.has(gitCommonDir)) {
      gitCommonDirs.add(gitCommonDir);
      gitCommonDirQueue.push(gitCommonDir);
    }
  };
  const currentRepo = cwd ? tryInspectLocalRepository(cwd) : null;
  if (currentRepo) addGitCommonDir(currentRepo.gitCommonDir);

  // Walk the small graph of runtimes and their Room repositories. A legacy
  // runtime found through one Room may itself name a second repository, so
  // stopping after the first state-home scan would still leave part of a
  // mixed-age fleet behind.
  while (configQueue.length || gitCommonDirQueue.length) {
    const configPath = configQueue.shift();
    if (configPath && !inspectedConfigs.has(configPath)) {
      inspectedConfigs.add(configPath);
      const runtime = await readRuntimeRecord(configPath).catch(() => undefined);
      for (const room of runtime?.rooms ?? []) {
        if (typeof room.repo?.gitCommonDir === 'string' && room.repo.gitCommonDir) {
          addGitCommonDir(room.repo.gitCommonDir);
        }
      }
      continue;
    }

    const gitCommonDir = gitCommonDirQueue.shift();
    if (!gitCommonDir) continue;
    for (const discoveredPath of await runtimeConfigPathsIn(agentsDirectory(gitCommonDir))) {
      if (!configs.has(discoveredPath)) {
        configs.add(discoveredPath);
        configQueue.push(discoveredPath);
      }
    }
  }
  return [...configs];
}

export async function runtimeDaemonPid(configPath: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(resolve(dirname(configPath), 'daemon.pid'), 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Gracefully stop a stored daemon and wait until it is safe to launch its replacement. */
/**
 * Whether one live process is `beeline daemon --config <configPath>`.
 *
 * `/proc/<pid>/cmdline` (Linux) gives exact argv; macOS has no /proc, so fall
 * back to a whole-command match against `ps -o command=` — the daemon is
 * always launched with an absolute, resolved config path, so a substring
 * match on it is sufficient identification there. Both sources fail closed:
 * an unreadable answer returns false and the caller refuses to signal a
 * process it could not identify.
 */
async function daemonIsThisRuntime(pid: number, configPath: string): Promise<boolean> {
  let argumentsForPid: string[] | undefined;
  try {
    argumentsForPid = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  const wanted = resolve(configPath);
  if (!argumentsForPid) {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
      const command = stdout.trim();
      return command.includes(' daemon ') && command.includes('--config') && command.includes(wanted);
    } catch {
      return false;
    }
  }
  const configFlag = argumentsForPid.lastIndexOf('--config');
  const processConfigPath = argumentsForPid[configFlag + 1];
  return Boolean(
    configFlag >= 1 &&
      argumentsForPid[configFlag - 1] === 'daemon' &&
      processConfigPath &&
      resolve(processConfigPath) === wanted,
  );
}

export async function stopRuntimeDaemon(
  pathOrPointer: string,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    /** Invoked while waiting for the daemon to finish its graceful drain. */
    onWait?: (pid: number, waitedMs: number) => void;
  } = {},
): Promise<number | null> {
  const configPath = await resolveRuntimeConfigPath(pathOrPointer);
  const pid = await runtimeDaemonPid(configPath);
  if (!pid) return null;
  if (!(await daemonIsThisRuntime(pid, configPath))) {
    throw new Error(
      `pid ${pid} does not belong to the daemon for ${configPath}; refusing to stop it`,
    );
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    throw error;
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const startedAt = Date.now();
  const pollMs = opts.pollMs ?? 100;
  let lastWaitNoticeAt = startedAt;
  while (Date.now() < deadline) {
    if ((await runtimeDaemonPid(configPath)) === null) return pid;
    // The daemon drains in-flight agent work before exiting (SIGTERM →
    // supervisor stopAll → Body.dispose awaits every running turn), so a long
    // wait is the restart NOT interrupting work — surface it, don't escalate.
    if (opts.onWait && Date.now() - lastWaitNoticeAt >= 5_000) {
      lastWaitNoticeAt = Date.now();
      opts.onWait(pid, Date.now() - startedAt);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  throw new Error(`agent daemon ${pid} did not stop after ${opts.timeoutMs ?? 10_000}ms`);
}

export async function launchRuntimeDaemon(
  configPath: string,
  opts: { entrypoint?: string; execArgv?: string[]; env?: NodeJS.ProcessEnv; foreground?: boolean } = {},
): Promise<number> {
  const directory = dirname(configPath);
  const logPath = resolve(directory, 'daemon.log');
  const pidPath = resolve(directory, 'daemon.pid');
  // A foreground daemon (`beeline daemon --config …` on a tty) that hands over
  // to a self-updated replacement must stay attached to its terminal: stdio
  // inherits and the child is NOT detached, so Ctrl-C keeps reaching the
  // daemon the operator is watching.
  const foreground = opts.foreground === true;
  const output = foreground ? 'inherit' : openSync(logPath, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [
      ...(opts.execArgv ?? process.execArgv),
      opts.entrypoint ?? process.argv[1]!,
      'daemon',
      '--config',
      configPath,
    ],
    {
      detached: !foreground,
      stdio: ['ignore', output, output],
      env: { ...(opts.env ?? process.env), BEELINE_DAEMON_BACKGROUND: '1' },
    },
  );
  await new Promise<void>((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn);
    child.once('error', reject);
  });
  if (!foreground) closeSync(output as number);
  child.unref();
  await writeFile(pidPath, `${child.pid}\n`, { mode: 0o600 });
  return child.pid!;
}

export async function pairRepositoryAgent(
  input: {
    code: string;
    cwd: string;
    /**
     * The repository binding to record for the Room created at pair time.
     * Omitted derives it from `cwd` and fails when cwd is not a git
     * repository (the historical behaviour); an explicit `null` pairs the
     * agent with NO repository binding, which is a fully valid
     * configuration since room-owns-repo.
     */
    repo?: LocalRepositoryBinding | null;
    relayBaseUrl: string;
    relayHost?: string;
    llmEnvFile?: string;
    agentBinary: string;
    agentKind?: AgentKind;
    agentCommand?: string;
    agentArgs?: string[];
    accessPolicy?: AgentAccessPolicy;
    accessAutoResponse?: string;
    externalMcpCapabilities?: ExternalMcpCapability[];
    modelSelection?: { model?: string; effort?: string };
    mcpBinary: string;
    agentIdentity: Identity;
    bodyIdentity: Identity;
    mergeWorkerIdentity: Identity;
    /** Override the machine-local agent state root (tests, unusual layouts). */
    supervisorRoot?: string;
    env?: NodeJS.ProcessEnv;
  },
  deps: {
    redeem(code: string): Promise<RedeemAgentPairingResult>;
    resolveRoom(
      pairing: RedeemAgentPairingResult,
      repository: RepositoryBinding,
      mergeWorkerPubkey?: string,
    ): Promise<RepositoryRoomResult>;
    validate?(
      pairing: RedeemAgentPairingResult,
      room: RepositoryRoomResult,
      repo: LocalRepositoryBinding,
    ): Promise<void>;
    launch?(configPath: string): Promise<number>;
    /**
     * Best-effort undo of `redeem`'s Workspace registration, called only when
     * a step between redemption and the runtime record landing on disk throws.
     * Must never throw itself — a real pairing error is already propagating.
     */
    abandonPairing?(pairing: RedeemAgentPairingResult): Promise<unknown>;
  },
): Promise<PairRuntimeResult> {
  if (input.externalMcpCapabilities?.length && input.accessPolicy !== 'creator') {
    throw new Error('external MCP capabilities require creator access');
  }
  // The runtime root is machine-local agent state, deliberately not the paired
  // repository's `.git`. The repository binding for this Room is `repo` below.
  const supervisorRoot = input.supervisorRoot
    ? resolve(input.supervisorRoot)
    : defaultSupervisorRoot(input.env);
  // S0 — fail-closed multi-identity guard. Every agent in a Workspace must own
  // a fresh keypair. Runtime storage is keyed by agent pubkey, so a runtime
  // already sitting at this pubkey means the identity is being reused for a
  // second agent (a pinned BUZZ_AGENT_KEY across pairings). Refuse rather than
  // silently overwrite the first agent's binding and share one Nostr identity.
  await assertAgentIdentityUnpaired(supervisorRoot, input.agentIdentity.publicKey);
  // Resolve the repository before consuming the one-shot pairing code. An
  // explicit `null` pairs the agent with no repository binding at all — see
  // `input.repo` above.
  const repo = input.repo === undefined ? inspectLocalRepository(input.cwd) : input.repo;
  // Last host-local precondition before the irreversible relay writes below.
  await assertRuntimeStorageWritable(supervisorRoot, input.agentIdentity.publicKey);
  const runtimeRoot = runtimeDirectory(supervisorRoot, input.agentIdentity.publicKey);
  // ── Everything from here to `writeRuntimeRecord` is the half-created window.
  // `redeem` self-adds the agent as a Workspace member and publishes its
  // identity record; both are irreversible relay writes, and `resolveRoom`,
  // `validate` and the runtime write can all still fail after them. A failure
  // there used to leave the agent registered with no daemon behind it — a
  // permanently-offline ghost in the Workspace that the operator cannot even
  // re-pair, because the one-shot code is already spent. Undo the registration
  // instead, best-effort, and only when this run is the one that added it.
  const pairing = await deps.redeem(input.code);
  let configPath: string;
  let room: RepositoryRoomResult | undefined;
  let runtime: AgentRuntimeRecord;
  try {
    room = repo
      ? await deps.resolveRoom(
          pairing,
          repo.repository,
          repo.relayRepo ? input.mergeWorkerIdentity.publicKey : undefined,
        )
      : undefined;
    if (repo && room) await deps.validate?.(pairing, room, repo);
    runtime = {
      version: 2,
      communityId: pairing.communityId,
      pairedBy: pairing.pairedBy,
      agent: storeIdentity(input.agentIdentity, DEFAULT_AGENT_IDENTITY_NAME),
      body: storeIdentity(input.bodyIdentity, DEFAULT_BODY_IDENTITY_NAME),
      // Empty when pairing with no repository: the supervisor discovers every
      // Room this agent is invited to from relay membership and materializes
      // each Room's own repository on demand (`WorkspaceSupervisor.reconcile`).
      rooms:
        repo && room
          ? [
              {
                channelId: room.channelId,
                repo,
                root: resolve(runtimeRoot, 'rooms', room.channelId),
                ...(repo.relayRepo && room.mergeWorkerProvisioned
                  ? { mergeWorker: storeIdentity(input.mergeWorkerIdentity, 'beeline-merge-worker') }
                  : {}),
                membershipSince: Math.floor(Date.now() / 1000),
                discoveredAt: new Date().toISOString(),
              },
            ]
          : [],
      supervisorRoot,
      relayBaseUrl: input.relayBaseUrl,
      ...(input.relayHost ? { relayHost: input.relayHost } : {}),
      ...(input.llmEnvFile ? { llmEnvFile: input.llmEnvFile } : {}),
      // Every new pairing stores an EXPLICIT policy, defaulting to owner-only
      // (DEFAULT_ACCESS_POLICY = 'creator'), so a record written from now on
      // never depends on the constant at read time.
      accessPolicy: input.accessPolicy ?? DEFAULT_ACCESS_POLICY,
      ...(input.accessAutoResponse ? { accessAutoResponse: input.accessAutoResponse } : {}),
      ...(input.externalMcpCapabilities?.length
        ? { externalMcpCapabilities: [...new Set(input.externalMcpCapabilities)] }
        : {}),
      ...(input.modelSelection?.model || input.modelSelection?.effort
        ? { modelSelection: input.modelSelection }
        : {}),
      agentKind: input.agentKind ?? 'reference',
      agentCommand: input.agentCommand ?? input.agentBinary,
      agentArgs: [...(input.agentArgs ?? [])],
      agentBinary: input.agentCommand ?? input.agentBinary,
      mcpBinary: input.mcpBinary,
      createdAt: new Date().toISOString(),
    };
    configPath = await writeRuntimeRecord(runtime);
  } catch (error) {
    if (pairing.joined) await deps.abandonPairing?.(pairing).catch(() => undefined);
    throw error;
  }
  // Past this line the pairing is complete and recoverable from disk, so a
  // failure must NOT roll the registration back: that would delete a valid
  // agent the host still believes it owns. `writeRuntimePointer` already
  // swallows its own errors, and a daemon that fails to launch is started by
  // `beeline start --agent <pubkey>`.
  //
  // `beeline start` from inside the paired checkout keeps working. With no
  // repository there is no checkout to anchor a pointer in; `beeline start`
  // finds the agent in the machine-local state home instead.
  if (repo) await writeRuntimePointer(repo.gitCommonDir, runtime.agent.publicKey, configPath);
  let pid: number;
  try {
    pid = await (deps.launch ?? launchRuntimeDaemon)(configPath);
  } catch (error) {
    throw new Error(
      `agent ${runtime.agent.publicKey} is paired, but its daemon did not start: ${
        error instanceof Error ? error.message : String(error)
      }. Do not re-run \`beeline pair\` (the code is spent) — run ` +
        `\`beeline start --agent ${runtime.agent.publicKey}\`.`,
      { cause: error },
    );
  }
  return { pairing, ...(room ? { room } : {}), runtime, configPath, pid };
}
