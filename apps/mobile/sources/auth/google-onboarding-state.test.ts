import { describe, expect, it } from 'vitest';
import { OidcBindError } from '@beeline/buzz-client';
import { noticeForOidcError } from './google-onboarding-state';

describe('Google onboarding error states', () => {
  it.each([
    ['browser_canceled', 'browser_canceled', false],
    ['oidc_denied', 'browser_canceled', false],
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
