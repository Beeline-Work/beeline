import { OidcBindError } from '@beeline/buzz-client';

export type GoogleOnboardingStatus =
  | 'idle'
  | 'checking_device'
  | 'existing_device'
  | 'opening_browser'
  | 'binding'
  | 'entering_workspace'
  | 'bind_retry'
  | 'browser_canceled'
  | 'token_expired'
  | 'offline'
  | 'link_conflict';

export interface GoogleOnboardingNotice {
  status: GoogleOnboardingStatus;
  title: string;
  message: string;
  retryable: boolean;
}

type GoogleOnboardingEvent = 'callback_received' | 'bind_succeeded';

interface GoogleAuthBrowserResult {
  type: string;
  url?: string;
}

interface GoogleAuthUrlSubscription {
  remove(): void;
}

interface WaitForGoogleAuthCallbackInput {
  redirectUri: string;
  openAuthSession(): Promise<GoogleAuthBrowserResult>;
  subscribeToUrls(listener: (url: string) => void): GoogleAuthUrlSubscription;
  callbackGraceMs?: number;
}

export interface AuthCallbackResult {
  url: string;
  source: 'browser' | 'linking';
}

/** Keep the onboarding state transition explicit and independently testable. */
export function nextGoogleOnboardingStatus(
  current: GoogleOnboardingStatus,
  event: GoogleOnboardingEvent,
): GoogleOnboardingStatus {
  if (event === 'callback_received' && current === 'opening_browser') return 'binding';
  if (event === 'bind_succeeded' && current === 'binding') return 'entering_workspace';
  return current;
}

function isExpectedCallback(url: string, redirectUri: string): boolean {
  return url === redirectUri || url.startsWith(`${redirectUri}?`);
}

/**
 * Android's WebBrowser polyfill races AppState becoming active against the
 * matching Linking event. Preserve that event when AppState wins by a few
 * milliseconds instead of reporting a successful OAuth round-trip as canceled.
 */
export async function waitForGoogleAuthCallbackResult({
  redirectUri,
  openAuthSession,
  subscribeToUrls,
  callbackGraceMs = 1_500,
}: WaitForGoogleAuthCallbackInput): Promise<AuthCallbackResult> {
  let resolveObservedCallback: (result: AuthCallbackResult) => void = () => undefined;
  const observedCallback = new Promise<AuthCallbackResult>((resolve) => {
    resolveObservedCallback = resolve;
  });
  const subscription = subscribeToUrls((url) => {
    if (isExpectedCallback(url, redirectUri)) {
      resolveObservedCallback({ url, source: 'linking' });
    }
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const browserResult = await openAuthSession();
    if (
      browserResult.type === 'success' &&
      browserResult.url &&
      isExpectedCallback(browserResult.url, redirectUri)
    ) {
      return { url: browserResult.url, source: 'browser' };
    }

    const callback = await Promise.race([
      observedCallback,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), callbackGraceMs);
      }),
    ]);
    if (callback) return callback;
    throw new OidcBindError('browser_canceled', 'Account authorization was canceled');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    subscription.remove();
  }
}

export async function waitForGoogleAuthCallback(
  input: WaitForGoogleAuthCallbackInput,
): Promise<string> {
  return (await waitForGoogleAuthCallbackResult(input)).url;
}

export function noticeForOidcError(error: unknown): GoogleOnboardingNotice {
  const code = error instanceof OidcBindError ? error.code : 'unknown';
  const codeLabel = (code.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'unknown').toUpperCase();
  const titleWithCode = (title: string): string => `${title} · ${codeLabel}`;
  if (code === 'ticket_expired' || code === 'unknown_ticket' || code === 'invalid_oidc_flow') {
    return {
      status: 'token_expired',
      title: titleWithCode('SESSION EXPIRED'),
      message: 'The one-time account proof expired. Start again to get a new one.',
      retryable: false,
    };
  }
  if (code === 'identity_conflict') {
    return {
      status: 'link_conflict',
      title: titleWithCode('LINK CONFLICT · RECOVERY NEEDED'),
      message:
        'This sign-in account already has a different device key. Recovery is required; this key was not saved.',
      retryable: false,
    };
  }
  if (code === 'state_mismatch') {
    return {
      status: 'bind_retry',
      title: titleWithCode('SIGN-IN REJECTED'),
      message:
        'This callback did not match the sign-in started on this device. Start again from Beeline.',
      retryable: false,
    };
  }
  if (code === 'oidc_denied' || code === 'github_denied' || code === 'browser_canceled') {
    return {
      status: 'browser_canceled',
      title: titleWithCode('SIGN-IN CANCELED'),
      message: 'Nothing changed on this device. Sign in again when you are ready.',
      retryable: false,
    };
  }
  if (code === 'invalid_redirect' || code === 'invalid_configuration' || code === 'invalid_state') {
    return {
      status: 'bind_retry',
      title: titleWithCode('SIGN-IN CONFIG ERROR'),
      message: 'The app rejected its sign-in callback configuration. Update or reinstall the app.',
      retryable: false,
    };
  }
  if (code === 'offline' || (error instanceof OidcBindError && error.retryable)) {
    return {
      status: code === 'offline' ? 'offline' : 'bind_retry',
      title: titleWithCode(code === 'offline' ? 'OFFLINE' : 'BIND INTERRUPTED'),
      message:
        'The device key is ready but could not be bound. Check the connection and retry before the proof expires.',
      retryable: true,
    };
  }
  return {
    status: 'bind_retry',
    title: titleWithCode('BIND FAILED'),
    message: error instanceof Error ? error.message : 'The device key could not be bound.',
    retryable: false,
  };
}
