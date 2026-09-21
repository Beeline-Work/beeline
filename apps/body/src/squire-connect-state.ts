/**
 * Squire connect as three ordinary facts, not one blob.
 *
 * PROCESS — is a browser running, and whose is it?
 * VISIBILITY — can a person see it, and is one looking right now?
 * CREDENTIAL — is the account actually signed in?
 *
 * The Workbench status is derived from these. A dead connect does not
 * start another display (visibility already published). KEYS read the
 * session the app owns, so they do not wait on a host broker. Connected
 * is that same session, not a phrase Squire printed.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VaultConnectionMeta } from '@beeline/api-contract/daemon';

export type SquireProcessFact =
  | { readonly kind: 'none' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'ours'; readonly pid: number }
  | { readonly kind: 'foreign'; readonly pid: number; readonly action: string }
  | { readonly kind: 'unidentified' };

export type SquireVisibilityFact =
  | { readonly kind: 'none' }
  | { readonly kind: 'local'; readonly held: boolean }
  | { readonly kind: 'remote'; readonly held: boolean; readonly url: string };

export type SquireCredentialFact =
  | { readonly kind: 'none' }
  | { readonly kind: 'valid'; readonly accountId: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'challenge' };

export type SquireConnectFacts = {
  readonly process: SquireProcessFact;
  readonly visibility: SquireVisibilityFact;
  readonly credential: SquireCredentialFact;
};

export type SquireSessionRecord = {
  readonly apiBaseUrl: string;
  readonly accountId?: string;
  readonly agentSessionToken?: string;
  readonly machineToken?: string;
};

let publishedVisibility: SquireVisibilityFact = { kind: 'none' };
let vaultAuth: 'unknown' | 'expired' = 'unknown';

export function publishedSquireVisibility(): SquireVisibilityFact {
  return publishedVisibility;
}

export function publishSquireVisibility(next: SquireVisibilityFact): void {
  publishedVisibility = next;
}

export function noteSquireVaultAuth(outcome: 'ok' | 'expired'): void {
  vaultAuth = outcome === 'expired' ? 'expired' : 'unknown';
}

export function resetSquireConnectFacts(): void {
  publishedVisibility = { kind: 'none' };
  vaultAuth = 'unknown';
}

/**
 * Two branches only. A screen is whatever this process already has
 * (`DISPLAY` or `WAYLAND_DISPLAY`). No sockets, logind, or seat filter —
 * Squire answers which of its paths work.
 */
export function hostSeatDisplay(options?: {
  readonly env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = options?.env ?? process.env;
  const display = env.DISPLAY?.trim();
  if (display) return display;
  const wayland = env.WAYLAND_DISPLAY?.trim();
  return wayland || undefined;
}

export function squireSessionPath(configHome?: string): string {
  const root = configHome?.trim() || process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(root, 'trusty-squire', 'session.json');
}

/** The session file this helper owns — not Squire's stdout. */
export function readSquireSession(configHome?: string): SquireSessionRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(squireSessionPath(configHome), 'utf8')) as {
      api_base_url?: unknown;
      account_id?: unknown;
      agent_session_token?: unknown;
      machine_token?: unknown;
    };
    if (typeof parsed.api_base_url !== 'string' || parsed.api_base_url.length === 0) {
      return undefined;
    }
    return {
      apiBaseUrl: parsed.api_base_url,
      ...(typeof parsed.account_id === 'string' ? { accountId: parsed.account_id } : {}),
      ...(typeof parsed.agent_session_token === 'string'
        ? { agentSessionToken: parsed.agent_session_token }
        : {}),
      ...(typeof parsed.machine_token === 'string' ? { machineToken: parsed.machine_token } : {}),
    };
  } catch {
    return undefined;
  }
}

export function credentialFromSession(
  session: SquireSessionRecord | undefined,
  visibility: SquireVisibilityFact = publishedVisibility,
): SquireCredentialFact {
  if (vaultAuth === 'expired' && session?.agentSessionToken) return { kind: 'expired' };
  if (session?.agentSessionToken && session.accountId) {
    return { kind: 'valid', accountId: session.accountId };
  }
  if (visibility.kind !== 'none' && visibility.held) return { kind: 'challenge' };
  return { kind: 'none' };
}

/**
 * One Workbench status from facts the app owns. Valid credential is
 * connected; a published or held surface is still installing; process
 * waiters stay installing. Nothing here reads Squire's prose.
 */
export function connectStatusFromFacts(facts: SquireConnectFacts): 'connected' | 'installing' | 'disconnected' {
  if (facts.credential.kind === 'valid') return 'connected';
  if (facts.credential.kind === 'challenge') return 'installing';
  if (facts.visibility.kind !== 'none') return 'installing';
  if (facts.process.kind !== 'none') return 'installing';
  return 'disconnected';
}

/** Start a browser only when no process is running and no surface is up. */
export function shouldStartSquireConnect(facts: SquireConnectFacts): boolean {
  if (facts.credential.kind === 'valid') return false;
  if (facts.process.kind !== 'none') return false;
  if (facts.visibility.kind !== 'none') return false;
  return true;
}

export function visibilitySignIn(
  visibility: SquireVisibilityFact,
): { method: 'streamed-page'; url: string } | undefined {
  return visibility.kind === 'remote' ? { method: 'streamed-page', url: visibility.url } : undefined;
}

/**
 * KEYS from the session the app owns. A missing broker does not hide them:
 * this is an HTTP read of the account vault, not a façade spawn.
 */
export async function readVaultFromSession(options?: {
  readonly session?: SquireSessionRecord;
  readonly configHome?: string;
  readonly fetch?: typeof fetch;
}): Promise<VaultConnectionMeta[] | undefined> {
  const session = options?.session ?? readSquireSession(options?.configHome);
  if (!session?.agentSessionToken) return undefined;
  try {
    const response = await (options?.fetch ?? fetch)(`${session.apiBaseUrl}/v1/vault/credentials`, {
      headers: {
        Authorization: `Bearer ${session.agentSessionToken}`,
        Accept: 'application/json',
        ...(session.accountId ? { 'x-account-id': session.accountId } : {}),
      },
    });
    if (response.status === 401) {
      noteSquireVaultAuth('expired');
      return undefined;
    }
    if (!response.ok) return undefined;
    noteSquireVaultAuth('ok');
    const body = (await response.json()) as { credentials?: unknown };
    return Array.isArray(body.credentials) ? body.credentials.map(sessionVaultMeta) : [];
  } catch {
    return undefined;
  }
}

function sessionVaultMeta(raw: unknown): VaultConnectionMeta {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const created = record.created_at ?? record.createdAt;
  const reference = String(record.reference ?? record.id ?? '');
  return {
    reference,
    service: typeof record.service === 'string' ? record.service : null,
    label: String(record.label ?? record.service ?? reference),
    fieldNames: strings(record.field_names ?? record.fieldNames),
    allowedHosts: strings(record.allowed_hosts ?? record.allowedHosts ?? record.login_hosts),
    createdAt: typeof created === 'number' && Number.isFinite(created) ? created : 0,
    stale: record.stale === true,
    state: record.state === 'error' ? 'error' : 'active',
  };
}
