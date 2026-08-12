import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuzzClient, type BuzzClient } from './client.js';
import { createIdentity } from './identity.js';

const identity = createIdentity('relay-interaction-performance');
const NETWORK_RTT_MS = 30;

function installSerializedRelay() {
  let tail = Promise.resolve();
  const fetchMock = vi.fn(async () => {
    const response = tail.then(
      () => new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response('[]', { status: 200 })), NETWORK_RTT_MS);
      }),
    );
    tail = response.then(() => undefined);
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function loadWorkspaceHome(client: BuzzClient, roomIds: string[]): Promise<void> {
  await Promise.all([
    client.listCommunities(),
    client.isAgentIdentity(identity.publicKey),
  ]);

  await Promise.all(roomIds.map((roomId) => client.getChannelMetadata(roomId)));

  await Promise.all([
    client.communityMembers('workspace'),
    client.listAgents('workspace'),
  ]);

  await Promise.all([
    client.communityMembers('workspace'),
    client.listAgents('workspace'),
    client.listDirectMessages('workspace'),
    ...roomIds.map(async (roomId) => {
      await Promise.all([
        (async () => {
          await client.listSubchannels(roomId);
          await client.query([
            { kinds: [9], '#h': [roomId], '#t': ['merge-summary'], limit: 500 },
          ]);
        })(),
        client.sessionEventsBackfill(roomId, { limit: 30 }),
        client.listMembers(roomId),
      ]);
    }),
  ]);
}

async function loadRoomChat(client: BuzzClient, roomId: string): Promise<void> {
  await Promise.all([
    client.listCommunities(),
    client.getChannelCommunityId(roomId),
    client.getChannelMetadata(roomId),
    client.listMembers(roomId),
    client.getParentChannelId(roomId),
    client.sessionEventsBackfill(roomId, { limit: 50 }),
    client.isAgentIdentity(identity.publicKey),
    client.getDirectMessage(roomId),
  ]);
  await Promise.all([
    client.listAgents('workspace'),
    client.communityMembers('workspace'),
    client.getChannelMetadata(roomId),
  ]);
}

async function loadAgents(client: BuzzClient): Promise<void> {
  await Promise.all([
    client.listCommunities(),
    client.isAgentIdentity(identity.publicKey),
  ]);
  await Promise.all([
    client.listAgents('workspace'),
    client.getPersonProfile('workspace', identity.publicKey),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay interaction latency probe', () => {
  it('records the SDK round trips on the main mobile screen paths', async () => {
    const scenarios = [
      [
        'workspace-home-4-rooms-including-dm-discovery',
        (client: BuzzClient) =>
          loadWorkspaceHome(client, ['room-1', 'room-2', 'room-3', 'room-4']),
      ],
      ['room-or-dm-chat', (client: BuzzClient) => loadRoomChat(client, 'room-1')],
      ['agents', loadAgents],
    ] as const;

    const measurements: Record<string, { requests: number; elapsedMs: number }> = {};
    for (const [name, load] of scenarios) {
      const fetchMock = installSerializedRelay();
      const client = createBuzzClient({
        baseUrl: `https://${name}.relay.test`,
        identity,
        batchQueries: true,
      });
      const startedAt = Date.now();
      await load(client);
      measurements[name] = {
        requests: fetchMock.mock.calls.length,
        elapsedMs: Date.now() - startedAt,
      };
      vi.unstubAllGlobals();
    }

    console.info('relay-interaction-measurements', measurements);
    expect(measurements).toMatchObject({
      'workspace-home-4-rooms-including-dm-discovery': { requests: 8 },
      'room-or-dm-chat': { requests: 5 },
      agents: { requests: 3 },
    });
  }, 20_000);
});
