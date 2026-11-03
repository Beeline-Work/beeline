import type { SigninFunnelEvent } from '@beeline/api-contract/signin-funnel';
import { githubConnectionErrorMessage } from './github-connection-error';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  OidcBindError,
  parseOidcBindCallback,
  startGitHubBind,
  type OidcBindChallenge,
  type OidcBindStart,
} from '@beeline/buzz-client';
import { getBuzzRuntimeConfig, type BuzzRuntimeConfig } from '@/buzz/runtime-config';
import { isDesktopShell } from '@/utils/isDesktopShell';
import { waitForAuthCallbackResult } from './onboarding-state';
import { desktopAuthRedirectUri } from './desktop-auth-redirect';

const PENDING_GITHUB_PURPOSE_KEY = 'buzzy.github-purpose.v1';

export async function isPendingGitHubReconnect(): Promise<boolean> {
  return (await readPendingSession())?.purpose === 'reconnect';
}

const PENDING_SIGN_IN_STATE_KEY = 'buzzy.github-sign-in-state.v1';
const PENDING_SIGN_IN_CALLBACK_KEY = 'buzzy.github-sign-in-callback.v1';
const PENDING_SIGN_IN_RECOVERY_KEY = 'buzzy.github-sign-in-recovery.v1';
const PENDING_SIGN_IN_SESSION_KEY = 'buzzy.github-sign-in-session.v2';
const PENDING_INSTALLATION_RETURN_KEY = 'buzzy.github-installation-return.v1';
const PENDING_INSTALLATION_COMPLETED_KEY = 'buzzy.github-installation-completed.v1';
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const GITHUB_RECOVERY_WAIT_MS = 120_000;

const leftGitHubSignIns = new WeakSet<Error>();

/** True when the person left the GitHub page before finishing; sign-in should end without a notice. */
export function isGitHubSignInLeft(error: unknown): boolean {
  return error instanceof Error && leftGitHubSignIns.has(error);
}

interface PendingGitHubSignInSession {
  state: string;
  purpose: 'signin' | 'reconnect';
  recoveryToken?: string;
  callbackUrl?: string;
}

let pendingSessionMutation: Promise<void> = Promise.resolve();

function validPendingSession(value: unknown): value is PendingGitHubSignInSession {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.state === 'string' &&
    STATE_RE.test(record.state) &&
    (record.purpose === 'signin' || record.purpose === 'reconnect') &&
    (record.recoveryToken === undefined ||
      (typeof record.recoveryToken === 'string' && STATE_RE.test(record.recoveryToken))) &&
    (record.callbackUrl === undefined || typeof record.callbackUrl === 'string')
  );
}

async function readPendingSessionInsideMutation(): Promise<PendingGitHubSignInSession | null> {
  const encoded = await AsyncStorage.getItem(PENDING_SIGN_IN_SESSION_KEY);
  if (encoded) {
    try {
      const parsed: unknown = JSON.parse(encoded);
      if (validPendingSession(parsed)) return parsed;
    } catch {
      // Fall through to the v1 keys written by an older app release.
    }
  }
  const [state, purpose, recoveryToken, callbackUrl] = await Promise.all([
    AsyncStorage.getItem(PENDING_SIGN_IN_STATE_KEY),
    AsyncStorage.getItem(PENDING_GITHUB_PURPOSE_KEY),
    AsyncStorage.getItem(PENDING_SIGN_IN_RECOVERY_KEY),
    AsyncStorage.getItem(PENDING_SIGN_IN_CALLBACK_KEY),
  ]);
  if (!state || !STATE_RE.test(state)) return null;
  return {
    state,
    purpose: purpose === 'reconnect' ? 'reconnect' : 'signin',
    ...(recoveryToken && STATE_RE.test(recoveryToken) ? { recoveryToken } : {}),
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}

async function readPendingSession(): Promise<PendingGitHubSignInSession | null> {
  await pendingSessionMutation;
  return readPendingSessionInsideMutation();
}

function mutatePendingSession(operation: () => Promise<void>): Promise<void> {
  const result = pendingSessionMutation.then(operation, operation);
  pendingSessionMutation = result.catch(() => undefined);
  return result;
}

async function persistPendingCallback(callbackUrl: string, expectedState: string): Promise<void> {
  await mutatePendingSession(async () => {
    const session = await readPendingSessionInsideMutation();
    if (!session || session.state !== expectedState) {
      throw new OidcBindError(
        'state_mismatch',
        'This GitHub callback does not match the current sign-in.',
      );
    }
    await AsyncStorage.setItem(
      PENDING_SIGN_IN_SESSION_KEY,
      JSON.stringify({ ...session, callbackUrl }),
    );
    await AsyncStorage.setItem(PENDING_SIGN_IN_CALLBACK_KEY, callbackUrl);
  });
}

async function githubAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isDesktopShell()) return fetch(input, init);
  const { fetch: desktopFetch } = await import('@tauri-apps/plugin-http');
  return desktopFetch(input, init);
}

interface GitHubAuthBrowserResult {
  type: string;
  url?: string;
}

interface GitHubAuthUrlSubscription {
  remove(): void;
}

interface GitHubAppStateSubscription {
  remove(): void;
}

export type GitHubRepositoryRefreshPhase =
  'awaiting_return' | 'refreshing' | 'refreshed' | 'refresh_failed';

export function githubRepositoryRefreshFeedback(phase: GitHubRepositoryRefreshPhase): {
  notice: string | null;
  error: string | null;
} {
  if (phase === 'awaiting_return') {
    return {
      notice: 'Choose the repositories Beeline may access, then return.',
      error: null,
    };
  }
  if (phase === 'refreshing') {
    return { notice: 'Refreshing repositories…', error: null };
  }
  if (phase === 'refreshed') {
    return { notice: 'Repositories refreshed.', error: null };
  }
  return {
    notice: null,
    error: 'Could not refresh repositories. Return to Beeline and try again.',
  };
}

interface GitHubInstallationSessionInput {
  returnPath: string;
  startInstallation(): Promise<string>;
  openAuthSession(installationUrl: string, redirectUri: string): Promise<GitHubAuthBrowserResult>;
  subscribeToUrls(
    listener: (url: string) => void,
  ): GitHubAuthUrlSubscription | Promise<GitHubAuthUrlSubscription>;
  subscribeToAppState?: (listener: (state: string) => void) => GitHubAppStateSubscription;
  refreshRepositories?: () => Promise<void>;
  onRefreshPhase?: (phase: GitHubRepositoryRefreshPhase) => void;
  callbackGraceMs?: number;
}

function createRepositoryReturnMonitor(
  subscribeToAppState: NonNullable<GitHubInstallationSessionInput['subscribeToAppState']>,
  refreshRepositories: NonNullable<GitHubInstallationSessionInput['refreshRepositories']>,
  onRefreshPhase: NonNullable<GitHubInstallationSessionInput['onRefreshPhase']>,
): { refresh(): Promise<boolean>; returned: Promise<boolean>; remove(): void } {
  let resolveReturn: (success: boolean) => void = () => undefined;
  const returned = new Promise<boolean>(resolve => { resolveReturn = resolve; });
  let leftApp = false;
  let refreshInFlight: Promise<boolean> | null = null;
  let refreshResult: boolean | null = null;
  const refresh = (): Promise<boolean> => {
    if (refreshInFlight) return refreshInFlight;
    if (refreshResult !== null) return Promise.resolve(refreshResult);
    refreshInFlight = (async () => {
      onRefreshPhase('refreshing');
      try {
        await refreshRepositories();
        onRefreshPhase('refreshed');
        refreshResult = true;
        return true;
      } catch {
        onRefreshPhase('refresh_failed');
        refreshResult = false;
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  };
  const subscription = subscribeToAppState((state) => {
    if (state !== 'active') {
      leftApp = true;
      refreshResult = null;
      return;
    }
    if (!leftApp) return;
    leftApp = false;
    void refresh().then(resolveReturn);
  });
  return { refresh, returned, remove: () => subscription.remove() };
}

export function githubSignInRedirectUri(): string {
  return desktopAuthRedirectUri('github-callback', Linking.createURL('beeline/github-callback'));
}

/** Keep the browser authorize origin on the same stack that will consume its one-use ticket. */
export function startGitHubSignInWebFlow(
  state: string,
  runtime: BuzzRuntimeConfig = getBuzzRuntimeConfig(),
  recoveryToken?: string,
): OidcBindStart {
  const authBaseUrl = runtime.monolithUrl;
  const start = startGitHubBind(authBaseUrl, {
    redirectUri: githubSignInRedirectUri(),
    state,
  });
  if (recoveryToken !== undefined) {
    if (!STATE_RE.test(recoveryToken)) {
      throw new OidcBindError('invalid_state', 'GitHub recovery token must be 32 random bytes');
    }
    const authorization = new URL(start.authorizationUrl);
    authorization.searchParams.set(
      'app_recovery_challenge',
      bytesToHex(sha256(utf8ToBytes(recoveryToken))),
    );
    start.authorizationUrl = authorization.toString();
  }
  return start;
}

export function githubInstallationRedirectUri(): string {
  return desktopAuthRedirectUri(
    'github-installation',
    Linking.createURL('beeline/github-installation'),
  );
}

function isCallbackFor(url: string, redirectUri: string): boolean {
  return url === redirectUri || url.startsWith(`${redirectUri}?`);
}

function validInstallationReturnPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 1_024 &&
    /^\/(?:beeline|buzz)\/(?:onboarding|channels|settings(?:\/identity)?|chat\/[^/?#]+(?:\?repositoryPicker=[A-Za-z0-9_-]+)?)$/.test(value)
  );
}

export async function persistGitHubSignInState(
  state: string,
  purpose: 'signin' | 'reconnect' = 'signin',
  recoveryToken?: string,
): Promise<void> {
  if (!STATE_RE.test(state)) {
    throw new OidcBindError('invalid_state', 'GitHub app state must be 32 random bytes');
  }
  if (recoveryToken !== undefined && !STATE_RE.test(recoveryToken)) {
    throw new OidcBindError('invalid_state', 'GitHub recovery token must be 32 random bytes');
  }
  await mutatePendingSession(async () => {
    await AsyncStorage.setItem(
      PENDING_SIGN_IN_SESSION_KEY,
      JSON.stringify({ state, purpose, ...(recoveryToken ? { recoveryToken } : {}) }),
    );
    // Keep the old keys during the upgrade window. New code reads the single
    // record above, so it can never combine fields from two overlapping flows.
    await Promise.all([
      AsyncStorage.setItem(PENDING_GITHUB_PURPOSE_KEY, purpose),
      AsyncStorage.setItem(PENDING_SIGN_IN_STATE_KEY, state),
      AsyncStorage.removeItem(PENDING_SIGN_IN_CALLBACK_KEY),
      recoveryToken
        ? AsyncStorage.setItem(PENDING_SIGN_IN_RECOVERY_KEY, recoveryToken)
        : AsyncStorage.removeItem(PENDING_SIGN_IN_RECOVERY_KEY),
    ]);
  });
}

export async function clearPendingGitHubSignInState(expectedState?: string): Promise<void> {
  await mutatePendingSession(async () => {
    if (expectedState) {
      const session = await readPendingSessionInsideMutation();
      if (!session || session.state !== expectedState) return;
    }
    await Promise.all([
      AsyncStorage.removeItem(PENDING_SIGN_IN_SESSION_KEY),
      AsyncStorage.removeItem(PENDING_GITHUB_PURPOSE_KEY),
      AsyncStorage.removeItem(PENDING_SIGN_IN_STATE_KEY),
      AsyncStorage.removeItem(PENDING_SIGN_IN_CALLBACK_KEY),
      AsyncStorage.removeItem(PENDING_SIGN_IN_RECOVERY_KEY),
    ]);
  });
}

function authBaseUrl(runtime: BuzzRuntimeConfig): string {
  return runtime.monolithUrl;
}

function recoverySignal(callbackUrl: string, expectedState: string): boolean {
  const url = new URL(callbackUrl);
  if (!isCallbackFor(callbackUrl, githubSignInRedirectUri())) return false;
  if (
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.get('state') !== expectedState
  ) {
    throw new OidcBindError('state_mismatch', 'This GitHub callback does not match this sign-in.');
  }
  const keys = [...url.searchParams.keys()];
  return keys.length === 2 && keys.includes('state') && url.searchParams.get('completed') === '1';
}

function challengeCallbackUrl(challenge: OidcBindChallenge, state: string): string {
  const callback = new URL(githubSignInRedirectUri());
  callback.searchParams.set('state', state);
  for (const [name, value] of Object.entries(challenge)) {
    callback.searchParams.set(name, String(value));
  }
  return callback.toString();
}

async function fetchGitHubRecoveryChallenge(
  recoveryToken: string,
  state: string,
  runtime: BuzzRuntimeConfig,
  fetchImpl: typeof fetch,
  waitMs = 0, signal?: AbortSignal,
): Promise<OidcBindChallenge | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), waitMs + 3_000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let response: Response;
  try {
    response = await fetchImpl(`${authBaseUrl(runtime)}/auth/github/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryToken, ...(waitMs ? { waitMs } : {}) }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new OidcBindError('offline', 'Could not check GitHub sign-in completion');
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
  }
  if (response.status === 202) return null;
  if (response.status === 410) {
    throw new OidcBindError('ticket_expired', 'The GitHub completion expired', 410);
  }
  if (!response.ok) {
    if (response.status < 500) {
      throw new OidcBindError(
        'invalid_response',
        'GitHub sign-in completion was rejected',
        response.status,
      );
    }
    throw new OidcBindError(
      'offline',
      'Could not check GitHub sign-in completion',
      response.status,
    );
  }
  let challenge: OidcBindChallenge;
  try {
    challenge = (await response.json()) as OidcBindChallenge;
  } catch {
    throw new OidcBindError('invalid_response', 'GitHub completion response was invalid');
  }
  return parseOidcBindCallback(challengeCallbackUrl(challenge, state), state);
}

async function cancelGitHubRecovery(
  recoveryToken: string,
  runtime: BuzzRuntimeConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${authBaseUrl(runtime)}/auth/github/completion/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryToken }),
        signal: controller.signal,
      });
    } catch {
      throw new OidcBindError('offline', 'Could not cancel GitHub sign-in');
    }
    if (!response.ok) {
      throw new OidcBindError('offline', 'Could not cancel GitHub sign-in', response.status);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Revoke a pending/recovered ticket before forgetting the only token that can burn it. */
export async function cancelPendingGitHubSignIn(
  runtime: BuzzRuntimeConfig = getBuzzRuntimeConfig(),
  fetchImpl: typeof fetch = githubAuthFetch,
  expectedState?: string,
): Promise<void> {
  const session = await readPendingSession();
  if (expectedState && session?.state !== expectedState) return;
  const recoveryToken = session?.recoveryToken;
  if (recoveryToken && STATE_RE.test(recoveryToken)) {
    // Deliberately leave storage intact on failure. The next attempt must retry
    // this revocation before it may replace the old token.
    await cancelGitHubRecovery(recoveryToken, runtime, fetchImpl);
  }
  await clearPendingGitHubSignInState(expectedState);
}

export async function recoverPendingGitHubBindChallenge(
  runtime: BuzzRuntimeConfig = getBuzzRuntimeConfig(),
  fetchImpl: typeof fetch = githubAuthFetch,
  expectedState?: string,
): Promise<OidcBindChallenge | null> {
  const session = await readPendingSession();
  if (expectedState && session?.state !== expectedState) {
    throw new OidcBindError('state_mismatch', 'This GitHub callback does not match this sign-in.');
  }
  const recoveryToken = session?.recoveryToken;
  const state = session?.state;
  if (!recoveryToken || !STATE_RE.test(recoveryToken) || !state || !STATE_RE.test(state))
    return null;
  const challenge = await fetchGitHubRecoveryChallenge(recoveryToken, state, runtime, fetchImpl);
  if (challenge) {
    await persistPendingCallback(challengeCallbackUrl(challenge, state), state);
  }
  return challenge;
}

/** Cold recovery consumes one correlated held inspection, never a poll loop. */
async function awaitCompletedGitHubBindChallenge(expectedState: string): Promise<OidcBindChallenge> {
  const session = await readPendingSession();
  if (session?.state !== expectedState || !session.recoveryToken)
    throw new OidcBindError('state_mismatch', 'This GitHub callback has no pending recovery.');
  const challenge = await fetchGitHubRecoveryChallenge(session.recoveryToken, expectedState,
    getBuzzRuntimeConfig(), githubAuthFetch, GITHUB_RECOVERY_WAIT_MS);
  if ((await readPendingSession())?.state !== expectedState)
    throw new OidcBindError('state_mismatch', 'This GitHub callback does not match the current sign-in.');
  if (!challenge) throw new OidcBindError('ticket_expired', 'The GitHub completion expired', 410);
  await persistPendingCallback(challengeCallbackUrl(challenge, expectedState), expectedState);
  return challenge;
}

interface ResilientGitHubSessionInput {
  funnelContext?: SigninFunnelEvent;
  platform?: string;
  signal?: AbortSignal;
  onBrowserClosed?: () => void;
  state: string;
  recoveryToken: string;
  purpose?: 'signin' | 'reconnect';
  runtime?: BuzzRuntimeConfig;
  openAuthSession(authorizationUrl: string, redirectUri: string): Promise<GitHubAuthBrowserResult>;
  subscribeToUrls(
    listener: (url: string) => void,
  ): GitHubAuthUrlSubscription | Promise<GitHubAuthUrlSubscription>;
  fetchImpl?: typeof fetch;
  recoveryWaitMs?: number;
  callbackGraceMs?: number;
}

/** Keep the deep link fast path, then recover the same one-use proof by app-held secret. */
export async function runResilientGitHubSignInSession({
  funnelContext,
  platform,
  signal,
  onBrowserClosed,
  state,
  recoveryToken,
  purpose = 'signin',
  runtime = getBuzzRuntimeConfig(),
  openAuthSession,
  subscribeToUrls,
  fetchImpl = githubAuthFetch,
  recoveryWaitMs = platform === 'android' ? 5 * 60_000 : GITHUB_RECOVERY_WAIT_MS,
  callbackGraceMs,
}: ResilientGitHubSessionInput): Promise<OidcBindChallenge> {
  const assertCurrent = () => {
    if (signal?.aborted) throw new OidcBindError('browser_canceled', 'This sign-in was replaced');
  };
  assertCurrent();
  const previousRecoveryToken = (await readPendingSession())?.recoveryToken;
  assertCurrent();
  if (
    previousRecoveryToken &&
    previousRecoveryToken !== recoveryToken &&
    STATE_RE.test(previousRecoveryToken)
  ) {
    await cancelGitHubRecovery(previousRecoveryToken, runtime, fetchImpl);
  }
  const start = startGitHubSignInWebFlow(state, runtime, recoveryToken);
  if (funnelContext) {
    const authorization=new URL(start.authorizationUrl);
    authorization.searchParams.set('funnel',JSON.stringify(funnelContext));
    start.authorizationUrl=authorization.toString();
  }
  if (purpose === 'signin') {
    const authorization = new URL(start.authorizationUrl);
    authorization.searchParams.set('onboarding', '1');
    start.authorizationUrl = authorization.toString();
  }
  assertCurrent();
  await persistGitHubSignInState(state, purpose, recoveryToken);
  const controller = new AbortController();
  let completionFailure: unknown;
  const never = () => new Promise<never>(() => {});
  const recovery = fetchGitHubRecoveryChallenge(recoveryToken, state, runtime, fetchImpl,
    Math.min(120_000, Math.max(0, recoveryWaitMs)), controller.signal);
  const recovered = recovery.then(async challenge => {
    assertCurrent();
    if (!challenge) return never();
    await persistPendingCallback(challengeCallbackUrl(challenge, state), state);
    return challenge;
  }, error => {
    completionFailure = error;
    if (error instanceof OidcBindError && !error.retryable) throw error;
    return never();
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(completionFailure ??
      new OidcBindError('ticket_expired', 'The GitHub completion expired', 410)), recoveryWaitMs);
  });
  let rejectReplacement!: (error: OidcBindError) => void;
  const replaced = new Promise<never>((_resolve, reject) => { rejectReplacement = reject; });
  const abort = () => {
    controller.abort();
    rejectReplacement(new OidcBindError('browser_canceled', 'This sign-in was replaced'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const callback = waitForAuthCallbackResult({ redirectUri: start.redirectUri,
    openAuthSession: async () => {
      assertCurrent();
      const result = await openAuthSession(start.authorizationUrl, start.redirectUri);
      if (platform === 'android' && (result.type === 'cancel' || result.type === 'dismiss')) {
        onBrowserClosed?.();
        return { type: 'opened' };
      }
      return result;
    }, subscribeToUrls, openedCallbackWaitMs: recoveryWaitMs,
    signal: controller.signal, ...(callbackGraceMs === undefined ? {} : { callbackGraceMs }),
  }).then(async result => {
    assertCurrent();
    if (controller.signal.aborted) return never();
    if (!recoverySignal(result.url, state)) return resumeGitHubSignInCallback(result.url);
    // A callback is an actual completion boundary. Old servers may have returned
    // immediate pending for the held extension, so inspect once on that event.
    const challenge = await recovery.catch(error => {
      if (error instanceof OidcBindError && !error.retryable) throw error;
      return null;
    }) ?? await fetchGitHubRecoveryChallenge(recoveryToken, state, runtime, fetchImpl);
    assertCurrent();
    if (!challenge) throw new OidcBindError('ticket_expired', 'The GitHub completion expired', 410);
    await persistPendingCallback(challengeCallbackUrl(challenge, state), state);
    return challenge;
  }, async error => {
    if (controller.signal.aborted) throw error;
    if (!(error instanceof OidcBindError) || error.code !== 'browser_canceled') throw error;
    const challenge = await fetchGitHubRecoveryChallenge(recoveryToken, state, runtime, fetchImpl);
    if (challenge) { await persistPendingCallback(challengeCallbackUrl(challenge, state), state); return challenge; }
    void cancelGitHubRecovery(recoveryToken, runtime, fetchImpl).catch(() => undefined);
    leftGitHubSignIns.add(error); throw error;
  });
  try { return await Promise.race([recovered, callback, deadline, replaced]); }
  catch (error) {
    if (error instanceof OidcBindError && !error.retryable && !leftGitHubSignIns.has(error))
      await cancelGitHubRecovery(recoveryToken, runtime, fetchImpl).catch(() => undefined);
    if (signal?.aborted) await clearPendingGitHubSignInState(state);
    throw error;
  } finally { if (timeout) clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort(); }

}

/** Reload the signed bind challenge if Expo Router remounted during callback handling. */
export async function loadPendingGitHubBindChallenge(
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<OidcBindChallenge | null> {
  const session = await readPendingSession();
  const callbackUrl = session?.callbackUrl;
  const expectedState = session?.state;
  if (!callbackUrl || !expectedState || !STATE_RE.test(expectedState)) return null;
  const challenge = parseOidcBindCallback(callbackUrl, expectedState);
  if (challenge.expires_at <= nowSeconds) {
    await clearPendingGitHubSignInState();
    throw new OidcBindError('ticket_expired', 'The bind ticket expired', 410);
  }
  return challenge;
}

/**
 * Recover a GitHub proof delivered as the process-launching URL. The generated
 * state is read from durable storage and still goes through the SDK's strict
 * callback parser; a cold start never gets a state-check exception.
 */
export async function resumeInitialGitHubSignIn(
  getInitialUrl: () => Promise<string | null>,
  nowSeconds = Math.floor(Date.now() / 1_000),
  options: { signedIn?: boolean } = {},
): Promise<OidcBindChallenge | null> {
  const callbackUrl = await getInitialUrl();
  if (!callbackUrl || !isCallbackFor(callbackUrl, githubSignInRedirectUri())) return null;

  const expectedState = (await readPendingSession())?.state;
  // Android keeps the launching Intent across an OTA JavaScript reload. Once
  // sign-in finished and cleared its pending state, that URL is history, not
  // a new callback. A currently pending flow still gets every state check.
  if (!expectedState && options.signedIn) return null;
  if (expectedState && recoverySignal(callbackUrl, expectedState)) {
    return awaitCompletedGitHubBindChallenge(expectedState);
  }

  return resumeGitHubSignInCallback(callbackUrl, nowSeconds);
}

export async function resumeGitHubSignInCallback(
  callbackUrl: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<OidcBindChallenge> {
  if (!isCallbackFor(callbackUrl, githubSignInRedirectUri())) {
    throw new OidcBindError('invalid_callback', 'Unexpected GitHub sign-in callback');
  }
  const expectedState = (await readPendingSession())?.state;
  if (!expectedState || !STATE_RE.test(expectedState)) {
    throw new OidcBindError(
      'state_mismatch',
      'This GitHub callback does not match a sign-in started on this device.',
    );
  }
  const challenge = parseOidcBindCallback(callbackUrl, expectedState);
  if (challenge.expires_at <= nowSeconds) {
    await clearPendingGitHubSignInState();
    throw new OidcBindError('ticket_expired', 'The bind ticket expired', 410);
  }
  await persistPendingCallback(callbackUrl, expectedState);
  return challenge;
}

export async function persistGitHubInstallationReturnPath(returnPath: string): Promise<void> {
  if (!validInstallationReturnPath(returnPath)) {
    throw new OidcBindError('invalid_installation', 'Invalid GitHub installation return path');
  }
  await AsyncStorage.setItem(PENDING_INSTALLATION_RETURN_KEY, returnPath);
}

export async function githubInstallationReturnPath(): Promise<string | null> {
  const value = await AsyncStorage.getItem(PENDING_INSTALLATION_RETURN_KEY);
  return validInstallationReturnPath(value) ? value : null;
}

export async function clearPendingGitHubInstallation(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(PENDING_INSTALLATION_RETURN_KEY),
    AsyncStorage.removeItem(PENDING_INSTALLATION_COMPLETED_KEY),
  ]);
}

async function completeGitHubInstallationCallback(callbackUrl: string, requirePending = true): Promise<string> {
  const redirectUri = githubInstallationRedirectUri();
  if (!isCallbackFor(callbackUrl, redirectUri)) {
    throw new OidcBindError('invalid_installation', 'Unexpected GitHub installation callback');
  }
  const url = new URL(callbackUrl);
  const connectionError = url.searchParams.get('error');
  if (url.searchParams.get('installed') === '0' && connectionError && (!requirePending || await githubInstallationReturnPath())) {
    const message = githubConnectionErrorMessage(connectionError);
    throw new OidcBindError(connectionError, message);
  }
  const installed = url.searchParams.getAll('installed');
  const unexpected = [...url.searchParams.keys()].filter((key) => key !== 'installed');
  if (installed.length !== 1 || installed[0] !== '1' || unexpected.length > 0) {
    throw new OidcBindError('invalid_installation', 'GitHub App installation did not complete');
  }
  const pendingPath = await githubInstallationReturnPath();
  if (requirePending && !pendingPath) {
    throw new OidcBindError(
      'invalid_installation',
      'This GitHub installation does not match one started on this device.',
    );
  }
  // Keep the return path until the destination screen acknowledges it. A warm
  // Linking event also navigates Expo Router, and clearing here can race the
  // callback route before it has read where the repo picker came from.
  if (pendingPath) await AsyncStorage.setItem(PENDING_INSTALLATION_COMPLETED_KEY, '1');
  return callbackUrl;
}

export async function completeGitHubInstallationRoute(installed: unknown, error?: string): Promise<void> {
  const redirectUri = githubInstallationRedirectUri();
  const completion = new URL(redirectUri);
  if (typeof installed === 'string') completion.searchParams.set('installed', installed);
  if (error) completion.searchParams.set('error', error);
  // Web returns can outlive their opener. This only acknowledges the callback;
  // repository access is still read from the signed-in user's server session.
  await completeGitHubInstallationCallback(completion.toString(), !/^https?:/.test(redirectUri));
}

/** Browser return and warm Linking events share one completion path. */
export async function runGitHubInstallationSession({
  returnPath,
  startInstallation,
  openAuthSession,
  subscribeToUrls,
  subscribeToAppState,
  refreshRepositories,
  onRefreshPhase = () => undefined,
  callbackGraceMs,
}: GitHubInstallationSessionInput): Promise<string | null> {
  await persistGitHubInstallationReturnPath(returnPath);
  const redirectUri = githubInstallationRedirectUri();
  const webReturn = /^https?:/.test(redirectUri);
  const returnMonitor =
    subscribeToAppState && refreshRepositories
      ? createRepositoryReturnMonitor(subscribeToAppState, refreshRepositories, onRefreshPhase)
      : null;
  const controller = new AbortController();
  try {
    const installationUrl = await startInstallation();
    onRefreshPhase('awaiting_return');
    const waiting = waitForAuthCallbackResult({
      redirectUri,
      signal: controller.signal,
      openAuthSession: () => openAuthSession(installationUrl, redirectUri),
      subscribeToUrls,
      ...(callbackGraceMs === undefined ? {} : { callbackGraceMs }),
    });
    const callback = await (returnMonitor
      ? Promise.race([waiting, returnMonitor.returned.then(() => null)])
      : waiting);
    if (!callback) return null;
    const callbackUrl = await completeGitHubInstallationCallback(callback.url, !webReturn);
    await returnMonitor?.refresh();
    // Both web tabs share storage. The landing tab may still need the Room
    // path even after the opener receives the callback or gives up waiting.
    return callbackUrl;
  } catch (error) {
    if (returnMonitor && error instanceof OidcBindError && error.code === 'browser_canceled') {
      await returnMonitor.refresh();
      return null;
    }
    throw error;
  } finally {
    controller.abort();
    returnMonitor?.remove();
  }
}

/** Consume an installation callback that launched a fresh app process. */
export async function resumeInitialGitHubInstallation(
  getInitialUrl: () => Promise<string | null>,
): Promise<boolean> {
  if (!(await githubInstallationReturnPath())) return false;
  const callbackUrl = await getInitialUrl();
  if (callbackUrl && isCallbackFor(callbackUrl, githubInstallationRedirectUri())) {
    await completeGitHubInstallationCallback(callbackUrl);
  } else if ((await AsyncStorage.getItem(PENDING_INSTALLATION_COMPLETED_KEY)) !== '1') {
    return false;
  }
  await clearPendingGitHubInstallation();
  return true;
}
