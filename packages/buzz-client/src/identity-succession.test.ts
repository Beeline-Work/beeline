import { generateKeypair } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIdentityPredecessors, resolveCurrentIdentityPubkey } from './identity-succession.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('identity succession auth routes', () => {
  it('resolves the same predecessor deterministically for repeated session activations', async () => {
    const agent = generateKeypair();
    const predecessor = generateKeypair();
    const successor = generateKeypair();
    const authorizationHeaders: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          `https://relay.example/auth/oidc/current/${predecessor.publicKey}`,
        );
        authorizationHeaders.push(String(new Headers(init?.headers).get('authorization')));
        return new Response(JSON.stringify({ current_pubkey: successor.publicKey }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await expect(
      resolveCurrentIdentityPubkey('https://relay.example', agent, predecessor.publicKey),
    ).resolves.toBe(successor.publicKey);
    await expect(
      resolveCurrentIdentityPubkey('https://relay.example', agent, predecessor.publicKey),
    ).resolves.toBe(successor.publicKey);
    expect(authorizationHeaders).toHaveLength(2);
    expect(authorizationHeaders[0]).not.toBe(authorizationHeaders[1]);
  });

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
