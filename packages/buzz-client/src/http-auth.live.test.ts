import { describe, expect, it } from 'vitest';
import { signEvent } from '@beeline/nostr';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import { DEFAULT_BASE_URL, DEFAULT_HOST, isRelayUp, uniqueMarker } from './live-helpers.js';

const authEnforced = process.env.BUZZ_REQUIRE_AUTH_TOKEN === 'true';
const reachable = await isRelayUp();

describe.runIf(authEnforced && reachable)('auth-enforcing relay HTTP bridge', () => {
  it('rejects X-Pubkey alone and accepts signed query and publish requests', async () => {
    const identity = createIdentity('nip98-live');
    const xPubkeyOnly = await fetch(`${DEFAULT_BASE_URL}/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: DEFAULT_HOST,
        'x-pubkey': identity.publicKey,
      },
      body: '[]',
    });

    expect(xPubkeyOnly.status).toBe(401);
    expect(await xPubkeyOnly.json()).toMatchObject({ error: 'missing Nostr auth' });

    const client = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity,
    });
    expect(await client.query([])).toEqual([]);

    const event = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['t', uniqueMarker('nip98-live')]],
        content: 'buzz-client auth-enforcing relay proof',
      },
      identity.secretKey,
    );
    const published = await client.publish(event);
    expect(published.status).toBe(200);
    expect(published.accepted).toBe(true);
  });
});

describe.runIf(!authEnforced || !reachable)('auth-enforcing relay HTTP bridge (skipped)', () => {
  it('requires an explicitly auth-enforcing reachable relay', () => {
    console.log(
      `[live] SKIP NIP-98 bridge proof: authEnforced=${authEnforced} reachable=${reachable} relay=${DEFAULT_BASE_URL}`,
    );
    expect(true).toBe(true);
  });
});
