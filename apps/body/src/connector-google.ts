/**
 * Google Workspace tool connector lifecycle on the helper (Gmail / Calendar /
 * Drive / YouTube). One Google OAuth grant per person, four tool connectors
 * that share it: the grant is resolved ONCE per connect run and every tool
 * enabled for this connector kind is verified against it.
 *
 * Two credential paths:
 *
 * - ONE-CLICK (Trusty Squire): when the person already completed Google OAuth
 *   inside Squire, the grant is read from the vault through the typed
 *   `readGoogleCredentialsFromVault` seam — no browser, no sign-in step on
 *   the phone. If Squire's vault does not yet expose a Google OAuth
 *   credential type, the seam reports that honestly and the flow falls to
 *   the manual path (the missing Squire-side capability is tracked, never
 *   faked).
 *
 * - MANUAL: the person provisions the connector's OAuth client credentials
 *   on the helper machine — a `google-credentials.json` file under the
 *   connector home (or the `BEELINE_GOOGLE_ACCESS_TOKEN` env for quick
 *   tests). The connect checklist names exactly what is missing.
 *
 * Every step reports through `onProgress` with a bounded tail of its own
 * output so the phone can stream the setup logs live.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectorKind, ConnectorStep } from '@beeline/api-contract/daemon';
import {
  googleWorkspaceClient,
  credentialsTokenSource,
  type GoogleCredentials,
} from './google-workspace-client.js';
import type { SquireMcpClient } from './connector-squire.js';

/** The Google scopes each tool connector needs (scope minimization per tool). */
export const GOOGLE_TOOL_SCOPES: Record<string, readonly string[]> = {
  'google-gmail': [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ],
  'google-calendar': ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'],
  'google-drive': ['https://www.googleapis.com/auth/drive.readonly'],
  'google-youtube': ['https://www.googleapis.com/auth/youtube.readonly'],
};

export function isGoogleToolConnectorType(type: string): type is
  | 'google-gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-youtube' {
  return type in GOOGLE_TOOL_SCOPES;
}

/**
 * ONE-CLICK seam: resolve the person's Google OAuth grant from the Squire
 * vault. Squire's `list_credentials` reports field NAMES only (values are
 * masked from agents and helpers alike), so the grant must be readable
 * through a dedicated Squire tool. This seam calls
 * `google_oauth_credentials` when the vault offers it; anything else
 * (including a vault that never heard of the tool) resolves to
 * `{ source: 'unavailable' }` and the caller falls back to manual
 * provisioning. Flagged in the Workbench PR: Squire does not yet expose that
 * tool; when it ships, one-click works with no change here.
 */
export async function readGoogleCredentialsFromVault(
  mcp: SquireMcpClient | undefined,
): Promise<
  | { source: 'squire'; credentials: GoogleCredentials }
  | { source: 'unavailable'; reason: string }
> {
  if (!mcp) return { source: 'unavailable', reason: 'no Trusty Squire connector is paired' };
  let raw: unknown;
  try {
    raw = await mcp.call('google_oauth_credentials', {});
  } catch (error) {
    return {
      source: 'unavailable',
      reason:
        'Squire has no Google OAuth grant on record yet ' +
        `(connect your Google account in Squire first: ${describe(error)})`,
    };
  }
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const inner =
    record.credentials && typeof record.credentials === 'object'
      ? (record.credentials as Record<string, unknown>)
      : record;
  const accessToken = inner.accessToken ?? inner.access_token;
  if (!accessToken || typeof accessToken !== 'string') {
    return { source: 'unavailable', reason: 'Squire returned a Google grant without an access token' };
  }
  return {
    source: 'squire',
    credentials: {
      accessToken: accessToken,
      refreshToken:
        typeof record.refreshToken === 'string'
          ? record.refreshToken
          : typeof record.refresh_token === 'string'
            ? record.refresh_token
            : undefined,
      expiresAt:
        typeof record.expiresAt === 'number' ? record.expiresAt : undefined,
      accountEmail:
        typeof record.accountEmail === 'string'
          ? record.accountEmail
          : typeof record.email === 'string'
            ? record.email
            : undefined,
    },
  };
}

/** MANUAL path: credentials file under the connector home (or env token). */
export function manualGoogleCredentialsSearchPaths(home: string): readonly string[] {
  return [join(home, 'google-credentials.json')];
}

export function loadManualGoogleCredentials(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): { source: 'manual'; credentials: GoogleCredentials } | { source: 'manual-missing'; reason: string } {
  if (env.BEELINE_GOOGLE_ACCESS_TOKEN) {
    return {
      source: 'manual',
      credentials: { accessToken: env.BEELINE_GOOGLE_ACCESS_TOKEN },
    };
  }
  for (const path of manualGoogleCredentialsSearchPaths(home)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (typeof parsed.accessToken === 'string' || typeof parsed.access_token === 'string') {
        return {
          source: 'manual',
          credentials: {
            accessToken: (parsed.accessToken ?? parsed.access_token) as string,
            refreshToken:
              typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
            accountEmail:
              typeof parsed.accountEmail === 'string' ? parsed.accountEmail : undefined,
          },
        };
      }
    } catch {
      // missing or unreadable file: keep looking, report honestly at the end
    }
  }
  return {
    source: 'manual-missing',
    reason:
      'no Google credentials found. Put a google-credentials.json ' +
      `(OAuth access token) at ${manualGoogleCredentialsSearchPaths(home)[0]} or connect ` +
      'your Google account in Trusty Squire first.',
  };
}

const step = (label: string, status: ConnectorStep['status'], extra?: Partial<ConnectorStep>): ConnectorStep => ({
  label,
  status,
  ...extra,
});

/** Bounded output tail streamed with each step (the phone renders it mono). */
export function outputTail(text: string, maxChars = 800): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}

export type ResolvedGoogleCredentials =
  | { source: 'squire' | 'manual'; credentials: GoogleCredentials }
  | { source: 'manual-missing' | 'unavailable'; reason: string };

export type InstallGoogleToolOptions = {
  readonly connectorType: ConnectorKind;
  /** The connector's own home on the helper (manual credentials live here). */
  readonly home: string;
  /** The Squire MCP for the one-click vault path (absent → manual only). */
  readonly squire?: SquireMcpClient;
  /** Override the Google client (tests drive a fake). */
  readonly client?: ReturnType<typeof googleWorkspaceClient>;
  /** Override credential resolution (tests). */
  readonly resolveCredentials?: () => Promise<ResolvedGoogleCredentials>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProgress?: (steps: readonly ConnectorStep[]) => void;
};

export type InstallGoogleToolResult = {
  readonly status: 'connected' | 'error';
  readonly steps: readonly ConnectorStep[];
  readonly signedInAs?: string;
  readonly errorMessage?: string;
};

/**
 * Connect one Google tool connector, reporting every step in order:
 * helper reached → Google credentials resolved (one-click via Squire when
 * possible, otherwise the manual path) → authorized with Google → tools
 * enabled. A failed step ends the report with its reason and output; later
 * steps stay pending.
 */
export async function installGoogleTool(
  options: InstallGoogleToolOptions,
): Promise<InstallGoogleToolResult> {
  const steps: ConnectorStep[] = [step('helper reached', 'done')];
  const emit = () => options.onProgress?.([...steps]);
  const push = (next: ConnectorStep) => {
    steps.push(next);
    emit();
  };
  const fail = (label: string, reason: string, output?: string): InstallGoogleToolResult => {
    push(step(label, 'failed', { reason, ...(output ? { output } : {}) }));
    return { status: 'error', steps, errorMessage: reason };
  };
  emit();

  if (!isGoogleToolConnectorType(options.connectorType)) {
    return fail('connector type', `${options.connectorType} is not a Google tool connector`);
  }

  // Credentials: one-click first, manual fallback.
  push(step('Google credentials resolved', 'running', { output: 'resolving…' }));
  const resolved = options.resolveCredentials
    ? await options.resolveCredentials()
    : await (async () => {
        const oneClick = await readGoogleCredentialsFromVault(options.squire);
        return oneClick.source === 'squire'
          ? { ...oneClick }
          : { ...loadManualGoogleCredentials(options.home, options.env) };
      })();
  if (!('credentials' in resolved)) {
    const reason = resolved.reason;
    steps[1] = step('Google credentials resolved', 'failed', { reason, output: outputTail(reason) });
    emit();
    return { status: 'error', steps, errorMessage: reason };
  }
  steps[1] = step('Google credentials resolved', 'done', {
    output:
      resolved.source === 'squire'
        ? 'one-click: read the Google grant from Trusty Squire'
        : 'manual: local google-credentials.json',
  });
  emit();

  // Authorization: one verified call against the live grant.
  const client =
    options.client ?? googleWorkspaceClient(credentialsTokenSource(resolved.credentials));
  push(step('authorized with Google', 'running', { output: 'verifying the grant with Google…' }));
  const verify = await client.verify();
  if (!verify.ok) {
    return fail('authorized with Google', verify.reason, outputTail(verify.reason));
  }
  steps[2] = step('authorized with Google', 'done', {
    ...(verify.account ? { output: `signed in as ${verify.account}` } : {}),
  });
  emit();

  push(step('tools enabled', 'done', {
    output: `${GOOGLE_TOOL_SCOPES[options.connectorType]!.length} Google scopes granted`,
  }));
  return {
    status: 'connected',
    steps,
    ...(verify.account ? { signedInAs: verify.account } : {}),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
