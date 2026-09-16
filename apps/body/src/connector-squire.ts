/**
 * Trusty Squire connector lifecycle on the helper (Workbench PR 1).
 *
 * One helper carries ONE Squire account (captain decision 2026-09-14). The
 * install runs Squire's own `connect` command through a STREAMING runner that
 * captures the noVNC sign-in URL from live stdout as soon as it appears (the
 * machine token and sign-in surface print before connect blocks waiting for
 * the human). The URL is surfaced as a `streamed-page` signIn immediately;
 * the connect process stays alive in the background while the human completes
 * sign-in on that page. On a headless host the remote-login prerequisites
 * (Xvfb, x11vnc, websockify, cloudflared) are checked first and a missing
 * binary is a NAMED failed step, not a generic install error.
 *
 * The old exit-only `ShellRunner` (defaultShellRunner) remains for the
 * version probe and other quick commands. A new `StreamedShellRunner`
 * (`defaultStreamedRunner`) handles the connect command: it spawns the
 * process, reads stdout line by line, and resolves the promise as soon as the
 * sign-in URL is found (or the process exits without one).
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
  LoginPrerequisiteCheck,
  VaultConnectionMeta,
} from '@beeline/api-contract/daemon';

/** The one Squire MCP contract this connector speaks. */
export interface SquireMcpClient {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** The binaries the noVNC remote sign-in surface needs on a headless host. */
export const REMOTE_LOGIN_BINARIES = ['xvfb-run', 'Xvfb', 'x11vnc', 'websockify', 'cloudflared'] as const;

/** Where Squire installs the agent's own sign-in surface. */
export const SQUIRE_CONNECT_PACKAGE = '@trusty-squire/mcp';

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
        resolve({ stdout, stderr, signIn: undefined, abort: () => {} });
      }
      child.kill();
    }, CONNECT_TIMEOUT_MS);

    const abort = () => {
      clearTimeout(safetyTimer);
      child.kill();
    };

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
      finish({ stdout, stderr, signIn: undefined, abort: () => {} });
    });

    child.on('error', () => {
      finish({ stdout, stderr, signIn: undefined, abort: () => {} });
    });
  });

const step = (label: string, status: ConnectorStep['status'], reason?: string): ConnectorStep => ({
  label,
  status,
  ...(reason ? { reason } : {}),
});

function binaryExists(binary: string): Promise<LoginPrerequisiteCheck> {
  return new Promise((resolve) => {
    execFile('sh', ['-c', `command -v ${JSON.stringify(binary)}`], (error, stdout) => {
      const path = String(stdout ?? '').trim();
      resolve({ binary, found: !error && path.length > 0, ...(path ? { path } : {}) });
    });
  });
}

/** Check every remote-login prerequisite; one bounded parallel sweep. */
export async function checkRemoteLoginPrerequisites(
  probe: (binary: string) => Promise<LoginPrerequisiteCheck> = binaryExists,
): Promise<LoginPrerequisiteCheck[]> {
  return Promise.all(REMOTE_LOGIN_BINARIES.map(probe));
}

/** The named failed step a missing prerequisite produces. */
export function missingPrerequisiteStep(checks: readonly LoginPrerequisiteCheck[]): ConnectorStep {
  const missing = checks.filter((check) => !check.found).map((check) => check.binary);
  return step(
    'remote sign-in prerequisites',
    'failed',
    `missing on this helper: ${missing.join(', ')}`,
  );
}

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
  /** Runs short-lived commands (version probe, remote-login prerequisites). */
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
  readonly probeBinary?: (binary: string) => Promise<LoginPrerequisiteCheck>;
  /**
   * Called after every step settles with the steps so far — the helper
   * forwards each snapshot to the server so the phone paints progress live.
   */
  readonly onProgress?: (steps: readonly ConnectorStep[]) => void;
};

export type InstallSquireResult = {
  readonly status: 'connected' | 'error' | 'installing';
  readonly steps: readonly ConnectorStep[];
  readonly signIn?: ConnectorSignIn;
  readonly squireVersion?: string;
  readonly signedInAs?: string;
  readonly errorMessage?: string;
};

/** The installed trusty-squire version, straight from the package itself. */
export async function installedSquireVersion(
  run: ShellRunner,
): Promise<string | undefined> {
  const probe = await run('npx', ['-y', SQUIRE_CONNECT_PACKAGE, '--version']);
  const version = probe.stdout.match(/\d+\.\d+\.\d+[^\s]*/)?.[0];
  return version;
}

/** The account line Squire prints once a human completes sign-in. */
export function parseSignedInAs(output: string): string | undefined {
  return output.match(/signed in as ([^\s,;]+)/i)?.[1];
}

/**
 * Install and pair Squire on this helper, reporting every step in order.
 *
 * Order: helper reached → remote-login prerequisites → trusty-squire installed
 * → waiting for sign-in → paired to the workspace. The connect command runs
 * through a STREAMING runner that captures the noVNC sign-in URL from live
 * stdout as soon as it is printed (before the process exits). The connect
 * process stays alive in the background for the human to complete sign-in.
 * The post-install `pairSquire` probe confirms the account is live.
 *
 * A failed step ends the report with a clear reason and everything after it
 * stays pending.
 */
export async function installSquire(options: InstallSquireOptions): Promise<InstallSquireResult> {
  const run = options.run ?? defaultShellRunner;
  const streamRun = options.streamRun ?? defaultStreamedRunner;
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

  const checks = await checkRemoteLoginPrerequisites(options.probeBinary);
  if (checks.some((check) => !check.found)) {
    push(missingPrerequisiteStep(checks));
    return fail('this helper cannot host the remote sign-in surface');
  }
  push(step('remote sign-in prerequisites', 'done'));

  // Squire's `connect --force-relogin=google` prints the noVNC URL and then
  // blocks waiting for sign-in. The streaming runner captures the URL from
  // live stdout and resolves immediately — keeping the process alive.
  const install = await streamRun('xvfb-run', [
    '-a',
    'npx',
    '-y',
    SQUIRE_CONNECT_PACKAGE,
    'connect',
    '--force-relogin=google',
    '--target=codex',
  ]);
  if (!install.signIn) {
    const stderr = install.stderr.trim();
    push(step('trusty-squire installed', 'failed', stderr || 'connect printed no sign-in URL'));
    return fail(stderr || 'the trusty-squire connect command printed no sign-in surface');
  }
  // The connect process stays alive in the background for the human to sign in.
  // `install.abort()` can kill it (safety timeout also fires after 5 min).

  const version = await installedSquireVersion(run);
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

