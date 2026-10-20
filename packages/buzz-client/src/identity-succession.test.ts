import { generateKeypair } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIdentityPredecessors } from './identity-succession.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('identity succession auth routes', () => {
  it('times out a predecessor fetch even when the native fetch never settles', async () => {
    vi.useFakeTimers();
    const identity = generateKeypair();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    const fetching = fetchIdentityPredecessors('https://relay.example', identity);
    const result = expect(fetching).rejects.toMatchObject({
      code: 'offline',
      message: 'identity succession lookup timed out',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
  });
});
