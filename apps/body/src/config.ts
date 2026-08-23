/**
 * Body runtime config.
 *
 * LLM credentials are loaded from the process environment (or an optional
 * dotenv-style file driven by $BUZZY_BODY_LLM_FILE). Values are never logged.
 * The file provides `BUZZY_LLM_*` vars; we map those onto buzz-agent's
 * `OPENAI_COMPAT_*` names.
 */
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HOST, SCHEME, BASE_URL } from '@beeline/gate';
import { DEFAULT_RELAY_HOST, DEFAULT_RELAY_SCHEME } from '@beeline/buzz-client';
import {
  executableOnPath,
  resolveAgentCommand,
  type AgentCommand,
  type AgentKind,
} from './agent-command.js';
import type { AgentAccessPolicy } from './access-policy.js';
import type { ExternalMcpCapability } from './external-mcp-capabilities.js';

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
  /**
   * Optional codegraph CLI, mounted as an MCP for edit-mode corner sessions
   * when resolvable. Unlike mcpBinary/readonlyMcpCommand this is best-effort:
   * a missing codegraph install never blocks a corner from opening.
   */
  codegraphCommand?: string;
  /** Env vars inherited by the selected ACP agent process. */
  agentEnv: Record<string, string>;
  /** Base directory for TLC workspaces and git worktrees. */
  workspaceRoot: string;
  /**
   * Optional override for where corner edit worktrees are placed. Corners must
   * live at a clean, top-level path (never buried inside the source checkout's
   * `.git`) so a harness's project-root reflex cannot resolve back to the
   * shared primary checkout — see `corner-isolation.ts`. When unset, Body
   * derives a hidden sibling of the source checkout. Mainly a test/override hook.
   */
  cornersRoot?: string;
  /**
   * Per-room-instance harness state directory (see `agent-home.ts`). When set,
   * this Room's ACP children get their own `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/
   * XDG state+cache/`TMPDIR` while still sharing the operator's credentials and
   * `$HOME`. Unset keeps the daemon's ambient harness state, which is what an
   * already-provisioned Room from before per-room homes must keep using.
   */
  agentHomeRoot?: string;
  /** Durable persona memory/lessons root outside corner worktrees. */
  agentPrivateRoot?: string;
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
  /**
   * Per-agent access policy (who may drive this agent) plus its owner pubkey
   * and optional custom auto-response, injected from the runtime record by the
   * daemon. Absent for a standalone Body (`beeline serve`, unit tests), which
   * defaults to `everyone` — i.e. the pre-policy behaviour. See access-policy.ts.
   */
  accessPolicy?: AgentAccessPolicy;
  accessOwnerPubkey?: string;
  accessAutoResponse?: string;
  /** Explicit account capabilities mounted for this agent; never inherited from operator config. */
  externalMcpCapabilities?: ExternalMcpCapability[];
  /**
   * Pair-time default model/effort (`--model`/`--effort` at `beeline pair`),
   * injected from the runtime record by the daemon. Applied by
   * `Body.applyModelConfigForSession` only when no human has yet set an
   * explicit in-app selection (#223) for this agent.
   */
  modelSelection?: { model?: string; effort?: string };
  /**
   * Absolute path to a `bwrap` that passed `detectBwrapSandbox`'s self-test at
   * daemon start. Present means every ACP child is spawned inside the mount
   * namespace described in `bwrap-sandbox.ts`; absent means unwrapped (bwrap
   * missing, self-test failed, or `sandbox: 'off'` on the runtime record), i.e.
   * the pre-sandbox behaviour with `session-sandbox.ts` as the only boundary.
   */
  bwrapPath?: string;
  /**
   * Extra filesystem paths whose contents are masked ABSENT from sandboxed ACP
   * children, on top of the built-in known credential homes
   * (`bwrap-sandbox.ts` KNOWN_CREDENTIAL_MASK_PATHS). Sourced from the runtime
   * record's `sandboxMaskPaths` and/or `BUZZY_BODY_SANDBOX_MASK`
   * (comma-separated absolute paths). Only load-bearing while the OS sandbox
   * is enabled; with `sandbox: 'off'` nothing is masked.
   */
  sandboxMaskPaths?: string[];
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
  const configuredBinary = env.BUZZ_READONLY_MCP_BIN;
  if (configuredBinary) {
    try {
      accessSync(configuredBinary, constants.X_OK);
      return { command: resolve(configuredBinary), args: [] };
    } catch {
      throw new Error(
        `read-only tools unavailable: BUZZ_READONLY_MCP_BIN is not executable: ${configuredBinary}`,
      );
    }
  }

  const binary = executableOnPath('buzz-readonly-mcp', env);
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
    'read-only tools unavailable: buzz-readonly-mcp was not found. Reinstall Beeline or set BUZZ_READONLY_MCP_BIN / BUZZ_READONLY_MCP_SCRIPT',
  );
}

/**
 * Resolve the optional codegraph binary. Returns undefined (never throws)
 * when it isn't installed or configured — codegraph is a best-effort
 * capability for corner sessions, not a required one.
 */
export function resolveCodegraphCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.BUZZ_CODEGRAPH_BIN;
  if (configured) {
    try {
      accessSync(configured, constants.X_OK);
      return resolve(configured);
    } catch {
      return undefined;
    }
  }
  return executableOnPath('codegraph', env);
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
 * Names passed through to an ACP child verbatim when present.
 *
 * `AcpClient.start()` used to spread the daemon's entire `process.env`
 * underneath this map, which silently defeated the allowlist and handed every
 * harness every secret the daemon happened to hold. The list is deliberately
 * generous — a coding harness legitimately needs locale, proxy, TLS trust,
 * toolchain and terminal context — but it is now an actual boundary, and
 * `BUZZY_BODY_AGENT_ENV_PASSTHROUGH` (comma-separated) extends it without a
 * code change.
 */
export const AGENT_ENV_PASSTHROUGH_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TZ',
  'TMPDIR',
  'HOSTNAME',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'FORCE_COLOR',
  'NO_COLOR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'SSH_AUTH_SOCK',
  'GNUPGHOME',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'LD_LIBRARY_PATH',
  'MANPATH',
  // A corner agent builds the user's project, so its toolchain env has to
  // survive. Go has no single prefix worth allowing wholesale.
  'GOPATH',
  'GOROOT',
  'GOBIN',
  'GOFLAGS',
  'GOCACHE',
  'GOMODCACHE',
  'GOPROXY',
  'GOPRIVATE',
  'GONOSUMDB',
  'GONOSUMCHECK',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
] as const;

/** Prefixes passed through wholesale: harness, provider and toolchain families. */
export const AGENT_ENV_PASSTHROUGH_PREFIXES = [
  'LC_',
  'ANTHROPIC_',
  'CLAUDE_',
  'OPENAI_',
  'OPENROUTER_',
  'AZURE_',
  'AWS_',
  'GOOGLE_',
  'GEMINI_',
  'VERTEX_',
  'BEDROCK_',
  'DEEPSEEK_',
  'XAI_',
  'GROQ_',
  'MISTRAL_',
  'TOGETHER_',
  'FIREWORKS_',
  'CEREBRAS_',
  'OLLAMA_',
  'CODEX_',
  'GOOSE_',
  'PI_',
  'GH_',
  'GITHUB_',
  'GITLAB_',
  'GIT_',
  'NPM_',
  'npm_',
  'NODE_',
  'DENO_',
  'RUST_',
  'RUSTUP_',
  'CARGO_',
  'PYTHON',
  'PIP_',
  'PYENV_',
  'POETRY_',
  'CONDA_',
  'VIRTUAL_ENV',
  'UV_',
  'PNPM_',
  'YARN_',
  'BUN_',
  'FNM_',
  'NVM_',
  'VOLTA_',
  'ASDF_',
  'MISE_',
  'SDKMAN_',
  'RBENV_',
  'GEM_',
  'BUNDLE_',
  'COMPOSER_',
  'GRADLE_',
  'MAVEN_',
  'ANDROID_',
  'DOTNET_',
  'CMAKE_',
  'CCACHE_',
  'PKG_CONFIG_',
  'DOCKER_',
  'KUBE',
  'TERM',
  'SSH_',
  'HOMEBREW_',
  'BUZZ_',
  'BUZZY_',
] as const;

function isPassthroughName(name: string, extra: Set<string>): boolean {
  if (extra.has(name)) return true;
  if ((AGENT_ENV_PASSTHROUGH_NAMES as readonly string[]).includes(name)) return true;
  return AGENT_ENV_PASSTHROUGH_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Push-capable repository credential variables NEVER handed to an ACP child,
 * even when a passthrough prefix (`GH_`, `GITHUB_`) or an explicit
 * `BUZZY_BODY_AGENT_ENV_PASSTHROUGH` entry would otherwise carry them.
 *
 * This is the structural half of "an agent can never land on main without
 * the owner's signed approval": sessions get git access only through the
 * daemon's ref-policy broker (`push-broker.ts`), never through a token of
 * their own. The denylist is applied LAST, after every other rule, so no
 * configuration can re-introduce one; reads keep working unauthenticated for
 * public repos, and private-repo fetches are performed by the daemon.
 */
export const REPO_PUSH_CREDENTIAL_ENV_DENYLIST = [
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_TOKEN',
  // An ssh-agent socket is a keyring: reachable inside the mount namespace
  // (connecting is not a filesystem write), so it hands over exactly the
  // push capability this list exists to remove.
  'SSH_AUTH_SOCK',
] as const;

/**
 * Build the env map for an ACP agent child process.
 * Maps `BUZZY_LLM_*` (egress helper) onto `OPENAI_COMPAT_*` + `BUZZ_AGENT_PROVIDER=openai`.
 * Never logs secret values.
 *
 * This map is the child's *entire* environment (see `AcpClient.start()`), not
 * an overlay on the daemon's, so it carries the documented passthrough set
 * above alongside the LLM wiring.
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

  const extraPassthrough = new Set(
    (merged.BUZZY_BODY_AGENT_ENV_PASSTHROUGH ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const agentEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (isPassthroughName(name, extraPassthrough)) agentEnv[name] = value;
  }
  // Structural, last-word credential removal — see the denylist above. Runs
  // after EVERY other source so neither the host env nor an operator's
  // passthrough extension can hand a session a push-capable token.
  for (const name of REPO_PUSH_CREDENTIAL_ENV_DENYLIST) delete agentEnv[name];
  // Values the child always needs a defined answer for.
  agentEnv.PATH = merged.PATH ?? process.env.PATH ?? '';
  agentEnv.HOME = merged.HOME ?? process.env.HOME ?? '';
  agentEnv.TMPDIR = merged.TMPDIR ?? process.env.TMPDIR ?? '/tmp';
  agentEnv.RUST_LOG = merged.RUST_LOG ?? 'warn';

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
    codegraphCommand: resolveCodegraphCommand(env),
    agentEnv,
    workspaceRoot: resolve(opts.workspaceRoot),
    relayBaseUrl: base,
    relayHost: host,
    relayScheme: scheme,
    relayWsUrl: ws,
    autoApprovePermissions: env.BUZZY_BODY_AUTO_APPROVE !== '0',
    ...(parseSandboxMaskEnv(env) ? { sandboxMaskPaths: parseSandboxMaskEnv(env)! } : {}),
  };
}

/**
 * Owner-configurable sandbox mask list: `BUZZY_BODY_SANDBOX_MASK=/path/a,/path/b`.
 * Complements the runtime record field of the same name; both are unioned at
 * spawn time. Entries are resolved against `$HOME` lazily by
 * `credentialMaskPaths` only if they are not already absolute.
 */
export function parseSandboxMaskEnv(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = env.BUZZY_BODY_SANDBOX_MASK;
  if (!raw?.trim()) return undefined;
  const entries = raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length ? entries : undefined;
}

export { HOST, SCHEME, BASE_URL };
