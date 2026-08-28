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
  it('prefers the durable human-authored soul after its author leaves, then caches it', async () => {
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
        content: JSON.stringify({ name: 'Ada', soul: 'direct', avatarSeed: 'ada' }),
      },
      human.secretKey,
    );
    const memberProjection = unsignedEvent(39002, [
      ['d', COMMUNITY_ID],
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
      isDirectMessage: false,
      persistentWorkspaceRoom: true,
      workspaceName: 'Product Engineering',
      fixtureCandidates: ['Launch room', 'owner/repository', 'Product Engineering'],
      fixtureMarkers: [],
      senderName: 'Ada',
    });
    await expect(resolver.resolve(message, reader)).resolves.toEqual({
      roomName: 'Launch room',
      isDirectMessage: false,
      persistentWorkspaceRoom: true,
      workspaceName: 'Product Engineering',
      fixtureCandidates: ['Launch room', 'owner/repository', 'Product Engineering'],
      fixtureMarkers: [],
      senderName: 'Ada',
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('uses the per-pubkey seed name when an agent has no soul', async () => {
    const agent = createIdentity('unsouled agent');
    const roomCreate = unsignedEvent(9007, [
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
          ['name', 'beeline-agent'],
          ['community', COMMUNITY_ID],
        ],
        content: JSON.stringify({ displayName: 'beeline-agent' }),
      },
      agent.secretKey,
    );
    const reader: RelayEventReader = {
      query: async (filters) =>
        filters.some((filter) => (filter.kinds as number[]).includes(39000))
          ? [roomCreate]
          : [agentRecord],
      disconnect: () => undefined,
    };
    const message = unsignedEvent(9, [['h', COMMUNITY_ID]]);
    message.pubkey = agent.publicKey;

    const resolved = await new NotificationMetadataResolver().resolve(message, reader);
    expect(resolved.senderName).toMatch(/^[A-Z][a-z]+$/);
    expect(resolved.senderName).not.toBe('beeline-agent');
  });

  it('uses a verified NIP-01 handle with a display-name fallback and never exposes an id', async () => {
    const person = createIdentity('person');
    const profile = signEvent(
      {
        pubkey: person.publicKey,
        created_at: 12,
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: 'grace-h', display_name: 'Grace Hopper' }),
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
      isDirectMessage: false,
      persistentWorkspaceRoom: false,
      fixtureCandidates: [],
      fixtureMarkers: [],
      senderName: 'Grace Hopper',
      senderHandle: 'grace-h',
    });
  });

  it('classifies a DM from the existing immutable Room marker', async () => {
    const roomCreate = unsignedEvent(9007, [
      ['h', ROOM_ID],
      ['name', 'Direct message'],
      ['community', COMMUNITY_ID],
      ['t', 'buzz-dm'],
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
    ).resolves.toMatchObject({ roomName: 'Direct message', isDirectMessage: true });
  });

  it('carries a corner immutable parent into notification routing context', async () => {
    const cornerCreate = unsignedEvent(9007, [
      ['h', ROOM_ID],
      ['name', 'Push work'],
      ['parent', 'parent-room'],
      ['community', COMMUNITY_ID],
    ]);
    const workspaceCreate = unsignedEvent(9007, [
      ['h', COMMUNITY_ID],
      ['name', 'Product Engineering'],
      ['community', COMMUNITY_ID],
    ]);
    const reader: RelayEventReader = {
      query: async (filters) => {
        if (!filters.some((filter) => (filter.kinds as number[]).includes(39000))) return [];
        return JSON.stringify(filters).includes(COMMUNITY_ID) ? [workspaceCreate] : [cornerCreate];
      },
      disconnect: () => undefined,
    };

    await expect(
      new NotificationMetadataResolver().resolve(unsignedEvent(9, [['h', ROOM_ID]]), reader),
    ).resolves.toMatchObject({
      isChildChannel: true,
      parentChannelId: 'parent-room',
      persistentWorkspaceRoom: true,
    });
  });

  describe('channel-naming convention presentation names', () => {
    function metadataReader(
      rooms: Record<string, NostrEvent[]>,
    ): { reader: RelayEventReader; query: ReturnType<typeof vi.fn> } {
      const query = vi.fn(async (filters: Record<string, unknown>[]) => {
        if (
          !filters.some((filter) =>
            (filter.kinds as number[]).some((kind) => [39000, 9007].includes(kind)),
          )
        ) {
          return [];
        }
        const json = JSON.stringify(filters);
        for (const [channelId, events] of Object.entries(rooms)) {
          if (json.includes(channelId)) return events;
        }
        return [];
      });
      return { reader: { query, disconnect: () => undefined }, query };
    }

    it('resolves a corner notification\u2019s own name and its PARENT Room\u2019s current display name', async () => {
      const cornerCreate = unsignedEvent(9007, [
        ['h', 'corner-1'],
        ['name', 'fix-login-loop'],
        ['parent', ROOM_ID],
        ['community', COMMUNITY_ID],
      ]);
      const parentCreate = unsignedEvent(9007, [
        ['h', ROOM_ID],
        ['name', 'Old Name'],
        ['community', COMMUNITY_ID],
      ]);
      // The mutable projection is the Room's CURRENT display name.
      const parentMetadata = unsignedEvent(39000, [
        ['d', ROOM_ID],
        ['name', 'Launch room'],
      ]);
      const workspaceCreate = unsignedEvent(9007, [
        ['h', COMMUNITY_ID],
        ['name', 'Product Engineering'],
        ['community', COMMUNITY_ID],
      ]);
      const { reader, query } = metadataReader({
        'corner-1': [cornerCreate],
        [ROOM_ID]: [parentCreate, parentMetadata],
        [COMMUNITY_ID]: [workspaceCreate],
      });
      const resolver = new NotificationMetadataResolver();

      await expect(resolver.resolve(unsignedEvent(9, [['h', 'corner-1']]), reader)).resolves.toMatchObject(
        {
          roomName: 'fix-login-loop',
          isChildChannel: true,
          parentChannelId: ROOM_ID,
          cornerName: 'fix-login-loop',
          parentRoomName: 'Launch room',
        },
      );
      // The parent lookup rides the same per-Room cache: a second resolve
      // issues no further metadata queries.
      await expect(resolver.resolve(unsignedEvent(9, [['h', 'corner-1']]), reader)).resolves.toMatchObject(
        { cornerName: 'fix-login-loop', parentRoomName: 'Launch room' },
      );
      // Corner room + its workspace, sender, parent room + its workspace.
      expect(query).toHaveBeenCalledTimes(5);
    });

    it('resolves the subchannel attention target announced inside its parent Room', async () => {
      const waitingCreate = unsignedEvent(9007, [
        ['h', 'corner-waiting'],
        ['name', 'waiting-corner'],
        ['parent', ROOM_ID],
        ['community', COMMUNITY_ID],
      ]);
      const parentCreate = unsignedEvent(9007, [
        ['h', ROOM_ID],
        ['name', 'Roadmap'],
        ['community', COMMUNITY_ID],
      ]);
      const workspaceCreate = unsignedEvent(9007, [
        ['h', COMMUNITY_ID],
        ['name', 'Product Engineering'],
        ['community', COMMUNITY_ID],
      ]);
      const { reader } = metadataReader({
        'corner-waiting': [waitingCreate],
        [ROOM_ID]: [parentCreate],
        [COMMUNITY_ID]: [workspaceCreate],
      });

      await expect(
        new NotificationMetadataResolver().resolve(
          unsignedEvent(9, [
            ['h', ROOM_ID],
            ['display-status', 'needs-attention'],
            ['subchannel', 'corner-waiting'],
          ]),
          reader,
        ),
      ).resolves.toMatchObject({
        roomName: 'Roadmap',
        cornerName: 'waiting-corner',
        parentRoomName: 'Roadmap',
      });
    });

    it('leaves the parent name unset when the parent Room metadata is absent or deleted', async () => {
      const cornerCreate = unsignedEvent(9007, [
        ['h', 'corner-1'],
        ['name', 'fix-login-loop'],
        ['parent', ROOM_ID],
        ['community', COMMUNITY_ID],
      ]);
      const workspaceCreate = unsignedEvent(9007, [
        ['h', COMMUNITY_ID],
        ['name', 'Product Engineering'],
        ['community', COMMUNITY_ID],
      ]);
      const { reader } = metadataReader({
        'corner-1': [cornerCreate],
        [COMMUNITY_ID]: [workspaceCreate],
      });

      const context = await new NotificationMetadataResolver().resolve(
        unsignedEvent(9, [['h', 'corner-1']]),
        reader,
      );
      expect(context.cornerName).toBe('fix-login-loop');
      expect(context.parentRoomName).toBeUndefined();
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

  it('classifies a self-referencing Workspace group create as a persistent Workspace room', async () => {
    // Live production shape (2026-08-23): "Tubing Crew" / "Personal" are NIP-29
    // Workspace groups whose kind:9007 create carries `community` equal to its
    // own channel id. The old classification returned persistent=false, which
    // suppressed messages posted directly to those top-level Workspace rooms.
    const selfCreate = unsignedEvent(9007, [
      ['h', COMMUNITY_ID],
      ['name', 'Tubing Crew'],
      ['community', COMMUNITY_ID],
    ]);
    const selfMetadata = unsignedEvent(39000, [
      ['d', COMMUNITY_ID],
      ['name', 'Tubing Crew'],
      ['community', COMMUNITY_ID],
    ]);
    const query = vi.fn(async () => [selfMetadata, selfCreate]);

    await expect(
      new NotificationMetadataResolver().resolve(unsignedEvent(9, [['h', COMMUNITY_ID]]), {
        query,
        disconnect: () => undefined,
      }),
    ).resolves.toMatchObject({
      roomName: 'Tubing Crew',
      workspaceName: 'Tubing Crew',
      persistentWorkspaceRoom: true,
    });
    // Two loads only — Room + sender. The Workspace IS the Room here, so the
    // third Workspace round-trip the linked-Room path needs never happens.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps a nameless self-referencing group non-persistent', async () => {
    const selfCreate = unsignedEvent(9007, [
      ['h', COMMUNITY_ID],
      ['community', COMMUNITY_ID],
    ]);
    const reader: RelayEventReader = {
      query: async () => [selfCreate],
      disconnect: () => undefined,
    };

    await expect(
      new NotificationMetadataResolver().resolve(unsignedEvent(9, [['h', COMMUNITY_ID]]), reader),
    ).resolves.toMatchObject({ persistentWorkspaceRoom: false });
  });

  it('does not reuse room metadata across database community scopes', async () => {
    const resolver = new NotificationMetadataResolver();
    const scopedReader = (scopeKey: string, roomName: string): RelayEventReader => ({
      scopeKey,
      query: async (filters) =>
        filters.some((filter) => (filter.kinds as number[]).includes(39000))
          ? [
              unsignedEvent(9007, [
                ['h', ROOM_ID],
                ['name', roomName],
                ['community', ROOM_ID],
              ]),
            ]
          : [],
      disconnect: () => undefined,
    });
    const message = unsignedEvent(9, [['h', ROOM_ID]]);

    await expect(
      resolver.resolve(message, scopedReader('tenant-a', 'Alpha')),
    ).resolves.toMatchObject({ roomName: 'Alpha' });
    await expect(
      resolver.resolve(message, scopedReader('tenant-b', 'Beta')),
    ).resolves.toMatchObject({ roomName: 'Beta' });
  });
});
