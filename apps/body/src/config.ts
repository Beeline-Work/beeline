/**
 * Body runtime config.
 *
 * LLM credentials are loaded from the process environment (or an optional
 * dotenv-style file driven by $BUZZY_BODY_LLM_FILE). Values are never logged.
 * The file provides `BUZZY_LLM_*` vars; we map those onto buzz-agent's
 * `OPENAI_COMPAT_*` names.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOST, SCHEME, BASE_URL } from '@beeline/gate';
import { DEFAULT_RELAY_HOST, DEFAULT_RELAY_SCHEME } from '@beeline/buzz-client';
import {
  executableOnPath,
  resolveAgentCommand,
  type AgentCommand,
  type AgentKind,
} from './agent-command.js';

export type SessionMode = 'readonly' | 'edit';

/** Mutation-class tool names that must be absent in Room read-only sessions. */
export const WRITE_TOOL_NAMES = [
  'shell',
  'execute',
  'str_replace',
  'write',
  'Write',
  'write_file',
  'Bash',
  'apply_patch',
  'git_commit',
  'git_checkout',
  'git_branch',
  'git_config',
  'git_push',
] as const;

export interface BodyConfig {
  /** Backward-compatible alias of agentCommand. */
  agentBinary: string;
  /** Selected ACP implementation and its exact spawn argv. */
  agentKind?: AgentKind;
  agentCommand?: string;
  agentArgs?: string[];
  /** Absolute path to the buzz-dev-mcp binary (edit mode only). */
  mcpBinary: string;
  /** Built-in inspection MCP command mounted only in read-only Room sessions. */
  readonlyMcpCommand?: string;
  readonlyMcpArgs?: string[];
  /** Env vars inherited by the selected ACP agent process. */
  agentEnv: Record<string, string>;
  /** Base directory for TLC workspaces and git worktrees. */
  workspaceRoot: string;
  /** Relay HTTP base (defaults to @beeline/gate config). */
  relayBaseUrl: string;
  relayHost: string;
  relayScheme: string;
  /** WebSocket relay URL for documentation / optional buzz-acp. */
  relayWsUrl: string;
  /**
   * When true, edit-mode sessions auto-approve session/request_permission.
   * Room sessions always route the first mutating request through the signed
   * human permission flow instead.
   */
  autoApprovePermissions: boolean;
}

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Resolve binary paths. Prefers env overrides, then worktree scratch build,
 * then PATH-style defaults.
 */
export function resolveBinaries(env: NodeJS.ProcessEnv = process.env): {
  agentBinary: string;
  mcpBinary: string;
} {
  const agent = resolveAgentCommand({ kind: 'reference', env }).command;
  const mcp = resolveMcpBinary(env);
  return { agentBinary: agent, mcpBinary: mcp };
}

export function resolveMcpBinary(env: NodeJS.ProcessEnv = process.env): string {
  const mcp =
    env.BUZZ_DEV_MCP_BIN ??
    env.BUZZ_ACP_MCP_COMMAND ??
    firstExisting([
      resolve(process.cwd(), '.scratch-target', 'debug', 'buzz-dev-mcp'),
      resolve(process.cwd(), '..', '..', '.scratch-target', 'debug', 'buzz-dev-mcp'),
      executableOnPath('buzz-dev-mcp', env) ?? '',
    ]);
  if (!mcp) {
    throw new Error(
      'buzz-dev-mcp binary not found. Build with cargo or set BUZZ_DEV_MCP_BIN / BUZZ_ACP_MCP_COMMAND',
    );
  }
  return mcp;
}

/** Resolve the Beeline-owned read-only MCP without borrowing buzz-dev-mcp. */
export function resolveReadonlyMcpCommand(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
} {
  const binary = env.BUZZ_READONLY_MCP_BIN ?? executableOnPath('buzz-readonly-mcp', env);
  if (binary) return { command: binary, args: [] };

  const script = env.BUZZ_READONLY_MCP_SCRIPT;
  if (script && existsSync(script)) return { command: process.execPath, args: [script] };

  const built = firstExisting([
    resolve(process.cwd(), 'apps', 'body', 'dist', 'read-only-mcp.js'),
    resolve(process.cwd(), 'dist', 'read-only-mcp.js'),
    resolve(process.cwd(), '..', '..', 'apps', 'body', 'dist', 'read-only-mcp.js'),
  ]);
  if (built) return { command: process.execPath, args: [built] };

  const source = firstExisting([
    resolve(process.cwd(), 'apps', 'body', 'src', 'read-only-mcp.ts'),
    resolve(process.cwd(), 'src', 'read-only-mcp.ts'),
  ]);
  const tsx = executableOnPath('tsx', env);
  if (source && tsx) return { command: tsx, args: [source] };

  throw new Error(
    'buzz-readonly-mcp not found. Build @beeline/body or set BUZZ_READONLY_MCP_BIN / BUZZ_READONLY_MCP_SCRIPT',
  );
}

/**
 * Parse a simple KEY=VALUE env file without printing values.
 * Supports optional surrounding quotes; ignores blank lines and # comments.
 */
export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Build the env map for a buzz-agent child process.
 * Maps `BUZZY_LLM_*` (egress helper) onto `OPENAI_COMPAT_*` + `BUZZ_AGENT_PROVIDER=openai`.
 * Never logs secret values.
 */
export function buildAgentEnv(
  env: NodeJS.ProcessEnv = process.env,
  extraFile?: string,
): Record<string, string> {
  const fileVars = extraFile ? parseEnvFile(extraFile) : {};
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') merged[k] = v;
  }
  Object.assign(merged, fileVars);

  // Prefer explicit OPENAI_COMPAT_*; else map BUZZY_LLM_*.
  const apiKey = merged.OPENAI_COMPAT_API_KEY ?? merged.BUZZY_LLM_API_KEY ?? merged.OPENAI_API_KEY;
  const baseUrl =
    merged.OPENAI_COMPAT_BASE_URL ?? merged.BUZZY_LLM_BASE_URL ?? 'https://api.openai.com/v1';
  const model = merged.OPENAI_COMPAT_MODEL ?? merged.BUZZY_LLM_MODEL ?? merged.OPENAI_MODEL;

  const agentEnv: Record<string, string> = {
    // Pass through non-secret path/locale vars the child may need.
    PATH: merged.PATH ?? process.env.PATH ?? '',
    HOME: merged.HOME ?? process.env.HOME ?? '',
    TMPDIR: merged.TMPDIR ?? process.env.TMPDIR ?? '/tmp',
    RUST_LOG: merged.RUST_LOG ?? 'warn',
  };

  if (apiKey && model) {
    agentEnv.BUZZ_AGENT_PROVIDER = merged.BUZZ_AGENT_PROVIDER ?? 'openai';
    agentEnv.OPENAI_COMPAT_API_KEY = apiKey;
    agentEnv.OPENAI_COMPAT_BASE_URL = baseUrl;
    agentEnv.OPENAI_COMPAT_MODEL = model;
    // Non-openai.com hosts need Chat Completions, not Responses API.
    agentEnv.OPENAI_COMPAT_API =
      merged.OPENAI_COMPAT_API ?? (baseUrl.includes('api.openai.com') ? 'responses' : 'chat');
  }

  // Optional passthroughs if already set correctly.
  for (const k of [
    'BUZZ_AGENT_PROVIDER',
    'OPENAI_COMPAT_API_KEY',
    'OPENAI_COMPAT_BASE_URL',
    'OPENAI_COMPAT_MODEL',
    'OPENAI_COMPAT_API',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
  ]) {
    if (merged[k] && !agentEnv[k]) agentEnv[k] = merged[k]!;
  }

  return agentEnv;
}

/** True when agent env has enough credentials for a real LLM call. */
export function hasLlmCredentials(agentEnv: Record<string, string>): boolean {
  if (agentEnv.BUZZ_AGENT_PROVIDER === 'openai' || agentEnv.OPENAI_COMPAT_API_KEY) {
    return Boolean(agentEnv.OPENAI_COMPAT_API_KEY && agentEnv.OPENAI_COMPAT_MODEL);
  }
  if (agentEnv.BUZZ_AGENT_PROVIDER === 'anthropic') {
    return Boolean(agentEnv.ANTHROPIC_API_KEY && agentEnv.ANTHROPIC_MODEL);
  }
  return Boolean(
    (agentEnv.OPENAI_COMPAT_API_KEY && agentEnv.OPENAI_COMPAT_MODEL) ||
    (agentEnv.ANTHROPIC_API_KEY && agentEnv.ANTHROPIC_MODEL),
  );
}

export function loadBodyConfig(opts: {
  workspaceRoot: string;
  llmEnvFile?: string;
  env?: NodeJS.ProcessEnv;
  agent?: AgentCommand;
}): BodyConfig {
  const env = opts.env ?? process.env;
  const agent = opts.agent ?? resolveAgentCommand({ kind: 'reference', env });
  const mcpBinary = resolveMcpBinary(env);
  const readonlyMcp = resolveReadonlyMcpCommand(env);
  const agentEnv = buildAgentEnv(env, opts.llmEnvFile);
  const host = env.BUZZY_RELAY_HOST ?? DEFAULT_RELAY_HOST;
  const scheme = env.BUZZY_RELAY_SCHEME ?? DEFAULT_RELAY_SCHEME;
  const base = env.BUZZY_RELAY_URL
    ? env.BUZZY_RELAY_URL.replace(/^ws/, 'http').replace(/\/$/, '')
    : `${scheme}://${host}`;
  const ws =
    env.BUZZ_RELAY_URL ?? env.BUZZY_RELAY_WS ?? `${scheme === 'https' ? 'wss' : 'ws'}://${host}`;

  return {
    agentBinary: agent.command,
    agentKind: agent.kind,
    agentCommand: agent.command,
    agentArgs: [...agent.args],
    mcpBinary,
    readonlyMcpCommand: readonlyMcp.command,
    readonlyMcpArgs: readonlyMcp.args,
    agentEnv,
    workspaceRoot: resolve(opts.workspaceRoot),
    relayBaseUrl: base,
    relayHost: host,
    relayScheme: scheme,
    relayWsUrl: ws,
    autoApprovePermissions: env.BUZZY_BODY_AUTO_APPROVE !== '0',
  };
}

export { HOST, SCHEME, BASE_URL };
