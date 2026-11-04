// Local state for sessions that joined Beeline: one private file per machine user, a lock, and per-session inboxes
// for apps that take messages through their own hooks or plugins instead of a push channel.
import { createHash, randomUUID } from 'node:crypto';
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
  /** Committed member-stream delivery cursor, persisted after durable inbox. */
  streamCursor?: { epoch: string; through: number; pending?:true };
  /** Wakes already handed to the session, so a waiting order is delivered once. */
  deliveredWakes: string[];
  /** The newest wake handed over: only a newer one ends a long poll early. */
  wakesSeenAt?: string;
  /** When each still-waiting wake was first handed over, and how often it was handed over again since. */
  wakeDeliveries?: Record<string, { firstAt: string; redeliveries: number }>;
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

/** Every new local or streamed message uses the same durable delivery queue. */
export function queueInbox(dir: string, key: string, text: string): void {
  adoptInboxText(dir,key);
  queueInboxOnce(dir,key,`local:${randomUUID()}`,text);
}

/** Move installed-helper text into the delivery queue atomically. No text is
 * consumed here: a crash before/after rename leaves it in exactly one queue,
 * and the usual delivery claim handles concurrent hooks. The .text suffix is
 * the input codec for those pre-stream files, never a second writer/consumer.
 */
function adoptInboxText(dir:string,key:string):void {
  const folder=ensureDir(join(dir,'deliveries',createHash('sha256').update(key).digest('hex').slice(0,24)));
  try {renameSync(inboxPath(dir,key),join(folder,`${randomUUID()}.text.pending`));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
let lastInboxOrder=0;

/** A stable delivery is stored before its transport cursor advances. A taken
 * delivery retains a content-free tombstone, so replay after a crash cannot
 * append the same text to an app inbox again. This is local delivery identity,
 * not a claim of exactly-once behavior by a third-party app. */
export function queueInboxOnce(dir: string, key: string, deliveryId: string, text: string): boolean {
  lastInboxOrder=Math.max(Date.now(),lastInboxOrder+0.001);
  const queuedAt=lastInboxOrder;
  if (!deliveryId || deliveryId.length > 256) throw new Error('Invalid inbox delivery identity');
  const folder = ensureDir(join(dir, 'deliveries', createHash('sha256').update(key).digest('hex').slice(0,24)));
  const stem = join(folder, createHash('sha256').update(deliveryId).digest('hex'));
  if (existsDelivery(stem+'.pending') || existsDelivery(stem+'.done')) return false;
  writePrivate(stem+'.pending', JSON.stringify({id:deliveryId,text,queuedAt}));
  return true;
}
function existsDelivery(path: string): boolean { try { statSync(path); return true; } catch { return false; } }
function takeDeliveries(dir: string, key: string): string[] {
  const folder=join(dir,'deliveries',createHash('sha256').update(key).digest('hex').slice(0,24));
  let names: string[]; try { names=readdirSync(folder); } catch { return []; }
  const pending=names.filter(name=>name.endsWith('.pending')).flatMap(name=>{
    try { const contents=readFileSync(join(folder,name),'utf8');
      const item=name.endsWith('.text.pending')?{text:contents,queuedAt:0}:JSON.parse(contents) as {text:string;queuedAt:number};
      return typeof item.text==='string' ? [{name,...item}] : []; } catch { return []; }
  }).sort((a,b)=>a.queuedAt-b.queuedAt || a.name.localeCompare(b.name));
  const text: string[]=[];
  for (const item of pending) {
    const path=join(folder,item.name),done=path.replace(/\.pending$/,'.done');
    try { renameSync(path,done); } catch { continue; }
    text.push(item.text); writePrivate(done,'');
  }
  return text;
}

/** Takes everything waiting for a joined session; it is gone once taken. */
export function takeInbox(dir: string, key: string): string {
  adoptInboxText(dir,key);
  return takeDeliveries(dir,key).join('\n\n');
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
