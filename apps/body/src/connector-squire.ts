/**
 * Trusty Squire connector lifecycle on the helper (Workbench PR 1).
 *
 * One helper carries ONE Squire account (captain decision 2026-09-14). The
 * install runs Squire's own `connect --skip-browser` command through a
 * STREAMING runner that captures the hosted sign-in URL from live stdout as
 * soon as it appears (the machine token and sign-in surface print before
 * connect blocks waiting for the human). `--skip-browser` means connect never
 * launches its own Chrome — it prints a hosted sign-in page for the human's
 * own browser, so the install works on a headless helper with no local
 * display or tunnel binaries. The URL is surfaced as a `streamed-page` signIn
 * immediately; the connect process stays alive in the background while the
 * human completes sign-in on that page.
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
 * - SESSION: the spawned connect process OWNS the helper's one Squire
 *   browser-session claim. The claim outlives its process on purpose: when a
 *   fresh connect attempt starts, it releases the claim — detecting a dead
 *   owner (process gone: page closed, sign-in finished, or a crash) and
 *   clearing it, or aborting a still-live one it supersedes. Closing the
 *   noVNC page and hitting Retry must never leave the next attempt staring at
 *   "another Trusty Squire session is already using the browser".
 *
 * Vault reads, ledger reads, and grant revocation go through the Squire MCP
 * tools (`list_credentials`, `audit_log`, `list_app_access`,
 * `revoke_app_access`) — never through any raw-value path. Everything is
 * expressed against the `SquireMcpClient` interface so tests drive a mocked
 * Squire and no test touches a real Squire account.
 */
import { execFile, spawn } from 'node:child_process';
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

export type StreamedShellRunner = (
  command: string,
  args: readonly string[],
) => Promise<StreamedCommandResult>;

const CONNECT_TIMEOUT_MS = 300_000; // 5-minute safety bound for the connect process

/**
 * Default streamed runner: spawns the process, reads stdout line by line,
 * resolves as soon as `parseConnectOutput` finds a sign-in URL (or when the
 * process exits without one). Keeps the process alive until the safety
 * timeout or an explicit `abort()`.
 */
export const defaultStreamedRunner: StreamedShellRunner = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const safetyTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ stdout, stderr, pid: child.pid ?? undefined, signIn: undefined, abort: () => {} });
      }
      child.kill();
    }, CONNECT_TIMEOUT_MS);

    const abort = () => {
      clearTimeout(safetyTimer);
      child.kill();
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
 * Read the sign-in surface out of Squire's own connect output. Squire prints
 * a banner carrying the URL and names the surface; the method follows the
 * words it prints, never our guess.
 */
export function parseConnectOutput(output: string): ConnectorSignIn | undefined {
  const url = output.match(/https:\/\/[^\s"'<>]+/)?.[0];
  if (!url) return undefined;
  if (/oauth|authorize/i.test(url) || /oauth/i.test(output)) {
    return { method: 'oauth', url };
  }
  if (/novnc|vnc\.html|remote|stream/i.test(url) || /novnc|remote login|vnc/i.test(output)) {
    return { method: 'streamed-page', url };
  }
  // Squire's connect only prints one sign-in URL; a URL with no recognisable
  // surface words is the streamed page (the default install surface).
  return { method: 'streamed-page', url };
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
 * runner that captures the hosted sign-in URL from live stdout as soon as it
 * is printed (before the process exits). The connect process stays alive in
 * the background for the human to complete sign-in. The post-install
 * `pairSquire` probe confirms the account is live.
 *
 * A failed step ends the report with a clear reason and everything after it
 * stays pending.
 */
export async function installSquire(options: InstallSquireOptions): Promise<InstallSquireResult> {
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
  releaseSquireConnectSession(log);

  // Verify the copy npx resolves BEFORE connect runs, re-resolving a stale
  // one against the current published release.
  const resolution = await resolveSquireConnectSpec(run);
  if (resolution.reResolved) {
    log(
      `trusty-squire stale copy ${resolution.resolvedVersion ?? 'unknown'} re-resolved against current release ${resolution.currentRelease}`,
    );
  }

  // Squire's `connect --skip-browser` prints a hosted sign-in URL for the
  // human's own browser and then blocks waiting for sign-in. It never launches
  // its own Chrome, so no local display or tunnel binaries are needed on a
  // headless helper. The streaming runner captures the URL from live stdout
  // and resolves immediately — keeping the process alive.
  const install = await streamRun('npx', [
    ...resolution.npxArgs,
    'connect',
    '--force-relogin=google',
    '--target=codex',
    '--skip-browser',
  ]);
  if (!install.signIn) {
    const stderr = install.stderr.trim();
    push(step('trusty-squire installed', 'failed', stderr || 'connect printed no sign-in URL'));
    return fail(stderr || 'the trusty-squire connect command printed no sign-in surface');
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
    createdAt: numberOrNull(record.created_at ?? record.createdAt) ?? 0,
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

