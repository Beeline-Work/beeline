import { createIdentity } from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import type { Messaging } from 'firebase-admin/messaging';
import { describe, expect, it, vi } from 'vitest';
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
      () => 105_000,
    );

    await expect(poller.pollNext()).resolves.toBe('polled');
    expect(queried).toEqual([PUBKEY_A]);
    expect(queriedFilters[0]).toEqual([
      { kinds: [9], since: 100 },
      { kinds: [30078], '#t': ['buzz-agent-soul'], since: 100 },
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
      {
        resolve: async () => ({ roomName: 'Roadmap', senderName: 'Ada' }),
        invalidate: () => undefined,
      } as never,
    );

    await gateway.handleRelayEvent(event('f'), PUBKEY_A, reader);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
    expect(sendEachForMulticast.mock.calls[0]![0]).toMatchObject({
      tokens: [TOKEN_A],
      notification: { title: 'Ada', body: 'private message' },
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
      {
        resolve: async (relayEvent: NostrEvent) => {
          const roomId = relayEvent.tags.find((tag) => tag[0] === 'h')?.[1];
          return { roomName: roomId === 'room-5678' ? 'Design' : 'Roadmap', senderName: 'Ada' };
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
        content: JSON.stringify({ name: 'Joy', personality: 'bright', avatarSeed: 'joy' }),
      },
      human.secretKey,
    );
    let senderEvents: NostrEvent[] = [agentRecord, memberProjection];
    const authorizedReader: RelayEventReader = {
      query: async (filters) =>
        filters.some((filter) => (filter.kinds as number[]).includes(39000))
          ? [roomMetadata]
          : senderEvents,
      disconnect: () => undefined,
    };
    const resolver = new NotificationMetadataResolver();
    const firstMessage = event('8', agent.publicKey, roomId);
    await expect(resolver.resolve(firstMessage, authorizedReader)).resolves.toEqual({
      roomName: 'Launch room',
      senderName: 'Rhea',
    });
    const gateway = new PushGateway(registry, messaging, resolver);

    await gateway.handleRelayEvent(agentRecord, PUBKEY_A, authorizedReader);
    await gateway.handleRelayEvent(soul, PUBKEY_A, authorizedReader);
    expect(captured).toHaveLength(0);

    senderEvents = [agentRecord, soul, memberProjection];
    await gateway.handleRelayEvent(event('9', agent.publicKey, roomId), PUBKEY_A, authorizedReader);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      tokens: [TOKEN_A],
      notification: { title: 'Joy', body: 'private message' },
      data: { channelId: roomId, roomName: 'Launch room', type: 'channel-activity' },
    });
    expect(JSON.stringify(captured)).not.toContain('displayName');
  });
});
