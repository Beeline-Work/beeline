import type { SigninFunnelEvent } from '@beeline/api-contract/signin-funnel';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { OidcBindError, parseOidcBindCallback } from '@beeline/buzz-client';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { desktopAuthRedirectUri } from './desktop-auth-redirect';
import { googleAccountPicker } from './google-account-picker';

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
  if (googleAccountPicker) {
    // A server keeps the native recovery hash even after cancellation. Give
    // native and browser ceremonies separate secrets so fallback cannot hit
    // that unique hash, even when native cleanup cannot reach the server.
    const nativeToken = btoa(String.fromCharCode(...sha256(utf8ToBytes(`beeline-google-native:${input.recoveryToken}`))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const nativePending = { ...pending, recoveryToken: nativeToken };
    let nativeStarted = false;
    let completionAttempted = false;
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nativePending));
      const start = await googleAuthFetch(`${base}/auth/oidc/native/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryChallenge: bytesToHex(sha256(utf8ToBytes(nativeToken))),
          ...(input.funnelContext ? { funnel: JSON.stringify(input.funnelContext) } : {}) }),
      });
      if (!start.ok) throw new OidcBindError('native_google_unavailable', 'Google sign-in could not start. Try again.');
      nativeStarted = true;
      const config = await start.json() as { state: string; nonce: string; serverClientId: string };
      if (!TOKEN.test(config.state) || !TOKEN.test(config.nonce) ||
          typeof config.serverClientId !== 'string' || !config.serverClientId.endsWith('.apps.googleusercontent.com'))
        throw new OidcBindError('invalid_response', 'Invalid Google sign-in configuration');
      const idToken = await googleAccountPicker.signIn(config.serverClientId, config.nonce);
      completionAttempted = true;
      const complete = await googleAuthFetch(`${base}/auth/oidc/native/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: config.state, recoveryToken: nativeToken, idToken }),
      });
      // A dropped response can follow a committed ticket. Recover the same
      // one-use proof; neither account linking nor session exchange changes.
      if (!complete.ok) throw new OidcBindError('invalid_oidc_proof', 'Google sign-in could not finish. Try again.');
      if ((await complete.json() as { completed?: unknown }).completed !== true)
        throw new OidcBindError('invalid_response', 'Invalid Google sign-in completion');
      return nativeToken;
    } catch {
      // A dropped response may follow a committed ticket. Recover it before
      // falling back, without spending a second sign-in proof for that account.
      if (completionAttempted) {
        const recovered = await completion(nativePending).catch(() => null);
        if (recovered) return recovered;
      }
      if (nativeStarted) {
        await googleAuthFetch(`${base}/auth/oidc/completion/cancel`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recoveryToken: nativeToken }),
        }).catch(() => undefined);
      }
      // Missing routes/configuration and every native failure retain browser
      // sign-in, including test copies whose signing keys are unregistered.
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    }
  }
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
      // A dismissed tab can also have completed sign-in. Check the server
      // before treating either close result as cancellation.
      browserClosed = result.type === 'cancel' || result.type === 'dismiss';
    }, (error: unknown) => { browserFailure = error; browserClosed = true; });
    const deadline = Date.now() + 120_000;
    let closedAt: number | undefined;
    let connectionInterrupted = false;
    while (Date.now() < deadline) {
      if (browserFailure) throw browserFailure;
      const checkingClosedBrowser = browserClosed;
      let serverPending = false;
      try {
        const ticket = await resumeGoogleSignIn(callbackUrl);
        if (ticket) return ticket;
        serverPending = true;
        connectionInterrupted = false;
      } catch (error) {
        if (error instanceof OidcBindError) throw error;
        // A suspended browser handoff or a slow server cannot establish that
        // the device is offline. Keep recovering the same proof until expiry.
        connectionInterrupted = true;
      }
      if (checkingClosedBrowser && serverPending) {
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
