import { describe, expect, it } from 'vitest';
import { RelayPublishError } from '@beeline/buzz-client';
import { publishFailurePresentation } from './publish-failure';

describe('publish failure dialog copy', () => {
  it('renders safe typed recovery copy and exposes retry posture', () => {
    expect(
      publishFailurePresentation(
        new RelayPublishError({
          kind: 'RATE_LIMITED',
          sentence: 'The relay is receiving too many messages right now.',
          recoveryAction: 'Wait a moment, then try again.',
          retryable: true,
        }),
      ),
    ).toEqual({
      message:
        'The relay is receiving too many messages right now.\n\nWait a moment, then try again.',
      retryable: true,
    });
  });

  it('never renders a legacy raw relay body', () => {
    const presentation = publishFailurePresentation(
      new Error(
        'publishEvent kind=9 failed: HTTP 400 {"error":"invalid: root tag does not match thread ancestry"}',
      ),
    );
    expect(presentation.message).toBe(
      'This reply no longer matches its conversation thread.\n\nRefresh the Room and choose Reply again.',
    );
    expect(presentation.message).not.toContain('{"error"');
  });
});
