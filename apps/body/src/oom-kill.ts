/**
 * Kernel OOM-kill detection for ACP harness children.
 *
 * A harness killed by the kernel's OOM killer dies to SIGKILL exactly like one
 * killed by a person or a supervisor. cgroup v2 publishes the one durable fact
 * that separates them: `memory.events`'s `oom_kill` counter. The daemon and
 * every harness child share the agent service's cgroup, so an increase between
 * probes is a process of this unit that the kernel reclaimed.
 *
 * Detection is best-effort and never load-bearing: a host without cgroup v2 (or
 * without the memory controller) reads `null`, which means "not OOM" and the
 * exit keeps its ordinary `signal=SIGKILL` wording.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** cgroup v2 mount point where the kernel publishes per-cgroup OOM counters. */
const CGROUP_V2_ROOT = '/sys/fs/cgroup';

/**
 * The `oom_kill` count from a cgroup v2 `memory.events` body. Returns null when
 * the line is absent (cgroup v1, or a host without the memory controller), so
 * detection stays off rather than guessing.
 */
export function parseOomKillCount(contents: string): number | null {
  for (const line of contents.split('\n')) {
    const [key, raw] = line.trim().split(/\s+/, 2);
    if (key !== 'oom_kill') continue;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return null;
}

/** The unified-hierarchy cgroup path from a `/proc/self/cgroup` body. */
export function unifiedCgroupPath(procSelfCgroup: string): string | null {
  const line = procSelfCgroup
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.startsWith('0::'));
  const path = line?.slice(3).trim();
  return path && path.startsWith('/') ? path : null;
}

export interface OomKillProbe {
  /** Current cumulative `oom_kill` count for this daemon's cgroup, or null. */
  read(): Promise<number | null>;
}

/**
 * Read the daemon's own cgroup counters. The cgroup path is resolved once: the
 * unified path cannot change for a running process.
 */
export function cgroupOomKillProbe(
  options: {
    procSelfCgroup?: () => Promise<string>;
    cgroupRoot?: string;
  } = {},
): OomKillProbe {
  const readProc = options.procSelfCgroup ?? (() => readFile('/proc/self/cgroup', 'utf8'));
  const root = options.cgroupRoot ?? CGROUP_V2_ROOT;
  let directory: string | null | undefined;
  return {
    async read(): Promise<number | null> {
      try {
        if (directory === undefined) {
          const path = unifiedCgroupPath(await readProc());
          directory = path ? join(root, path) : null;
        }
        if (!directory) return null;
        return parseOomKillCount(await readFile(join(directory, 'memory.events'), 'utf8'));
      } catch {
        return null;
      }
    },
  };
}

/**
 * Turns a cgroup `oom_kill` counter into a per-child verdict. The counter is
 * cumulative and shared by the whole unit, so increments are banked and handed
 * out one per `consume()` call: several children reclaimed together still each
 * report an OOM exit instead of only the first.
 */
export class OomKillTracker {
  #last: number | null = null;
  #banked = 0;

  constructor(private readonly probe: OomKillProbe) {}

  /** Record the current count so the next kill is measured against it. */
  async prime(): Promise<void> {
    const current = await this.probe.read();
    if (current !== null) this.#last = current;
  }

  async consume(): Promise<boolean> {
    const current = await this.probe.read();
    if (current === null) return false;
    if (this.#last !== null && current > this.#last) this.#banked += current - this.#last;
    this.#last = current;
    if (this.#banked === 0) return false;
    this.#banked -= 1;
    return true;
  }
}

/** A tracker a caller may inject; tests stub it, production uses cgroup v2. */
export interface OomKillDetector {
  prime(): Promise<void>;
  consume(): Promise<boolean>;
}
