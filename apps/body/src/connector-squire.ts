/**
 * Trusty Squire connector lifecycle on the helper (Workbench PR 1).
 *
 * One helper carries ONE Squire account (captain decision 2026-09-14). The
 * install runs Squire's own `connect` command non-interactively with the
 * skip-browser flag: Squire prints its sign-in surface (the streamed noVNC
 * page URL or an OAuth URL) and this module reports exactly that method and
 * URL upward — the app opens what it is told (Q7). On a headless host the
 * remote-login prerequisites (Xvfb, x11vnc, websockify, cloudflared) are
 * checked first and a missing binary is a NAMED failed step, not a generic
 * install error.
 *
 * Vault reads, ledger reads, and grant revocation go through the Squire MCP
 * tools (`list_credentials`, `audit_log`, `list_app_access`,
 * `revoke_app_access`) — never through any raw-value path. Everything is
 * expressed against the `SquireMcpClient` interface so tests drive a mocked
 * Squire and no test touches a real Squire account.
 */
import { execFile } from 'node:child_process';
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
export const REMOTE_LOGIN_BINARIES = ['Xvfb', 'x11vnc', 'websockify', 'cloudflared'] as const;

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
  /** Runs the connect command; the default spawns it for real. */
  readonly run?: ShellRunner;
  /** The Squire MCP used for the post-install pairing probe. */
  readonly mcp?: SquireMcpClient;
  readonly probeBinary?: (binary: string) => Promise<LoginPrerequisiteCheck>;
};

export type InstallSquireResult = {
  readonly status: 'connected' | 'error' | 'installing';
  readonly steps: readonly ConnectorStep[];
  readonly signIn?: ConnectorSignIn;
  readonly errorMessage?: string;
};

/**
 * Install and pair Squire on this helper, reporting every step in order.
 * Order: helper reached → remote-login prerequisites → package install →
 * waiting for sign-in → paired to the workspace. A failed step ends the
 * report with a clear reason and everything after it stays pending.
 */
export async function installSquire(options: InstallSquireOptions): Promise<InstallSquireResult> {
  const run = options.run ?? defaultShellRunner;
  const steps: ConnectorStep[] = [step('helper reached', 'done')];
  const fail = (reason: string): InstallSquireResult => {
    steps.push(step('waiting for sign-in', 'pending'));
    return { status: 'error', steps, errorMessage: reason };
  };

  const checks = await checkRemoteLoginPrerequisites(options.probeBinary);
  if (checks.some((check) => !check.found)) {
    steps.push(missingPrerequisiteStep(checks));
    return fail('this helper cannot host the remote sign-in surface');
  }
  steps.push(step('remote sign-in prerequisites', 'done'));

  const install = await run('npx', [
    '-y',
    SQUIRE_CONNECT_PACKAGE,
    'connect',
    '--target=pi',
    '--skip-browser',
  ]);
  if (install.code !== 0) {
    steps.push(step('trusty-squire installed', 'failed', install.stderr.trim() || 'connect failed'));
    return fail('the trusty-squire install command failed');
  }
  steps.push(step('trusty-squire installed', 'done'));

  const signIn = parseConnectOutput(`${install.stdout}\n${install.stderr}`);
  if (!signIn) {
    steps.push(step('waiting for sign-in', 'failed', 'connect printed no sign-in URL'));
    return fail('the trusty-squire connect command printed no sign-in surface');
  }
  steps.push(step('waiting for sign-in', 'done'));

  const pair = await pairSquire(options.mcp, options.workspaceId);
  if (!pair.ok) {
    steps.push(step('paired to workspace', 'failed', pair.reason));
    return { status: 'installing', steps, signIn };
  }
  steps.push(step('paired to workspace', 'done'));
  return { status: 'connected', steps, signIn };
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

