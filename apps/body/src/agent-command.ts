import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';

export const AGENT_KINDS = [
  'codex',
  'claude',
  'goose',
  'pi',
  'reference',
  'custom',
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentCommand {
  kind: AgentKind;
  command: string;
  args: string[];
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => path && existsSync(path));
}

export function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
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
  throw new Error(missingMessage);
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
      'Codex ACP adapter not found. Install it with `npm install -g @agentclientprotocol/codex-acp`, then retry with `--agent codex`.',
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
        'Claude Code needs an ACP adapter. Install it with `npm install -g @agentclientprotocol/claude-agent-acp`, then retry with `--agent claude`.',
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
      'Pi needs an ACP adapter. Install it with `npm install -g pi-acp`, then retry with `--agent pi`.',
    );
    return { kind: typedKind, command, args: [] };
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
    : firstExisting([
        resolve(cwd, '.scratch-target', 'debug', 'buzz-agent'),
        resolve(cwd, '..', '..', '.scratch-target', 'debug', 'buzz-agent'),
      ]) ?? executableOnPath('buzz-agent', env);
  if (!command) {
    throw new Error(
      'buzz-agent binary not found. Build with: cargo build -p buzz-agent -p buzz-dev-mcp --target-dir .scratch-target (from block-buzz), or set BUZZ_AGENT_BIN',
    );
  }
  return { kind: typedKind, command, args: [] };
}

function displayWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

export function formatAgentCommand(agent: AgentCommand): string {
  return `${agent.kind}: ${[agent.command, ...agent.args].map(displayWord).join(' ')}`;
}
