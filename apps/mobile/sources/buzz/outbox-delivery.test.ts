import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real transport, real outbox storage and the real delivery driver; only the
// network, the device key-value store and React Native's AppState are stubbed.
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  appStateListeners: new Set<(state: string) => void>(),
  connectedListeners: new Set<() => void>(),
  store: new Map<string, string>(),
  seed: 0,
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.appStateListeners.add(listener);
      return { remove: () => mocks.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return mocks.store.get(key);
    }
    set(key: string, value: string) {
      mocks.store.set(key, value);
    }
    delete(key: string) {
      mocks.store.delete(key);
    }
    getAllKeys() {
      return [...mocks.store.keys()];
    }
  },
}));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(++mocks.seed),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));
vi.mock('@/auth/monolith-session', () => ({
  MonolithRequestTimeoutError: class extends Error {
    constructor() {
      super('The server timed out before it responded.');
    }
  },
  MONOLITH_REQUEST_TIMEOUT_MS: 15_000,
  monolithSession: { fetch: mocks.fetch, subscribeIdentityChange: () => () => undefined },
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) }),
}));
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    subscribeConnected: (listener: () => void) => {
      mocks.connectedListeners.add(listener);
      return () => mocks.connectedListeners.delete(listener);
    },
  }),
}));

import { BuzzRigTransport } from '@/sync/transport';
import { MonolithRequestTimeoutError } from '@/auth/monolith-session';
import { publishOutboxEvent, startOutboxDelivery } from './outbox-delivery';
import { createRoomOutbox, pendingOutboxRoomIds } from './surface-storage';

const ROOM = 'release-corner';
const REPLY_URL = 'https://server.example/v1/phone/operations/sendRoomReply';
const VIEWER = 'a'.repeat(64);
const identity = { publicKey: VIEWER, secretKey: new Uint8Array(32) };
const replyPosts = () => mocks.fetch.mock.calls.filter(([url]) => url === REPLY_URL);
const serverAccepts = () =>
  mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body)) as { messageId: string };
    return new Response(JSON.stringify({ messageId: input.messageId }), { status: 200 });
  });

/** The composer's path: prepare the reply, store it, then try to publish. */
async function sendReplyThenLeave(transport: BuzzRigTransport) {
  const event = await transport.composeReplyMessage(
    '@speedy Investigate in new corner',
    { channelId: ROOM, eventId: 'f'.repeat(64) } as never,
    'speedy',
  );
  const outbox = createRoomOutbox(identity, ROOM);
  await outbox.restore();
  await outbox.enqueue(event, {
    id: event.id,
    text: event.content,
    createdAt: event.created_at,
    author: { pubkey: VIEWER, kind: 'human', name: 'lunchboxfortwo' },
    presentation: 'message',
  });
  await outbox.attempted(event.id);
  expect(outbox.list()).toHaveLength(1);
  // The request dies after the person left the corner: no screen is mounted
  // to mark it failed, so the stored send stays pending.
  await publishOutboxEvent(transport, event).catch(() => undefined);
  return event;
}

describe('a Room send that did not land while its corner was closed', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.store.clear();
    mocks.appStateListeners.clear();
    mocks.connectedListeners.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is delivered while the app stays open on another screen', async () => {
    // The person never leaves the app: no foreground, no reconnect. The
    // driver is already running from launch with nothing to send.
    vi.useFakeTimers();
    const stop = startOutboxDelivery();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).not.toHaveBeenCalled();

    mocks.fetch.mockRejectedValue(new MonolithRequestTimeoutError());
    const transport = new BuzzRigTransport(identity as never);
    const event = await sendReplyThenLeave(transport);
    expect(replyPosts()).toHaveLength(1);
    console.log(`reply ${event.id.slice(0, 8)} timed out after leaving ${ROOM}; app still open`);

    serverAccepts();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replyPosts()).toHaveLength(2);
    expect(pendingOutboxRoomIds(VIEWER)).toEqual([]);
    console.log(`retry timer delivered ${event.id.slice(0, 8)} 5s later; corner never opened`);
    stop();
  });

  it('backs off while the server stays unreachable, and stops once delivered', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockRejectedValue(new TypeError('Network request failed'));
    await sendReplyThenLeave(new BuzzRigTransport(identity as never));
    const stop = startOutboxDelivery();
    await vi.advanceTimersByTimeAsync(0);
    expect(replyPosts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replyPosts()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replyPosts()).toHaveLength(3);
    serverAccepts();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replyPosts()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(replyPosts()).toHaveLength(4);
    stop();
  });

  it('marks a refused send failed instead of retrying it', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'room access denied' }), { status: 403 }),
    );
    const event = await sendReplyThenLeave(new BuzzRigTransport(identity as never));
    const stop = startOutboxDelivery();
    await vi.advanceTimersByTimeAsync(0);
    expect(createRoomOutbox(identity, ROOM).get(event.id)?.status).toBe('failed');
    const posts = replyPosts().length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(replyPosts()).toHaveLength(posts);
    stop();
  });

  it('retires the stored send when the composer’s own request lands', async () => {
    vi.useFakeTimers();
    const stop = startOutboxDelivery();
    serverAccepts();
    await sendReplyThenLeave(new BuzzRigTransport(identity as never));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(replyPosts()).toHaveLength(1);
    expect(pendingOutboxRoomIds(VIEWER)).toEqual([]);
    stop();
  });

  it('is delivered on app foreground without opening the corner', async () => {
    mocks.fetch.mockRejectedValue(new TypeError('Network request failed'));
    const transport = new BuzzRigTransport(identity as never);
    const event = await sendReplyThenLeave(transport);
    expect(replyPosts()).toHaveLength(1);
    expect(pendingOutboxRoomIds(VIEWER)).toEqual([ROOM]);
    console.log(`left ${ROOM} with reply ${event.id.slice(0, 8)} still pending`);

    const stop = startOutboxDelivery();
    // Launch flush runs while the network is still down: it stays pending.
    await vi.waitFor(() => expect(replyPosts()).toHaveLength(2));
    expect(pendingOutboxRoomIds(VIEWER)).toEqual([ROOM]);

    serverAccepts();
    for (const listener of mocks.appStateListeners) listener('active');
    await vi.waitFor(() => expect(pendingOutboxRoomIds(VIEWER)).toEqual([]));
    stop();

    const delivered = JSON.parse(String(replyPosts().at(-1)?.[1].body)) as {
      roomId: string;
      messageId: string;
      parentMessageId: string;
      mentions: string[];
    };
    console.log(
      `foreground delivered ${delivered.messageId.slice(0, 8)} to ${delivered.roomId}; corner never opened`,
    );
    expect(delivered).toMatchObject({
      roomId: ROOM,
      messageId: event.id,
      parentMessageId: 'f'.repeat(64),
      mentions: ['speedy'],
    });
  });

  it('is delivered when the live socket reconnects', async () => {
    mocks.fetch.mockRejectedValue(new TypeError('Network request failed'));
    const transport = new BuzzRigTransport(identity as never);
    await sendReplyThenLeave(transport);
    const stop = startOutboxDelivery();
    await vi.waitFor(() => expect(mocks.connectedListeners.size).toBe(1));

    serverAccepts();
    for (const listener of mocks.connectedListeners) listener();
    await vi.waitFor(() => expect(pendingOutboxRoomIds(VIEWER)).toEqual([]));
    stop();
  });

  it('sends one request when the composer and the driver publish together', async () => {
    let release!: () => void;
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      await new Promise<void>((resolve) => (release = resolve));
      const input = JSON.parse(String(init.body)) as { messageId: string };
      return new Response(JSON.stringify({ messageId: input.messageId }), { status: 200 });
    });
    const transport = new BuzzRigTransport(identity as never);
    const event = await transport.composeMessage({ sessionId: ROOM, text: 'hi' });
    const first = publishOutboxEvent(transport, event);
    const second = publishOutboxEvent(transport, event);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
