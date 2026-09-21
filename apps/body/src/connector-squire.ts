/**
 * Trusty Squire connector lifecycle on the helper (Workbench PR 1).
 *
 * One helper shares the host Squire broker and its one Chrome. The install
 * runs Squire's own `connect` through a STREAMING runner that captures the
 * sign-in URL from live stdout as soon as it appears (a noVNC URL on a
 * headless helper, or the confirm page in the shared Chrome). Squire
 * announces "Opening the Trusty Squire install page" seconds BEFORE it
 * prints that URL, so the runner waits for the URL itself — the phone has
 * no sign-in surface until one arrives. Connect is not given
 * `--skip-browser` or `--force-relogin`: skip-browser signs the human in
 * outside the bot profile so the shared Chrome never gains the session, and
 * force-relogin clears provider cookies and asserts a single-session
 * precondition the broker does not have. Dropping force-relogin also makes
 * Squire's already-provisioned short-circuit reachable: the shared profile
 * already holds the session, connect refreshes the config and exits with no
 * ceremony at all, which is a CONNECTED outcome, never a failed install.
 * The connect process stays alive in the background while the human
 * completes sign-in.
 *
 * The old exit-only `ShellRunner` (defaultShellRunner) remains for the
 * version probe and other quick commands. A new `StreamedShellRunner`
 * (`defaultStreamedRunner`) handles the connect command: it spawns the
 * process, reads stdout line by line, and resolves the promise as soon as the
 * sign-in URL is found (or the process exits without one).
 *
 * Two guards keep a fresh connect attempt working (captain, 2026-09-17):
 *
 * - VERSION: the connect package spec is `@trusty-squire/mcp@latest` — never a
 *   source-level pin. Before connect runs, the version npx actually resolves
 *   is verified against the current published release (`npm view`). A stale
 *   local copy (an npx cache or local node_modules shadow serving, say,
 *   `1.1.14-rc.34` while `1.1.14` is current) is re-resolved with
 *   `--prefer-online`, and if the cache still refuses to move, connect runs
 *   the exact current release resolved at runtime — never a stale copy.
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
  ConnectorSignIn,
  ConnectorStep,
  VaultConnectionMeta,
} from '@beeline/api-contract/daemon';

/** The one Squire MCP contract this connector speaks. */
export interface SquireMcpClient {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** The one Squire connect package, always the current release (captain). */
export const SQUIRE_MCP_NAME = '@trusty-squire/mcp';

/**
 * Where Squire installs the agent's own sign-in surface: the `@latest` dist
 * tag, never a source-level version pin (captain). A stale npx-resolved copy
 * is caught by `resolveSquireConnectSpec` before connect runs, not by a pin.
 */
export const SQUIRE_CONNECT_PACKAGE = `${SQUIRE_MCP_NAME}@latest`;

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

/** Helper copy when a Google tool is blocked on Squire's one browser claim. */
export const SQUIRE_BROWSER_BUSY_GOOGLE_REASON =
  'Trusty Squire is still using the browser — connect Trusty Squire first';

/** True for Squire's PROFILE_BUSY_MESSAGE (hyphen or em dash) and the
 *  helper's remapped "connect Trusty Squire first" spellings. */
export function isSquireBrowserSessionFailure(text: string | undefined | null): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return (
    /Trusty Squire[\s\S]{0,80}browser/i.test(text) ||
    /browser[\s\S]{0,80}Trusty Squire/i.test(text)
  );
}

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
 * The result of a streamed shell command that resolves when a sign-in URL
 * appears in the output (not when the process exits). The process stays alive
 * so the human can complete sign-in; call `abort()` to kill it.
 */
export type StreamedCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  /** The spawned process's pid, when it has one (session-claim ownership). */
  readonly pid?: number;
  /** The sign-in surface, captured from live output. Undefined when the process
   * exited or errored before printing a URL. */
  readonly signIn?: ConnectorSignIn;
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
 * Default streamed runner: spawns the process, reads stdout line by line,
 * resolves as soon as `parseConnectOutput` finds a sign-in URL (or when the
 * process exits without one). Keeps the process alive until the safety
 * timeout or an explicit `abort()`.
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

    const safetyTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ stdout, stderr, pid: child.pid ?? undefined, signIn: undefined, abort: () => {} });
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
        clearTimeout(safetyTimer);
        resolve(result);
      }
    };

    const checkOutput = () => {
      const combined = `${stdout}\n${stderr}`;
      const signIn = parseConnectOutput(combined);
      if (signIn) {
        finish({ stdout, stderr, signIn, abort });
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
      checkOutput();
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
      checkOutput();
    });

    child.on('close', () => {
      finish({ stdout, stderr, pid: child.pid ?? undefined, signIn: undefined, abort: () => {} });
    });

    child.on('error', () => {
      finish({ stdout, stderr, pid: child.pid ?? undefined, signIn: undefined, abort: () => {} });
    });
  });

const step = (label: string, status: ConnectorStep['status'], reason?: string): ConnectorStep => ({
  label,
  status,
  ...(reason ? { reason } : {}),
});

/**
 * Squire prints exactly two sign-in surfaces: the headless noVNC tunnel
 * (`https://<host>/#p=<password>`) and the hosted install confirm page
 * (`https://<host>/install…`). Everything else on connect's streams belongs
 * to somebody else — npm's update notifier writes its changelog link to
 * stderr, and a failed tunnel rig carries Cloudflare's docs link in the
 * stderr tail Squire quotes back. Neither is a page the phone may open.
 */
function isConnectCeremonyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hash.startsWith('#p=') || /(^|\/)install(\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

const BOXED_ROW = /^\s*\u2502(.*)\u2502\s*$/;

/**
 * Rejoin ONE box's rows. Every row of a box is rendered to the same inner
 * width over the same horizontal padding, so the padding is the narrowest
 * leading and trailing run of spaces its non-blank rows carry — never a
 * constant, because boxen's `padding: 1` shorthand is three columns and
 * Squire's explicit `{left:1,right:1}` is one. A row whose content reaches
 * that content area's right edge was hard-wrapped, so the next row continues
 * it rather than starting a line of its own.
 */
function rejoinBoxRows(cells: readonly string[]): string[] {
  const written = cells.filter((cell) => cell.trim() !== '');
  const pad = (measure: (cell: string) => number): number =>
    written.length === 0 ? 0 : Math.min(...written.map(measure));
  const left = pad((cell) => cell.length - cell.trimStart().length);
  const right = pad((cell) => cell.length - cell.trimEnd().length);
  const lines: string[] = [];
  let carry: string | undefined;
  for (const cell of cells) {
    const content = cell.slice(left, cell.length - right);
    const text = content.replace(/\s+$/, '');
    carry = (carry ?? '') + text;
    if (text.length < content.length) {
      lines.push(carry);
      carry = undefined;
    }
  }
  if (carry !== undefined) lines.push(carry);
  return lines;
}

/**
 * Squire prints the ceremony URL inside a fixed-width boxen frame, and boxen
 * HARD-WRAPS a token wider than the frame — a long quick-tunnel host splits
 * the URL across two rows. Rejoin each frame's rows before reading a URL out
 * of it, or the phone is handed the first 74 characters of a live link.
 */
export function unframeBoxedOutput(output: string): string {
  const lines: string[] = [];
  let box: string[] = [];
  const flush = () => {
    if (box.length > 0) lines.push(...rejoinBoxRows(box));
    box = [];
  };
  for (const row of output.split('\n')) {
    const framed = BOXED_ROW.exec(row);
    if (framed) {
      box.push(framed[1] ?? '');
      continue;
    }
    flush();
    lines.push(row);
  }
  flush();
  return lines.join('\n');
}

/**
 * Read the sign-in surface out of Squire's own connect output. Both surfaces
 * it prints are pages the in-app webview shows, so the method is the same for
 * either. A URL is taken only once a terminator proves it is whole — the
 * streamed runner reads partial chunks, and half a tunnel host parses as a
 * perfectly valid URL.
 */
export function parseConnectOutput(output: string): ConnectorSignIn | undefined {
  const urls = unframeBoxedOutput(output).match(/https:\/\/[^\s"'<>]+(?=[\s"'<>])/g) ?? [];
  const url = urls.find(isConnectCeremonyUrl);
  return url ? { method: 'streamed-page', url } : undefined;
}

/**
 * True when connect short-circuited on Squire's preflight having VERIFIED the
 * live provider session: the shared profile already carries it, so connect
 * refreshed the agent config and exited with no ceremony. Squire's sibling
 * outcome — config refreshed but the session unverifiable — says in its own
 * words that it will not call that connected, and neither may we: reporting
 * it green would leave an expired session with no way back to a ceremony.
 */
export function parseConnectAlreadyConnected(output: string): boolean {
  return /Already connected \(/i.test(output) && /config refreshed/i.test(output);
}

/**
 * Squire's preflight hint tells the owner to close other sessions and re-run
 * with `--force-relogin`. The broker is multi-session, so that precondition
 * is not true and the line must never reach the Workbench as a failed step.
 */
export function withoutForceReloginHint(output: string): string {
  return output
    .split('\n')
    .filter((line) => !/--force-relogin/.test(line))
    .join('\n')
    .trim();
}

export type InstallSquireOptions = {
  readonly workspaceId: string;
  /** Runs short-lived commands (the trusty-squire version probe). */
  readonly run?: ShellRunner;
  /**
   * Streamed runner for Squire's `connect` command. Captures the sign-in URL
   * from live stdout as soon as it is printed (before the process exits).
   * The connect process stays alive in the background for the human to
   * complete sign-in.
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
  readonly signedInAs?: string;
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
 * The current published release, straight from the registry. Undefined when
 * the registry is unreachable — verification is then skipped (never block a
 * connect on a probe we cannot make).
 */
export async function currentSquireRelease(run: ShellRunner): Promise<string | undefined> {
  const probe = await run('npm', ['view', SQUIRE_MCP_NAME, 'version']);
  if (probe.code !== 0) return undefined;
  return probe.stdout.match(/\d+\.\d+\.\d+[^\s]*/)?.[0];
}

/**
 * What `npx` must be told to run a CURRENT Squire copy. The plain `@latest`
 * spec is used when the resolved version already matches the current release
 * (or the registry could not be asked); a stale copy is re-resolved with
 * `--prefer-online`, and if the cache still refuses to move, connect runs the
 * exact current release — resolved at RUNTIME from the registry, never pinned
 * in source.
 */
export type SquireConnectResolution = {
  /** The npx arguments selecting the package (spec and cache flags). */
  readonly npxArgs: readonly string[];
  /** The version npx resolved during verification, when it answered. */
  readonly resolvedVersion?: string;
  /** The current published release, when the registry answered. */
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
  // The cache will not move: run the exact current release, resolved from the
  // registry just now — still @latest semantics, never a source-level pin.
  return {
    npxArgs: ['-y', `${SQUIRE_MCP_NAME}@${currentRelease}`],
    ...(fresh !== undefined ? { resolvedVersion: fresh } : {}),
    currentRelease,
    reResolved: true,
  };
}

/** The account line Squire prints once a human completes sign-in. */
export function parseSignedInAs(output: string): string | undefined {
  return output.match(/signed in as ([^\s,;]+)/i)?.[1];
}

/**
 * Install and pair Squire on this helper, reporting every step in order.
 *
 * Order: helper reached → trusty-squire installed → waiting for sign-in →
 * paired to the workspace. The connect command runs through a STREAMING
 * runner that captures the ceremony URL from live stdout as soon as it is
 * printed (before the process exits), or continues with no ceremony at all
 * when Squire reports the shared profile is already connected. The connect
 * process stays alive in the background for the human to complete sign-in.
 * The post-install `pairSquire` probe confirms the account is live.
 *
 * A failed step ends the report with a clear reason and everything after it
 * stays pending.
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
  // one against the current published release.
  const resolution = await resolveSquireConnectSpec(run);
  if (resolution.reResolved) {
    log(
      `trusty-squire stale copy ${resolution.resolvedVersion ?? 'unknown'} re-resolved against current release ${resolution.currentRelease}`,
    );
  }

  // Connect uses the shared host Chrome (or its headless noVNC URL). Do not
  // pass --skip-browser or --force-relogin: those sign the human in outside
  // the bot profile and clear cookies the broker can already share.
  const install = await streamRun(
    'npx',
    [...resolution.npxArgs, 'connect', '--target=codex'],
    squireConnectProcessEnv(profileDir),
  );
  const alreadyConnected =
    !install.signIn && parseConnectAlreadyConnected(`${install.stdout}\n${install.stderr}`);
  if (!install.signIn && !alreadyConnected) {
    const stderr = withoutForceReloginHint(install.stderr);
    let stepReason = stderr || 'connect printed no sign-in URL';
    let failReason = stderr || 'the trusty-squire connect command printed no sign-in surface';
    if (isSquireBrowserSessionFailure(stderr)) {
      const again = reclaimSquireProfileClaim({ log, profileDir, lockRoot });
      if (again.kind === 'blocked-foreign') {
        stepReason = again.action;
        failReason = again.action;
      }
    }
    push(step('trusty-squire installed', 'failed', stepReason));
    return fail(failReason);
  }
  // The connect process stays alive in the background for the human to sign in.
  // `install.abort()` can kill it (safety timeout also fires after 5 min).

  // The version was verified before connect ran; the step records what is
  // actually installed, not what a stale cache would have served.
  const version = resolution.resolvedVersion;
  push(step(`trusty-squire${version ? ` ${version}` : ''} installed`, 'done'));

  const signIn = install.signIn;
  const signedInAs = parseSignedInAs(`${install.stdout}\n${install.stderr}`);

  // Surface the sign-in URL immediately so the phone paints the noVNC page.
  push(step('waiting for sign-in', 'done'));

  const pair = await pairSquire(options.mcp, options.workspaceId);
  if (!pair.ok) {
    push(step('paired to workspace', 'failed', pair.reason));
    return {
      status: 'installing',
      steps,
      signIn,
      ...(version ? { squireVersion: version } : {}),
      ...(signedInAs ? { signedInAs } : {}),
    };
  }
  push(step('paired to workspace', 'done'));
  return {
    status: 'connected',
    steps,
    signIn,
    ...(version ? { squireVersion: version } : {}),
    ...(signedInAs ? { signedInAs } : {}),
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

