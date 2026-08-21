import { describe, expect, it } from 'vitest';
import { OidcBindError } from '@beeline/buzz-client';
import {
  nextOnboardingStatus,
  noticeForAuthError,
  waitForAuthCallback,
} from './onboarding-state';

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
    const notice = noticeForAuthError(error);
    expect(notice).toMatchObject({ status, retryable });
    expect(notice.title).toContain(code.toUpperCase());
  });

  it.each(['invalid_redirect', 'invalid_configuration', 'invalid_state'])(
    'reports %s as a non-network configuration failure',
    (code) => {
      const notice = noticeForAuthError(new OidcBindError(code, code));
      expect(notice).toMatchObject({
        status: 'bind_retry',
        retryable: false,
      });
      expect(notice.title).toBe(`SIGN-IN CONFIG ERROR · ${code.toUpperCase()}`);
      expect(notice.message).toContain('callback configuration');
      expect(notice.message).not.toContain('connection');
    },
  );

  it('names both real ways out of a device-key conflict', () => {
    const notice = noticeForAuthError(
      new OidcBindError('identity_conflict', 'identity is already bound to another public key', 409),
    );
    expect(notice.title).toBe('DEVICE KEY ALREADY LINKED · IDENTITY_CONFLICT');
    expect(notice.message).toContain('Replace it');
    expect(notice.message).toContain('import your backed-up key');
    expect(notice.message).not.toContain('Recovery is required');
  });

  it('keeps unknown client failures distinct from retryable network failures', () => {
    const notice = noticeForAuthError(new OidcBindError('invalid_callback', 'Bad callback'));
    expect(notice).toEqual({
      status: 'bind_retry',
      title: 'BIND FAILED · INVALID_CALLBACK',
      message: 'Bad callback',
      retryable: false,
    });
  });
});

describe('provider onboarding completion', () => {
  it('returns a matching custom-scheme callback directly from the browser result', async () => {
    const redirectUri = 'beeline://buzz/github-callback';
    const callbackUrl = `${redirectUri}?state=${'s'.repeat(43)}`;

    await expect(
      waitForAuthCallback({
        redirectUri,
        openAuthSession: async () => ({ type: 'success', url: callbackUrl }),
        subscribeToUrls: () => ({ remove: () => undefined }),
      }),
    ).resolves.toBe(callbackUrl);
  });

  it('keeps a successful HTTPS callback when Android reports the browser dismissed first', async () => {
    const redirectUri = 'beeline://buzz/github-callback';
    const callbackUrl = `${redirectUri}?state=${'s'.repeat(43)}&ticket=${'t'.repeat(43)}`;
    let onUrl: ((url: string) => void) | null = null;

    const completion = waitForAuthCallback({
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
    const binding = nextOnboardingStatus('opening_browser', 'callback_received');
    expect(binding).toBe('binding');
    expect(nextOnboardingStatus(binding, 'bind_succeeded')).toBe('entering_workspace');
  });

  it('still treats a real browser close with no callback as cancellation', async () => {
    await expect(
      waitForAuthCallback({
        redirectUri: 'beeline://buzz/github-callback',
        openAuthSession: async () => ({ type: 'dismiss' }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        callbackGraceMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'browser_canceled' });
  });
});
