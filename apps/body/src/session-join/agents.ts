// Ported from Reason Network (src/agent.rs, src/util.rs), Copyright 2026 Reason Machines, Inc.,
// MIT OR Apache-2.0. See ./NOTICE and ./UPSTREAM.json for the copied commit.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** The coding-agent apps a running session can join from. */
export const AGENTS = ['claude-code', 'codex', 'opencode', 'pi', 'antigravity', 'gemini', 'hermes', 'zcode'] as const;
export type AgentId = (typeof AGENTS)[number];

const LABELS: Record<AgentId, string> = {
  'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi',
  antigravity: 'Antigravity', gemini: 'Gemini CLI', hermes: 'Hermes', zcode: 'ZCode',
};

/** How people write the app's name. It is also the client name Beeline shows as the member's model label. */
export function agentLabel(agent: AgentId): string {
  return LABELS[agent];
}

export function isAgentId(value: string): value is AgentId {
  return (AGENTS as readonly string[]).includes(value);
}

/** Best guess from the environment an app gives its children. `BEELINE_SESSION_AGENT` wins. */
export function detectEnv(env: NodeJS.ProcessEnv = process.env): AgentId | undefined {
  const chosen = env.BEELINE_SESSION_AGENT;
  if (chosen) return fromClientName(chosen);
  const has = (key: string) => Boolean(env[key]);
  if (has('CLAUDECODE') || has('CLAUDE_CODE_SESSION_ID')) return 'claude-code';
  if (has('CODEX_THREAD_ID') || has('CODEX_SESSION_ID')) return 'codex';
  if (has('ANTIGRAVITY_SESSION_ID') || has('ANTIGRAVITY_AGENT')) return 'antigravity';
  if (has('GEMINI_CLI')) return 'gemini';
  if (has('OPENCODE')) return 'opencode';
  if (has('PI_CODING_AGENT') || has('PI_SESSION_ID')) return 'pi';
  if (has('HERMES_SESSION_ID') || has('HERMES_HOME')) return 'hermes';
  if (has('ZCODE') || has('ZCODE_SESSION_ID')) return 'zcode';
  return undefined;
}

/** From an MCP client's `clientInfo.name`, a hook argument or an override. */
export function fromClientName(name: string): AgentId | undefined {
  const n = name.toLowerCase();
  const has = (part: string) => n.includes(part);
  if (has('claude-code') || has('claude code') || n === 'claude') return 'claude-code';
  if (has('codex')) return 'codex';
  if (has('antigravity')) return 'antigravity';
  if (has('gemini')) return 'gemini';
  if (has('opencode')) return 'opencode';
  if (n === 'pi' || n.startsWith('pi-') || n.startsWith('pi ')) return 'pi';
  if (has('hermes')) return 'hermes';
  if (n === 'zcode' || n.startsWith('zcode-') || n.startsWith('zcode ')) return 'zcode';
  return undefined;
}

/** The app a process name belongs to, for apps that set no environment marker. */
export function fromProcessName(command: string): AgentId | undefined {
  const name = basename(command.split(/\s+/)[0] ?? '').toLowerCase().replace(/\.(exe|js|mjs|cjs)$/, '');
  if (name === 'claude') return 'claude-code';
  if (name === 'codex' || name === 'codex-tui') return 'codex';
  if (name === 'opencode') return 'opencode';
  if (name === 'pi') return 'pi';
  if (name === 'gemini') return 'gemini';
  if (name === 'antigravity' || name === 'agy') return 'antigravity';
  if (name === 'hermes') return 'hermes';
  if (name === 'zcode') return 'zcode';
  return undefined;
}

/** The parent of `pid` from `/proc/<pid>/stat`: `<pid> (<name>) <state> <ppid> …`, where the name may hold spaces. */
export function statParent(stat: string): number | undefined {
  const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  const parent = Number(rest[1]);
  return Number.isInteger(parent) && parent > 0 ? parent : undefined;
}

export function parentPid(pid: number): number | undefined {
  try {
    return statParent(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return pid === process.pid ? process.ppid : undefined;
  }
}

export function processCommand(pid: number): string | undefined {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    // A node launcher runs the app's script: `node …/bin/codex.js`.
    const script = argv[0] && /(^|\/)node$/.test(argv[0]) ? argv[1] : argv[0];
    return script;
  } catch {
    return undefined;
  }
}

/** Our ancestors, nearest first, stopping before init and never looping. */
export function ancestors(start: number, parentOf: (pid: number) => number | undefined = parentPid): number[] {
  const seen: number[] = [];
  for (let pid = parentOf(start); pid && pid > 1 && !seen.includes(pid) && seen.length < 64; pid = parentOf(pid)) seen.push(pid);
  return seen;
}

/**
 * The app running us and its process. The nearest ancestor an app owns beats the environment, which an app
 * launched from another's terminal inherits; `BEELINE_SESSION_AGENT` beats both.
 */
export function detectAgent(
  env: NodeJS.ProcessEnv = process.env,
  start = process.pid,
  parentOf: (pid: number) => number | undefined = parentPid,
  commandOf: (pid: number) => string | undefined = processCommand,
): { agent: AgentId; pid?: number } | undefined {
  const chosen = env.BEELINE_SESSION_AGENT ? fromClientName(env.BEELINE_SESSION_AGENT) : undefined;
  for (const pid of ancestors(start, parentOf)) {
    const command = commandOf(pid);
    const agent = command ? fromProcessName(command) : undefined;
    if (agent && (!chosen || agent === chosen)) return { agent, pid };
  }
  const fromEnv = detectEnv(env);
  return fromEnv ? { agent: fromEnv } : undefined;
}

/** Lower-case ASCII words joined by dashes, at most 40 characters. */
export function slug(value: string): string {
  let out = '';
  for (const ch of value.normalize('NFKD')) {
    if (out.length > 40) break;
    if (/[A-Za-z0-9]/.test(ch)) out += ch.toLowerCase();
    else if (/\p{M}/u.test(ch)) continue;
    else if (out && !out.endsWith('-')) out += '-';
  }
  return out.slice(0, 40).replace(/-+$/, '');
}

export function joined(base: string, suffix: string): string {
  const s = slug(suffix);
  const b = slug(base).slice(0, Math.max(0, 39 - s.length)).replace(/-+$/, '');
  if (!b) return s;
  if (!s) return b;
  return `${b}-${s}`;
}

function shortName(agent: AgentId): string {
  return agent === 'claude-code' ? 'claude' : agent;
}

/** `<folder>-<app>`: the repository's folder, else the working folder. */
export function defaultName(agent: AgentId, cwd: string, root?: string): string {
  return joined(slug(basename(root || cwd)) || 'home', shortName(agent));
}

/** The name asked for, else the default; the first `-2`, `-3`, … no other session here holds. */
export function pickName(asked: string | undefined, fallback: string, taken: (name: string) => boolean): string {
  const base = (asked && slug(asked)) || fallback;
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const name = joined(base, String(i));
    if (!taken(name)) return name;
  }
}
