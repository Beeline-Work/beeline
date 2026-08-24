import type { NostrEvent } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryState } from './delivery-state.js';
import { PushEventFeed } from './feed.js';
import { RegisteredEventPoller } from './gateway.js';
import { TokenRegistry } from './registry.js';

const RECIPIENT = 'a'.repeat(64);

function messageEvent(): NostrEvent {
  return {
    id: 'b'.repeat(64),
    pubkey: 'c'.repeat(64),
    created_at: 100,
    kind: 9,
    tags: [['h', 'room-1234']],
    content: 'live message',
    sig: 'd'.repeat(128),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PushEventFeed', () => {
  it('receives a kind-9 event from the Postgres member-scoped feed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(105_000);
    const registry = await TokenRegistry.load();
    await registry.register(RECIPIENT, 'fcm-token-A_12345678901234567890');
    const handled: NostrEvent[] = [];
    const poller = new RegisteredEventPoller(
      registry,
      () => ({ query: async () => [messageEvent()], disconnect: () => undefined }),
      async (event) => {
        handled.push(event);
        feed.noteEvent();
      },
      await DeliveryState.load(),
      Date.now,
    );
    const logs: string[] = [];
    const feed = new PushEventFeed(poller, {
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 60_000,
      log: (line) => logs.push(line),
    });

    feed.start();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0);

    expect(handled).toEqual([messageEvent()]);
    expect(logs[0]).toContain('feed started mode=postgres-tail');
    expect(logs).toContainEqual(
      expect.stringContaining('feed live mode=postgres-tail firstSuccess='),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs).toContainEqual(
      expect.stringContaining('feed heartbeat mode=postgres-tail eventsPerMinute=1'),
    );
    feed.stop();
  });

  it('reconnects with bounded backoff after a dropped query transport', async () => {
    vi.useFakeTimers();
    const pollNext = vi
      .fn<() => Promise<'polled'>>()
      .mockRejectedValueOnce(new Error('database transport dropped'))
      .mockRejectedValueOnce(new Error('database transport dropped'))
      .mockRejectedValueOnce(new Error('database transport dropped'))
      .mockRejectedValueOnce(new Error('database transport dropped'))
      .mockResolvedValue('polled');
    const errors: string[] = [];
    const feed = new PushEventFeed(
      { pollNext },
      {
        pollIntervalMs: 1_000,
        retryMaxMs: 5_000,
        error: (line) => errors.push(line),
      },
    );

    feed.start();
    await flushPromises();
    expect(pollNext).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      expect.stringContaining('error=database%20transport%20dropped retryMs=1000'),
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(pollNext).toHaveBeenCalledTimes(5);
    expect(errors.map((line) => line.match(/retryMs=(\d+)/)?.[1])).toEqual([
      '1000',
      '2000',
      '4000',
      '5000',
    ]);
    feed.stop();
  });
});
