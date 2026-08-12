import { describe, expect, it, vi } from 'vitest';
import type { Messaging } from 'firebase-admin/messaging';
import type { NostrEvent } from '@beeline/nostr';
import { PushGateway, RegisteredEventPoller } from './gateway.js';
import { TokenRegistry } from './registry.js';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const AUTHOR = 'c'.repeat(64);
const TOKEN_A = 'fcm-token-A_12345678901234567890';
const TOKEN_B = 'fcm-token-B_12345678901234567890';

function event(id: string, pubkey = AUTHOR): NostrEvent {
  return {
    id: id.repeat(64),
    pubkey,
    created_at: 100,
    kind: 9,
    tags: [['h', 'room-1234']],
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
    const delivered: string[] = [];
    const poller = new RegisteredEventPoller(
      registry,
      (pubkey) => ({
        query: async () => {
          queried.push(pubkey);
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
    await expect(poller.pollNext()).resolves.toBe('polled');
    expect(queried).toEqual([PUBKEY_A, PUBKEY_B]);
    expect(delivered).toEqual([
      `${PUBKEY_A}:${'e'.repeat(64)}`,
      `${PUBKEY_B}:${'e'.repeat(64)}`,
    ]);
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
    );

    await gateway.handleRelayEvent(event('f'), PUBKEY_A);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
    expect(sendEachForMulticast.mock.calls[0]![0].tokens).toEqual([TOKEN_A]);

    await gateway.handleRelayEvent(event('a', PUBKEY_A), PUBKEY_A);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
  });
});
