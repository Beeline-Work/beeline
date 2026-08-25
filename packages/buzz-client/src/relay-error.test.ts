import { describe, expect, it } from 'vitest';
import {
  asRelayPublishError,
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
    [408, 'TIMEOUT'],
    [429, 'RATE_LIMITED'],
    [500, 'TRANSIENT'],
    [503, 'TRANSIENT'],
  ] as const)('classifies HTTP %i as retryable %s', (status, kind) => {
    expect(relayPublishErrorFromResponse(status, 'upstream details')).toMatchObject({
      kind,
      retryable: true,
      status,
    });
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
