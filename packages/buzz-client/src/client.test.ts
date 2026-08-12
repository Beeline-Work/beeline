import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import type { NostrEvent } from '@beeline/nostr';

afterEach(() => vi.unstubAllGlobals());

describe('explicit Agent work intent', () => {
  it('signs the addressed Start work marker as one Room event', async () => {
    const identity = createIdentity('start-work-client');
    let published: NostrEvent | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published = JSON.parse(String(init?.body)) as NostrEvent;
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity });

    await client.startAgentWork('room-id', 'Fix the scheduler', 'b'.repeat(64));

    expect(published).toMatchObject({ kind: 9, content: 'Fix the scheduler' });
    expect(published!.tags).toContainEqual(['h', 'room-id']);
    expect(published!.tags).toContainEqual(['p', 'b'.repeat(64)]);
    expect(published!.tags).toContainEqual(['t', 'buzz-agent-request']);
  });
});
