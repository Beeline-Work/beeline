/**
 * Delivery discipline for lifecycle-critical publications
 * (`publish-delivery.ts`).
 *
 * The 2026-08-23 incident: a merge-ready card was published once, straight
 * into a 502 window (the deploy bouncing relay-front), and never retried —
 * the corner read NOTHING READY TO MERGE YET forever. These tests pin the
 * classifier (what is worth retrying) and the loop's contract (retry
 * transient failures with bounded backoff; give up honestly otherwise).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  isTransientRelayPublishError,
  publishCritical,
} from './publish-delivery.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('isTransientRelayPublishError', () => {
  it('treats HTTP 5xx as transient', () => {
    expect(
      isTransientRelayPublishError(new Error('publishEvent kind=9 failed: HTTP 502 <html>')),
    ).toBe(true);
    expect(
      isTransientRelayPublishError(new Error('publishEvent kind=9 failed: HTTP 503')),
    ).toBe(true);
  });

  it('treats 408 and 429 as transient, other 4xx as permanent', () => {
    expect(isTransientRelayPublishError(new Error('publishEvent kind=9 failed: HTTP 429'))).toBe(true);
    expect(isTransientRelayPublishError(new Error('publishEvent kind=9 failed: HTTP 408'))).toBe(true);
    expect(isTransientRelayPublishError(new Error('publishEvent kind=9 failed: HTTP 400 {"error":"invalid"}'))).toBe(false);
  });

  it('treats exhausted transport retries as transient and relay negative-acks as permanent', () => {
    expect(
      isTransientRelayPublishError(
        new Error('publishEvent kind=9 failed after 4 attempts: This operation was aborted'),
      ),
    ).toBe(true);
    expect(
      isTransientRelayPublishError(
        new Error('publishEvent kind=9 was not accepted: {"accepted":false}'),
      ),
    ).toBe(false);
  });

  it('never classifies non-publish failures as transient relay errors', () => {
    expect(isTransientRelayPublishError(new Error('HTTP 502 from somewhere else'))).toBe(false);
    expect(isTransientRelayPublishError(new Error('git diff failed for src/x.ts'))).toBe(false);
  });
});

describe('publishCritical', () => {
  it('retries transient failures until the publish succeeds', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const run = publishCritical(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('publishEvent kind=9 failed: HTTP 502');
      },
      { label: 'test' },
    );
    await vi.runAllTimersAsync();
    await expect(run).resolves.toBe(true);
    expect(attempts).toBe(3);
  });

  it('fails fast on a permanent refusal instead of burning the budget', async () => {
    let attempts = 0;
    const gaveUp: unknown[] = [];
    const result = await publishCritical(
      async () => {
        attempts++;
        throw new Error('publishEvent kind=9 failed: HTTP 400 {"error":"invalid: channel is archived"}');
      },
      { label: 'test', onGiveUp: (error) => gaveUp.push(error) },
    );
    expect(result).toBe(false);
    expect(attempts).toBe(1);
    expect(gaveUp.length).toBe(1);
  });

  it('returns false after the bounded attempt budget is spent', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const run = publishCritical(
      async () => {
        attempts++;
        throw new Error('publishEvent kind=9 failed: HTTP 502');
      },
      { label: 'test', maxAttempts: 3 },
    );
    await vi.runAllTimersAsync();
    await expect(run).resolves.toBe(false);
    expect(attempts).toBe(3);
  });

  it('reports each retry through onRetry', async () => {
    vi.useFakeTimers();
    const retries: number[] = [];
    let attempts = 0;
    const run = publishCritical(
      async () => {
        attempts++;
        if (attempts < 2)
          throw new Error('publishEvent kind=9 failed after 4 attempts: network down');
      },
      { label: 'test', onRetry: (attempt) => retries.push(attempt) },
    );
    await vi.runAllTimersAsync();
    await expect(run).resolves.toBe(true);
    expect(retries).toEqual([1]);
  });
});
