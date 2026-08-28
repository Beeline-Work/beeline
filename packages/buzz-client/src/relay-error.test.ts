import { describe, expect, it } from 'vitest';
import {
  asRelayPublishError,
  RELAY_RETRY_AFTER_MAX_MS,
  relayPublishErrorFromResponse,
  RelayPublishError,
} from './relay-error.js';

describe('relay publish errors', () => {
  it('turns the observed thread ancestry refusal into safe recovery copy', () => {
    const error = relayPublishErrorFromResponse(
      400,
      JSON.stringify({ error: 'invalid: root tag does not match thread ancestry' }),
      9,
    );
    expect(error).toBeInstanceOf(RelayPublishError);
    expect(error).toMatchObject({
      kind: 'THREAD_ANCESTRY_MISMATCH',
      sentence: 'This reply no longer matches its conversation thread.',
      recoveryAction: 'Refresh the Room and choose Reply again.',
      retryable: false,
      status: 400,
      eventKind: 9,
    });
    expect(error.message).not.toContain('invalid:');
  });

  it.each([
    [400, 'INVALID_EVENT', false],
    [408, 'TIMEOUT', true],
    [429, 'RATE_LIMITED', true],
    [500, 'TRANSIENT', true],
    [503, 'TRANSIENT', true],
  ] as const)('classifies HTTP %i as %s with retryable=%s', (status, kind, retryable) => {
    expect(relayPublishErrorFromResponse(status, 'upstream details')).toMatchObject({
      kind,
      retryable,
      status,
    });
  });

  it('carries a bounded advertised delay without exposing relay text', () => {
    const error = relayPublishErrorFromResponse(
      429,
      JSON.stringify({ error: 'private quota detail; retry in 4s' }),
      9,
    );
    expect(error.retryAfterMs).toBe(4_000);
    expect(error.message).not.toContain('private quota detail');

    expect(
      relayPublishErrorFromResponse(429, 'retry in 999999s').retryAfterMs,
    ).toBe(RELAY_RETRY_AFTER_MAX_MS);
  });

  it('keeps legacy raw relay JSON behind the typed compatibility boundary', () => {
    const typed = asRelayPublishError(
      new Error(
        'publishEvent kind=9 failed: HTTP 400 {"error":"invalid: root tag does not match thread ancestry"}',
      ),
    );
    expect(typed.kind).toBe('THREAD_ANCESTRY_MISMATCH');
    expect(typed.message).not.toContain('{"error"');
  });
});
