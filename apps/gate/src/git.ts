/**
 * Deadline-bound Git helpers.
 *
 * Every invocation is delegated to a disposable Node worker. Its command
 * arguments arrive as one JSON argv value and its only stdout is a JSON
 * result. The worker and all of its git/ssh/credential descendants share a
 * fresh process group. A timeout or caller abort signals the whole group,
 * then escalates to SIGKILL after a short grace period. This is load-bearing
 * for remote Git because killing only `git` leaks its stuck children.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { nip98AuthHeader } from './nip98.js';
import { gitRepoUrl } from './config.js';
import type { Identity } from './identity.js';

export interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
  truncated?: boolean;
  stdoutBytes?: number;
}

export interface GitRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  stdin?: string;
  maxOutputBytes?: number;
}

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const DEFAULT_GIT_KILL_GRACE_MS = 500;

const BASE_GIT_ARGS = [
  '-c',
  'credential.helper=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'user.name=buzzy',
  '-c',
  'user.email=buzzy@example.com',
  '-c',
  'protocol.version=2',
  '-c',
  'http.lowSpeedLimit=1',
  '-c',
  'http.lowSpeedTime=30',
];

/** Plain spawned worker: request in argv, Git stdin streamed separately, JSON stdout out. */
const GIT_WORKER_SOURCE = String.raw`
const { spawn } = require('node:child_process');
const request = JSON.parse(process.argv[1]);
const child = spawn(request.command, request.args, {
  cwd: request.cwd,
  env: process.env,
  stdio: [request.hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
let stdoutBytes = 0;
let stderrBytes = 0;
let truncated = false;
const append = (current, chunk, bytes) => {
  const text = chunk.toString('utf8');
  const nextBytes = bytes + Buffer.byteLength(text);
  const remaining = Math.max(0, request.maxOutputBytes - Buffer.byteLength(current));
  const next = remaining > 0
    ? current + Buffer.from(text).subarray(0, remaining).toString('utf8')
    : current;
  return { text: next, bytes: nextBytes };
};
child.stdout.on('data', (chunk) => {
  const next = append(stdout, chunk, stdoutBytes);
  stdout = next.text;
  stdoutBytes = next.bytes;
  if (stdoutBytes > request.maxOutputBytes) truncated = true;
});
child.stderr.on('data', (chunk) => {
  const next = append(stderr, chunk, stderrBytes);
  stderr = next.text;
  stderrBytes = next.bytes;
  if (stderrBytes > request.maxOutputBytes) truncated = true;
});
if (request.hasStdin) process.stdin.pipe(child.stdin);
let emitted = false;
const emit = (status, error) => {
  if (emitted) return;
  emitted = true;
  if (error) stderr += (stderr ? '\\n' : '') + error.message;
  process.stdout.write(JSON.stringify({
    ok: status === 0,
    status,
    stdout,
    stderr,
    ...(truncated ? { truncated: true } : {}),
    stdoutBytes,
  }));
};
child.once('error', (error) => emit(null, error));
child.once('close', (status) => emit(status));
`;

function isolatedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH_COMMAND:
      process.env.GIT_SSH_COMMAND ??
      'ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=2',
  };
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

async function runGitProcess(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: GitRunOptions = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_GIT_KILL_GRACE_MS;
  const command = env.BEELINE_GIT_BINARY?.trim() || 'git';
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const child = spawn(
    process.execPath,
    [
      '-e',
      GIT_WORKER_SOURCE,
      JSON.stringify({
        command,
        args,
        cwd,
        hasStdin: options.stdin !== undefined,
        maxOutputBytes,
      }),
    ],
    {
      env,
      detached: process.platform !== 'win32',
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    },
  );
  let workerStdout = '';
  let workerStderr = '';
  let timedOut = false;
  let aborted = false;
  let killTimer: NodeJS.Timeout | undefined;
  let settled = false;

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    workerStdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    workerStderr = `${workerStderr}${chunk}`.slice(-16_000);
  });
  if (child.stdin) {
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin);
  }

  const terminate = (reason: 'timeout' | 'abort') => {
    if (settled) return;
    timedOut ||= reason === 'timeout';
    aborted ||= reason === 'abort';
    killProcessGroup(child, 'SIGTERM');
    killTimer ??= setTimeout(() => killProcessGroup(child, 'SIGKILL'), killGraceMs);
    // This timer is intentionally referenced. The worker leader commonly
    // exits on SIGTERM before a stuck ssh/credential descendant does; letting
    // a one-shot caller exit before this fires would leak that descendant.
  };
  const onAbort = () => terminate('abort');
  const deadlineTimer = setTimeout(() => terminate('timeout'), timeoutMs);
  deadlineTimer.unref?.();

  return new Promise<GitResult>((resolveResult) => {
    const finish = (status: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      // After an abort/deadline, keep the scheduled SIGKILL alive even when
      // the worker leader exits first: a git/ssh descendant may still be
      // ignoring SIGTERM in the same process group.
      if (killTimer && !timedOut && !aborted) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      let result: GitResult = { ok: false, status: null, stdout: '', stderr: workerStderr };
      if (!timedOut && !aborted && !spawnError && status === 0) {
        try {
          result = JSON.parse(workerStdout) as GitResult;
        } catch {
          result.stderr = `${result.stderr ? `${result.stderr}\n` : ''}git worker returned invalid JSON`;
        }
      }
      if (spawnError) {
        result.stderr += `${result.stderr ? '\n' : ''}${spawnError.message}`;
      }
      if (timedOut) {
        result.stderr += `${result.stderr ? '\n' : ''}git deadline exceeded after ${timeoutMs}ms`;
      }
      if (aborted) result.stderr += `${result.stderr ? '\n' : ''}git operation aborted`;
      resolveResult({
        ...result,
        ok: result.ok && !timedOut && !aborted,
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
      });
    };
    child.once('error', (error) => finish(null, error));
    child.once('close', (status) => finish(status));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

/** Run a plain isolated git command in `cwd` (no relay auth). */
export function git(cwd: string, args: string[], options?: GitRunOptions): Promise<GitResult> {
  return runGitProcess(cwd, [...BASE_GIT_ARGS, ...args], isolatedGitEnv(), options);
}

/** Run git with the operator's ambient configuration and credentials. */
export function gitWithUserCredentials(
  cwd: string,
  args: string[],
  options?: GitRunOptions,
): Promise<GitResult> {
  return runGitProcess(cwd, args, { ...process.env }, options);
}

/** Run GitHub smart-HTTP with a short-lived App installation token. */
export function gitWithInstallationToken(
  cwd: string,
  token: string,
  args: string[],
  options?: GitRunOptions,
): Promise<GitResult> {
  if (!token.trim()) throw new Error('GitHub installation token is required');
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return runGitProcess(
    cwd,
    [...BASE_GIT_ARGS, '-c', `http.extraHeader=Authorization: Basic ${basic}`, ...args],
    isolatedGitEnv(),
    options,
  );
}

/** Run a git command that talks to the relay as `identity`. */
export function gitAuthed(
  cwd: string,
  identity: Identity,
  ownerHex: string,
  repo: string,
  args: string[],
  options?: GitRunOptions,
): Promise<GitResult> {
  const url = gitRepoUrl(ownerHex, repo);
  const header = nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'GET');
  return runGitProcess(
    cwd,
    [...BASE_GIT_ARGS, '-c', `http.extraHeader=Authorization: ${header}`, ...args],
    isolatedGitEnv(),
    options,
  );
}

/** Resolve the remote tip of a ref (40-hex) or undefined if absent. */
export async function lsRemoteRef(
  cwd: string,
  identity: Identity,
  ownerHex: string,
  repo: string,
  ref: string,
  options?: GitRunOptions,
): Promise<string | undefined> {
  const url = gitRepoUrl(ownerHex, repo);
  const res = await gitAuthed(cwd, identity, ownerHex, repo, ['ls-remote', url, ref], options);
  if (!res.ok) return undefined;
  const line = res.stdout.split('\n').find((candidate) => candidate.trim().length > 0);
  return line ? line.split('\t')[0] : undefined;
}
