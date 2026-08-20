import { describe, expect, it } from 'vitest';
import { OidcBindError } from '@beeline/buzz-client';
import {
  nextGoogleOnboardingStatus,
  noticeForOidcError,
  waitForGoogleAuthCallback,
} from './google-onboarding-state';

describe('provider onboarding error states', () => {
  it.each([
    ['browser_canceled', 'browser_canceled', false],
    ['oidc_denied', 'browser_canceled', false],
    ['github_denied', 'browser_canceled', false],
    ['ticket_expired', 'token_expired', false],
    ['invalid_oidc_flow', 'token_expired', false],
    ['identity_conflict', 'link_conflict', false],
    ['offline', 'offline', true],
    ['internal_error', 'bind_retry', true],
  ])('maps %s to explicit %s state', (code, status, retryable) => {
    const error = new OidcBindError(code, code, code === 'internal_error' ? 500 : undefined);
    expect(noticeForOidcError(error)).toMatchObject({ status, retryable });
  });
});

describe('provider onboarding completion', () => {
  it('keeps a successful HTTPS callback when Android reports the browser dismissed first', async () => {
    const redirectUri = 'https://relay.buzzrouter.com/auth/oidc/mobile-callback';
    const callbackUrl = `${redirectUri}?state=${'s'.repeat(43)}&ticket=${'t'.repeat(43)}`;
    let onUrl: ((url: string) => void) | null = null;

    const completion = waitForGoogleAuthCallback({
      redirectUri,
      openAuthSession: async () => {
        queueMicrotask(() => onUrl?.(callbackUrl));
        return { type: 'dismiss' };
      },
      subscribeToUrls: (listener) => {
        onUrl = listener;
        return { remove: () => (onUrl = null) };
      },
      callbackGraceMs: 50,
    });

    await expect(completion).resolves.toBe(callbackUrl);
    const binding = nextGoogleOnboardingStatus('opening_browser', 'callback_received');
    expect(binding).toBe('binding');
    expect(nextGoogleOnboardingStatus(binding, 'bind_succeeded')).toBe('entering_workspace');
  });

  it('still treats a real browser close with no callback as cancellation', async () => {
    await expect(
      waitForGoogleAuthCallback({
        redirectUri: 'https://relay.buzzrouter.com/auth/oidc/mobile-callback',
        openAuthSession: async () => ({ type: 'dismiss' }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        callbackGraceMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'browser_canceled' });
  });
});
