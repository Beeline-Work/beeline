import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import type { NostrEvent } from '@beeline/nostr';

afterEach(() => vi.unstubAllGlobals());

describe('Agent write permission', () => {
  it('signs a response bound to the permission, request, and agent', async () => {
    const identity = createIdentity('write-permission-client');
    let published: NostrEvent | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published = JSON.parse(String(init?.body)) as NostrEvent;
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity });

    await client.respondToWritePermission(
      'room-id',
      'permission-id',
      'request-id',
      'b'.repeat(64),
      'allow',
    );

    expect(published).toMatchObject({ kind: 9, content: 'Allowed editing.' });
    expect(published!.tags).toContainEqual(['h', 'room-id']);
    expect(published!.tags).toContainEqual(['p', 'b'.repeat(64)]);
    expect(published!.tags).toContainEqual(['t', 'buzz-write-permission-response']);
    expect(published!.tags).toContainEqual(['permission', 'permission-id']);
    expect(published!.tags).toContainEqual(['request', 'request-id']);
    expect(published!.tags).toContainEqual(['decision', 'allow']);
  });
});
