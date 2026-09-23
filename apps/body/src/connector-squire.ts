/**
 * Trusty Squire connector lifecycle on the helper (Workbench PR 1).
 *
 * One helper shares the host Squire broker and its one Chrome. The install
 * runs Squire's own `connect --json` through a STREAMING runner that reads
 * the newline-delimited typed reports on stdout and hands the phone the
 * run's LAST report: the sign-in page once that report also names where the
 * page opened (Squire writes the placement on a later line, always before it
 * waits on the human), or a terminal report.
 *
 * Connect is not given `--skip-browser` or `--force-relogin`: skip-browser signs the
 * human in outside the bot profile so the shared Chrome never gains the
 * session, and force-relogin clears provider cookies and asserts a
 * single-session precondition the broker does not have. Not passing
 * force-relogin also makes Squire's already-provisioned short-circuit
 * reachable: the shared profile already holds the session, connect refreshes
 * the config and exits reporting `connected` with no ceremony at all, which
 * is a CONNECTED outcome, never a failed install. The connect process stays
 * alive in the background while the human completes sign-in.
 *
 * The old exit-only `ShellRunner` (defaultShellRunner) remains for the
 * version probe and other quick commands. A new `StreamedShellRunner`
 * (`defaultStreamedRunner`) handles the connect command: it spawns the
 * process, reads stdout line by line, and resolves the promise as soon as a
 * report is publishable (`isPublishableConnectReport`) or the process exits.
 *
 * Two guards keep a fresh connect attempt working (captain, 2026-09-17):
 *
 * - VERSION: the connect package spec tracks the `latest` dist-tag
 *   (`SQUIRE_CONNECT_VERSION`), which carries the machine-readable `--json`
 *   report this reader consumes (1.1.16 and later). Before connect runs, the
 *   version npx actually resolves is verified against that spec on the
 *   registry (`npm view`). A stale local copy (an npx cache or local
 *   node_modules shadow serving an older release or RC) is re-resolved with
 *   `--prefer-online`, and if the cache still refuses to move, connect runs
 *   the exact release resolved at runtime — never a stale copy.
 *
 * - SESSION: two claims, one authority. The spawned connect process owns the
 *   helper's in-memory claim (`activeConnectSession`). Squire itself records
 *   the real cross-process claim on disk as
 *   `/tmp/trusty-squire-profile-<digest>.lock` (digest of the Chrome profile
 *   path). A fresh connect attempt releases BOTH: a dead on-disk owner is
 *   reclaimed, our previous connect is aborted, and a still-live owner that
 *   is not our connect (another Squire server, another agent system) is
 *   left alone with an actionable "close that session" line — never killed.
 *   Closing the noVNC page and hitting Retry must never leave the next
 *   attempt staring at "another Trusty Squire session is already using the
 *   browser".
 *
 * Vault reads, ledger reads, and grant revocation go through the Squire MCP
 * tools (`list_credentials`, `audit_log`, `list_app_access`,
 * `revoke_app_access`) — never through any raw-value path. Everything is
 * expressed against the `SquireMcpClient` interface so tests drive a mocked
 * Squire and no test touches a real Squire account.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { squireHostPaths, squireHostRewriteEnv } from './squire-host.js';
import type {
  ConnectionDetail,
  ConnectionGrant,
  ConnectionLedgerEntry,
  ConnectorBrowserLocation,
  ConnectorSignIn,
  ConnectorStep,
  VaultConnectionMeta,
} from '@beeline/api-contract/daemon';

/** The one Squire MCP contract this connector speaks. */
export interface SquireMcpClient {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** The one Squire connect package, tracked at the release that carries the
 *  machine-readable `--json` connect report the helper reads. */
export const SQUIRE_MCP_NAME = '@trusty-squire/mcp';

/**
 * The npm dist-tag the Squire connect package tracks. `latest` carries the
 * typed `connect --json` report this helper consumes (1.1.16 and later), so
 * a Squire promote reaches the fleet with no Beeline change. A stale npx
 * cache is still caught by `resolveSquireConnectSpec` before connect runs:
 * the version npx actually resolves is re-checked against this dist-tag on
 * the registry.
 */
export const SQUIRE_CONNECT_VERSION = 'latest';
export const SQUIRE_CONNECT_PACKAGE = `${SQUIRE_MCP_NAME}@${SQUIRE_CONNECT_VERSION}`;

/**
 * The helper's one Squire connect browser-session claim. The connect process
 * spawned by `defaultStreamedRunner` claims it at spawn; the claim is
 * released by the NEXT connect attempt (`releaseSquireConnectSession`), which
 * detects whether the owner is still alive.
 */
export type ConnectSessionClaim = {
  /** The connect process's pid; undefined when the spawn never yielded one. */
  readonly pid: number | undefined;
  readonly claimedAt: number;
  /** Kill the owning connect process. */
  readonly abort: () => void;
};

let activeConnectSession: ConnectSessionClaim | undefined;

/** The connect session this helper currently claims, if any. */
export function squireConnectSession(): ConnectSessionClaim | undefined {
  return activeConnectSession;
}

/** Whether a process id is still running (`kill(pid, 0)`; EPERM means alive). */
export function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Release whatever connect session this helper still claims, so a fresh
 * connect attempt is never blocked by a phantom session. A claim whose owner
 * process has died (the human closed the page and the process exited, or the
 * claim outlived its spawn) is cleared outright; a still-live owner is
 * aborted — the fresh attempt supersedes it.
 */
export function releaseSquireConnectSession(log?: (message: string) => void): void {
  const claim = activeConnectSession;
  activeConnectSession = undefined;
  if (!claim) return;
  if (isProcessAlive(claim.pid)) {
    log?.(
      `released trusty-squire connect session claim (pid ${String(claim.pid)} still live — a fresh connect owns the browser now)`,
    );
    claim.abort();
  } else {
    log?.('cleared dead trusty-squire connect session claim (owner process gone)');
  }
}

/** The profile Squire serializes on, matching `@trusty-squire/mcp` host rewrite. */
export function squireChromeProfileDir(): string {
  return process.env.TRUSTY_SQUIRE_PROFILE_DIR ?? squireHostPaths(homedir()).profileDir;
}

/**
 * Squire's profile-path identity: realpath the longest existing prefix and
 * re-append missing suffixes so two spellings of the same profile hash
 * identically (the lock digest is of this string, not the raw path).
 */
export function squireProfilePathIdentity(profileDir: string): string {
  const absolute = resolve(profileDir);
  const suffix: string[] = [];
  let candidate = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(candidate), ...suffix.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

/** On-disk profile-operation lock Squire's connect CLI acquires. */
export function squireProfileLockPath(
  profileDir: string = squireChromeProfileDir(),
  lockRoot: string = tmpdir(),
): string {
  const digest = createHash('sha256')
    .update(squireProfilePathIdentity(profileDir))
    .digest('hex')
    .slice(0, 24);
  return join(lockRoot, `trusty-squire-profile-${digest}.lock`);
}

export type SquireProfileLockOwner = {
  readonly host: string;
  readonly pid: number;
  readonly startTime: string | null;
};

export function squireForeignClaimAction(owner: SquireProfileLockOwner): string {
  return (
    `Trusty Squire's browser is in use by another process (pid ${owner.pid}). ` +
    'Finish or close that Trusty Squire session, then press Connect again.'
  );
}

export type SquireProfileClaim =
  | { readonly kind: 'free' }
  | { readonly kind: 'reclaimed-dead'; readonly owner: SquireProfileLockOwner }
  | { readonly kind: 'released-ours'; readonly owner: SquireProfileLockOwner }
  | {
      readonly kind: 'blocked-foreign';
      readonly owner: SquireProfileLockOwner;
      readonly action: string;
    };

function readLinuxStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return close < 0 ? undefined : stat.slice(close + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

function lockOwnerIsAlive(owner: SquireProfileLockOwner): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  if (owner.startTime === null || owner.startTime === 'unknown') return true;
  const actual = readLinuxStartTime(owner.pid);
  if (actual === undefined) return true;
  return actual === owner.startTime;
}

function readLockFileOwner(lockPath: string): SquireProfileLockOwner | undefined {
  try {
    const target = lstatSync(lockPath).isDirectory() ? join(lockPath, 'owner.json') : lockPath;
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      host?: unknown;
      pid?: unknown;
      start_time?: unknown;
    };
    if (typeof parsed.host !== 'string' || typeof parsed.pid !== 'number') return undefined;
    return {
      host: parsed.host,
      pid: parsed.pid,
      startTime: typeof parsed.start_time === 'string' ? parsed.start_time : null,
    };
  } catch {
    return undefined;
  }
}

function removeProfileLock(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true });
}

/**
 * Reclaim Squire's on-disk browser claim so a fresh connect is not blocked
 * by a phantom lock. Dead owners (process gone, or pid reused with a
 * different start_time) are cleared. A pid this helper already aborted is
 * cleared. A live owner that is not ours is left untouched — killing
 * another Squire server (or another agent system on this machine) is not
 * safe; the caller surfaces `action` instead.
 */
export function reclaimSquireProfileClaim(options?: {
  readonly profileDir?: string;
  readonly lockRoot?: string;
  readonly ourPids?: readonly number[];
  readonly log?: (message: string) => void;
}): SquireProfileClaim {
  const profileDir = options?.profileDir ?? squireChromeProfileDir();
  const lockRoot = options?.lockRoot ?? tmpdir();
  const lockPath = squireProfileLockPath(profileDir, lockRoot);
  const owner = readLockFileOwner(lockPath);
  if (!owner) {
    return { kind: 'free' };
  }
  const ours = (options?.ourPids ?? []).includes(owner.pid);
  if (ours) {
    removeProfileLock(lockPath);
    options?.log?.(
      `released our trusty-squire on-disk browser claim (pid ${owner.pid})`,
    );
    return { kind: 'released-ours', owner };
  }
  if (owner.host !== hostname() || lockOwnerIsAlive(owner)) {
    const action = squireForeignClaimAction(owner);
    options?.log?.(
      `trusty-squire browser claim blocked by live pid ${owner.pid} — not superseding a foreign session`,
    );
    return { kind: 'blocked-foreign', owner, action };
  }
  removeProfileLock(lockPath);
  options?.log?.(
    `cleared dead trusty-squire on-disk browser claim (pid ${owner.pid} gone)`,
  );
  return { kind: 'reclaimed-dead', owner };
}

export type ShellRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const defaultShellRunner: ShellRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (error as any)?.code;
        resolve({
          code: typeof code === 'number' ? code : error ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });

/**
 * The result of a streamed shell command that resolves when a sign-in report
 * appears (not when the process exits). The process stays alive so the human
 * can complete sign-in; call `abort()` to kill it.
 */
export type StreamedCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  /** The spawned process's pid, when it has one (session-claim ownership). */
  readonly pid?: number;
  /**
   * The LAST connect report this run emitted — the only report this helper
   * keeps, and nothing else is derived from it. Undefined when the process
   * printed no report before it exited or errored.
   */
  readonly report?: SquireConnectReport;
  /** Kill the background process and clean up. Safe to call even if the
   * process has already exited. */
  readonly abort: () => void;
};

/** Env for every helper-spawned Squire process. The three host rewrite
 *  variables point at one broker inode and one Chrome; `--target=codex`
 *  otherwise reads that agent's config and can steal a foreign profile. */
export function squireConnectProcessEnv(
  profileDir: string = squireChromeProfileDir(),
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...squireHostRewriteEnv(homedir()),
    TRUSTY_SQUIRE_PROFILE_DIR: profileDir,
  };
}

export type StreamedShellRunner = (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => Promise<StreamedCommandResult>;

/** Safety bound for the connect process, and the life of the ceremony it prints. */
export const CONNECT_TIMEOUT_MS = 300_000;

/**
 * Default streamed runner: spawns the process, reads its NEWLINE-DELIMITED
 * `--json` reports line by line, and resolves with the last one read as soon
 * as it is publishable — a sign-in that names its placement, or a terminal
 * report — or when the process exits. Keeps the process alive until the
 * safety timeout or an explicit `abort()`.
 */
function killConnectTree(child: { pid?: number; kill: () => boolean }): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Not a process-group leader (spawn without detached); fall through.
    }
  }
  child.kill();
}

export const defaultStreamedRunner: StreamedShellRunner = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? squireConnectProcessEnv(),
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let consumed = 0;
    // The one copy of the run's answer: the last report received. Nothing
    // else is remembered and nothing is inferred from it.
    let report: SquireConnectReport | undefined;

    // This timer bounds the ceremony itself, not just the wait for its URL: it
    // stays armed after the surface is published, because nothing downstream
    // reaps the connect once the connector row leaves `installing`. The human
    // has until it fires to finish; after that the Xvfb/x11vnc/websockify/
    // cloudflared rig under the connect goes with the process group.
    const safetyTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ stdout, stderr, pid: child.pid ?? undefined, report, abort: () => {} });
      }
      killConnectTree(child);
    }, CONNECT_TIMEOUT_MS);

    const abort = () => {
      clearTimeout(safetyTimer);
      killConnectTree(child);
    };

    // The connect process owns the helper's browser-session claim from spawn
    // on. The claim intentionally outlives the process: it is released lazily
    // by the next connect attempt, which detects a dead owner (process gone —
    // page closed, sign-in finished, or a crash) and clears it, or aborts a
    // still-live one it supersedes. One authority, no phantom locks.
    const claim: ConnectSessionClaim = {
      pid: child.pid ?? undefined,
      claimedAt: Date.now(),
      abort,
    };
    activeConnectSession = claim;

    const finish = (result: StreamedCommandResult) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const settle = (result: StreamedCommandResult) => {
      clearTimeout(safetyTimer);
      finish(result);
    };

    // Only COMPLETE lines that have been read so far: a chunk can end in the
    // middle of a report, and half a JSON line must never be parsed (or
    // remembered) as one.
    const consumeReports = (final: boolean) => {
      const pending = stdout.slice(consumed);
      const lastNewline = pending.lastIndexOf('\n');
      if (lastNewline < 0 && !final) return;
      const complete = lastNewline < 0 ? pending : pending.slice(0, lastNewline);
      for (const line of complete.split('\n')) {
        if (line.trim() === '') continue;
        const parsed = parseConnectReport(line);
        if (parsed) report = parsed;
      }
      consumed += lastNewline < 0 ? pending.length : lastNewline + 1;
    };

    const publishSignIn = () => {
      consumeReports(false);
      // The run's answer is its LAST report. Squire writes the first
      // `needs-sign-in` line before the ceremony browser is placed and writes
      // another one the moment the placement is known — always before it
      // starts waiting on the human — so publishing the first line would
      // publish a page with nowhere attached to it. Wait for the placement,
      // never for the process.
      if (report && isPublishableConnectReport(report)) {
        finish({ stdout, stderr, pid: child.pid ?? undefined, report, abort });
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
      publishSignIn();
    });

    // stderr is captured for diagnostics only. Under `--json` Squire keeps
    // human copy there, and none of it ever reaches the person.
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on('close', () => {
      consumeReports(true);
      settle({
        stdout,
        stderr,
        pid: child.pid ?? undefined,
        report,
        abort: () => {},
      });
    });

    child.on('error', () => {
      settle({ stdout, stderr, pid: child.pid ?? undefined, report, abort: () => {} });
    });
  });

const step = (label: string, status: ConnectorStep['status'], reason?: string): ConnectorStep => ({
  label,
  status,
  ...(reason ? { reason } : {}),
});

/**
 * The connect report fields this helper reads. Re-declared here because the
 * helper cannot import Squire's CLI; the contract lives in Squire's
 * `apps/mcp/src/install/connect-report.ts` and this is a consumer of it.
 *
 * `state` is a plain string because an unrecognised state stays unrecognised
 * and is never coerced into a Beeline lifecycle. `holder` and
 * `browser_location` are kept as read and rendered by kind.
 */
export interface SquireConnectAccount {
  readonly id: string;
  /** What Squire's probe actually saw: `[]` = looked and found nothing;
   *  `null` = could not read the profile at all. These are different
   *  answers, so null is never flattened into an empty list. */
  readonly providers: readonly string[] | null;
}

export interface SquireConnectReport {
  readonly state: string;
  readonly terminal: boolean;
  readonly reason: string | null;
  readonly sign_in_url: string | null;
  readonly account: SquireConnectAccount | null;
  readonly holder: unknown;
  readonly browser_location: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function connectAccount(raw: unknown): SquireConnectAccount | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    // An absent or unreadable `providers` is `null` (could not look), never
    // `[]` (looked and found nothing).
    providers: Array.isArray(raw.providers)
      ? raw.providers.filter((provider): provider is string => typeof provider === 'string')
      : null,
  };
}

/**
 * One line of Squire's `connect --json` stream, or undefined when the line is
 * not a connect report. The last report received is the run's answer.
 */
export function parseConnectReport(line: string): SquireConnectReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.state !== 'string') return undefined;
  return {
    state: parsed.state,
    terminal: parsed.terminal === true,
    reason: typeof parsed.reason === 'string' ? parsed.reason : null,
    sign_in_url: typeof parsed.sign_in_url === 'string' ? parsed.sign_in_url : null,
    account: connectAccount(parsed.account),
    holder: parsed.holder,
    browser_location: parsed.browser_location,
  };
}

/**
 * Whether this report leaves a sign-in outstanding: a run that has not ended
 * (`terminal` false), names a page, and names a placement somebody can be
 * sent to. The placement is written on a later line than the URL and every
 * ceremony reports it before it starts waiting on the human, so an unnamed
 * placement (`none`) is a line to wait past. `unreachable` is a placement
 * that is nowhere, and a run that has ENDED waits for nobody — both are
 * blocked connects, and `connectBlockedLine` says so.
 */
export function isOutstandingSignIn(report: SquireConnectReport): boolean {
  if (report.terminal || report.state !== 'needs-sign-in' || !report.sign_in_url) return false;
  const location = report.browser_location;
  if (!isRecord(location) || typeof location.kind !== 'string') return false;
  return location.kind !== 'none' && location.kind !== 'unreachable';
}

/**
 * Whether this report is the run's answer, or whether another line is still
 * coming: the line that ended the run, or the one that hands a person a page
 * to go to.
 */
export function isPublishableConnectReport(report: SquireConnectReport): boolean {
  return report.terminal || isOutstandingSignIn(report);
}

/** Squire's reason codes, in the words a person reads. The code is the
 *  contract; this map is only its wording. */
const CONNECT_REASON_LINES: Record<string, string> = {
  provider_session_missing: "the bot's Chrome profile has no live provider session",
  requested_provider_missing: 'the provider sign-in you asked to refresh did not complete',
  account_mismatch: 'this machine is bound to a different account',
  profile_unverifiable: "the bot's Chrome profile could not be verified",
  install_expired: 'the sign-in page expired before it was used',
  cached_cookie_evidence: 'the shared profile already carried the session',
  run_failed: 'the connect run failed before it could finish',
};

/** Who holds the bot profile, as the report named them. */
function holderLine(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'other') {
    const pid = typeof raw.pid === 'number' ? raw.pid : undefined;
    return pid === undefined
      ? 'another Trusty Squire session is using the browser'
      : squireForeignClaimAction({ host: hostname(), pid, startTime: null });
  }
  if (raw.kind === 'unknown') return 'another process may be using the browser';
  return undefined;
}

/**
 * What blocks a connect, in one line for the person, from the typed report
 * alone, in the contract's own order: the fields that name the block come
 * first and the reason code answers only what they cannot. `undefined` for a
 * run that connected or still has a human's sign-in outstanding.
 */
export function connectBlockedLine(report: SquireConnectReport): string | undefined {
  if (report.state === 'connected' || isOutstandingSignIn(report)) return undefined;
  if (report.reason && CONNECT_REASON_LINES[report.reason]) {
    return CONNECT_REASON_LINES[report.reason]!;
  }
  const location = isRecord(report.browser_location) ? report.browser_location : undefined;
  if (location?.kind === 'unreachable') {
    return 'the sign-in page could not be shown on this machine';
  }
  if (report.state === 'needs-sign-in') {
    return 'the connect run ended before the sign-in was completed';
  }
  // Last, because a holder is snapshotted onto EVERY line: the shared
  // broker's own Chrome holds the profile while a ceremony runs, so a holder
  // read ahead of the typed reason would tell a person to close the browser
  // that is serving every other agent.
  const holder = holderLine(report.holder);
  if (holder) return holder;
  // An unrecognised state is named verbatim, never coerced into one of
  // Squire's four.
  return `Trusty Squire reported the connect state "${report.state}"`;
}

/**
 * Where the report says the sign-in page opened, as the wire carries it. The
 * helper reads Squire's own placement answer; it never detects a display.
 */
export function connectBrowserLocation(raw: unknown): ConnectorBrowserLocation | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case 'host_screen':
      return { kind: 'host_screen' };
    case 'virtual':
      return typeof raw.url === 'string' ? { kind: 'virtual', url: raw.url } : undefined;
    case 'unreachable':
      return {
        kind: 'unreachable',
        reason:
          typeof raw.reason === 'string' ? raw.reason : 'the sign-in page could not be shown',
      };
    case 'none':
      return { kind: 'none' };
    case 'unknown':
      return typeof raw.reason === 'string' ? { kind: 'unknown', reason: raw.reason } : undefined;
    default:
      return undefined;
  }
}

export type InstallSquireOptions = {
  readonly workspaceId: string;
  /** Runs short-lived commands (the trusty-squire version probe). */
  readonly run?: ShellRunner;
  /**
   * Streamed runner for Squire's `connect --json` command. Reads the typed
   * reports from live stdout and hands over the sign-in page as soon as one
   * carries it (before the process exits). The connect process stays alive in
   * the background for the human to complete sign-in.
   */
  readonly streamRun?: StreamedShellRunner;
  /** The Squire MCP used for the post-install pairing probe. */
  readonly mcp?: SquireMcpClient;
  /**
   * Called after every step settles with the steps so far — the helper
   * forwards each snapshot to the server so the phone paints progress live.
   */
  readonly onProgress?: (steps: readonly ConnectorStep[]) => void;
  /** Helper-side diagnostics (session-claim releases, re-resolutions). */
  readonly log?: (message: string) => void;
  /**
   * The Chrome profile Squire serializes on, and the directory its
   * profile-operation lock lives in. Tests inject a temp pair; production
   * uses Squire's own defaults (`~/.trusty-squire/chrome-profile`, `os.tmpdir()`).
   */
  readonly profileDir?: string;
  readonly lockRoot?: string;
};

export type InstallSquireResult = {
  readonly status: 'connected' | 'error' | 'installing';
  readonly steps: readonly ConnectorStep[];
  readonly signIn?: ConnectorSignIn;
  readonly squireVersion?: string;
  readonly errorMessage?: string;
};

/**
 * The version npx resolves for one Squire package spec, straight from the
 * package itself. `preferOnline` revalidates the registry metadata instead of
 * trusting the npx/npm cache — the cache-busting re-resolution path.
 */
export async function installedSquireVersion(
  run: ShellRunner,
  spec: string = SQUIRE_CONNECT_PACKAGE,
  preferOnline = false,
): Promise<string | undefined> {
  const probe = await run('npx', [
    ...(preferOnline ? ['--prefer-online'] : []),
    '-y',
    spec,
    '--version',
  ]);
  const version = probe.stdout.match(/\d+\.\d+\.\d+[^\s]*/)?.[0];
  return version;
}

/**
 * The registry's version for the connect spec this helper runs. Undefined
 * when the registry is unreachable — verification is then skipped (never
 * block a connect on a probe we cannot make).
 */
export async function currentSquireRelease(run: ShellRunner): Promise<string | undefined> {
  const probe = await run('npm', ['view', SQUIRE_CONNECT_PACKAGE, 'version']);
  if (probe.code !== 0) return undefined;
  return probe.stdout.match(/\d+\.\d+\.\d+[^\s]*/)?.[0];
}

/**
 * What `npx` must be told to run the Squire release whose `--json` connect
 * report this helper reads. The plain spec is used when the resolved
 * version already matches the registry (or the registry could not be asked);
 * a stale npx copy is re-resolved with `--prefer-online`.
 */
export type SquireConnectResolution = {
  /** The npx arguments selecting the package (spec and cache flags). */
  readonly npxArgs: readonly string[];
  /** The version npx resolved during verification, when it answered. */
  readonly resolvedVersion?: string;
  /** The registry's version for this spec, when it answered. */
  readonly currentRelease?: string;
  /** True when the first probe resolved a stale copy and we re-resolved. */
  readonly reResolved: boolean;
};

export async function resolveSquireConnectSpec(run: ShellRunner): Promise<SquireConnectResolution> {
  const currentRelease = await currentSquireRelease(run);
  const first = await installedSquireVersion(run);
  if (currentRelease === undefined || first === currentRelease) {
    return {
      npxArgs: ['-y', SQUIRE_CONNECT_PACKAGE],
      ...(first !== undefined ? { resolvedVersion: first } : {}),
      ...(currentRelease !== undefined ? { currentRelease } : {}),
      reResolved: false,
    };
  }
  // Stale local copy: bust the npx cache with a registry revalidation and ask
  // again before connect may run on the stale version.
  const fresh = await installedSquireVersion(run, SQUIRE_CONNECT_PACKAGE, true);
  if (fresh === currentRelease) {
    return {
      npxArgs: ['--prefer-online', '-y', SQUIRE_CONNECT_PACKAGE],
      resolvedVersion: fresh,
      currentRelease,
      reResolved: true,
    };
  }
  // The cache will not move: run the exact release, resolved from the
  // registry just now.
  return {
    npxArgs: ['-y', `${SQUIRE_MCP_NAME}@${currentRelease}`],
    ...(fresh !== undefined ? { resolvedVersion: fresh } : {}),
    currentRelease,
    reResolved: true,
  };
}

/**
 * Install and pair Squire on this helper, reporting every step in order.
 *
 * Order: helper reached → trusty-squire installed → waiting for sign-in →
 * paired to the workspace. The connect command runs through a STREAMING
 * runner that reads Squire's newline-delimited `--json` reports and hands the
 * phone the sign-in page once a `needs-sign-in` report names where it opened, or
 * continues with no page at all when the last report says the shared profile
 * is already connected. The connect process stays alive in the background for
 * the human to complete sign-in. The post-install `pairSquire` probe confirms
 * the account is live.
 *
 * A run that reports neither `connected` nor `needs-sign-in` is blocked: the
 * step and the error carry the typed report's own reason, never Squire's
 * stderr. A failed step ends the report with that reason and everything after
 * it stays pending.
 */
export async function installSquire(options: InstallSquireOptions): Promise<InstallSquireResult> {
  const profileDir = options.profileDir ?? squireChromeProfileDir();
  const lockRoot = options.lockRoot ?? tmpdir();
  const run = options.run ?? defaultShellRunner;
  const streamRun = options.streamRun ?? defaultStreamedRunner;
  const log = options.log ?? (() => {});
  const steps: ConnectorStep[] = [step('helper reached', 'done')];
  const emit = () => options.onProgress?.([...steps]);
  const push = (next: ConnectorStep) => {
    steps.push(next);
    emit();
  };
  const fail = (reason: string): InstallSquireResult => {
    steps.push(step('waiting for sign-in', 'pending'));
    emit();
    return { status: 'error', steps, errorMessage: reason };
  };
  emit();

  // A fresh connect attempt owns the browser session: release whatever a
  // previous attempt still claims — aborting a live owner, clearing a dead
  // one — so closing the noVNC page and retrying is never blocked by a
  // phantom "another session is already using the browser".
  const previousPid = squireConnectSession()?.pid;
  releaseSquireConnectSession(log);
  const claim = reclaimSquireProfileClaim({
    log,
    profileDir,
    lockRoot,
    ...(previousPid !== undefined ? { ourPids: [previousPid] } : {}),
  });
  if (claim.kind === 'blocked-foreign') {
    push(step('trusty-squire installed', 'failed', claim.action));
    return fail(claim.action);
  }

  // Verify the copy npx resolves BEFORE connect runs, re-resolving a stale
  // one against the release this reader is written for.
  const resolution = await resolveSquireConnectSpec(run);
  if (resolution.reResolved) {
    log(
      `trusty-squire stale copy ${resolution.resolvedVersion ?? 'unknown'} re-resolved against current release ${resolution.currentRelease}`,
    );
  }

  // Connect uses the shared host Chrome (or its headless noVNC URL). Do not
  // pass --skip-browser or --force-relogin: those sign the human in outside
  // the bot profile and clear cookies the broker can already share. `--json`
  // is what puts the typed report on stdout.
  const install = await streamRun(
    'npx',
    [...resolution.npxArgs, 'connect', '--target=codex', '--json'],
    squireConnectProcessEnv(profileDir),
  );
  const report = install.report;
  const version = resolution.resolvedVersion;

  // Nothing to render: a run that printed no report at all. Never Squire's
  // stderr — that is a command-line error, not something a person can act on.
  if (!report) {
    const reason = 'Trusty Squire did not report a connect result';
    push(step('trusty-squire installed', 'failed', reason));
    return fail(reason);
  }
  // A `needs-sign-in` report promises a page. Anything else that is not
  // `connected` is blocked, and its own reason is what the person reads.
  if (report.state === 'needs-sign-in' && !report.sign_in_url) {
    const reason = 'Trusty Squire reported a sign-in without a page';
    push(step('trusty-squire installed', 'failed', reason));
    return fail(reason);
  }
  if (report.state !== 'connected' && !isOutstandingSignIn(report)) {
    const reason = connectBlockedLine(report) ?? 'Trusty Squire could not connect';
    push(step('trusty-squire installed', 'failed', reason));
    return fail(reason);
  }
  // The connect process stays alive in the background for the human to sign in.
  // `install.abort()` can kill it (safety timeout also fires after 5 min).

  // The version was verified before connect ran; the step records what is
  // actually installed, not what a stale cache would have served.
  push(step(`trusty-squire${version ? ` ${version}` : ''} installed`, 'done'));

  const location = connectBrowserLocation(report.browser_location);
  const signIn: ConnectorSignIn | undefined =
    isOutstandingSignIn(report) && report.sign_in_url
      ? {
          method: 'streamed-page',
          url: report.sign_in_url,
          ...(location ? { browserLocation: location } : {}),
        }
      : undefined;

  // Surface the reported sign-in URL immediately so the phone has a page to
  // open, with the report's own placement riding beside it. The step settles
  // only when there is nothing left to press: a run that printed a ceremony
  // is still waiting on the human, while the already-connected report has
  // nobody to wait for.
  push(step('waiting for sign-in', signIn ? 'pending' : 'done'));

  const pair = await pairSquire(options.mcp, options.workspaceId);
  if (!pair.ok) {
    push(step('paired to workspace', 'failed', pair.reason));
    return {
      status: 'installing',
      steps,
      ...(signIn ? { signIn } : {}),
      ...(version ? { squireVersion: version } : {}),
    };
  }
  push(step('paired to workspace', 'done'));
  // An OUTSTANDING ceremony is not a connected helper. The vault answering
  // `list_credentials` proves the credential plane, never that the shared
  // Chrome carries a provider session — and `installConnector` completes the
  // row in one write, which navigates the connect screen off the surface the
  // human still has to press. This run stays `installing` and hands the phone
  // its ceremony; a LATER run whose report says `connected` completes it.
  if (signIn) {
    return {
      status: 'installing',
      steps,
      signIn,
      ...(version ? { squireVersion: version } : {}),
    };
  }
  return {
    status: 'connected',
    steps,
    ...(version ? { squireVersion: version } : {}),
  };
}

/** Probe the mounted Squire MCP to confirm the account is live on this helper. */
export async function pairSquire(
  mcp: SquireMcpClient | undefined,
  _workspaceId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!mcp) return { ok: false, reason: 'the Squire MCP surface is not mounted on this helper' };
  try {
    await mcp.call('list_credentials', { fields: 'summary' });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string');
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Squire reports vault timestamps as ISO-8601 strings; older shapes sent epoch
 * seconds. An unreadable one stays 0, which the Workbench KEYS ordering reads
 * as "no vault time" and answers with the row's own insert time.
 */
function epochSeconds(value: unknown): number | null {
  const numeric = numberOrNull(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/** Map one Squire vault entry to the contract metadata (never secret values). */
export function vaultConnectionMeta(raw: unknown): VaultConnectionMeta {
  const record = asRecord(raw);
  const reference = String(record.reference ?? record.id ?? '');
  return {
    reference,
    service: typeof record.service === 'string' ? record.service : null,
    label: String(record.label ?? record.service ?? reference),
    fieldNames: stringList(record.field_names ?? record.fieldNames),
    allowedHosts: stringList(record.allowed_hosts ?? record.allowedHosts ?? record.login_hosts),
    createdAt: epochSeconds(record.created_at ?? record.createdAt) ?? 0,
    stale: record.stale === true,
    state: record.state === 'error' ? 'error' : 'active',
  };
}

/** `list_credentials` through the Squire MCP, shaped to the contract. */
export async function readVault(mcp: SquireMcpClient): Promise<VaultConnectionMeta[]> {
  const result = asRecord(await mcp.call('list_credentials'));
  return asArray(result.credentials ?? result.items ?? result).map(vaultConnectionMeta);
}

export function connectionLedgerEntry(raw: unknown): ConnectionLedgerEntry {
  const record = asRecord(raw);
  return {
    id: String(record.id ?? record.event_id ?? ''),
    timestamp: numberOrNull(record.timestamp ?? record.created_at) ?? 0,
    action: String(record.action ?? record.event ?? record.kind ?? 'event'),
    ...(typeof record.actor === 'string' ? { actor: record.actor } : {}),
    ...(numberOrNull(record.status) !== null ? { status: numberOrNull(record.status)! } : {}),
    ...(numberOrNull(record.bytes) !== null ? { bytes: numberOrNull(record.bytes)! } : {}),
    ...(record.anomaly === true || record.anomaly === false
      ? { anomaly: record.anomaly as boolean }
      : {}),
    ...(typeof record.anomaly_reason === 'string' ? { anomalyReason: record.anomaly_reason } : {}),
  };
}

/** `audit_log` (default ledger view) for one credential, shaped to the contract. */
export async function readConnectionLedger(
  mcp: SquireMcpClient,
  ref: string,
): Promise<ConnectionLedgerEntry[]> {
  const result = asRecord(await mcp.call('audit_log', { reference: ref, view: 'ledger' }));
  const entries = asArray(result.entries ?? result.events ?? result.ledger ?? result);
  return entries.map(connectionLedgerEntry);
}

export function connectionGrant(raw: unknown): ConnectionGrant {
  const record = asRecord(raw);
  return {
    grantId: String(record.grant_id ?? record.grantId ?? record.id ?? ''),
    credentialRef: String(record.credential_ref ?? record.credentialRef ?? record.reference ?? ''),
    createdAt: numberOrNull(record.created_at ?? record.createdAt) ?? 0,
    ...(numberOrNull(record.revoked_at ?? record.revokedAt) !== null
      ? { revokedAt: numberOrNull(record.revoked_at ?? record.revokedAt)! }
      : {}),
    ...(numberOrNull(record.rate_limit_per_hour) !== null
      ? { rateLimitPerHour: numberOrNull(record.rate_limit_per_hour)! }
      : {}),
    ...(numberOrNull(record.spend_cap_usd) !== null
      ? { spendCapUsd: numberOrNull(record.spend_cap_usd)! }
      : {}),
  };
}

/** Every live grant on one connection, from `list_app_access`. */
export async function readGrants(mcp: SquireMcpClient, ref: string): Promise<ConnectionGrant[]> {
  const result = asRecord(await mcp.call('list_app_access', {}));
  return asArray(result.grants ?? result.items ?? result)
    .map(connectionGrant)
    .filter((grant) => grant.credentialRef === ref && grant.revokedAt === undefined);
}

/** Revoke every live grant on one connection; partial failures are counted. */
export async function revokeGrants(
  mcp: SquireMcpClient,
  ref: string,
): Promise<{ revoked: number; failed: number }> {
  const grants = await readGrants(mcp, ref);
  let revoked = 0;
  let failed = 0;
  for (const grant of grants) {
    try {
      const result = asRecord(await mcp.call('revoke_app_access', { grant_id: grant.grantId }));
      if (result.revoked === false) failed += 1;
      else revoked += 1;
    } catch {
      failed += 1;
    }
  }
  return { revoked, failed };
}

/** One connection's full detail: metadata, live grants, ledger. */
export async function readConnectionDetail(
  mcp: SquireMcpClient,
  ref: string,
): Promise<ConnectionDetail | { error: string }> {
  try {
    const vault = await readVault(mcp);
    const metadata = vault.find((entry) => entry.reference === ref);
    if (!metadata) return { error: `unknown connection: ${ref}` };
    const [grants, ledger] = await Promise.all([
      readGrants(mcp, ref),
      readConnectionLedger(mcp, ref),
    ]);
    return { metadata, grants, ledger };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

