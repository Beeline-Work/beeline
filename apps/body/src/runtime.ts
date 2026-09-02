import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeNsec, getPublicKey } from '@beeline/nostr';
import { DEFAULT_ACCESS_POLICY, LEGACY_ACCESS_POLICY, type AgentAccessPolicy } from './access-policy.js';
import type { AgentCommand, AgentKind } from './agent-command.js';
import type { ExternalMcpCapability } from './external-mcp-capabilities.js';
import type { SandboxPolicy } from './bwrap-sandbox.js';

const execFileAsync = promisify(execFile);
const DEFAULT_AGENT_IDENTITY_NAME = 'beeline-agent';
const DEFAULT_BODY_IDENTITY_NAME = 'beeline-body';
export const DEFAULT_DAEMON_MONOLITH_BASE_URL = 'https://server.usebeeline.app';

export interface Identity {
  name: string;
  secretKey: Uint8Array;
  publicKey: string;
}

interface StoredIdentity {
  name: string;
  secretKeyHex: string;
  publicKey: string;
}

export interface RoomRuntimeRecord {
  channelId: string;
  root?: string;
  membershipSince?: number;
  discoveredAt?: string;
  repo: {
    root: string;
    gitCommonDir?: string;
    targetBranch?: string;
    repository?: { key?: string; name?: string; remote?: string; localOnly?: boolean };
  };
}

export interface AgentRuntimeRecord {
  version: 2;
  communityId: string;
  pairedBy: string;
  agent: StoredIdentity;
  body: StoredIdentity;
  rooms: RoomRuntimeRecord[];
  supervisorRoot: string;
  transport?:
    | { kind: 'monolith'; baseUrl: string; exchangeToken: string; daemonToken?: never }
    | { kind: 'monolith'; baseUrl: string; daemonToken: string; exchangeToken?: never };
  llmEnvFile?: string;
  accessPolicy?: AgentAccessPolicy;
  accessAllowlist?: string[];
  accessAutoResponse?: string;
  externalMcpCapabilities?: ExternalMcpCapability[];
  modelSelection?: { model?: string; effort?: string };
  agentKind?: AgentKind;
  agentCommand?: string;
  agentArgs?: string[];
  agentBinary: string;
  mcpBinary: string;
  sharedSkills?: string[];
  sandbox?: SandboxPolicy;
  sandboxMaskPaths?: string[];
}

export function defaultSupervisorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.XDG_STATE_HOME ?? resolve(homedir(), '.local', 'state'));
}

export function runtimeDirectory(supervisorRoot: string, publicKey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(publicKey)) throw new Error('invalid agent public key');
  return resolve(supervisorRoot, 'beeline', 'agents', publicKey.toLowerCase());
}

export function runtimeConfigPath(supervisorRoot: string, publicKey: string): string {
  return resolve(runtimeDirectory(supervisorRoot, publicKey), 'runtime.json');
}

export function identityFromKey(value: string | undefined, name: string): Identity {
  const secretKey = value
    ? value.startsWith('nsec1')
      ? decodeNsec(value)
      : Uint8Array.from(Buffer.from(value, 'hex'))
    : randomBytes(32);
  if (secretKey.length !== 32) throw new Error('identity secret key must be 32 bytes');
  return { name, secretKey, publicKey: getPublicKey(secretKey) };
}

function storeIdentity(identity: Identity, fallback: string): StoredIdentity {
  return {
    name: identity.name || fallback,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    publicKey: identity.publicKey,
  };
}

export function runtimeIdentity(identity: StoredIdentity): Identity {
  const restored = identityFromKey(identity.secretKeyHex, identity.name);
  if (restored.publicKey !== identity.publicKey) throw new Error('stored identity public key mismatch');
  return restored;
}

export function runtimeAgentCommand(runtime: AgentRuntimeRecord): AgentCommand {
  return {
    kind: runtime.agentKind ?? 'reference',
    command: runtime.agentCommand ?? runtime.agentBinary,
    args: runtime.agentArgs ?? [],
  };
}

export async function writeRuntimeRecord(runtime: AgentRuntimeRecord): Promise<string> {
  const path = runtimeConfigPath(runtime.supervisorRoot, runtime.agent.publicKey);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, path);
  return path;
}

export async function readRuntimeRecord(path: string): Promise<AgentRuntimeRecord> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as AgentRuntimeRecord;
  if (parsed.version !== 2 || !parsed.agent || !parsed.body || !parsed.communityId) {
    throw new Error(`invalid agent runtime record: ${path}`);
  }
  parsed.rooms ??= [];
  runtimeIdentity(parsed.agent);
  runtimeIdentity(parsed.body);
  return parsed;
}

export async function migrateRuntimeRecordAccessPolicy(
  path: string,
): Promise<{ runtime: AgentRuntimeRecord; migrated: boolean }> {
  const runtime = await readRuntimeRecord(path);
  if (runtime.accessPolicy) return { runtime, migrated: false };
  runtime.accessPolicy = LEGACY_ACCESS_POLICY;
  await writeRuntimeRecord(runtime);
  return { runtime, migrated: true };
}

export async function stageMonolithAgentRuntime(input: {
  workspaceId: string;
  pairedBy: string;
  monolithBaseUrl?: string;
  daemonExchangeToken: string;
  llmEnvFile?: string;
  agentBinary: string;
  agentKind: AgentKind;
  agentCommand: string;
  agentArgs: string[];
  modelSelection?: { model?: string; effort?: string };
  mcpBinary: string;
  agentIdentity: Identity;
  bodyIdentity: Identity;
  supervisorRoot?: string;
}): Promise<{ runtime: AgentRuntimeRecord; configPath: string }> {
  const supervisorRoot = input.supervisorRoot
    ? resolve(input.supervisorRoot)
    : defaultSupervisorRoot();
  const configPath = runtimeConfigPath(supervisorRoot, input.agentIdentity.publicKey);
  const configuredBaseUrl = input.monolithBaseUrl ?? DEFAULT_DAEMON_MONOLITH_BASE_URL;
  const baseUrl = new URL(configuredBaseUrl).origin;
  if (baseUrl !== configuredBaseUrl || !/^https?:$/.test(new URL(baseUrl).protocol)) {
    throw new Error('monolith base URL must be an HTTP or HTTPS origin');
  }
  if (!/^bde_[A-Za-z0-9_-]{43}$/.test(input.daemonExchangeToken)) {
    throw new Error('daemon exchange token is invalid');
  }
  try {
    await stat(configPath);
    const existing = await readRuntimeRecord(configPath);
    const transport = existing.transport;
    const sameRuntime =
      existing.communityId === input.workspaceId &&
      existing.pairedBy === input.pairedBy &&
      existing.agent.publicKey === input.agentIdentity.publicKey &&
      existing.agent.secretKeyHex === Buffer.from(input.agentIdentity.secretKey).toString('hex') &&
      existing.body.publicKey === input.bodyIdentity.publicKey &&
      transport?.kind === 'monolith' &&
      transport.baseUrl === baseUrl &&
      ('daemonToken' in transport || transport.exchangeToken === input.daemonExchangeToken);
    if (!sameRuntime) {
      throw new Error(`agent identity ${input.agentIdentity.publicKey} already has another runtime`);
    }
    return { runtime: existing, configPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const runtime: AgentRuntimeRecord = {
    version: 2,
    communityId: input.workspaceId,
    pairedBy: input.pairedBy,
    agent: storeIdentity(input.agentIdentity, DEFAULT_AGENT_IDENTITY_NAME),
    body: storeIdentity(input.bodyIdentity, DEFAULT_BODY_IDENTITY_NAME),
    rooms: [],
    supervisorRoot,
    transport: { kind: 'monolith', baseUrl, exchangeToken: input.daemonExchangeToken },
    ...(input.llmEnvFile ? { llmEnvFile: input.llmEnvFile } : {}),
    accessPolicy: DEFAULT_ACCESS_POLICY,
    agentBinary: input.agentBinary,
    agentKind: input.agentKind,
    agentCommand: input.agentCommand,
    agentArgs: [...input.agentArgs],
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    mcpBinary: input.mcpBinary,
  };
  await writeRuntimeRecord(runtime);
  return { runtime, configPath };
}

async function runtimePaths(root: string): Promise<string[]> {
  const agents = resolve(root, 'beeline', 'agents');
  const entries = await readdir(agents, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(agents, entry.name, 'runtime.json'));
}

export async function findAgentRuntimeConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
  _cwd = process.cwd(),
): Promise<string[]> {
  return runtimePaths(defaultSupervisorRoot(env));
}

export async function findRuntimeConfigPaths(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return findAgentRuntimeConfigPaths(env, cwd);
}

export async function resolveRuntimeConfigPath(path: string): Promise<string> {
  return resolve(path);
}

export async function selectRuntimeConfigPaths(options: {
  cwd: string;
  all: boolean;
  requestedPubkey?: string;
  findHostRuntimes: (cwd: string) => Promise<string[]>;
  findRepositoryRuntimes: (cwd: string) => Promise<string[]>;
  noRuntimeMessage: (hostScope: boolean) => string;
  multipleRuntimeMessage: string;
}): Promise<{ paths: string[]; hostScope: boolean }> {
  const hostScope = true;
  const configs = await options.findHostRuntimes(options.cwd);
  const requestedPubkey = options.requestedPubkey;
  const paths = requestedPubkey
    ? configs.filter((path) => dirname(path).endsWith(requestedPubkey))
    : [...new Set(configs)];
  if (!paths.length) throw new Error(options.noRuntimeMessage(hostScope));
  if (options.requestedPubkey && paths.length > 1) throw new Error(options.multipleRuntimeMessage);
  return { paths, hostScope };
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

async function daemonIsThisRuntime(pid: number, configPath: string): Promise<boolean> {
  try {
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    const flag = argv.lastIndexOf('--config');
    return flag > 0 && argv[flag - 1] === 'daemon' && resolve(argv[flag + 1]!) === resolve(configPath);
  } catch {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
      return stdout.includes(' daemon ') && stdout.includes(resolve(configPath));
    } catch {
      return false;
    }
  }
}

export async function stopRuntimeDaemon(
  path: string,
  opts: { timeoutMs?: number; pollMs?: number; onWait?: (pid: number, waitedMs: number) => void } = {},
): Promise<number | null> {
  const configPath = await resolveRuntimeConfigPath(path);
  const pid = await runtimeDaemonPid(configPath);
  if (!pid) return null;
  if (!(await daemonIsThisRuntime(pid, configPath))) {
    throw new Error(`pid ${pid} does not belong to the daemon for ${configPath}`);
  }
  process.kill(pid, 'SIGTERM');
  const started = Date.now();
  const timeout = opts.timeoutMs ?? 10_000;
  while (Date.now() - started < timeout) {
    if ((await runtimeDaemonPid(configPath)) === null) return pid;
    opts.onWait?.(pid, Date.now() - started);
    await new Promise((resolveWait) => setTimeout(resolveWait, opts.pollMs ?? 100));
  }
  throw new Error(`agent daemon ${pid} did not stop after ${timeout}ms`);
}

export async function launchRuntimeDaemon(
  configPath: string,
  opts: { entrypoint?: string; execArgv?: string[]; env?: NodeJS.ProcessEnv; foreground?: boolean } = {},
): Promise<number> {
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const foreground = opts.foreground === true;
  const output = foreground ? 'inherit' : openSync(resolve(directory, 'daemon.log'), 'a', 0o600);
  const entrypoint = opts.entrypoint ?? process.argv[1];
  if (!entrypoint) throw new Error('cannot resolve daemon CLI entrypoint');
  const child = spawn(process.execPath, [...(opts.execArgv ?? []), entrypoint, 'daemon', '--config', resolve(configPath)], {
    cwd: directory,
    env: opts.env ?? process.env,
    detached: !foreground,
    stdio: ['ignore', output, output],
  });
  if (!foreground) {
    child.unref();
    if (typeof output === 'number') closeSync(output);
  }
  if (!child.pid) throw new Error('daemon process did not start');
  return child.pid;
}

export async function removeAgentRuntime(runtime: AgentRuntimeRecord): Promise<string> {
  const source = runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey);
  const deletedRoot = resolve(runtime.supervisorRoot, 'beeline', 'deleted-runtimes');
  await mkdir(deletedRoot, { recursive: true, mode: 0o700 });
  const target = resolve(deletedRoot, `${runtime.agent.publicKey}-${Date.now()}`);
  await rename(source, target);
  return target;
}
