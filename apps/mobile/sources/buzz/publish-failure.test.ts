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

  it('keeps classified recovery copy while exposing the underlying error', () => {
    const presentation = publishFailurePresentation(
      new Error(
        'publishEvent kind=9 failed: HTTP 400 {"error":"invalid: root tag does not match thread ancestry"}',
      ),
    );
    expect(presentation.message).toBe(
      'This reply no longer matches its conversation thread.\n\nRefresh the Room and choose Reply again.\n\nTechnical detail: publishEvent kind=9 failed: HTTP 400 {"error":"invalid: root tag does not match thread ancestry"}',
    );
  });

  it('shows an unknown error and its cause without repeating generic copy', () => {
    const presentation = publishFailurePresentation(
      new Error('outbox write failed', { cause: new Error('storage is unavailable') }),
    );
    expect(presentation.message).toBe(
      'The message could not be sent.\n\nTry again after refreshing the Room.\n\nTechnical detail: outbox write failed\nCaused by: storage is unavailable',
    );
  });
});
