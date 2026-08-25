import { createIdentity } from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import type { Messaging } from 'firebase-admin/messaging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    tags: [
      ['h', roomId],
      ['p', PUBKEY_A],
      ['p', PUBKEY_B],
    ],
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
      { kinds: [30078], '#t': ['buzz-corner-state'], since: 100, limit: 1_000 },
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
  it('deduplicates and rate-limits standing corner attention until lifecycle resolution', async () => {
    let now = 1_000_000;
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'attention' }],
    }));
    const gateway = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(undefined, { now: () => now }),
      {
        resolve: async () => ({
          roomName: 'Peddle',
          senderName: 'Codex',
          workspaceName: 'Product Engineering',
          persistentWorkspaceRoom: true,
        }),
        invalidate: () => undefined,
      } as never,
    );
    const attention = (id: string, content: string, reason = 'review'): NostrEvent => ({
      ...event(id, AUTHOR, 'room-peddle'),
      tags: [
        ['h', 'room-peddle'],
        ['subchannel', 'corner-peddle'],
        ['status', 'needs-attention'],
        ['reason', reason],
      ],
      content,
    });
    const lifecycle = (id: string, state: 'working' | 'idle'): NostrEvent => ({
      ...event('9', AUTHOR, 'room-peddle'),
      id: id.repeat(64),
      kind: 30078,
      tags: [
        ['d', 'buzz-corner-state:corner-peddle'],
        ['h', 'room-peddle'],
        ['t', 'buzz-corner-state'],
        ['state', state],
        ['at', '1000'],
      ],
    });

    await gateway.handleRelayEvent(
      attention('1', 'Nothing committed is ready for review.'),
      PUBKEY_A,
      reader,
    );
    await gateway.handleRelayEvent(
      attention('2', 'Nothing committed is ready for review.'),
      PUBKEY_A,
      reader,
    );
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);

    await gateway.handleRelayEvent(attention('3', 'Nothing ready to merge yet.'), PUBKEY_A, reader);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    await gateway.handleRelayEvent(attention('4', 'Nothing ready to merge yet.'), PUBKEY_A, reader);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);

    await gateway.handleRelayEvent(
      attention('5', 'Delivery failed. Open corner for details.', 'failure'),
      PUBKEY_A,
      reader,
    );
    expect(sendEachForMulticast).toHaveBeenCalledTimes(3);

    // An automatic retry's transient working lease is not a human resolution.
    await gateway.handleRelayEvent(lifecycle('8', 'working'), PUBKEY_A, reader);
    await gateway.handleRelayEvent(
      attention('7', 'Delivery failed. Open corner for details.', 'failure'),
      PUBKEY_A,
      reader,
    );
    expect(sendEachForMulticast).toHaveBeenCalledTimes(3);

    await gateway.handleRelayEvent(lifecycle('9', 'idle'), PUBKEY_A, reader);
    await gateway.handleRelayEvent(
      attention('6', 'Nothing committed is ready for review.'),
      PUBKEY_A,
      reader,
    );
    expect(sendEachForMulticast).toHaveBeenCalledTimes(4);
  });

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
      android: { notification: { channelId: 'attention' } },
    });
  });

  it('uses activity for DMs and attention for an agent question', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    const send = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'sent' }],
    }));
    const metadata = {
      resolve: async (relayEvent: NostrEvent) => ({
        roomName: relayEvent.tags.some((tag) => tag[1] === 'dm-room') ? 'Direct message' : 'Corner',
        senderName: 'Codex',
        isDirectMessage: relayEvent.tags.some((tag) => tag[1] === 'dm-room'),
        workspaceName: 'Product Engineering',
        persistentWorkspaceRoom: true,
      }),
      invalidate: () => undefined,
    } as never;
    const gateway = new PushGateway(
      registry,
      { sendEachForMulticast: send } as unknown as Messaging,
      await DeliveryState.load(),
      metadata,
    );
    const dm = { ...event('q'), tags: [['h', 'dm-room']] };
    const question = {
      ...event('r'),
      tags: [
        ['h', 'corner-room'],
        ['t', 'agent-message'],
      ],
      content: 'Which branch should I use?',
    };

    await gateway.handleRelayEvent(dm, PUBKEY_A, reader);
    await gateway.handleRelayEvent(question, PUBKEY_A, reader);

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      data: { type: 'direct-message' },
      android: { notification: { channelId: 'activity' } },
    });
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      data: { type: 'agent-question' },
      android: { notification: { channelId: 'attention' } },
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
      notification: { title: '#Roadmap', body: 'Ada mentioned you: private message' },
      data: { channelId: 'room-1234', roomName: 'Roadmap', type: 'mention' },
      android: {
        collapseKey: 'room-1234',
        notification: { channelId: 'mentions', tag: 'room:room-1234' },
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
      notification: { title: '#Launch room', body: 'Joy mentioned you: private message' },
      data: { channelId: roomId, roomName: 'Launch room', type: 'mention' },
    });
    expect(JSON.stringify(captured)).not.toContain('displayName');
  });
});
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('PushGateway decision tracing', () => {
  const metadata = {
    resolve: async () => ({
      roomName: 'Roadmap',
      senderName: 'Ada',
      workspaceName: 'Product Engineering',
      persistentWorkspaceRoom: true,
    }),
    invalidate: () => undefined,
  } as never;

  async function gatewayWith(
    sendEachForMulticast: ReturnType<typeof vi.fn>,
    meta: object = metadata,
    state?: DeliveryState,
  ): Promise<PushGateway> {
    return new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      state ?? (await DeliveryState.load()),
      meta,
    );
  }

  let registry: TokenRegistry;
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  const NO_CHANNEL_EVENT: NostrEvent = {
    ...event('a'),
    tags: [['t', 'agent-message']],
  };

  it.each([
    ['no-channel', NO_CHANNEL_EVENT],
    [
      'fatigue-policy-ambient',
      {
        ...event('b', AUTHOR),
        tags: [
          ['h', 'room-1234'],
          ['t', 'merge-summary'],
        ],
      },
    ],
    ['not-notifiable-kind', { ...event('b', AUTHOR), kind: 30078 }],
    ['sender-self', event('c', PUBKEY_A)],
    // An unregistered identity models a reader whose devices have all vanished.
    ['no-devices', event('d', AUTHOR, 'room-9999')],
  ] as Array<[string, NostrEvent]>)(
    'traces skip reason %s in one line',
    async (reason, relayEvent) => {
      const gateway = await gatewayWith(vi.fn());
      const recipient =
        reason === 'sender-self' ||
        reason === 'no-channel' ||
        reason === 'fatigue-policy-ambient' ||
        reason.startsWith('not-notifiable-')
          ? PUBKEY_A
          : PUBKEY_B;
      await gateway.handleRelayEvent(relayEvent, recipient, reader);
      expect(logs.filter((line) => line.includes('[push] decision event='))).toHaveLength(1);
      expect(logs[0]).toContain(`verdict=skip reason=${reason}`);
      expect(logs[0]).toContain(`event=${relayEvent.id}`);
      expect(logs[0]).toContain(`room=${relayEvent.tags.find((t) => t[0] === 'h')?.[1] ?? '-'}`);
      expect(logs[0]).toContain(`recipient=${recipient}`);
    },
  );

  it('traces room-not-persistent-workspace separately from fixture suppression', async () => {
    const notPersistent = {
      resolve: async () => ({ roomName: 'Roadmap', persistentWorkspaceRoom: false }),
      invalidate: () => undefined,
    } as never;
    await (
      await gatewayWith(vi.fn(), notPersistent)
    ).handleRelayEvent(event('e'), PUBKEY_A, reader);
    expect(logs[0]).toContain('reason=room-not-persistent-workspace');

    const fixture = {
      resolve: async () => ({
        roomName: 'research-no-findings-xyz',
        workspaceName: 'Product Engineering',
        persistentWorkspaceRoom: true,
      }),
      invalidate: () => undefined,
    } as never;
    await (await gatewayWith(vi.fn(), fixture)).handleRelayEvent(event('f'), PUBKEY_A, reader);
    expect(logs[1]).toContain('reason=fixture-suppressed');
  });

  it('traces an already-attempted replay without re-sending', async () => {
    const send = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'x' }],
    }));
    const gateway = await gatewayWith(send);
    await gateway.handleRelayEvent(event('g'), PUBKEY_A, reader);
    await gateway.handleRelayEvent(event('g'), PUBKEY_A, reader);
    expect(send).toHaveBeenCalledOnce();
    expect(logs.map((line) => (line.match(/reason=([^ ]+)/) ?? [])[1])).toEqual([
      'fcm-result',
      'already-attempted',
    ]);
  });

  it('the notify verdict carries recipients and device counts', async () => {
    const send = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'y' }],
    }));
    await (await gatewayWith(send)).handleRelayEvent(event('h'), PUBKEY_A, reader);
    expect(logs[0]).toContain('verdict=notify');
    expect(logs[0]).toContain('reason=fcm-result');
    expect(logs[0]).toMatch(/recipients=1 devices=1 success=1 failure=0/);
  });

  it('traces metadata errors once and preserves retry behavior', async () => {
    const failedMetadata = {
      resolve: async () => {
        throw new Error('relay unavailable\nupstream reset');
      },
      invalidate: () => undefined,
    } as never;
    const gateway = await gatewayWith(vi.fn(), failedMetadata);

    await expect(gateway.handleRelayEvent(event('i'), PUBKEY_A, reader)).rejects.toThrow(
      'relay unavailable',
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('verdict=skip reason=metadata-error');
    expect(logs[0]).toContain('error=relay%20unavailable%0Aupstream%20reset');
    expect(logs[0]).not.toContain('\n');
  });

  it('traces delivery-state failures once and lets the poller retry', async () => {
    const failedState = {
      reserveAttempt: async () => {
        throw new Error('ledger read-only');
      },
    } as never;
    const gateway = await gatewayWith(vi.fn(), metadata, failedState);

    await expect(gateway.handleRelayEvent(event('j'), PUBKEY_A, reader)).rejects.toThrow(
      'ledger read-only',
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('verdict=skip reason=delivery-state-error');
  });

  it('traces whole-request FCM failures with recipient and device counts', async () => {
    const send = vi.fn(async () => {
      throw new Error('FCM unavailable');
    });
    const gateway = await gatewayWith(send);

    await expect(gateway.handleRelayEvent(event('k'), PUBKEY_A, reader)).rejects.toThrow(
      'FCM unavailable',
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('verdict=skip reason=fcm-error');
    expect(logs[0]).toContain('recipients=1 devices=1');
  });
});

describe('PushGateway @mention pushes', () => {
  const metadata = {
    resolve: async () => ({
      roomName: 'Roadmap',
      senderName: 'Ada',
      workspaceName: 'Product Engineering',
      persistentWorkspaceRoom: true,
    }),
    invalidate: () => undefined,
  } as never;

  async function gatewayWith(
    sendEachForMulticast: ReturnType<typeof vi.fn>,
    meta: object = metadata,
  ) {
    return new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(),
      meta,
    );
  }

  let registry: TokenRegistry;
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  /** Real app shape: an agent-authored reply carrying extra markers plus the mentioned member's p tag. */
  function mentionEvent(id: string, mentionedPubkey: string | null, author = AUTHOR): NostrEvent {
    return {
      id: id.repeat(64),
      pubkey: author,
      created_at: 100,
      kind: 9,
      tags: [
        ['h', 'room-1234'],
        ['t', 'agent-message'],
        ['t', 'land-summary'],
        ...(mentionedPubkey ? [['p', mentionedPubkey]] : []),
      ],
      content: 'please review this.',
      sig: 'd'.repeat(128),
    } as NostrEvent;
  }

  it('notifies a mentioned registered recipient even when the plain-chat marker gate would skip', async () => {
    const send = vi.fn(async () => ({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'mention' }],
    }));
    await (await gatewayWith(send)).handleRelayEvent(mentionEvent('m', PUBKEY_A), PUBKEY_A, reader);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      tokens: [TOKEN_A],
      notification: { title: '#Roadmap', body: 'Ada mentioned you: please review this.' },
      data: { channelId: 'room-1234', roomName: 'Roadmap', type: 'mention' },
    });
  });

  it('the same shape without a p tag stays in-app only', async () => {
    const send = vi.fn();
    await (await gatewayWith(send)).handleRelayEvent(mentionEvent('m', null), PUBKEY_A, reader);

    expect(send).not.toHaveBeenCalled();
    expect(logs.filter((line) => line.includes('[push] decision event='))).toHaveLength(1);
    expect(logs[0]).toContain('verdict=skip reason=fatigue-policy-ambient');
  });

  it('never notifies the author of their own mention', async () => {
    const send = vi.fn();
    await (
      await gatewayWith(send)
    ).handleRelayEvent(mentionEvent('m', PUBKEY_A, PUBKEY_A), PUBKEY_A, reader);

    expect(send).not.toHaveBeenCalled();
    expect(logs[0]).toContain('verdict=skip reason=sender-self');
  });

  it('fixture suppression still wins over a mention', async () => {
    const send = vi.fn();
    const fixtureMetadata = {
      resolve: async () => ({
        roomName: 'research-no-findings-xyz',
        senderName: 'Ada',
        workspaceName: 'Product Engineering',
        persistentWorkspaceRoom: true,
      }),
      invalidate: () => undefined,
    } as never;
    await (
      await gatewayWith(send, fixtureMetadata)
    ).handleRelayEvent(mentionEvent('m', PUBKEY_A), PUBKEY_A, reader);

    expect(send).not.toHaveBeenCalled();
    expect(logs[0]).toContain('verdict=skip reason=fixture-suppressed');
  });
});

describe('PushGateway member-join fatigue policy', () => {
  it('keeps member joins in-app only and records the decision', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    const send = vi.fn();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      const gateway = new PushGateway(
        registry,
        { sendEachForMulticast: send } as unknown as Messaging,
        await DeliveryState.load(),
      );
      await gateway.handleRelayEvent(
        {
          ...event('j'),
          kind: 9000,
          tags: [
            ['h', 'room-1234'],
            ['p', 'd'.repeat(64)],
            ['role', 'member'],
          ],
        },
        PUBKEY_A,
        reader,
      );

      expect(send).not.toHaveBeenCalled();
      expect(logs[0]).toContain('verdict=skip reason=fatigue-policy-member-join');
    } finally {
      spy.mockRestore();
    }
  });
});
describe('PushGateway.sendTestNotification', () => {
  it('reports per-device FCM results and sends a real-shaped notification', async () => {
    const registry = await TokenRegistry.load();
    await registry.register(PUBKEY_A, TOKEN_A);
    await registry.register(PUBKEY_A, TOKEN_B);
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true, messageId: 'projects/x/messages/y' },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
      ],
    }));
    const gateway = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(),
    );

    const report = await gateway.sendTestNotification(PUBKEY_A);

    expect(report.pubkey).toBe(PUBKEY_A);
    expect(report).toMatchObject({ successCount: 1, failureCount: 1 });
    expect(report.devices).toHaveLength(2);
    expect(report.devices[0]).toMatchObject({
      deviceId: expect.stringMatching(/^[0-9a-f]{16}$/),
      ok: true,
      messageId: 'projects/x/messages/y',
    });
    expect(report.devices[1]).toMatchObject({
      deviceId: expect.stringMatching(/^[0-9a-f]{16}$/),
      ok: false,
      error: 'messaging/registration-token-not-registered',
    });
    expect(JSON.stringify(report)).not.toContain(TOKEN_A);
    expect(JSON.stringify(report)).not.toContain(TOKEN_B);
    // Real-shape FCM payload, like a production send.
    expect(sendEachForMulticast.mock.calls[0]?.[0]).toMatchObject({
      tokens: [TOKEN_A, TOKEN_B],
      notification: { title: 'Beeline push test' },
      data: { type: 'delivery-test' },
      android: { priority: 'high', notification: { channelId: 'messages' } },
    });
    // A test send must not consume durable delivery state or mutate the registry.
    expect(registry.tokenCount).toBe(2);
  });

  it('returns an empty device list without calling FCM for an unregistered pubkey', async () => {
    const sendEachForMulticast = vi.fn();
    const gateway = new PushGateway(
      await TokenRegistry.load(),
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(),
    );
    const report = await gateway.sendTestNotification(PUBKEY_B);
    expect(report).toEqual({
      pubkey: PUBKEY_B,
      successCount: 0,
      failureCount: 0,
      devices: [],
    });
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });
});
