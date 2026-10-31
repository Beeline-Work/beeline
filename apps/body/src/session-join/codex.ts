// Ported from Reason Network (src/codex.rs, src/daemon/mail.rs), Copyright 2026 Reason Machines, Inc.,
// MIT OR Apache-2.0. See ./NOTICE and ./UPSTREAM.json for the copied commit.
//
// A Codex thread's rollout records each turn's start (`task_started`) and end (`task_complete`, `turn_aborted`).
// `codex queue --thread <id> --message <text>` hands a message to a running thread: it runs after the current turn,
// or at once if the thread is idle.
import { execFile } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fromProcessName, processCommand } from './agents.js';

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
}

/** true for a line recording a turn's start, false for its end, undefined for anything else. */
export function turnEvent(line: string): boolean | undefined {
  if (!line.includes('event_msg') || !(line.includes('task_') || line.includes('turn_'))) return undefined;
  try {
    const value = JSON.parse(line) as { type?: unknown; payload?: { type?: unknown } };
    if (value.type !== 'event_msg') return undefined;
    const type = value.payload?.type;
    if (type === 'task_started' || type === 'turn_started') return true;
    if (type === 'task_complete' || type === 'turn_complete' || type === 'turn_aborted') return false;
  } catch { /* not a whole event */ }
  return undefined;
}

const seen = new Map<string, { at: number; running: boolean }>();

/**
 * Whether the last turn the rollout records is still running; a rollout without a turn yet is idle. undefined when
 * it can't be read. Remembers how far it read, so later calls read only what was appended; a line still being
 * written is read next time.
 */
export function turnRunning(path: string): boolean | undefined {
  let fd: number;
  try {
    // Only a regular file: opening a pipe a hook named would wait for a writer.
    if (!statSync(path).isFile()) return undefined;
    fd = openSync(path, 'r');
  } catch { return undefined; }
  try {
    const length = fstatSync(fd).size;
    const before = seen.get(path);
    // Rollouts only grow: a shorter one was rewritten, and is read again.
    const from = before && before.at <= length ? before.at : 0;
    let running = before && before.at <= length ? before.running : false;
    const buffer = Buffer.alloc(length - from);
    readSync(fd, buffer, 0, buffer.length, from);
    const whole = buffer.lastIndexOf(0x0a) + 1;
    for (const line of buffer.subarray(0, whole).toString('utf8').split('\n')) {
      const event = turnEvent(line);
      if (event !== undefined) running = event;
    }
    seen.set(path, { at: from + whole, running });
    return running;
  } finally { closeSync(fd); }
}

/** The thread id a rollout file is named for: `rollout-<time>-<uuid>.jsonl`. */
export function rolloutThread(path: string): string | undefined {
  return /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(basename(path))?.[1];
}

export interface CodexSession { pid: number; threadId: string; cwd?: string; rollout: string }

/** Live Codex threads on this machine: each Codex process keeps its thread's rollout open. Linux only. */
export function scanCodex(proc = '/proc'): CodexSession[] {
  let pids: string[];
  try { pids = readdirSync(proc).filter(name => /^\d+$/.test(name)); } catch { return []; }
  const found: CodexSession[] = [];
  for (const name of pids) {
    const pid = Number(name);
    const command = proc === '/proc' ? processCommand(pid) : undefined;
    if (proc === '/proc' && (!command || fromProcessName(command) !== 'codex')) continue;
    let fds: string[];
    try { fds = readdirSync(join(proc, name, 'fd')); } catch { continue; }
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(join(proc, name, 'fd', fd)); } catch { continue; }
      const threadId = rolloutThread(target);
      if (!threadId) continue;
      let cwd: string | undefined;
      try { cwd = readlinkSync(join(proc, name, 'cwd')); } catch { /* unknown */ }
      found.push({ pid, threadId, cwd, rollout: target });
      break;
    }
  }
  return found;
}

/** Hands text to a Codex thread with Codex's own CLI. */
export function codexQueue(threadId: string, text: string, bin = 'codex', timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['queue', '--thread', threadId, '--message', text], { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message));
      else resolve();
    });
  });
}
