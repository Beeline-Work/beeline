import { createIdentity } from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { describe, expect, it, vi } from 'vitest';
import { NotificationMetadataResolver, type RelayEventReader } from './metadata.js';

const COMMUNITY_ID = 'community-1';
const ROOM_ID = 'room-1';

function unsignedEvent(kind: number, tags: string[][]): NostrEvent {
  return {
    id: `${kind}`.padEnd(64, '0'),
    pubkey: 'f'.repeat(64),
    created_at: kind,
    kind,
    tags,
    content: '',
    sig: 'e'.repeat(128),
  };
}

describe('NotificationMetadataResolver', () => {
  it('resolves the latest room metadata and single-word agent soul, then caches both', async () => {
    const agent = createIdentity('legacy name');
    const human = createIdentity('human');
    const roomMetadata = unsignedEvent(39000, [
      ['d', ROOM_ID],
      ['name', 'Launch room'],
      ['community', COMMUNITY_ID],
    ]);
    const roomCreate = unsignedEvent(9007, [
      ['h', ROOM_ID],
      ['name', 'Launch room'],
      ['community', COMMUNITY_ID],
      ['repo-key', 'owner/repository'],
    ]);
    const workspaceCreate = unsignedEvent(9007, [
      ['h', COMMUNITY_ID],
      ['name', 'Product Engineering'],
      ['community', COMMUNITY_ID],
    ]);
    const agentRecord = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: 10,
        kind: 9,
        tags: [
          ['h', COMMUNITY_ID],
          ['t', 'buzz-agent'],
          ['d', 'agent-1'],
          ['p', agent.publicKey],
          ['name', 'Legacy Name'],
          ['community', COMMUNITY_ID],
        ],
        content: JSON.stringify({ displayName: 'Legacy Name' }),
      },
      agent.secretKey,
    );
    const soul = signEvent(
      {
        pubkey: human.publicKey,
        created_at: 11,
        kind: 30078,
        tags: [
          ['d', `${COMMUNITY_ID}:${agent.publicKey}`],
          ['h', COMMUNITY_ID],
          ['p', agent.publicKey],
          ['t', 'buzz-agent-soul'],
          ['community', COMMUNITY_ID],
        ],
        content: JSON.stringify({ name: 'Ada', personality: 'direct', avatarSeed: 'ada' }),
      },
      human.secretKey,
    );
    const memberProjection = unsignedEvent(39002, [
      ['d', COMMUNITY_ID],
      ['p', human.publicKey],
      ['p', agent.publicKey],
    ]);
    const query = vi.fn(async (filters: Record<string, unknown>[]) => {
      if (!filters.some((filter) => (filter.kinds as number[]).includes(39000))) {
        return [agentRecord, soul, memberProjection];
      }
      return JSON.stringify(filters).includes(COMMUNITY_ID)
        ? [workspaceCreate]
        : [roomMetadata, roomCreate];
    });
    const reader: RelayEventReader = { query, disconnect: () => undefined };
    const resolver = new NotificationMetadataResolver();
    const message = unsignedEvent(9, [['h', ROOM_ID]]);
    message.pubkey = agent.publicKey;

    await expect(resolver.resolve(message, reader)).resolves.toEqual({
      roomName: 'Launch room',
      persistentWorkspaceRoom: true,
      workspaceName: 'Product Engineering',
      fixtureCandidates: ['Launch room', 'owner/repository', 'Product Engineering'],
      fixtureMarkers: [],
      senderName: 'Ada',
    });
    await expect(resolver.resolve(message, reader)).resolves.toEqual({
      roomName: 'Launch room',
      persistentWorkspaceRoom: true,
      workspaceName: 'Product Engineering',
      fixtureCandidates: ['Launch room', 'owner/repository', 'Product Engineering'],
      fixtureMarkers: [],
      senderName: 'Ada',
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('uses a verified NIP-01 person name and never exposes an id when room metadata is absent', async () => {
    const person = createIdentity('person');
    const profile = signEvent(
      {
        pubkey: person.publicKey,
        created_at: 12,
        kind: 0,
        tags: [],
        content: JSON.stringify({ display_name: 'Grace Hopper' }),
      },
      person.secretKey,
    );
    const query = vi.fn(async (filters: Record<string, unknown>[]) =>
      filters.some((filter) => (filter.kinds as number[]).includes(39000)) ? [] : [profile],
    );
    const reader: RelayEventReader = { query, disconnect: () => undefined };
    const message = unsignedEvent(9, [['h', 'a'.repeat(64)]]);
    message.pubkey = person.publicKey;

    await expect(new NotificationMetadataResolver().resolve(message, reader)).resolves.toEqual({
      roomName: 'Room',
      persistentWorkspaceRoom: false,
      fixtureCandidates: [],
      fixtureMarkers: [],
      senderName: 'Grace Hopper',
    });
  });

  it('projects Room fixture tags into the final pre-FCM context', async () => {
    const roomCreate = unsignedEvent(9007, [
      ['h', ROOM_ID],
      ['name', 'Roadmap'],
      ['community', COMMUNITY_ID],
      ['t', 'ui-test'],
    ]);
    const workspaceCreate = unsignedEvent(9007, [
      ['h', COMMUNITY_ID],
      ['name', 'Product Engineering'],
      ['community', COMMUNITY_ID],
    ]);
    const reader: RelayEventReader = {
      query: async (filters) => {
        if (!filters.some((filter) => (filter.kinds as number[]).includes(39000))) return [];
        return JSON.stringify(filters).includes(COMMUNITY_ID) ? [workspaceCreate] : [roomCreate];
      },
      disconnect: () => undefined,
    };

    await expect(
      new NotificationMetadataResolver().resolve(unsignedEvent(9, [['h', ROOM_ID]]), reader),
    ).resolves.toMatchObject({
      persistentWorkspaceRoom: true,
      fixtureMarkers: ['ui-test'],
    });
  });

  it('does not let mutable metadata invent a persistent Workspace binding', async () => {
    const metadata = unsignedEvent(39000, [
      ['d', ROOM_ID],
      ['name', 'Roadmap'],
      ['community', COMMUNITY_ID],
    ]);
    const query = vi.fn(async (filters: Record<string, unknown>[]) =>
      filters.some((filter) => (filter.kinds as number[]).includes(39000)) ? [metadata] : [],
    );

    await expect(
      new NotificationMetadataResolver().resolve(unsignedEvent(9, [['h', ROOM_ID]]), {
        query,
        disconnect: () => undefined,
      }),
    ).resolves.toMatchObject({ persistentWorkspaceRoom: false });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
