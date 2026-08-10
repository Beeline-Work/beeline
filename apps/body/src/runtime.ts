import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { decodeNsec, getPublicKey } from '@beeline/nostr';
import { newIdentity, type Identity } from '@beeline/gate';
import type {
  RedeemAgentPairingResult,
  RepositoryBinding,
  RepositoryRoomResult,
} from '@beeline/buzz-client';

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
  version: 1;
  communityId: string;
  channelId: string;
  pairedBy: string;
  agent: StoredIdentity;
  body: StoredIdentity;
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
  room: RepositoryRoomResult;
  runtime: AgentRuntimeRecord;
  configPath: string;
  pid: number;
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

/** Inspect the git repository at cwd and derive its immutable Room binding. */
export function inspectLocalRepository(cwd: string): LocalRepositoryBinding {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error('beeline pair must be run inside a git repository');
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

export function runtimeDirectory(repo: LocalRepositoryBinding, agentPubkey: string): string {
  return resolve(repo.gitCommonDir, 'beeline', 'agents', agentPubkey);
}

export async function writeRuntimeRecord(record: AgentRuntimeRecord): Promise<string> {
  const directory = runtimeDirectory(record.repo, record.agent.publicKey);
  const path = resolve(directory, 'runtime.json');
  const temporary = resolve(directory, `runtime-${process.pid}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return path;
}

export async function readRuntimeRecord(path: string): Promise<AgentRuntimeRecord> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as AgentRuntimeRecord;
  if (parsed.version !== 1 || !parsed.channelId || !parsed.repo?.root) {
    throw new Error(`invalid agent runtime config: ${path}`);
  }
  runtimeIdentity(parsed.agent);
  runtimeIdentity(parsed.body);
  return parsed;
}

export async function findRuntimeConfigPaths(cwd: string): Promise<string[]> {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error('buzz start must be run inside a paired git repository');
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitCommonDir = common
    ? resolve(root, common)
    : resolve(root, git(root, ['rev-parse', '--git-common-dir']) ?? '.git');
  const agentsDir = resolve(gitCommonDir, 'beeline', 'agents');
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }
  return entries.map((entry) => resolve(agentsDir, entry, 'runtime.json'));
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
    relayBaseUrl: string;
    relayHost?: string;
    llmEnvFile?: string;
    agentBinary: string;
    mcpBinary: string;
    agentIdentity: Identity;
    bodyIdentity: Identity;
  },
  deps: {
    redeem(code: string): Promise<RedeemAgentPairingResult>;
    resolveRoom(
      pairing: RedeemAgentPairingResult,
      repository: RepositoryBinding,
    ): Promise<RepositoryRoomResult>;
    validate?(
      pairing: RedeemAgentPairingResult,
      room: RepositoryRoomResult,
      repo: LocalRepositoryBinding,
    ): Promise<void>;
    launch?(configPath: string): Promise<number>;
  },
): Promise<PairRuntimeResult> {
  // Resolve the repository before consuming the one-shot pairing code.
  const repo = inspectLocalRepository(input.cwd);
  const pairing = await deps.redeem(input.code);
  const room = await deps.resolveRoom(pairing, repo.repository);
  await deps.validate?.(pairing, room, repo);
  const runtime: AgentRuntimeRecord = {
    version: 1,
    communityId: pairing.communityId,
    channelId: room.channelId,
    pairedBy: pairing.pairedBy,
    agent: storeIdentity(input.agentIdentity, 'buzzy-agent'),
    body: storeIdentity(input.bodyIdentity, 'buzzy-body'),
    repo,
    relayBaseUrl: input.relayBaseUrl,
    ...(input.relayHost ? { relayHost: input.relayHost } : {}),
    ...(input.llmEnvFile ? { llmEnvFile: input.llmEnvFile } : {}),
    agentBinary: input.agentBinary,
    mcpBinary: input.mcpBinary,
    createdAt: new Date().toISOString(),
  };
  const configPath = await writeRuntimeRecord(runtime);
  const pid = await (deps.launch ?? launchRuntimeDaemon)(configPath);
  return { pairing, room, runtime, configPath, pid };
}
