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
  return (await AsyncStorage.getItem(PENDING_GITHUB_PURPOSE_KEY)) === 'reconnect';
}

const PENDING_SIGN_IN_STATE_KEY = 'buzzy.github-sign-in-state.v1';
const PENDING_SIGN_IN_CALLBACK_KEY = 'buzzy.github-sign-in-callback.v1';
const PENDING_SIGN_IN_RECOVERY_KEY = 'buzzy.github-sign-in-recovery.v1';
const PENDING_INSTALLATION_RETURN_KEY = 'buzzy.github-installation-return.v1';
const PENDING_INSTALLATION_COMPLETED_KEY = 'buzzy.github-installation-completed.v1';
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const GITHUB_RECOVERY_WAIT_MS = 120_000;

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
): { refresh(): Promise<boolean>; remove(): void } {
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
    void refresh();
  });
  return { refresh, remove: () => subscription.remove() };
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
  const authBaseUrl = runtime.monolithEnabled ? runtime.monolithUrl : runtime.relayUrl;
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

export function isGitHubSignInCallbackUrl(url: string | null): boolean {
  return Boolean(url && isCallbackFor(url, githubSignInRedirectUri()));
}

function validInstallationReturnPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 1_024 &&
    /^\/(?:beeline|buzz)\/(?:onboarding|channels|chat\/[^/?#]+)$/.test(value)
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
  await Promise.all([
    AsyncStorage.setItem(PENDING_GITHUB_PURPOSE_KEY, purpose),
    AsyncStorage.setItem(PENDING_SIGN_IN_STATE_KEY, state),
    AsyncStorage.removeItem(PENDING_SIGN_IN_CALLBACK_KEY),
    recoveryToken
      ? AsyncStorage.setItem(PENDING_SIGN_IN_RECOVERY_KEY, recoveryToken)
      : AsyncStorage.removeItem(PENDING_SIGN_IN_RECOVERY_KEY),
  ]);
}

export async function clearPendingGitHubSignInState(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(PENDING_GITHUB_PURPOSE_KEY),
    AsyncStorage.removeItem(PENDING_SIGN_IN_STATE_KEY),
    AsyncStorage.removeItem(PENDING_SIGN_IN_CALLBACK_KEY),
    AsyncStorage.removeItem(PENDING_SIGN_IN_RECOVERY_KEY),
  ]);
}

function authBaseUrl(runtime: BuzzRuntimeConfig): string {
  return runtime.monolithEnabled ? runtime.monolithUrl : runtime.relayUrl;
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
): Promise<OidcBindChallenge | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  let response: Response;
  try {
    response = await fetchImpl(`${authBaseUrl(runtime)}/auth/github/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryToken }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new OidcBindError('offline', 'Could not check GitHub sign-in completion');
  } finally {
    clearTimeout(timeout);
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
    const response = await fetchImpl(`${authBaseUrl(runtime)}/auth/github/completion/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryToken }),
      signal: controller.signal,
    });
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
): Promise<void> {
  const recoveryToken = await AsyncStorage.getItem(PENDING_SIGN_IN_RECOVERY_KEY);
  if (recoveryToken && STATE_RE.test(recoveryToken)) {
    // Deliberately leave storage intact on failure. The next attempt must retry
    // this revocation before it may replace the old token.
    await cancelGitHubRecovery(recoveryToken, runtime, fetchImpl);
  }
  await clearPendingGitHubSignInState();
}

export async function recoverPendingGitHubBindChallenge(
  runtime: BuzzRuntimeConfig = getBuzzRuntimeConfig(),
  fetchImpl: typeof fetch = githubAuthFetch,
): Promise<OidcBindChallenge | null> {
  const [recoveryToken, state] = await Promise.all([
    AsyncStorage.getItem(PENDING_SIGN_IN_RECOVERY_KEY),
    AsyncStorage.getItem(PENDING_SIGN_IN_STATE_KEY),
  ]);
  if (!recoveryToken || !STATE_RE.test(recoveryToken) || !state || !STATE_RE.test(state))
    return null;
  const challenge = await fetchGitHubRecoveryChallenge(recoveryToken, state, runtime, fetchImpl);
  if (challenge) {
    await AsyncStorage.setItem(
      PENDING_SIGN_IN_CALLBACK_KEY,
      challengeCallbackUrl(challenge, state),
    );
  }
  return challenge;
}

interface ResilientGitHubSessionInput {
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
  recoveryPollMs?: number;
  callbackGraceMs?: number;
}

/** Keep the deep link fast path, then recover the same one-use proof by app-held secret. */
export async function runResilientGitHubSignInSession({
  state,
  recoveryToken,
  purpose = 'signin',
  runtime = getBuzzRuntimeConfig(),
  openAuthSession,
  subscribeToUrls,
  fetchImpl = githubAuthFetch,
  recoveryWaitMs = GITHUB_RECOVERY_WAIT_MS,
  recoveryPollMs = 200,
  callbackGraceMs,
}: ResilientGitHubSessionInput): Promise<OidcBindChallenge> {
  const previousRecoveryToken = await AsyncStorage.getItem(PENDING_SIGN_IN_RECOVERY_KEY);
  if (
    previousRecoveryToken &&
    previousRecoveryToken !== recoveryToken &&
    STATE_RE.test(previousRecoveryToken)
  ) {
    await cancelGitHubRecovery(previousRecoveryToken, runtime, fetchImpl);
  }
  const start = startGitHubSignInWebFlow(state, runtime, recoveryToken);
  await persistGitHubSignInState(state, purpose, recoveryToken);
  let callbackUrl: string | null = null;
  try {
    callbackUrl = await waitForAuthCallbackResult({
      redirectUri: start.redirectUri,
      openAuthSession: () => openAuthSession(start.authorizationUrl, start.redirectUri),
      subscribeToUrls,
      ...(callbackGraceMs === undefined ? {} : { callbackGraceMs }),
    }).then((result) => result.url);
  } catch (error) {
    if (!(error instanceof OidcBindError) || error.code !== 'browser_canceled') {
      await cancelGitHubRecovery(recoveryToken, runtime, fetchImpl).catch(() => undefined);
      throw error;
    }
  }

  if (callbackUrl) {
    try {
      if (!recoverySignal(callbackUrl, state)) {
        return resumeGitHubSignInCallback(callbackUrl);
      }
    } catch (error) {
      await cancelGitHubRecovery(recoveryToken, runtime, fetchImpl).catch(() => undefined);
      throw error;
    }
  }

  const deadline = Date.now() + recoveryWaitMs;
  do {
    try {
      const recovered = await fetchGitHubRecoveryChallenge(
        recoveryToken,
        state,
        runtime,
        fetchImpl,
      );
      if (recovered) {
        await AsyncStorage.setItem(
          PENDING_SIGN_IN_CALLBACK_KEY,
          challengeCallbackUrl(recovered, state),
        );
        return recovered;
      }
    } catch (error) {
      // A slow or interrupted completion read says nothing about the proof. Keep
      // the app-held recovery secret and retry while the server ticket can live.
      if (!(error instanceof OidcBindError) || !error.retryable) {
        await cancelGitHubRecovery(recoveryToken, runtime, fetchImpl).catch(() => undefined);
        throw error;
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(recoveryPollMs, remainingMs)));
  } while (Date.now() <= deadline);
  await cancelGitHubRecovery(recoveryToken, runtime, fetchImpl).catch(() => undefined);
  throw new OidcBindError('ticket_expired', 'The GitHub completion expired', 410);
}

/** Reload the signed bind challenge if Expo Router remounted during callback handling. */
export async function loadPendingGitHubBindChallenge(
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<OidcBindChallenge | null> {
  const [callbackUrl, expectedState] = await Promise.all([
    AsyncStorage.getItem(PENDING_SIGN_IN_CALLBACK_KEY),
    AsyncStorage.getItem(PENDING_SIGN_IN_STATE_KEY),
  ]);
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
): Promise<OidcBindChallenge | null> {
  const callbackUrl = await getInitialUrl();
  if (!callbackUrl || !isCallbackFor(callbackUrl, githubSignInRedirectUri())) return null;

  const expectedState = await AsyncStorage.getItem(PENDING_SIGN_IN_STATE_KEY);
  if (expectedState && recoverySignal(callbackUrl, expectedState)) {
    return recoverPendingGitHubBindChallenge();
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
  const expectedState = await AsyncStorage.getItem(PENDING_SIGN_IN_STATE_KEY);
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
  await AsyncStorage.setItem(PENDING_SIGN_IN_CALLBACK_KEY, callbackUrl);
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

async function completeGitHubInstallationCallback(callbackUrl: string): Promise<string> {
  const redirectUri = githubInstallationRedirectUri();
  if (!isCallbackFor(callbackUrl, redirectUri)) {
    throw new OidcBindError('invalid_installation', 'Unexpected GitHub installation callback');
  }
  const url = new URL(callbackUrl);
  const installed = url.searchParams.getAll('installed');
  const unexpected = [...url.searchParams.keys()].filter((key) => key !== 'installed');
  if (installed.length !== 1 || installed[0] !== '1' || unexpected.length > 0) {
    throw new OidcBindError('invalid_installation', 'GitHub App installation did not complete');
  }
  if (!(await githubInstallationReturnPath())) {
    throw new OidcBindError(
      'invalid_installation',
      'This GitHub installation does not match one started on this device.',
    );
  }
  // Keep the return path until the destination screen acknowledges it. A warm
  // Linking event also navigates Expo Router, and clearing here can race the
  // callback route before it has read where the repo picker came from.
  await AsyncStorage.setItem(PENDING_INSTALLATION_COMPLETED_KEY, '1');
  return callbackUrl;
}

export async function completeGitHubInstallationRoute(installed: unknown): Promise<void> {
  const redirectUri = githubInstallationRedirectUri();
  const completion = new URL(redirectUri);
  if (typeof installed === 'string') completion.searchParams.set('installed', installed);
  await completeGitHubInstallationCallback(completion.toString());
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
  const returnMonitor =
    subscribeToAppState && refreshRepositories
      ? createRepositoryReturnMonitor(subscribeToAppState, refreshRepositories, onRefreshPhase)
      : null;
  try {
    const installationUrl = await startInstallation();
    onRefreshPhase('awaiting_return');
    const callback = await waitForAuthCallbackResult({
      redirectUri,
      openAuthSession: () => openAuthSession(installationUrl, redirectUri),
      subscribeToUrls,
      ...(callbackGraceMs === undefined ? {} : { callbackGraceMs }),
    });
    const callbackUrl = await completeGitHubInstallationCallback(callback.url);
    await returnMonitor?.refresh();
    if (callback.source === 'browser') await clearPendingGitHubInstallation();
    return callbackUrl;
  } catch (error) {
    if (returnMonitor && error instanceof OidcBindError && error.code === 'browser_canceled') {
      await returnMonitor.refresh();
      await clearPendingGitHubInstallation();
      return null;
    }
    await clearPendingGitHubInstallation();
    throw error;
  } finally {
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
