/** Dedicated no-model runner for exact hash-pinned mission schedule scripts. */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { buildBwrapArgv, type MaskedPath, type SandboxMountPlan } from './bwrap-sandbox.js';

export const MAX_MISSION_SCRIPT_OUTPUT_BYTES = 64 * 1024;
export const MAX_MISSION_POINTER_CHARS = 2_048;
export const MISSION_SCRIPT_KILL_GRACE_MS = 500;
export const MISSION_SCRIPT_SCRATCH_BYTES = 64 * 1024 * 1024;
export const MISSION_SCRIPT_SCRATCH_INODES = 4_096;

const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_REPOSITORY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SCRATCH_DIR = '/tmp/beeline-mission-script';

export interface MissionScriptWake {
  agentPubkey: string;
  repositoryKey: string;
  pointer: string;
}

export interface MissionScriptResult {
  status: 'complete';
  outputBytes: number;
  wake?: MissionScriptWake;
}

export type MissionScriptFailureCode =
  | 'sandbox-unavailable'
  | 'script-hash-mismatch'
  | 'spawn-failed'
  | 'timeout'
  | 'output-truncated'
  | 'nonzero-exit'
  | 'invalid-output'
  | 'cancelled';

export class MissionScriptFailure extends Error {
  constructor(
    readonly code: MissionScriptFailureCode,
    readonly outputTail = '',
  ) {
    super(outputTail ? `${code}: ${outputTail}` : code);
    this.name = 'MissionScriptFailure';
  }
}

export function missionScriptHashMatches(script: string, expectedSha256: string): boolean {
  return (
    HEX_64.test(expectedSha256) &&
    createHash('sha256').update(script).digest('hex') === expectedSha256
  );
}

function safePointer(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const pointer = value.trim();
  if (
    !pointer ||
    pointer.length > MAX_MISSION_POINTER_CHARS ||
    /[\0\r\n]/.test(pointer) ||
    isAbsolute(pointer) ||
    pointer.split(/[\\/]/).includes('..') ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(pointer)
  ) {
    return undefined;
  }
  return pointer;
}

/** Strict one-line protocol. Arbitrary stdout is never executable authority. */
export function parseMissionScriptOutput(
  stdout: string,
  expectedRepositoryKey: string,
): MissionScriptResult {
  const line = stdout.trim();
  if (!line || line.includes('\n') || line.includes('\r')) {
    throw new MissionScriptFailure('invalid-output');
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new MissionScriptFailure('invalid-output');
  }
  const input =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (!input || input.version !== 1 || input.status !== 'complete') {
    throw new MissionScriptFailure('invalid-output');
  }
  const wakeAgentPubkey = input.wakeAgentPubkey;
  const repositoryKey = input.repositoryKey;
  const pointer = input.pointer;
  const hasWake =
    wakeAgentPubkey !== undefined || repositoryKey !== undefined || pointer !== undefined;
  if (!hasWake) return { status: 'complete', outputBytes: Buffer.byteLength(stdout) };
  const parsedPointer = safePointer(pointer);
  if (
    typeof wakeAgentPubkey !== 'string' ||
    !HEX_64.test(wakeAgentPubkey) ||
    typeof repositoryKey !== 'string' ||
    !SAFE_REPOSITORY_KEY.test(repositoryKey) ||
    repositoryKey !== expectedRepositoryKey ||
    !parsedPointer
  ) {
    throw new MissionScriptFailure('invalid-output');
  }
  return {
    status: 'complete',
    outputBytes: Buffer.byteLength(stdout),
    wake: { agentPubkey: wakeAgentPubkey, repositoryKey, pointer: parsedPointer },
  };
}

function minimalEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: input.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: input.LANG ?? 'C.UTF-8',
    LC_ALL: input.LC_ALL ?? 'C.UTF-8',
    HOME: '/tmp',
    TMPDIR: SCRATCH_DIR,
  };
}

/** Pure mount plan: read-only host, exact mission checkout writable, masked credentials. */
export function missionScriptMountPlan(cwd: string, masks: MaskedPath[]): SandboxMountPlan {
  const worktree = resolve(cwd);
  return {
    readOnly: [],
    writable: [worktree],
    quotaTmpfs: [
      {
        target: SCRATCH_DIR,
        maxBytes: MISSION_SCRIPT_SCRATCH_BYTES,
        maxInodes: MISSION_SCRIPT_SCRATCH_INODES,
        blockGit: true,
      },
    ],
    masks: [...masks],
  };
}

function outputTail(stderr: Buffer, stdout: Buffer): string {
  return Buffer.concat([stderr, stdout])
    .toString('utf8')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(-600);
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * Run exact script bytes. Bubblewrap and the exact hash are hard start gates;
 * unlike interactive corner activation this unattended path never fails open.
 * Network is intentionally inherited, matching the captain-approved corner
 * posture; only filesystem/process setup is narrower here.
 */
export async function runMissionScript(input: {
  bwrapPath?: string;
  cwd: string;
  repositoryKey: string;
  script: string;
  scriptSha256: string;
  timeoutSeconds: number;
  maskPaths: MaskedPath[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<MissionScriptResult> {
  if (!input.bwrapPath) throw new MissionScriptFailure('sandbox-unavailable');
  if (!missionScriptHashMatches(input.script, input.scriptSha256)) {
    throw new MissionScriptFailure('script-hash-mismatch');
  }
  const cwd = resolve(input.cwd);
  const wrapped = buildBwrapArgv({
    bwrapPath: input.bwrapPath,
    plan: missionScriptMountPlan(cwd, input.maskPaths),
    cwd,
    command: '/bin/sh',
    args: ['-ceu', input.script],
  });
  return new Promise<MissionScriptResult>((resolvePromise, rejectPromise) => {
    const child = spawn(wrapped.command, wrapped.args, {
      cwd,
      env: minimalEnvironment(input.env),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let termination: MissionScriptFailureCode | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (code: MissionScriptFailureCode) => {
      if (settled || termination) return;
      termination = code;
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(
        () => killProcessGroup(child, 'SIGKILL'),
        MISSION_SCRIPT_KILL_GRACE_MS,
      );
    };
    const onAbort = () => terminate('cancelled');
    const deadline = setTimeout(() => terminate('timeout'), input.timeoutSeconds * 1_000);
    deadline.unref?.();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    const finish = (result?: MissionScriptResult, error?: MissionScriptFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener('abort', onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(result!);
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (termination) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_MISSION_SCRIPT_OUTPUT_BYTES - stdout.length - stderr.length;
      const retained = remaining > 0 ? bytes.subarray(0, remaining) : Buffer.alloc(0);
      if (target === 'stdout') stdout = Buffer.concat([stdout, retained]);
      else stderr = Buffer.concat([stderr, retained]);
      if (bytes.length >= remaining) {
        terminate('output-truncated');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', () => finish(undefined, new MissionScriptFailure('spawn-failed')));
    child.once('close', (code) => {
      const tail = outputTail(stderr, stdout);
      if (termination) {
        finish(undefined, new MissionScriptFailure(termination, tail));
        return;
      }
      if (code !== 0) {
        finish(undefined, new MissionScriptFailure('nonzero-exit', tail));
        return;
      }
      try {
        finish(parseMissionScriptOutput(stdout.toString('utf8'), input.repositoryKey));
      } catch (error) {
        finish(
          undefined,
          error instanceof MissionScriptFailure
            ? new MissionScriptFailure(error.code, tail)
            : new MissionScriptFailure('invalid-output', tail),
        );
      }
    });
  });
}
