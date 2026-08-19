import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { decodeNsec, getPublicKey } from '@beeline/nostr';
import { newIdentity, type Identity } from '@beeline/gate';
import type {
  RedeemAgentPairingResult,
  RepositoryBinding,
  RepositoryRoomResult,
} from '@beeline/buzz-client';
import { AGENT_KINDS, type AgentCommand, type AgentKind } from './agent-command.js';
import { isAgentAccessPolicy, type AgentAccessPolicy } from './access-policy.js';

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
  /**
   * Pair-time default model/effort, set by `--model`/`--effort` and applied
   * by `Body.applyModelConfigForSession` (`body.ts`) whenever no human has
   * yet set an explicit in-app selection (#223) for this agent — the same
   * `session/set_config_option` mechanism, just seeded before any picker
   * write exists. Never validated again after pairing; the pairing CLI
   * already checked it against the agent's live advertised catalog.
   */
  modelSelection?: { model?: string; effort?: string };
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
      '`beeline start --agent <pubkey>`, or unset BUZZ_AGENT_KEY/BUZZ_PRIVATE_KEY to mint a new identity.',
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

/** Remove the exact machine-local runtime owned by one paired agent. */
export async function removeAgentRuntime(
  configPath: string,
  expectedAgentPubkey: string,
  pointerRoots: string[] = [],
): Promise<void> {
  const resolvedConfig = resolve(configPath);
  const directory = dirname(resolvedConfig);
  if (
    basename(resolvedConfig) !== 'runtime.json' ||
    basename(directory) !== expectedAgentPubkey ||
    basename(dirname(directory)) !== 'agents'
  ) {
    throw new Error(`refusing to remove unexpected agent runtime path: ${resolvedConfig}`);
  }
  await rm(directory, { recursive: true, force: true });
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
 * Runtimes in the machine-local agent state home, so starting an agent no
 * longer requires standing in the specific repository it was paired in.
 */
export async function findAgentRuntimeConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return runtimeConfigPathsIn(agentsDirectory(defaultSupervisorRoot(env)));
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

export async function launchRuntimeDaemon(
  configPath: string,
  opts: { entrypoint?: string; execArgv?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const directory = dirname(configPath);
  const logPath = resolve(directory, 'daemon.log');
  const pidPath = resolve(directory, 'daemon.pid');
  const output = openSync(logPath, 'a', 0o600);
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
      detached: true,
      stdio: ['ignore', output, output],
      env: opts.env ?? process.env,
    },
  );
  await new Promise<void>((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn);
    child.once('error', reject);
  });
  closeSync(output);
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
  },
): Promise<PairRuntimeResult> {
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
  const pairing = await deps.redeem(input.code);
  const room = repo
    ? await deps.resolveRoom(
        pairing,
        repo.repository,
        repo.relayRepo ? input.mergeWorkerIdentity.publicKey : undefined,
      )
    : undefined;
  if (repo && room) await deps.validate?.(pairing, room, repo);
  const runtimeRoot = runtimeDirectory(supervisorRoot, input.agentIdentity.publicKey);
  const runtime: AgentRuntimeRecord = {
    version: 2,
    communityId: pairing.communityId,
    pairedBy: pairing.pairedBy,
    agent: storeIdentity(input.agentIdentity, 'buzzy-agent'),
    body: storeIdentity(input.bodyIdentity, 'buzzy-body'),
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
                ? { mergeWorker: storeIdentity(input.mergeWorkerIdentity, 'buzzy-merge-worker') }
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
    ...(input.accessPolicy ? { accessPolicy: input.accessPolicy } : {}),
    ...(input.accessAutoResponse ? { accessAutoResponse: input.accessAutoResponse } : {}),
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
  const configPath = await writeRuntimeRecord(runtime);
  // `beeline start` from inside the paired checkout keeps working. With no
  // repository there is no checkout to anchor a pointer in; `beeline start`
  // finds the agent in the machine-local state home instead.
  if (repo) await writeRuntimePointer(repo.gitCommonDir, runtime.agent.publicKey, configPath);
  const pid = await (deps.launch ?? launchRuntimeDaemon)(configPath);
  return { pairing, ...(room ? { room } : {}), runtime, configPath, pid };
}
