import type { SigninFunnelEvent } from '@beeline/api-contract/signin-funnel';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { OidcBindError, parseOidcBindCallback } from '@beeline/buzz-client';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { desktopAuthRedirectUri } from './desktop-auth-redirect';

const STORAGE_KEY = 'beeline.google-sign-in.v1';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
type PendingGoogle = { state: string; recoveryToken: string; startedAt: number; linkIdentity?: string };

function googleSignInRedirectUri(): string {
  return desktopAuthRedirectUri('google-callback', Linking.createURL('beeline/google-callback'));
}

async function pendingGoogle(): Promise<PendingGoogle | null> {
  const value = await AsyncStorage.getItem(STORAGE_KEY);
  if (!value) return null;
  try {
    const pending = JSON.parse(value) as PendingGoogle;
    if (TOKEN.test(pending.state) && TOKEN.test(pending.recoveryToken) &&
        Number.isFinite(pending.startedAt) && Date.now() - pending.startedAt < 10 * 60_000) return pending;
  } catch { /* Ignore a damaged local continuation. */ }
  await AsyncStorage.removeItem(STORAGE_KEY);
  return null;
}

export async function clearPendingGoogleSignIn(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

/** Hermes supports AbortController but not every AbortSignal static helper. */
async function googleAuthFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally { clearTimeout(timer); }
}

async function completion(pending: PendingGoogle): Promise<string | null> {
  const base = getBuzzRuntimeConfig().monolithUrl;
  const response = await googleAuthFetch(`${base}/auth/oidc/completion`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recoveryToken: pending.recoveryToken }),
  });
  if (response.status === 202) return null;
  if (response.status >= 500 || response.status === 429) {
    throw new Error('Google sign-in service temporarily unavailable');
  }
  if (!response.ok) throw new OidcBindError('token_expired', 'Google sign-in expired. Try again.');
  return pending.recoveryToken;
}

/** A state-bound recovery token also survives a lost redirect or app restart. */
export async function resumeGoogleSignIn(callbackUrl: string | null): Promise<string | null> {
  const pending = await pendingGoogle();
  if (!pending) return null;
  const redirect = googleSignInRedirectUri();
  if (callbackUrl && (callbackUrl === redirect || callbackUrl.startsWith(`${redirect}?`))) {
    const callback = new URL(callbackUrl);
    if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== pending.state) {
      throw new OidcBindError('state_mismatch', 'Google callback state mismatch');
    }
    if (callback.searchParams.get('completed') !== '1') {
      const challenge = parseOidcBindCallback(callbackUrl, pending.state);
      if (challenge.provider !== 'https://accounts.google.com') throw new OidcBindError('wrong_provider', 'Invalid Google sign-in proof');
      return challenge.ticket;
    }
  }
  return completion(pending);
}

export async function runGoogleSignIn(input: {
  state: string;
  recoveryToken: string;
  funnelContext?: SigninFunnelEvent;
  linkIdentity?: string;
  openAuthSession(url: string, redirect: string): Promise<{ type: string; url?: string }>;
  subscribeToUrls(listener: (url: string) => void): { remove(): void } | Promise<{ remove(): void }>;
}): Promise<string> {
  if (!TOKEN.test(input.state) || !TOKEN.test(input.recoveryToken)) throw new OidcBindError('invalid_state', 'Invalid Google sign-in state');
  const pending = { state: input.state, recoveryToken: input.recoveryToken, startedAt: Date.now(), ...(input.linkIdentity ? { linkIdentity: input.linkIdentity } : {}) };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  const redirect = googleSignInRedirectUri();
  const base = getBuzzRuntimeConfig().monolithUrl;
  const url = new URL('/auth/oidc/start', base);
  if (input.funnelContext) url.searchParams.set('funnel', JSON.stringify(input.funnelContext));
  url.searchParams.set('app_redirect', redirect);
  url.searchParams.set('app_state', input.state);
  url.searchParams.set('app_recovery_challenge', bytesToHex(sha256(utf8ToBytes(input.recoveryToken))));
  let callbackUrl: string | null = null;
  let browserClosed = false;
  let browserFailure: unknown;
  const subscription = await input.subscribeToUrls((value) => {
    if (value === redirect || value.startsWith(`${redirect}?`)) callbackUrl = value;
  });
  try {
    void input.openAuthSession(url.toString(), redirect).then((result) => {
      if (result.url) callbackUrl = result.url;
      browserClosed = result.type !== 'opened';
    }, (error: unknown) => { browserFailure = error; browserClosed = true; });
    const deadline = Date.now() + 120_000;
    let closedAt: number | undefined;
    let connectionInterrupted = false;
    while (Date.now() < deadline) {
      if (browserFailure) throw browserFailure;
      try {
        const ticket = await resumeGoogleSignIn(callbackUrl);
        if (ticket) return ticket;
        connectionInterrupted = false;
      } catch (error) {
        if (error instanceof OidcBindError) throw error;
        // A suspended browser handoff or a slow server cannot establish that
        // the device is offline. Keep recovering the same proof until expiry.
        connectionInterrupted = true;
      }
      if (browserClosed) {
        closedAt ??= Date.now();
        if (Date.now() - closedAt >= 1_500) throw new OidcBindError('browser_canceled', 'Google sign-in was canceled');
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new OidcBindError(connectionInterrupted ? 'connection_failed' : 'token_expired',
      connectionInterrupted ? 'Could not reach Google sign-in. Try again.' : 'Google sign-in expired. Try again.');
  } catch (error) {
    await googleAuthFetch(`${base}/auth/oidc/completion/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryToken: input.recoveryToken }),
    }).catch(() => undefined);
    await clearPendingGoogleSignIn();
    throw error;
  } finally { subscription.remove(); }
}

export async function pendingGoogleLinkIdentity(): Promise<string | null> {
  return (await pendingGoogle())?.linkIdentity ?? null;
}

let linking: Promise<void> | undefined;
let completedLink: string | undefined;
export function completeGoogleAccountLink(ticket: string, identityId: string): Promise<void> {
  if (completedLink === `${identityId}:${ticket}`) return Promise.resolve();
  if (linking) return linking;
  linking = (async () => {
    if (await pendingGoogleLinkIdentity() !== identityId) throw new Error('Google connection does not match this account. Try again.');
    const { monolithSession } = await import('./monolith-session');
    if (await monolithSession.identityId() !== identityId) throw new Error('Your account changed. Connect Google again.');
    await monolithSession.linkGoogleTicket(ticket);
    await clearPendingGoogleSignIn();
    completedLink = `${identityId}:${ticket}`;
  })().finally(() => { linking = undefined; });
  return linking;
}
