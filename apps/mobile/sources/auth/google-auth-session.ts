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
let pendingMutation: Promise<void> = Promise.resolve();

function mutatePending(operation: () => Promise<void>): Promise<void> {
  const result = pendingMutation.then(operation, operation);
  pendingMutation = result.catch(() => undefined);
  return result;
}

function savePending(pending: PendingGoogle): Promise<void> {
  return mutatePending(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pending)));
}

function googleSignInRedirectUri(): string {
  return desktopAuthRedirectUri('google-callback', Linking.createURL('beeline/google-callback'));
}

async function pendingGoogle(): Promise<PendingGoogle | null> {
  await pendingMutation;
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

export async function clearPendingGoogleSignIn(expectedState?: string): Promise<void> {
  await mutatePending(async () => {
    if (expectedState) {
      const value = await AsyncStorage.getItem(STORAGE_KEY);
      if (!value) return;
      try { if (JSON.parse(value).state !== expectedState) return; } catch { return; }
    }
    await AsyncStorage.removeItem(STORAGE_KEY);
  });
}

/** Hermes supports AbortController but not every AbortSignal static helper. */
async function googleAuthFetch(url: string, init: RequestInit, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) abort();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
}

let completionFlight: { key: string; promise: Promise<string | null> } | undefined;
/** Warm Linking, browser and cold-start callbacks join the same correlated
 * inspection. A failed/pending result never schedules another observation. */
function completion(pending: PendingGoogle, waitMs = 0, signal?: AbortSignal): Promise<string | null> {
  const base = getBuzzRuntimeConfig().monolithUrl;
  const key = JSON.stringify([base, pending.state, pending.recoveryToken]);
  if (completionFlight?.key === key) return completionFlight.promise;
  const promise = inspectCompletion(pending, base, waitMs, signal);
  const flight = { key, promise }; completionFlight = flight;
  void promise.finally(() => { if (completionFlight === flight) completionFlight = undefined; }).catch(() => {});
  return promise;
}
async function inspectCompletion(pending: PendingGoogle, base: string, waitMs: number, signal?: AbortSignal): Promise<string | null> {
  const response = await googleAuthFetch(`${base}/auth/oidc/completion`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recoveryToken: pending.recoveryToken, ...(waitMs ? { waitMs } : {}) }), signal,
  }, waitMs + 5_000);
  const current = await pendingGoogle();
  if (signal?.aborted || current?.state !== pending.state || current.recoveryToken !== pending.recoveryToken)
    throw new OidcBindError('browser_canceled', 'This sign-in was replaced');
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
  platform?: string;
  signal?: AbortSignal;
  onBrowserClosed?: () => void;
  funnelContext?: SigninFunnelEvent;
  linkIdentity?: string;
  openAuthSession(url: string, redirect: string): Promise<{ type: string; url?: string }>;
  subscribeToUrls(listener: (url: string) => void): { remove(): void } | Promise<{ remove(): void }>;
}): Promise<string> {
  if (!TOKEN.test(input.state) || !TOKEN.test(input.recoveryToken)) throw new OidcBindError('invalid_state', 'Invalid Google sign-in state');
  if (input.signal?.aborted) throw new OidcBindError('browser_canceled', 'This sign-in was replaced');
  const pending = { state: input.state, recoveryToken: input.recoveryToken, startedAt: Date.now(), ...(input.linkIdentity ? { linkIdentity: input.linkIdentity } : {}) };
  await savePending(pending);
  const assertCurrent = async (token = input.recoveryToken) => {
    const current = await pendingGoogle();
    if (input.signal?.aborted || current?.state !== input.state || current.recoveryToken !== token)
      throw new OidcBindError('browser_canceled', 'This sign-in was replaced');
  };
  await assertCurrent();
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
      await savePending(nativePending);
      const start = await googleAuthFetch(`${base}/auth/oidc/native/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryChallenge: bytesToHex(sha256(utf8ToBytes(nativeToken))),
          ...(input.funnelContext ? { funnel: JSON.stringify(input.funnelContext) } : {}) }),
      });
      nativeStarted = start.ok;
      await assertCurrent(nativeToken);
      if (!start.ok) throw new OidcBindError('native_google_unavailable', 'Google sign-in could not start. Try again.');
      const config = await start.json() as { state: string; nonce: string; serverClientId: string };
      if (!TOKEN.test(config.state) || !TOKEN.test(config.nonce) ||
          typeof config.serverClientId !== 'string' || !config.serverClientId.endsWith('.apps.googleusercontent.com'))
        throw new OidcBindError('invalid_response', 'Invalid Google sign-in configuration');
      await assertCurrent(nativeToken);
      const idToken = await googleAccountPicker.signIn(config.serverClientId, config.nonce);
      await assertCurrent(nativeToken);
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
      await assertCurrent(nativeToken);
      return nativeToken;
    } catch {
      const current = await pendingGoogle();
      if (input.signal?.aborted || current?.state !== input.state || current.recoveryToken !== nativeToken) {
        if (nativeStarted) await googleAuthFetch(`${base}/auth/oidc/completion/cancel`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recoveryToken: nativeToken }),
        }).catch(() => undefined);
        await clearPendingGoogleSignIn(input.state);
        throw new OidcBindError('browser_canceled', 'This sign-in was replaced');
      }
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
      await assertCurrent(nativeToken);
      await savePending(pending);
    }
  }
  await assertCurrent();
  const url = new URL('/auth/oidc/start', base);
  if (input.funnelContext) url.searchParams.set('funnel', JSON.stringify(input.funnelContext));
  url.searchParams.set('app_redirect', redirect);
  url.searchParams.set('app_state', input.state);
  url.searchParams.set('app_recovery_challenge', bytesToHex(sha256(utf8ToBytes(input.recoveryToken))));
  const controller = new AbortController();
  let terminal: ReturnType<typeof setTimeout> | undefined;
  let completionFailure: unknown;
  const never = () => new Promise<never>(() => {});
  let observed!: (url: string) => void;
  const callback = new Promise<string>(resolve => { observed = resolve; });
  const subscription = await input.subscribeToUrls(value => {
    if (value === redirect || value.startsWith(`${redirect}?`)) observed(value);
  });
  try { await assertCurrent(); } catch (error) { subscription.remove(); throw error; }
  // One outstanding recovery connection also covers a lost OS/browser callback.
  const waitMs = input.platform === 'android' ? 5 * 60_000 : 120_000;
  let rejectReplacement!: (error: OidcBindError) => void;
  const replaced = new Promise<never>((_resolve, reject) => { rejectReplacement = reject; });
  const abort = () => {
    controller.abort();
    rejectReplacement(new OidcBindError('browser_canceled', 'This sign-in was replaced'));
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const held = completion(pending, Math.min(waitMs, 120_000), controller.signal);
  const completed = held.then(ticket => ticket ?? never(), error => { completionFailure = error; return never(); });
  const callbackResult = callback.then(async value => {
    if (controller.signal.aborted) return never();
    if ((await pendingGoogle())?.state !== input.state)
      throw new OidcBindError('state_mismatch', 'This sign-in was replaced');
    const ticket = new URL(value).searchParams.get('completed') === '1'
      ? await held.catch(() => null) ?? await resumeGoogleSignIn(value)
      : await resumeGoogleSignIn(value);
    if (!ticket) throw new OidcBindError('token_expired', 'Google sign-in expired. Try again.');
    return ticket;
  });
  let browserFailed = false;
  const browser = input.openAuthSession(url.toString(), redirect).then(async result => {
    if (controller.signal.aborted) return never();
    if (result.url) { observed(result.url); return never(); }
    if (result.type !== 'cancel' && result.type !== 'dismiss') return never();
    if (input.platform === 'android') {
      input.onBrowserClosed?.();
      return never();
    }
    // Stop the held request before the close event inspects once.
    controller.abort();
    const ticket = await held.catch(() => null) ?? await completion(pending);
    if (ticket) return ticket;
    throw new OidcBindError('browser_canceled', 'Google sign-in was canceled');
  }, error => { browserFailed = true; throw error; });
  const deadline = new Promise<never>((_resolve, reject) => {
    terminal = setTimeout(() => reject(completionFailure ??
      new OidcBindError('token_expired', 'Google sign-in expired. Try again.')), waitMs);
  });
  try { return await Promise.race([completed, callbackResult, browser, deadline, replaced]); }
  catch (error) {
    // Preserve correlation after uncertain transport loss so a cold callback
    // gets one recovery inspection. Explicit close/invalid proof revokes it.
    if (error instanceof OidcBindError || browserFailed) {
      await googleAuthFetch(`${base}/auth/oidc/completion/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryToken: input.recoveryToken }),
      }).catch(() => undefined);
      await clearPendingGoogleSignIn(input.state);
    }
    throw error;
  } finally { if (terminal) clearTimeout(terminal); input.signal?.removeEventListener('abort', abort); controller.abort(); subscription.remove(); }

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
