import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import { signEvent, type NostrEvent } from '@beeline/nostr';

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
      'lunchboxfortwo/buzzy',
    );

    expect(published).toMatchObject({
      kind: 9,
      content: 'Allowed editing on lunchboxfortwo/buzzy.',
    });
    expect(published!.tags).toContainEqual(['h', 'room-id']);
    expect(published!.tags).toContainEqual(['p', 'b'.repeat(64)]);
    expect(published!.tags).toContainEqual(['t', 'buzz-write-permission-response']);
    expect(published!.tags).toContainEqual(['permission', 'permission-id']);
    expect(published!.tags).toContainEqual(['request', 'request-id']);
    expect(published!.tags).toContainEqual(['decision', 'allow']);
    expect(published!.tags).toContainEqual(['repo', 'lunchboxfortwo/buzzy']);
  });
});

describe('Agent presence', () => {
  it('queries replaceable Room presence by its d tag without the stream h filter', async () => {
    const reader = createIdentity('presence-reader');
    const agent = createIdentity('presence-agent');
    const roomId = 'presence-room';
    const event = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: 42,
        kind: 30078,
        tags: [
          ['d', `agent-presence:${roomId}`],
          ['h', roomId],
          ['t', 'agent-presence'],
          ['agent', agent.publicKey],
          ['status', 'online'],
        ],
        content: '',
      },
      agent.secretKey,
    );
    let filters: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        filters = JSON.parse(String(init?.body));
        return new Response(JSON.stringify([event]), { status: 200 });
      }),
    );
    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity: reader });

    await expect(client.agentPresenceBackfill(roomId)).resolves.toHaveLength(1);
    expect(filters).toEqual([
      {
        kinds: [30078],
        '#d': [`agent-presence:${roomId}`],
        limit: 20,
      },
    ]);
  });
});
