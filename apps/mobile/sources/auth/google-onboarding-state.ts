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
export async function waitForGoogleAuthCallback({
  redirectUri,
  openAuthSession,
  subscribeToUrls,
  callbackGraceMs = 1_500,
}: WaitForGoogleAuthCallbackInput): Promise<string> {
  let resolveObservedCallback: (url: string) => void = () => undefined;
  const observedCallback = new Promise<string>((resolve) => {
    resolveObservedCallback = resolve;
  });
  const subscription = subscribeToUrls((url) => {
    if (isExpectedCallback(url, redirectUri)) resolveObservedCallback(url);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const browserResult = await openAuthSession();
    if (
      browserResult.type === 'success' &&
      browserResult.url &&
      isExpectedCallback(browserResult.url, redirectUri)
    ) {
      return browserResult.url;
    }

    const callbackUrl = await Promise.race([
      observedCallback,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), callbackGraceMs);
      }),
    ]);
    if (callbackUrl) return callbackUrl;
    throw new OidcBindError('browser_canceled', 'Google authorization was canceled');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    subscription.remove();
  }
}

export function noticeForOidcError(error: unknown): GoogleOnboardingNotice {
  const code = error instanceof OidcBindError ? error.code : 'unknown';
  if (code === 'ticket_expired' || code === 'unknown_ticket' || code === 'invalid_oidc_flow') {
    return {
      status: 'token_expired',
      title: 'SESSION EXPIRED',
      message: 'The one-time Google proof expired. Start again to get a new one.',
      retryable: false,
    };
  }
  if (code === 'identity_conflict') {
    return {
      status: 'link_conflict',
      title: 'LINK CONFLICT · RECOVERY NEEDED',
      message:
        'This Google account already has a different device key. Recovery arrives in Phase 3; this key was not saved.',
      retryable: false,
    };
  }
  if (code === 'oidc_denied' || code === 'browser_canceled') {
    return {
      status: 'browser_canceled',
      title: 'GOOGLE CANCELED',
      message: 'Nothing changed on this device. Continue with Google when you are ready.',
      retryable: false,
    };
  }
  if (code === 'offline' || (error instanceof OidcBindError && error.retryable)) {
    return {
      status: code === 'offline' ? 'offline' : 'bind_retry',
      title: code === 'offline' ? 'OFFLINE' : 'BIND INTERRUPTED',
      message:
        'The device key is ready but could not be bound. Check the connection and retry before the proof expires.',
      retryable: true,
    };
  }
  return {
    status: 'bind_retry',
    title: 'BIND INTERRUPTED',
    message: error instanceof Error ? error.message : 'The device key could not be bound.',
    retryable: true,
  };
}
