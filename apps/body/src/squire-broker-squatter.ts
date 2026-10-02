/**
 * The host unit's socket preflight. Squire's broker unlinks a dead
 * predecessor's socket on its own, but it refuses to bind over a LIVE
 * listener: `listen EADDRINUSE` on `<host>/.trusty-squire/mcp.sock`, every
 * five seconds, for as long as the other broker lives. Before the unit execs
 * Squire, find whoever holds the unit's sockets and, only when that holder is
 * itself a Trusty Squire broker for the same profile directory, stop it so the
 * unit becomes the single broker. Anything else is left alone and the unit
 * fails with a reason that names the holder.
 */
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { squireBrokerSocketReady } from './squire-host.js';

export type SquireSocketHolder = {
  readonly pid: number;
  readonly argv: readonly string[];
  /** A Trusty Squire `broker` process whose profile resolves to ours. */
  readonly sameProfileBroker: boolean;
};

export type ReclaimOptions = {
  readonly sockets: readonly string[];
  readonly profileDir: string;
  readonly procRoot?: string;
  readonly log?: (line: string) => void;
  readonly stopTimeoutMs?: number;
  readonly killTimeoutMs?: number;
};

export type ReclaimResult = { ok: true; stopped: number[] } | { ok: false; reason: string };

const LISTENING = 0x10000;

/** Listening Unix socket inodes bound to `path`, including ones whose file was since unlinked. */
export function listeningSocketInodes(path: string, procRoot = '/proc'): string[] {
  let table: string;
  try {
    table = readFileSync(join(procRoot, 'net', 'unix'), 'utf8');
  } catch {
    return [];
  }
  const inodes: string[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const flags = Number.parseInt(fields[3] ?? '', 16);
    if (!(flags & LISTENING)) continue;
    if (fields.slice(7).join(' ') !== path) continue;
    inodes.push(fields[6] as string);
  }
  return inodes;
}

function readNulList(path: string): string[] | null {
  try {
    return readFileSync(path, 'utf8').split('\0').filter((part) => part.length > 0);
  } catch {
    return null;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** `node …/@trusty-squire/mcp/dist/bin.js broker`, directly or through npm's `.bin/mcp` link. */
function isSquireBrokerArgv(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index + 1] !== 'broker') continue;
    if (canonical(argv[index] as string).includes('/@trusty-squire/mcp/')) return true;
  }
  return false;
}

/** The profile Squire's `CHROME_PROFILE_DIR` resolves to under that process's own environment. */
function holderProfileDir(environ: readonly string[]): string | null {
  const env = new Map<string, string>();
  for (const entry of environ) {
    const at = entry.indexOf('=');
    if (at > 0) env.set(entry.slice(0, at), entry.slice(at + 1));
  }
  const configured = env.get('TRUSTY_SQUIRE_PROFILE_DIR')?.trim();
  if (configured) return configured;
  const home = env.get('HOME');
  return home ? join(home, '.trusty-squire', 'chrome-profile') : null;
}

/** Every process with an open fd on one of `inodes`, and whether it is a same-profile Squire broker. */
export function socketHolders(
  inodes: readonly string[],
  profileDir: string,
  procRoot = '/proc',
): SquireSocketHolder[] {
  if (inodes.length === 0) return [];
  const wanted = new Set(inodes.map((inode) => `socket:[${inode}]`));
  const holders: SquireSocketHolder[] = [];
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let fds: string[];
    try {
      fds = readdirSync(join(procRoot, entry, 'fd'));
    } catch {
      continue;
    }
    const holds = fds.some((fd) => {
      try {
        return wanted.has(readlinkSync(join(procRoot, entry, 'fd', fd)));
      } catch {
        return false;
      }
    });
    if (!holds) continue;
    const argv = readNulList(join(procRoot, entry, 'cmdline')) ?? [];
    const environ = readNulList(join(procRoot, entry, 'environ')) ?? [];
    const theirs = holderProfileDir(environ);
    holders.push({
      pid,
      argv,
      sameProfileBroker:
        isSquireBrokerArgv(argv) && theirs !== null && canonical(theirs) === canonical(profileDir),
    });
  }
  return holders;
}

function alive(pid: number, procRoot: string): boolean {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    // `pid (comm) S …` — comm may contain spaces and parentheses.
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

async function waitGone(pids: readonly number[], procRoot: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some((pid) => alive(pid, procRoot))) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return true;
}

function describe(holder: SquireSocketHolder): string {
  return `pid ${holder.pid} (${holder.argv.join(' ') || 'unknown command'})`;
}

/**
 * Leave the unit's sockets free for Squire to bind. A missing or stale socket
 * file needs nothing here (Squire unlinks it itself); a live one is reclaimed
 * only from a same-profile Squire broker.
 */
export async function reclaimSquireBrokerSockets(options: ReclaimOptions): Promise<ReclaimResult> {
  const procRoot = options.procRoot ?? '/proc';
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const held: string[] = [];
  for (const socket of options.sockets) {
    if (await squireBrokerSocketReady(socket)) held.push(socket);
  }
  if (held.length === 0) return { ok: true, stopped: [] };

  const holders = new Map<number, SquireSocketHolder>();
  for (const socket of held) {
    for (const holder of socketHolders(listeningSocketInodes(socket, procRoot), options.profileDir, procRoot)) {
      holders.set(holder.pid, holder);
    }
  }
  const named = held.join(', ');
  if (holders.size === 0) {
    return { ok: false, reason: `${named} is held by a live listener whose pid could not be found` };
  }
  const foreign = [...holders.values()].filter((holder) => !holder.sameProfileBroker);
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `${named} is held by ${foreign.map(describe).join(', ')}, which is not a Trusty Squire broker for ${options.profileDir}; refusing to stop it`,
    };
  }

  const pids = [...holders.keys()];
  for (const holder of holders.values()) {
    log(`[beeline] ${named} is held by Trusty Squire broker ${describe(holder)} that this unit did not start; stopping it`);
    try {
      process.kill(holder.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  if (!(await waitGone(pids, procRoot, options.stopTimeoutMs ?? 15_000))) {
    for (const pid of pids.filter((candidate) => alive(candidate, procRoot))) {
      log(`[beeline] Trusty Squire broker pid ${pid} ignored SIGTERM; sending SIGKILL`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    if (!(await waitGone(pids, procRoot, options.killTimeoutMs ?? 5_000))) {
      return { ok: false, reason: `Trusty Squire broker ${pids.join(', ')} holding ${named} did not exit` };
    }
  }
  for (const socket of held) {
    if (await squireBrokerSocketReady(socket)) {
      return { ok: false, reason: `${socket} is still held after stopping pid ${pids.join(', ')}` };
    }
  }
  return { ok: true, stopped: pids };
}

