// Ported from Reason Network (src/claude.rs, src/agent.rs), Copyright 2026 Reason Machines, Inc.,
// MIT OR Apache-2.0. See ./NOTICE and ./UPSTREAM.json for the copied commit.
//
// Claude Code keeps one `<config>/sessions/<pid>.json` per live session (name, cwd, busy/idle, and the inbox socket
// its peers post into). Posting a `user` frame to that socket puts the text in the conversation between tool calls,
// or starts a turn if the session is idle. This is undocumented; `postToClaude` failing falls back to the
// SessionStart hook's next run.
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pidAlive } from './store.js';

export interface ClaudeSession {
  pid: number;
  sessionId?: string;
  cwd?: string;
  name?: string;
  /** `user` after a `/rename`; `derived` or `auto` for a name Claude Code made up. */
  nameSource?: string;
  status?: string;
  messagingSocketPath?: string;
}

export interface ClaudeSocket { path: string; token?: string }

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
}

/** Every live Claude Code session on this machine. */
export function scanClaude(env: NodeJS.ProcessEnv = process.env, alive: (pid: number) => boolean = pidAlive): ClaudeSession[] {
  const dir = join(claudeConfigDir(env), 'sessions');
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const sessions: ClaudeSession[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8')) as ClaudeSession;
      if (Number.isInteger(value.pid) && alive(value.pid)) sessions.push(value);
    } catch { /* A half-written entry is read next time. */ }
  }
  return sessions;
}

/** The name someone chose for the session (`/rename`), as opposed to the one Claude Code made up. */
export function chosenName(session: ClaudeSession): string | undefined {
  return ['user', 'peer', 'hook'].includes(session.nameSource ?? '') ? session.name : undefined;
}

/**
 * The Claude Code process we run under: the nearest ancestor with a registry entry. A headless Claude run from an
 * interactive one's shell has no entry of its own, so the entry above it is the other conversation's; the caller
 * checks the conversation id when the environment names one.
 */
export function registryAncestor(chain: number[], hasEntry: (pid: number) => boolean): number | undefined {
  return chain.find(hasEntry);
}

/** The inbox of a live session, by its conversation id or its process. */
export function socketFor(sessions: ClaudeSession[], sessionId?: string, pid?: number): ClaudeSocket | undefined {
  const session = sessions.find(s => (sessionId && s.sessionId === sessionId) || (pid !== undefined && s.pid === pid));
  return session?.messagingSocketPath ? { path: session.messagingSocketPath } : undefined;
}

export function postToClaude(socket: ClaudeSocket, text: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket.path);
    const timer = setTimeout(() => { connection.destroy(); reject(new Error('Claude Code inbox did not answer')); }, timeoutMs);
    connection.once('error', error => { clearTimeout(timer); reject(error); });
    connection.once('connect', () => {
      if (socket.token) connection.write(JSON.stringify({ type: 'auth', token: socket.token }) + '\n');
      connection.end(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

/** The transcript of a conversation, wherever Claude Code filed it under its projects. */
export function claudeTranscript(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = join(claudeConfigDir(env), 'projects');
  let projects: string[];
  try { projects = readdirSync(root); } catch { return undefined; }
  for (const project of projects) {
    const path = join(root, project, `${sessionId}.jsonl`);
    try { if (statSync(path).isFile()) return path; } catch { /* not this project */ }
  }
  return undefined;
}

/** The permission mode a transcript last records; the last 2 MiB are enough. */
export function permissionMode(transcript: string): string | undefined {
  let fd: number;
  try { fd = openSync(transcript, 'r'); } catch { return undefined; }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 2 << 20);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    for (const line of buffer.toString('utf8').split('\n').reverse()) {
      try {
        const mode = (JSON.parse(line) as { permissionMode?: unknown }).permissionMode;
        if (typeof mode === 'string') return mode;
      } catch { /* The first line may be cut by the offset. */ }
    }
    return undefined;
  } finally { closeSync(fd); }
}

/**
 * Claude Code holds a peer's message for its person when the session skips permission prompts, unless
 * `crossSessionInbound` is `accept` in the person's settings.
 */
export function heldBy(mode: string | undefined, setting: string | undefined): boolean {
  return mode === 'bypassPermissions' && setting !== 'accept';
}

export function inboundSetting(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(claudeConfigDir(env), 'settings.json'), 'utf8')) as { crossSessionInbound?: unknown };
    return typeof value.crossSessionInbound === 'string' ? value.crossSessionInbound : undefined;
  } catch { return undefined; }
}
