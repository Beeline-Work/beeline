import { createIdentity } from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import type { Messaging } from 'firebase-admin/messaging';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryState } from './delivery-state.js';
import { PushGateway, RegisteredEventPoller } from './gateway.js';
import { NotificationMetadataResolver, type RelayEventReader } from './metadata.js';
import { TokenRegistry } from './registry.js';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const AUTHOR = 'c'.repeat(64);
const TOKEN_A = 'fcm-token-A_12345678901234567890';
const TOKEN_B = 'fcm-token-B_12345678901234567890';
const reader: RelayEventReader = { query: async () => [], disconnect: () => undefined };

function event(id: string, pubkey = AUTHOR, roomId = 'room-1234'): NostrEvent {
  return {
    id: id.repeat(64),
    pubkey,
    created_at: 100,
    kind: 9,
    tags: [['h', roomId]],
    content: 'private message',
    sig: 'd'.repeat(128),
  };
}

describe('RegisteredEventPoller', () => {
  it('sends exactly once across duplicate polls, restart, and subscription replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buzzy-push-restart-'));
    const stateFile = join(directory, 'deliveries.json');
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    const replayedEvent = event('e');
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'capture-only' }],
    }));
    const metadata = {
      resolve: async () => ({
        roomName: 'Roadmap',
        senderName: 'Ada',
        workspaceName: 'Product Engineering',
        persistentWorkspaceRoom: true,
      }),
      invalidate: () => undefined,
    } as never;

    const run = async (state: DeliveryState, polls: number): Promise<void> => {
      const gateway = new PushGateway(
        registry,
        { sendEachForMulticast } as unknown as Messaging,
        state,
        metadata,
      );
      const poller = new RegisteredEventPoller(
        registry,
        () => ({ query: async () => [replayedEvent], disconnect: () => undefined }),
        (relayEvent, recipient, scopedReader) =>
          gateway.handleRelayEvent(relayEvent, recipient, scopedReader),
        state,
        () => 105_000,
      );
      for (let index = 0; index < polls; index += 1) await poller.pollNext();
    };

    await run(await DeliveryState.load(stateFile), 2);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();

    // A new gateway/poller pair models a forced process restart. The relay
    // intentionally returns the old backlog event again, as can a WS replay.
    await run(await DeliveryState.load(stateFile), 2);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
  });

  it('never retries an ambiguous FCM attempt after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buzzy-push-attempt-'));
    const stateFile = join(directory, 'deliveries.json');
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    const sendEachForMulticast = vi.fn().mockRejectedValueOnce(new Error('FCM timeout'));
    const metadata = {
      resolve: async () => ({
        roomName: 'Roadmap',
        senderName: 'Ada',
        workspaceName: 'Product Engineering',
        persistentWorkspaceRoom: true,
      }),
      invalidate: () => undefined,
    } as never;
    const first = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(stateFile),
      metadata,
    );

    await expect(first.handleRelayEvent(event('d'), PUBKEY_A, reader)).rejects.toThrow(
      'FCM timeout',
    );
    const restarted = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(stateFile),
      metadata,
    );
    await expect(restarted.handleRelayEvent(event('d'), PUBKEY_A, reader)).resolves.toBeUndefined();
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
  });

  it('polls one ACL identity per tick and delivers the event to each visible recipient', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    await registry.register(PUBKEY_B, TOKEN_B);
    const queried: string[] = [];
    const queriedFilters: Record<string, unknown>[][] = [];
    const delivered: string[] = [];
    const poller = new RegisteredEventPoller(
      registry,
      (pubkey) => ({
        query: async (filters) => {
          queried.push(pubkey);
          queriedFilters.push(filters);
          return [event('e')];
        },
        disconnect: () => undefined,
      }),
      async (relayEvent, recipient) => {
        delivered.push(`${recipient}:${relayEvent.id}`);
      },
      await DeliveryState.load(),
      () => 105_000,
    );

    await expect(poller.pollNext()).resolves.toBe('polled');
    expect(queried).toEqual([PUBKEY_A]);
    expect(queriedFilters[0]).toEqual([
      { kinds: [9], since: 100, limit: 1_000 },
      { kinds: [30078], '#t': ['buzz-agent-soul'], since: 100, limit: 1_000 },
    ]);
    await expect(poller.pollNext()).resolves.toBe('polled');
    expect(queried).toEqual([PUBKEY_A, PUBKEY_B]);
    expect(delivered).toEqual([`${PUBKEY_A}:${'e'.repeat(64)}`, `${PUBKEY_B}:${'e'.repeat(64)}`]);
  });

  it('honors relay backoff and advances past a rate-limited identity', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    await registry.register(PUBKEY_B, TOKEN_B);
    let now = 105_000;
    const queried: string[] = [];
    const poller = new RegisteredEventPoller(
      registry,
      (pubkey) => ({
        query: async () => {
          queried.push(pubkey);
          if (pubkey === PUBKEY_A) throw new Error('HTTP 429: retry in 30s');
          return [];
        },
        disconnect: () => undefined,
      }),
      async () => undefined,
      await DeliveryState.load(),
      () => now,
    );

    await expect(poller.pollNext()).rejects.toThrow('HTTP 429');
    await expect(poller.pollNext()).resolves.toBe('backoff');
    expect(queried).toEqual([PUBKEY_A]);

    now += 31_000;
    await expect(poller.pollNext()).resolves.toBe('polled');
    expect(queried).toEqual([PUBKEY_A, PUBKEY_B]);
  });
});

describe('PushGateway', () => {
  it('coalesces retried merge-ready events for one exact corner target', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'approval' }],
    }));
    const gateway = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(),
      {
        resolve: async () => ({
          roomName: 'Corner',
          workspaceName: 'Product Engineering',
          persistentWorkspaceRoom: true,
        }),
        invalidate: () => undefined,
      } as never,
    );
    const mergeReady = (id: string): NostrEvent => ({
      ...event(id, AUTHOR, 'corner-1234'),
      tags: [
        ['h', 'corner-1234'],
        ['t', 'body-control'],
        ['t', 'merge-ready'],
        ['repo', 'owner/repo'],
        ['branch', 'refs/heads/main'],
        ['tip', 'a'.repeat(40)],
      ],
    });

    await gateway.handleRelayEvent(mergeReady('1'), PUBKEY_A, reader);
    await gateway.handleRelayEvent(mergeReady('2'), PUBKEY_A, reader);

    expect(sendEachForMulticast).toHaveBeenCalledOnce();
    expect(sendEachForMulticast.mock.calls[0]?.[0]).toMatchObject({
      data: { channelId: 'corner-1234', cornerId: 'corner-1234', type: 'merge-approval-request' },
    });
  });

  it('sends zero FCM requests for a fixture-named persistent Room', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    const sendEachForMulticast = vi.fn();
    const gateway = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(),
      {
        resolve: async () => ({
          roomName: 'research-no-findings-xyz',
          workspaceName: 'Product Engineering',
          persistentWorkspaceRoom: true,
        }),
        invalidate: () => undefined,
      } as never,
    );

    await gateway.handleRelayEvent(event('0'), PUBKEY_A, reader);

    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('sends only to the ACL-scoped recipient and never to the author', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    await registry.register(PUBKEY_B, TOKEN_B);
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'fcm-message-id' }],
    }));
    const gateway = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(),
      {
        resolve: async () => ({
          roomName: 'Roadmap',
          senderName: 'Ada',
          workspaceName: 'Product Engineering',
          persistentWorkspaceRoom: true,
        }),
        invalidate: () => undefined,
      } as never,
    );

    await gateway.handleRelayEvent(event('f'), PUBKEY_A, reader);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
    expect(sendEachForMulticast.mock.calls[0]![0]).toMatchObject({
      tokens: [TOKEN_A],
      notification: { title: '#Roadmap', body: 'Ada: private message' },
      data: { channelId: 'room-1234', roomName: 'Roadmap', type: 'channel-activity' },
      android: {
        collapseKey: 'room-1234',
        notification: { channelId: 'messages', tag: 'room:room-1234' },
      },
    });
    expect(JSON.stringify(sendEachForMulticast.mock.calls[0]![0])).not.toContain('Buzzy');

    await gateway.handleRelayEvent(event('a', PUBKEY_A), PUBKEY_A, reader);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
  });

  it('uses one stable Android tag and collapse key per room', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'fcm-message-id' }],
    }));
    const gateway = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(),
      {
        resolve: async (relayEvent: NostrEvent) => {
          const roomId = relayEvent.tags.find((tag) => tag[0] === 'h')?.[1];
          return {
            roomName: roomId === 'room-5678' ? 'Design' : 'Roadmap',
            senderName: 'Ada',
            workspaceName: 'Product Engineering',
            persistentWorkspaceRoom: true,
          };
        },
        invalidate: () => undefined,
      } as never,
    );

    await gateway.handleRelayEvent(event('1'), PUBKEY_A, reader);
    await gateway.handleRelayEvent(event('2'), PUBKEY_A, reader);
    await gateway.handleRelayEvent(event('3', AUTHOR, 'room-5678'), PUBKEY_A, reader);

    const payloads = sendEachForMulticast.mock.calls.map((call) => call[0]);
    expect(payloads.map((payload) => payload.android?.collapseKey)).toEqual([
      'room-1234',
      'room-1234',
      'room-5678',
    ]);
    expect(payloads.map((payload) => payload.android?.notification?.tag)).toEqual([
      'room:room-1234',
      'room:room-1234',
      'room:room-5678',
    ]);
  });

  it('invalidates a cached fallback on a soul update and sends Joy only for real chat', async () => {
    const communityId = 'workspace-1';
    const roomId = 'room-1234';
    const agent = createIdentity('agent');
    const human = createIdentity('human');
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    const captured: unknown[] = [];
    const messaging = {
      sendEachForMulticast: vi.fn(async (payload: unknown) => {
        captured.push(payload);
        return {
          successCount: 1,
          failureCount: 0,
          responses: [{ success: true, messageId: 'captured-only' }],
        };
      }),
    } as unknown as Messaging;
    const roomMetadata: NostrEvent = {
      ...event('6', human.publicKey, roomId),
      kind: 39000,
      tags: [
        ['d', roomId],
        ['name', 'Launch room'],
        ['community', communityId],
      ],
      content: '',
    };
    const roomCreate: NostrEvent = {
      ...event('5', human.publicKey, roomId),
      kind: 9007,
      tags: [
        ['h', roomId],
        ['name', 'Launch room'],
        ['community', communityId],
      ],
      content: '',
    };
    const workspaceCreate: NostrEvent = {
      ...event('4', human.publicKey, communityId),
      kind: 9007,
      tags: [
        ['h', communityId],
        ['name', 'Product Engineering'],
        ['community', communityId],
      ],
      content: '',
    };
    const memberProjection: NostrEvent = {
      ...event('7', human.publicKey, communityId),
      kind: 39002,
      tags: [
        ['d', communityId],
        ['p', human.publicKey],
        ['p', agent.publicKey],
      ],
      content: '',
    };
    const agentRecord = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: 10,
        kind: 9,
        tags: [
          ['h', communityId],
          ['t', 'buzz-agent'],
          ['d', 'agent-1'],
          ['p', agent.publicKey],
          ['name', 'Rhea'],
          ['community', communityId],
        ],
        content: JSON.stringify({ displayName: 'Rhea' }),
      },
      agent.secretKey,
    );
    const soul = signEvent(
      {
        pubkey: human.publicKey,
        created_at: 11,
        kind: 30078,
        tags: [
          ['d', `${communityId}:${agent.publicKey}`],
          ['h', communityId],
          ['p', agent.publicKey],
          ['t', 'buzz-agent-soul'],
          ['community', communityId],
        ],
        content: JSON.stringify({ name: 'Joy', soul: 'bright', avatarSeed: 'joy' }),
      },
      human.secretKey,
    );
    let senderEvents: NostrEvent[] = [agentRecord, memberProjection];
    const authorizedReader: RelayEventReader = {
      query: async (filters) => {
        if (!filters.some((filter) => (filter.kinds as number[]).includes(39000))) {
          return senderEvents;
        }
        return JSON.stringify(filters).includes(communityId)
          ? [workspaceCreate]
          : [roomMetadata, roomCreate];
      },
      disconnect: () => undefined,
    };
    const resolver = new NotificationMetadataResolver();
    const firstMessage = event('8', agent.publicKey, roomId);
    await expect(resolver.resolve(firstMessage, authorizedReader)).resolves.toEqual({
      roomName: 'Launch room',
      isDirectMessage: false,
      persistentWorkspaceRoom: true,
      workspaceName: 'Product Engineering',
      fixtureCandidates: ['Launch room', 'Product Engineering'],
      fixtureMarkers: [],
      senderName: 'Rhea',
    });
    const gateway = new PushGateway(registry, messaging, await DeliveryState.load(), resolver);

    await gateway.handleRelayEvent(agentRecord, PUBKEY_A, authorizedReader);
    await gateway.handleRelayEvent(soul, PUBKEY_A, authorizedReader);
    expect(captured).toHaveLength(0);

    senderEvents = [agentRecord, soul, memberProjection];
    await gateway.handleRelayEvent(event('9', agent.publicKey, roomId), PUBKEY_A, authorizedReader);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      tokens: [TOKEN_A],
      notification: { title: '#Launch room', body: 'Joy: private message' },
      data: { channelId: roomId, roomName: 'Launch room', type: 'channel-activity' },
    });
    expect(JSON.stringify(captured)).not.toContain('displayName');
  });
});
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
