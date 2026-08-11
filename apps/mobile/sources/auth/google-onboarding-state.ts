import { OidcBindError } from '@beeline/buzz-client';

export type GoogleOnboardingStatus =
  | 'idle'
  | 'checking_device'
  | 'existing_device'
  | 'opening_browser'
  | 'binding'
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
