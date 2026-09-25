/**
 * Google Workspace tool connector lifecycle on the helper (Gmail / Calendar /
 * Drive / YouTube). One Google OAuth grant per person, four tool connectors
 * that share a Beeline-owned OAuth grant. Each tool checks its own scopes
 * and reports its own install status.
 *
 * Every step reports through `onProgress` with a bounded tail of its own
 * output so the phone can stream the setup logs live.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConnectorKind, ConnectorStep } from '@beeline/api-contract/daemon';
import { GOOGLE_TOOL_SCOPES } from '@beeline/api-contract/workbench';
export { GOOGLE_TOOL_SCOPES } from '@beeline/api-contract/workbench';
import {
  googleWorkspaceClient,
  refreshableTokenSource,
  type GoogleCredentials,
} from './google-workspace-client.js';

export function isGoogleToolConnectorType(type: string): type is
  | 'google-gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-youtube' {
  return Object.hasOwn(GOOGLE_TOOL_SCOPES, type);
}

/** The helper's local copy of Beeline's grant, also read at session startup. */
export function manualGoogleCredentialsSearchPaths(home: string): readonly string[] {
  return [join(home, 'google-credentials.json')];
}

export function loadManualGoogleCredentials(
  home: string,
): { source: 'manual'; credentials: GoogleCredentials } | { source: 'manual-missing'; reason: string } {
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
            expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
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
    reason: 'Google Workspace has not been connected through Beeline',
  };
}

/** Persist the resolved grant so later sessions can mount YouTube. */
export function persistManualGoogleCredentials(home: string, credentials: GoogleCredentials): string {
  const path = manualGoogleCredentialsSearchPaths(home)[0]!;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${JSON.stringify({
      accessToken: credentials.accessToken,
      ...(credentials.expiresAt ? { expiresAt: credentials.expiresAt } : {}),
      ...(credentials.accountEmail ? { accountEmail: credentials.accountEmail } : {}),
      ...(credentials.scopes ? { scopes: credentials.scopes } : {}),
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return path;
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
  | { source: 'beeline'; credentials: GoogleCredentials }
  | { source: 'pending' | 'error'; reason: string };

export type InstallGoogleToolOptions = {
  readonly connectorType: ConnectorKind;
  /** The connector's own home on the helper (manual credentials live here). */
  readonly home: string;
  /** Override the Google client (tests drive a fake). */
  readonly client?: ReturnType<typeof googleWorkspaceClient>;
  /** Override credential resolution (tests). */
  readonly resolveCredentials?: () => Promise<ResolvedGoogleCredentials>;
  /**
   * An already-resolved (or in-flight) grant shared across this drain's
   * Google tool installs: the single Google consent resolves ONCE and every
   * tool's install rides the same result. Takes precedence over
   * `resolveCredentials` when both are given.
   */
  readonly resolvedCredentials?:
    | ResolvedGoogleCredentials
    | Promise<ResolvedGoogleCredentials>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProgress?: (steps: readonly ConnectorStep[]) => void;
};

export type InstallGoogleToolResult = {
  readonly status: 'connected' | 'installing' | 'error';
  readonly steps: readonly ConnectorStep[];
  readonly signedInAs?: string;
  readonly errorMessage?: string;
};

/**
 * Connect one Google tool connector, reporting every step in order:
 * helper reached → Beeline grant resolved → authorized with Google → tools
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

  // The grant is issued by Beeline's own OAuth callback.
  push(step('Google credentials resolved', 'running', { output: 'resolving…' }));
  const resolved = options.resolvedCredentials
    ? await options.resolvedCredentials
    : options.resolveCredentials
      ? await options.resolveCredentials()
      : { source: 'pending' as const, reason: 'waiting for Google sign-in' };
  if (!('credentials' in resolved)) {
    const reason = resolved.reason;
    steps[1] = step('Google credentials resolved',
      resolved.source === 'pending' ? 'running' : 'failed',
      { ...(resolved.source === 'error' ? { reason } : {}), output: outputTail(reason) });
    emit();
    return resolved.source === 'pending'
      ? { status: 'installing', steps }
      : { status: 'error', steps, errorMessage: reason };
  }
  steps[1] = step('Google credentials resolved', 'done', {
    output: 'Google sign-in completed through Beeline',
  });
  emit();
  const missing = GOOGLE_TOOL_SCOPES[options.connectorType]!.filter(
    (scope) => !resolved.credentials.scopes?.includes(scope),
  );
  if (missing.length) return fail('tools enabled', `Google did not grant ${options.connectorType} permission`);

  // Authorization: one verified call against the live grant.
  const client =
    options.client ??
    googleWorkspaceClient(
      refreshableTokenSource(
        resolved.credentials,
        options.env?.BEELINE_GOOGLE_CLIENT_ID,
        options.env?.BEELINE_GOOGLE_CLIENT_SECRET,
      ),
    );
  push(step('authorized with Google', 'running', { output: 'verifying the grant with Google…' }));
  const verify = await client.verify();
  if (!verify.ok) {
    return fail('authorized with Google', verify.reason, outputTail(verify.reason));
  }
  steps[2] = step('authorized with Google', 'done', {
    ...(verify.account ? { output: `signed in as ${verify.account}` } : {}),
  });
  emit();

  // User-info proves the token, but it cannot prove access to this tool.
  // Exercise a read-only capability before the server clears an old error.
  push(step('tools enabled', 'running', { output: 'verifying this Google tool…' }));
  try {
    switch (options.connectorType) {
      case 'google-gmail':
        await client.gmail.listMessages();
        break;
      case 'google-calendar':
        await client.calendar.listEvents({ maxResults: 1 });
        break;
      case 'google-drive':
        await client.drive.searchFiles('');
        break;
      case 'google-youtube':
        await client.youtube.listVideos();
        break;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    steps[3] = step('tools enabled', 'failed', { reason, output: outputTail(reason) });
    emit();
    return { status: 'error', steps, errorMessage: reason };
  }
  steps[3] = step('tools enabled', 'done', {
    output: `${GOOGLE_TOOL_SCOPES[options.connectorType]!.length} Google scopes granted; tool verified`,
  });
  emit();
  if (options.connectorType === 'google-youtube')
    persistManualGoogleCredentials(options.home, resolved.credentials);
  return {
    status: 'connected',
    steps,
    ...(verify.account ? { signedInAs: verify.account } : {}),
  };
}
