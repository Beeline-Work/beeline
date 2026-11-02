import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { activeAdapterCommand } from './adapter-store.js';
import type { AgentId } from './session-join/agents.js';
import type { AdapterUpdateOptions } from './adapter-update.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const AGENT_KINDS = [
  'codex',
  'claude',
  'goose',
  'pi',
  'grok',
  'cursor',
  'opencode',
  'reference',
  'custom',
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Per-harness policy. Consumers select a capability; harness names stay here. */
interface AgentBehavior {
  label?: string;
  cliSignIn?: 'codex' | 'grok' | 'cursor';
  providerKeyStore?: 'env' | 'auth-file';
  sharedLoginWriteBack?: boolean;
  codexCacheBindings?: boolean;
  probeProviderRootEnv?: string;
  modelCatalogOwnsCredentials?: boolean;
  fastMode?: boolean;
  modelLaunch?: 'native-args' | 'command';
  hostedModelConfig?: 'model-file' | 'inline-provider';
  validateHostedModelInSession?: boolean;
  resolveCommandOnStart?: boolean;
  identityLabel?: string;
  cliModelCatalog?: boolean;
  providerModelEnv?: { provider: string; model: string };
  roomTomlDefaults?: boolean;
  quotaCredential?: { homeEnv: string; directory: string; file: string };
  importedMcp?: { format: 'toml' | 'json' | 'extensions'; source: string; homeEnv: string; file: string };
  session?: SessionAgentBehavior;
}

interface SessionAgentBehavior {
  delivery?: 'socket' | 'queue';
  processNames?: readonly string[];
  clientNames?: readonly string[];
  clientExactNames?: readonly string[];
  clientPrefix?: string;
  mailEvents?: readonly string[];
  hookOutput?: Partial<Record<'start' | 'prompt' | 'tool' | 'stop', string>>;
  pollText?: boolean;
}

export const CURSOR_ACP_BRIDGE_LABEL = 'cursor-acp-bridge';
export const CURSOR_ACP_BRIDGE_FLAG = '--cursor-acp-bridge';

/** Resolve the Beeline-owned bridge beside this helper, or inside its bundle. */
export function cursorAcpBridgeLaunch(): { command: string; args: string[] } {
  const meta = import.meta.url;
  if (meta === 'beeline:bundle' || meta.startsWith('beeline:')) {
    const entry = process.argv[1];
    if (!entry) {
      throw new Error('Cursor ACP bridge cannot resolve the Beeline CLI entry');
    }
    return { command: process.execPath, args: [entry, CURSOR_ACP_BRIDGE_FLAG] };
  }
  const js = fileURLToPath(new URL('./cursor-acp-bridge.js', meta));
  const ts = fileURLToPath(new URL('./cursor-acp-bridge.ts', meta));
  if (existsSync(js)) return { command: process.execPath, args: [js] };
  if (existsSync(ts)) {
    const tsx = createRequire(meta).resolve('tsx');
    return { command: process.execPath, args: ['--import', tsx, ts] };
  }
  throw new Error('Cursor ACP bridge entry not found next to the Beeline helper');
}


export const AGENT_BEHAVIORS: Readonly<Record<AgentKind, AgentBehavior>> = {
  codex: {
    label: 'Codex', cliSignIn: 'codex', roomTomlDefaults: true, codexCacheBindings: true, fastMode: true,
    quotaCredential: { homeEnv: 'CODEX_HOME', directory: '.codex', file: 'auth.json' },
    importedMcp: { format: 'toml', source: '.codex/config.toml', homeEnv: 'CODEX_HOME', file: 'config.toml' },
    session: { delivery: 'queue', processNames: ['codex', 'codex-tui'], clientNames: ['codex'],
      hookOutput: { start: 'SessionStart', prompt: 'UserPromptSubmit', tool: 'PostToolUse', stop: 'block' } },
  },
  claude: {
    label: 'Claude', sharedLoginWriteBack: true,
    quotaCredential: { homeEnv: 'CLAUDE_CONFIG_DIR', directory: '.claude', file: '.credentials.json' },
    importedMcp: { format: 'json', source: '.claude.json', homeEnv: 'CLAUDE_CONFIG_DIR', file: '.claude.json' },
    session: { delivery: 'socket', processNames: ['claude'], clientNames: ['claude-code', 'claude code'], clientExactNames: ['claude'],
      hookOutput: { start: 'SessionStart', prompt: 'UserPromptSubmit', stop: 'block' } },
  },
  goose: {
    label: 'Goose', providerKeyStore: 'env', probeProviderRootEnv: 'GOOSE_PATH_ROOT', modelCatalogOwnsCredentials: true,
    providerModelEnv: { provider: 'GOOSE_PROVIDER', model: 'GOOSE_MODEL' },
    importedMcp: { format: 'extensions', source: '.config/goose/config.yaml', homeEnv: 'GOOSE_PATH_ROOT', file: 'config/config.yaml' },
  },
  pi: {
    label: 'Pi', providerKeyStore: 'env', hostedModelConfig: 'model-file', validateHostedModelInSession: true,
    importedMcp: { format: 'json', source: '.pi/agent/mcp.json', homeEnv: 'PI_CODING_AGENT_DIR', file: 'mcp.json' },
    session: { processNames: ['pi'], clientPrefix: 'pi', mailEvents: ['poll', 'post-tool-use'], pollText: true },
  },
  grok: {
    label: 'Grok', cliSignIn: 'grok', modelLaunch: 'native-args',
    importedMcp: { format: 'toml', source: '.grok/config.toml', homeEnv: 'GROK_HOME', file: 'config.toml' },
  },
  cursor: { label: 'Cursor', cliSignIn: 'cursor', resolveCommandOnStart: true, identityLabel: CURSOR_ACP_BRIDGE_LABEL, cliModelCatalog: true },
  opencode: { label: 'OpenCode', providerKeyStore: 'auth-file', modelCatalogOwnsCredentials: true, hostedModelConfig: 'inline-provider',
    session: { processNames: ['opencode'], clientNames: ['opencode'], mailEvents: ['poll'], pollText: true } },
  reference: {},
  custom: { modelLaunch: 'command' },
};

export function agentBehavior(kind: string | undefined): AgentBehavior {
  return kind && Object.hasOwn(AGENT_BEHAVIORS, kind) ? AGENT_BEHAVIORS[kind as AgentKind] : {};
}

// Preserve cross-harness declaration precedence when scanning the operator home.
export const IMPORTED_MCP_KINDS: readonly AgentKind[] = ['codex', 'grok', 'claude', 'goose', 'pi'];

// Joined sessions also include apps that are not daemon ACP harnesses.
export const SESSION_AGENT_BEHAVIORS = {
  'claude-code': AGENT_BEHAVIORS.claude.session!,
  codex: AGENT_BEHAVIORS.codex.session!,
  opencode: AGENT_BEHAVIORS.opencode.session!,
  pi: AGENT_BEHAVIORS.pi.session!,
  antigravity: { processNames: ['antigravity', 'agy'], clientNames: ['antigravity'],
    mailEvents: ['session-start', 'user-prompt-submit', 'stop'], hookOutput: { start: 'inject', prompt: 'inject', stop: 'continue' } },
  gemini: { processNames: ['gemini'], clientNames: ['gemini'],
    hookOutput: { start: 'SessionStart', prompt: 'BeforeAgent', tool: 'AfterTool', stop: 'deny' } },
  hermes: { processNames: ['hermes'], clientNames: ['hermes'], mailEvents: ['poll'], pollText: true },
  zcode: { processNames: ['zcode'], clientPrefix: 'zcode', mailEvents: ['poll'], pollText: true },
} satisfies Record<AgentId, SessionAgentBehavior>;

export const SESSION_CLIENT_ORDER = ['claude-code', 'codex', 'antigravity', 'gemini', 'opencode', 'pi', 'hermes', 'zcode'] as const;

export function sessionAgentBehavior(agent: keyof typeof SESSION_AGENT_BEHAVIORS | undefined): SessionAgentBehavior {
  return agent ? SESSION_AGENT_BEHAVIORS[agent] : {};
}

/**
 * Credential files shared back into an isolated harness state directory,
 * keyed by the state directory the harness was pointed at. `source` is
 * relative to the operator's real `$HOME`; `target` to the isolated dir.
 */
export const SHARED_CREDENTIALS: Array<{
  dir: 'claude' | 'codex' | 'grok' | 'pi' | 'cursor' | 'user';
  source: string;
  target: string;
  writeBack?: boolean;
}> = [
  // Claude Code relocates ~/.claude wholesale via CLAUDE_CONFIG_DIR; the OAuth
  // credentials live inside it, so an isolated dir needs them linked back.
  { dir: 'claude', source: '.claude/.credentials.json', target: '.credentials.json', writeBack: AGENT_BEHAVIORS.claude.sharedLoginWriteBack },
  // Codex CLI relocates ~/.codex via CODEX_HOME; auth.json holds its login.
  { dir: 'codex', source: '.codex/auth.json', target: 'auth.json' },
  // Grok relocates ~/.grok via GROK_HOME; auth.json holds its login (same
  // shape as codex).
  { dir: 'grok', source: '.grok/auth.json', target: 'auth.json' },
  { dir: 'pi', source: '.pi/agent/auth.json', target: 'auth.json' },
  // Cursor CLI stores chat/MCP state under ~/.cursor/; cursor-agent reads
  // CURSOR_HOME to relocate that data directory. The login is NOT there:
  // cursor-agent reads ~/.config/cursor/auth.json (XDG config). Beeline
  // remaps HOME to the isolated user/ dir, so the login has to be linked
  // into that HOME or every Room/corner except one that was patched by
  // hand fails with "Authentication required".
  { dir: 'cursor', source: '.cursor/agent-cli-state.json', target: 'agent-cli-state.json' },
  { dir: 'user', source: '.config/cursor/auth.json', target: '.config/cursor/auth.json' },
  // OpenCode stores provider logins under XDG data, which follows isolated HOME.
  {
    dir: 'user',
    source: '.local/share/opencode/auth.json',
    target: '.local/share/opencode/auth.json',
  },
];

export const AUTO_DETECT_AGENT_KINDS = [
  'codex',
  'claude',
  'goose',
  'pi',
  'grok',
  'cursor',
  'opencode',
] as const;

export interface AgentCommand {
  kind: AgentKind;
  command: string;
  args: string[];
}

export interface AdapterInstallCommand {
  command: 'npm';
  args: ['install', ...string[]];
}

export type DetectedAgentCommand =
  | {
      kind: (typeof AUTO_DETECT_AGENT_KINDS)[number];
      status: 'ready';
      agent: AgentCommand;
    }
  | {
      kind: 'codex' | 'claude' | 'pi';
      status: 'missing-adapter';
      install: AdapterInstallCommand;
    };

const AGENT_EXECUTABLES: Record<(typeof AUTO_DETECT_AGENT_KINDS)[number], string> = {
  codex: 'codex',
  claude: 'claude',
  goose: 'goose',
  pi: 'pi',
  grok: 'grok',
  cursor: 'cursor-agent',
  opencode: 'opencode',
};

/** Install hints verified against the upstream docs; see docs/agent-programs.md. */
const AGENT_PROGRAMS = {
  codex: { name: 'Codex', binary: 'codex', install: 'npm install -g @openai/codex' },
  claude: { name: 'Claude Code', binary: 'claude', install: 'curl -fsSL https://claude.ai/install.sh | bash' },
  goose: { name: 'Goose', binary: 'goose', install: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash' },
  pi: { name: 'Pi', binary: 'pi', install: 'curl -fsSL https://pi.dev/install.sh | sh' },
  grok: { name: 'Grok', binary: 'grok', install: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
  cursor: { name: 'Cursor', binary: 'cursor-agent', install: 'curl https://cursor.com/install -fsS | bash' },
  opencode: { name: 'OpenCode', binary: 'opencode', install: 'npm install -g opencode-ai' },
} as const;

export function missingAgentProgramMessage(kind: keyof typeof AGENT_PROGRAMS): string {
  const program = AGENT_PROGRAMS[kind];
  return `${program.name} is not installed on this machine (${program.binary}). Install it with \`${program.install}\`, then try again.`;
}

export function requireInstalledAgentProgram(kind: AgentKind, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!(kind in AGENT_PROGRAMS)) return undefined;
  const key = kind as keyof typeof AGENT_PROGRAMS;
  const path = executableOnPath(AGENT_PROGRAMS[key].binary, env);
  if (!path) throw new Error(missingAgentProgramMessage(key));
  return path;
}

/** Explicit upstream overrides keep adapters on the operator's program. */
export function installedAgentProgramEnvironment(kind: AgentKind, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const variable = kind === 'claude' ? 'CLAUDE_CODE_EXECUTABLE' : kind === 'codex' ? 'CODEX_PATH' : kind === 'pi' ? 'PI_ACP_PI_COMMAND' : undefined;
  if (!variable) return {};
  const path = executableOnPath(AGENT_PROGRAMS[kind as 'claude' | 'codex' | 'pi'].binary, env);
  return path ? { [variable]: path } : {};
}

const ADAPTER_INSTALL_COMMANDS: Record<'codex' | 'claude' | 'pi', AdapterInstallCommand> = {
  codex: {
    command: 'npm',
    args: ['install', '-g', '@agentclientprotocol/codex-acp@latest'],
  },
  claude: {
    command: 'npm',
    args: ['install', '-g', '@agentclientprotocol/claude-agent-acp@latest'],
  },
  pi: {
    command: 'npm',
    args: ['install', '-g', 'pi-acp@latest'],
  },
};

export function latestAdapterInstallCommand(kind: AgentKind): AdapterInstallCommand | undefined {
  return kind === 'codex' || kind === 'claude' || kind === 'pi'
    ? ADAPTER_INSTALL_COMMANDS[kind]
    : undefined;
}

export async function runAdapterInstall(
  install: AdapterInstallCommand,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: 'inherit' | 'ignore' } = {},
): Promise<void> {
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn(install.command, [...install.args, '--omit=optional'], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: opts.env ?? process.env,
      stdio: opts.stdio ?? 'inherit',
      timeout: 2 * 60_000,
    });
    child.once('error', rejectInstall);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveInstall();
      else {
        rejectInstall(
          new Error(
            signal
              ? `${install.command} was terminated by ${signal}`
              : `${install.command} exited with status ${code ?? 'unknown'}`,
          ),
        );
      }
    });
  });
}

/** Install beside the working adapter and promote only after session-start validation. */
export async function installLatestAgentAdapter(
  kind: AgentKind,
  opts: AdapterUpdateOptions = {},
): Promise<boolean> {
  if (kind !== 'codex' && kind !== 'claude' && kind !== 'pi') return false;
  const { updateAgentAdapter } = await import('./adapter-update.js');
  return updateAgentAdapter(kind, opts);
}

const execFileAsync = promisify(execFile);

/** Older user CLIs can reject flags required by the latest adapter. */
export async function explainAgentProgramFailure(error: unknown, env: NodeJS.ProcessEnv): Promise<unknown> {
  if (!env.CLAUDE_CODE_EXECUTABLE || !/unknown option|unrecognized (?:option|argument)|unsupported.*version|requires.*version/i.test(String(error))) return error;
  const version = await execFileAsync(env.CLAUDE_CODE_EXECUTABLE, ['--version'], { env, timeout: 3000, maxBuffer: 4096 })
    .then(result => result.stdout.trim().replace(/\s+/g, ' ').slice(0, 80)).catch(() => 'version unavailable');
  return new Error(`Claude Code ${version} could not start. Install it with \`${AGENT_PROGRAMS.claude.install}\`, then try again. ${String(error)}`, { cause: error });
}

function adapterInstallHint(kind: keyof typeof ADAPTER_INSTALL_COMMANDS): string {
  return formatAdapterInstallCommand(ADAPTER_INSTALL_COMMANDS[kind]);
}

/** Version triple parsed from a node version-manager directory name. */
function nodeVersionRank(name: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!match) return undefined;
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function nodeVersionBins(versionsDir: string, binSuffix: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return [];
  }
  return entries
    .map((name) => ({ name, rank: nodeVersionRank(name) }))
    .filter((entry): entry is { name: string; rank: [number, number, number] } =>
      Boolean(entry.rank),
    )
    .sort((a, b) => {
      for (let i = 0; i < 3; i += 1) {
        const delta = (b.rank[i] ?? 0) - (a.rank[i] ?? 0);
        if (delta !== 0) return delta;
      }
      return 0;
    })
    .map((entry) => join(versionsDir, entry.name, binSuffix));
}

/**
 * Well-known install locations that are frequently missing from a non-login
 * shell's PATH (fnm and nvm version dirs are discovered fresh each call so the
 * newest installed node version wins when several match).
 */
export function wellKnownExecutableDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || homedir();
  const xdgData = env.XDG_DATA_HOME?.trim() || resolve(home, '.local', 'share');
  const fnmRoots = [env.FNM_DIR?.trim(), resolve(xdgData, 'fnm'), resolve(home, '.fnm')].filter(
    (root): root is string => Boolean(root),
  );
  const nvmRoots = [env.NVM_DIR?.trim(), resolve(home, '.nvm')].filter((root): root is string =>
    Boolean(root),
  );
  const versioned: string[] = [];
  for (const root of fnmRoots) {
    versioned.push(...nodeVersionBins(join(root, 'node-versions'), 'installation/bin'));
  }
  for (const root of nvmRoots) {
    versioned.push(...nodeVersionBins(join(root, 'versions', 'node'), 'bin'));
  }
  return [...versioned, resolve(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
}

/**
 * The full harness search order: the caller's PATH, then well-known global
 * bins, then the launcher's own recorded PATH (`BEELINE_LAUNCHER_PATH`).
 * Deduplicated; the wizard probe and the daemon-side resolution share this.
 * `BEELINE_HARNESS_PATH_AUGMENT=0` restricts the search to the caller's PATH
 * (hermetic test seam).
 */
export function augmentedSearchDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const directories: string[] = [];
  const pushAll = (paths: string[]): void => {
    for (const directory of paths) {
      if (directory && !directories.includes(directory)) directories.push(directory);
    }
  };
  pushAll((env.PATH ?? '').split(delimiter));
  if (env.BEELINE_HARNESS_PATH_AUGMENT === '0') return directories;
  pushAll(wellKnownExecutableDirs(env));
  pushAll((env.BEELINE_LAUNCHER_PATH ?? '').split(delimiter));
  return directories;
}

/** Human-readable list of everywhere a harness lookup looks, for error text. */
export function describeExecutableSearch(env: NodeJS.ProcessEnv = process.env): string {
  return augmentedSearchDirectories(env).join(', ');
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => path && existsSync(path));
}

export function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const directory of augmentedSearchDirectories(env)) {
    const candidate = resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}

function requireExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  missingMessage: string,
): string {
  const pathLike = isAbsolute(command) || command.includes('/') || command.includes('\\');
  const candidate = pathLike ? resolve(cwd, command) : executableOnPath(command, env);
  if (candidate) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Use the actionable caller-provided error below.
    }
  }
  throw new Error(`${missingMessage} Searched: ${describeExecutableSearch(env)}.`);
}

/** Parse a command string into argv without invoking a shell or expanding variables. */
export function parseAgentCommand(value: string): { command: string; args: string[] } {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      word += char;
      started = true;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    word += char;
    started = true;
  }

  if (escaped) throw new Error('--agent-command ends with an incomplete escape');
  if (quote) throw new Error(`--agent-command has an unterminated ${quote} quote`);
  if (started) words.push(word);
  const [command, ...args] = words;
  if (!command) throw new Error('--agent custom requires a non-empty --agent-command');
  return { command, args };
}

export function resolveAgentCommand(opts: {
  kind?: string;
  customCommand?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): AgentCommand {
  const kind = opts.kind ?? 'reference';
  if (!AGENT_KINDS.includes(kind as AgentKind)) {
    throw new Error(`unknown agent "${kind}"; expected ${AGENT_KINDS.join(', ')}`);
  }
  const typedKind = kind as AgentKind;
  const env = opts.env ?? process.env;
  const cwd = resolve(opts.cwd ?? process.cwd());
  requireInstalledAgentProgram(typedKind, env);

  if (typedKind !== 'custom' && opts.customCommand !== undefined) {
    throw new Error('--agent-command may only be used with --agent custom');
  }

  if (typedKind === 'codex') {
    requireExecutable(
      'codex',
      env,
      cwd,
      'Codex CLI not found. Install it with `npm install -g @openai/codex@latest`, then retry with `--agent codex`.',
    );
    const command = requireExecutable(
      activeAdapterCommand('codex', env) ?? 'codex-acp',
      env,
      cwd,
      `Codex ACP adapter not found. Install it with \`${adapterInstallHint('codex')}\`, then retry with \`--agent codex\`.`,
    );
    return { kind: typedKind, command, args: [] };
  }

  if (typedKind === 'claude') {
    requireExecutable(
      'claude',
      env,
      cwd,
      'Claude Code not found. Install Claude Code, then retry with `--agent claude`.',
    );
    const command =
      activeAdapterCommand('claude', env) ?? executableOnPath('claude-agent-acp', env) ?? executableOnPath('claude-code-acp', env);
    if (!command) {
      throw new Error(
        `Claude Code needs an ACP adapter. Install it with \`${adapterInstallHint('claude')}\`, then retry with \`--agent claude\`.`,
      );
    }
    return { kind: typedKind, command, args: [] };
  }

  if (typedKind === 'goose') {
    const command = requireExecutable(
      'goose',
      env,
      cwd,
      'Goose CLI not found. Install it from https://block.github.io/goose/docs/getting-started/installation/, then retry with `--agent goose`.',
    );
    return { kind: typedKind, command, args: ['acp'] };
  }

  if (typedKind === 'opencode') {
    const command = requireExecutable(
      'opencode',
      env,
      cwd,
      'OpenCode CLI not found. Install it with `npm install -g opencode-ai@latest`, then retry with `--agent opencode`.',
    );
    return { kind: typedKind, command, args: ['acp'] };
  }

  if (typedKind === 'pi') {
    requireExecutable(
      'pi',
      env,
      cwd,
      'Pi coding agent not found. Install it with `npm install -g @mariozechner/pi-coding-agent@latest`, then retry with `--agent pi`.',
    );
    const command = requireExecutable(
      activeAdapterCommand('pi', env) ?? 'pi-acp',
      env,
      cwd,
      `Pi needs an ACP adapter. Install it with \`${adapterInstallHint('pi')}\`, then retry with \`--agent pi\`.`,
    );
    return { kind: typedKind, command, args: [] };
  }

  if (typedKind === 'cursor') {
    // cursor-agent has no native ACP server. The published third-party adapter
    // (`cursor-agent-acp`) is an unfinished stub, so Beeline owns the bridge
    // (`cursor-acp-bridge.ts`) and drives `--print --output-format stream-json`.
    requireExecutable(
      'cursor-agent',
      env,
      cwd,
      'Cursor Agent CLI not found. Install it from https://cursor.com/docs/cli, then retry with `--agent cursor`.',
    );
    const bridge = cursorAcpBridgeLaunch();
    return { kind: typedKind, command: bridge.command, args: bridge.args };
  }

  if (typedKind === 'grok') {
    // Grok speaks ACP natively: `grok agent stdio` is the ACP server (verified
    // against a real initialize/session/new/session/prompt handshake — it sends
    // standard `session/request_permission` requests in ask mode). No adapter
    // binary, so there is no missing-adapter state for this kind.
    const command = requireExecutable(
      'grok',
      env,
      cwd,
      'Grok CLI not found. Install it with `curl -fsSL https://x.ai/cli/install.sh | bash`, then retry with `--agent grok`.',
    );
    return { kind: typedKind, command, args: ['agent', 'stdio'] };
  }

  if (typedKind === 'custom') {
    const parsed = parseAgentCommand(opts.customCommand ?? '');
    return {
      kind: typedKind,
      command: requireExecutable(
        parsed.command,
        env,
        cwd,
        `Custom ACP command not found or not executable: ${parsed.command}`,
      ),
      args: parsed.args,
    };
  }

  const configured = env.BUZZ_AGENT_BIN ?? env.BUZZ_ACP_AGENT_COMMAND;
  const command = configured
    ? requireExecutable(
        configured,
        env,
        cwd,
        `Reference agent not found or not executable: ${configured}`,
      )
    : (firstExisting([
        resolve(cwd, '.scratch-target', 'debug', 'buzz-agent'),
        resolve(cwd, '..', '..', '.scratch-target', 'debug', 'buzz-agent'),
      ]) ?? executableOnPath('buzz-agent', env));
  if (!command) {
    throw new Error(
      'buzz-agent binary not found. Build with: cargo build -p buzz-agent -p buzz-dev-mcp --target-dir .scratch-target (from block-buzz), or set BUZZ_AGENT_BIN',
    );
  }
  return { kind: typedKind, command, args: [] };
}

/** Detect installed user-owned agents, retaining an actionable missing-adapter state. */
export function detectInstalledAgentCommands(
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): DetectedAgentCommand[] {
  const env = opts.env ?? process.env;
  const detected: DetectedAgentCommand[] = [];
  for (const kind of AUTO_DETECT_AGENT_KINDS) {
    if (!executableOnPath(AGENT_EXECUTABLES[kind], env)) continue;
    try {
      detected.push({
        kind,
        status: 'ready',
        agent: resolveAgentCommand({ kind, env, cwd: opts.cwd }),
      });
    } catch {
      // Native ACP agents have no separable adapter to install (cursor uses
      // Beeline's own bridge), so a failed resolution has no install step.
      if (kind !== 'goose' && kind !== 'grok' && kind !== 'cursor' && kind !== 'opencode') {
        detected.push({
          kind,
          status: 'missing-adapter',
          install: ADAPTER_INSTALL_COMMANDS[kind],
        });
      }
    }
  }
  return detected;
}

function displayWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

export function formatAgentCommand(agent: AgentCommand): string {
  return `${agent.kind}: ${[agent.command, ...agent.args].map(displayWord).join(' ')}`;
}

export function formatAdapterInstallCommand(install: AdapterInstallCommand): string {
  return [install.command, ...install.args].map(displayWord).join(' ');
}
