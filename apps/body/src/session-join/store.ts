// Local state for sessions that joined Beeline: one private file per machine user, a lock, and per-session inboxes
// for apps that take messages through their own hooks or plugins instead of a push channel.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentId } from './agents.js';

/** One joined session: the Beeline member it acts as, and how it is reached on this machine. */
export interface JoinedSession {
  /** `<app>:<working folder>`: a session reopened in the same folder rejoins as the same member. */
  key: string;
  agent: AgentId;
  cwd: string;
  name: string;
  handle?: string;
  server: string;
  clientId: string;
  refreshToken: string;
  accessToken?: string;
  accessExpiresAt?: number;
  /** The app's own conversation id when it was last seen (Claude Code session, Codex thread, …). */
  sessionId?: string;
  pid?: number;
  /** Mentions after this `list_mentions` cursor are not delivered yet. */
  cursor: string;
  /** Wakes already handed to the session, so a waiting order is delivered once. */
  deliveredWakes: string[];
  /** The newest wake handed over: only a newer one ends a long poll early. */
  wakesSeenAt?: string;
  /** The app's own CLI, for apps reached through it (Codex). */
  agentBin?: string;
  joinedAt: string;
}

/** A session an app's hook or plugin reported: alive while it reports, and its process lives. */
export interface HookSession {
  agent: AgentId;
  sessionId: string;
  cwd: string;
  pid?: number;
  state?: 'busy' | 'idle';
  transcript?: string;
  seenAt: number;
}

interface State { sessions: JoinedSession[] }

/** A hook-only session that has not reported for this long is gone. */
export const HOOK_TTL_MS = 6 * 3_600_000;

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state'), 'beeline-sessions');
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function writePrivate(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function readState(dir = stateDir()): State {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as State;
    return Array.isArray(value.sessions) ? value : { sessions: [] };
  } catch { return { sessions: [] }; }
}

/** Callers hold the lock. */
export function writeState(dir: string, state: State): void {
  writePrivate(join(ensureDir(dir), 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

/** Serializes every change to the state file across the bridge and one-off commands. */
export async function withLock<T>(dir: string, run: () => Promise<T> | T): Promise<T> {
  const lock = join(ensureDir(dir), 'state.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A holder that died leaves its lock; nothing holds it for 30 seconds.
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
      if (attempt > 400) throw new Error('Beeline session state is locked');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await run(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Reads, changes and writes the state under the lock. */
export function updateState<T>(dir: string, change: (state: State) => T): Promise<T> {
  return withLock(dir, () => {
    const state = readState(dir);
    const result = change(state);
    writeState(dir, state);
    return result;
  });
}

export function sessionKey(agent: AgentId, cwd: string): string {
  return `${agent}:${cwd}`;
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

function inboxPath(dir: string, key: string): string {
  return join(dir, 'inbox', `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.txt`);
}

/** Text waiting for a joined session until its app takes it: by push, or at its next hook or plugin poll. */
export function queueInbox(dir: string, key: string, text: string): void {
  ensureDir(join(dir, 'inbox'));
  const path = inboxPath(dir, key);
  let existing = '';
  try { existing = readFileSync(path, 'utf8'); } catch { /* empty */ }
  writePrivate(path, existing ? `${existing}\n\n${text}` : text);
}

/** Takes everything waiting for a joined session; it is gone once taken. */
export function takeInbox(dir: string, key: string): string {
  const path = inboxPath(dir, key);
  const taken = `${path}.${process.pid}.taking`;
  try { renameSync(path, taken); } catch { return ''; }
  try { return readFileSync(taken, 'utf8'); } finally { rmSync(taken, { force: true }); }
}

export function recordHookSession(dir: string, session: HookSession): void {
  writePrivate(join(ensureDir(join(dir, 'hooks')), `${safe(session.agent)}-${safe(session.sessionId)}.json`), JSON.stringify(session));
}

export function forgetHookSession(dir: string, agent: AgentId, sessionId: string): void {
  rmSync(join(dir, 'hooks', `${safe(agent)}-${safe(sessionId)}.json`), { force: true });
}

/** Sessions apps reported through hooks that are still alive. */
export function hookSessions(dir: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): HookSession[] {
  let names: string[];
  try { names = readdirSync(join(dir, 'hooks')); } catch { return []; }
  const found: HookSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const session = JSON.parse(readFileSync(join(dir, 'hooks', name), 'utf8')) as HookSession;
      if (now - session.seenAt <= HOOK_TTL_MS && (session.pid === undefined || alive(session.pid))) found.push(session);
    } catch { /* half-written */ }
  }
  return found;
}
