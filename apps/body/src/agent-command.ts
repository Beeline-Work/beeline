import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const AGENT_KINDS = [
  'codex',
  'claude',
  'goose',
  'pi',
  'grok',
  'reference',
  'custom',
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AUTO_DETECT_AGENT_KINDS = ['codex', 'claude', 'goose', 'pi', 'grok'] as const;

export interface AgentCommand {
  kind: AgentKind;
  command: string;
  args: string[];
}

export interface AdapterInstallCommand {
  command: 'npm';
  args: ['install', '-g', string];
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
};

const ADAPTER_INSTALL_COMMANDS: Record<'codex' | 'claude' | 'pi', AdapterInstallCommand> = {
  codex: {
    command: 'npm',
    args: ['install', '-g', '@agentclientprotocol/codex-acp'],
  },
  claude: {
    command: 'npm',
    args: ['install', '-g', '@agentclientprotocol/claude-agent-acp'],
  },
  pi: {
    command: 'npm',
    args: ['install', '-g', 'pi-acp'],
  },
};

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
  const fnmRoots = [
    env.FNM_DIR?.trim(),
    resolve(xdgData, 'fnm'),
    resolve(home, '.fnm'),
  ].filter((root): root is string => Boolean(root));
  const nvmRoots = [env.NVM_DIR?.trim(), resolve(home, '.nvm')].filter(
    (root): root is string => Boolean(root),
  );
  const versioned: string[] = [];
  for (const root of fnmRoots) {
    versioned.push(...nodeVersionBins(join(root, 'node-versions'), 'installation/bin'));
  }
  for (const root of nvmRoots) {
    versioned.push(...nodeVersionBins(join(root, 'versions', 'node'), 'bin'));
  }
  return [
    ...versioned,
    resolve(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
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

  if (typedKind !== 'custom' && opts.customCommand !== undefined) {
    throw new Error('--agent-command may only be used with --agent custom');
  }

  if (typedKind === 'codex') {
    requireExecutable(
      'codex',
      env,
      cwd,
      'Codex CLI not found. Install it with `npm install -g @openai/codex`, then retry with `--agent codex`.',
    );
    const command = requireExecutable(
      'codex-acp',
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
      executableOnPath('claude-agent-acp', env) ?? executableOnPath('claude-code-acp', env);
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

  if (typedKind === 'pi') {
    requireExecutable(
      'pi',
      env,
      cwd,
      'Pi coding agent not found. Install it with `npm install -g @mariozechner/pi-coding-agent`, then retry with `--agent pi`.',
    );
    const command = requireExecutable(
      'pi-acp',
      env,
      cwd,
      `Pi needs an ACP adapter. Install it with \`${adapterInstallHint('pi')}\`, then retry with \`--agent pi\`.`,
    );
    return { kind: typedKind, command, args: [] };
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
      // goose speaks ACP natively (`goose acp`) and grok does too (`grok agent
      // stdio`): neither has a separable adapter to install, so a detected
      // binary that fails to resolve has no actionable install step.
      if (kind !== 'goose' && kind !== 'grok') {
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
