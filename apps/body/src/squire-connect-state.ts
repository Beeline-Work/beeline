/**
 * Squire connect as three ordinary facts, not one blob.
 *
 * PROCESS — is a browser running, and whose is it?
 * VISIBILITY — can a person see it, and is one looking right now?
 * CREDENTIAL — is the account actually signed in?
 *
 * The Workbench status is derived from these. A dead connect's ceremony is
 * retired rather than handed back. KEYS read the session the app owns, so
 * they do not wait on a host broker. Connected is that same session, not a
 * phrase Squire printed.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { squireHostPaths } from './squire-host.js';

export type SquireProcessFact =
  | { readonly kind: 'none' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'ours'; readonly pid: number }
  | { readonly kind: 'foreign'; readonly pid: number; readonly action: string };

export type SquireVisibilityFact =
  | { readonly kind: 'none' }
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
 * The session root every helper-spawned Squire writes to: the same pinned
 * `XDG_CONFIG_HOME` `squireHostRewriteEnv` gives it, never this process's
 * ambient one. The argument is the test seam.
 */
export function squireSessionPath(configHome?: string): string {
  const root = configHome?.trim() || squireHostPaths(homedir()).configHome;
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

/** Start only when nothing else holds the browser. This helper's own
 *  live connect may be released and retried; a foreign process may not.
 *  A ceremony nobody is running is not a holder: it is retired by the
 *  release the start itself performs, never handed back. */
export function shouldStartSquireConnect(facts: SquireConnectFacts): boolean {
  if (facts.credential.kind === 'valid') return false;
  if (facts.process.kind === 'foreign') return false;
  return true;
}

export function visibilitySignIn(
  visibility: SquireVisibilityFact,
): { method: 'streamed-page'; url: string } | undefined {
  return visibility.kind === 'remote' ? { method: 'streamed-page', url: visibility.url } : undefined;
}
