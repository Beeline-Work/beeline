import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  OidcBindError,
  parseOidcBindCallback,
  type OidcBindChallenge,
} from '@beeline/buzz-client';
import { waitForAuthCallbackResult } from './onboarding-state';

const PENDING_SIGN_IN_STATE_KEY = 'buzzy.github-sign-in-state.v1';
const PENDING_INSTALLATION_RETURN_KEY = 'buzzy.github-installation-return.v1';
const PENDING_INSTALLATION_COMPLETED_KEY = 'buzzy.github-installation-completed.v1';
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

interface GitHubAuthBrowserResult {
  type: string;
  url?: string;
}

interface GitHubAuthUrlSubscription {
  remove(): void;
}

interface GitHubInstallationSessionInput {
  returnPath: string;
  startInstallation(): Promise<string>;
  openAuthSession(installationUrl: string, redirectUri: string): Promise<GitHubAuthBrowserResult>;
  subscribeToUrls(listener: (url: string) => void): GitHubAuthUrlSubscription;
  callbackGraceMs?: number;
}

export function githubSignInRedirectUri(): string {
  return Linking.createURL('buzz/github-callback');
}

export function githubInstallationRedirectUri(): string {
  return Linking.createURL('buzz/github-installation');
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
    /^\/buzz\/(?:onboarding|channels|chat\/[^/?#]+)$/.test(value)
  );
}

export async function persistGitHubSignInState(state: string): Promise<void> {
  if (!STATE_RE.test(state)) {
    throw new OidcBindError('invalid_state', 'GitHub app state must be 32 random bytes');
  }
  await AsyncStorage.setItem(PENDING_SIGN_IN_STATE_KEY, state);
}

export async function clearPendingGitHubSignInState(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_SIGN_IN_STATE_KEY);
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
  callbackGraceMs,
}: GitHubInstallationSessionInput): Promise<string> {
  await persistGitHubInstallationReturnPath(returnPath);
  const redirectUri = githubInstallationRedirectUri();
  try {
    const installationUrl = await startInstallation();
    const callback = await waitForAuthCallbackResult({
      redirectUri,
      openAuthSession: () => openAuthSession(installationUrl, redirectUri),
      subscribeToUrls,
      ...(callbackGraceMs === undefined ? {} : { callbackGraceMs }),
    });
    const callbackUrl = await completeGitHubInstallationCallback(callback.url);
    if (callback.source === 'browser') await clearPendingGitHubInstallation();
    return callbackUrl;
  } catch (error) {
    await clearPendingGitHubInstallation();
    throw error;
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
