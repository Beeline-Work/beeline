import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveConnection } from './live-connection';

const ROOM_A = 'room-a';
const ROOM_B = 'room-b';

type TestSocket = {
  sent: string[];
  closed: boolean;
  readyState: number;
  url: string;
  protocols: string[];
  open: () => void;
  emit: (data: unknown) => void;
  drop: () => void;
};

function stubSockets(): TestSocket[] {
  const sockets: TestSocket[] = [];
  class TestWebSocket {
    static readonly OPEN = 1;
    sent: string[] = [];
    closed = false;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {
      sockets.push(this as unknown as TestSocket);
    }
    send(value: string) {
      this.sent.push(value);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    emit(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
    drop() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  vi.stubGlobal('WebSocket', TestWebSocket);
  return sockets;
}

function createConnection(authorization = vi.fn().mockResolvedValue('phone-session')) {
  const identityListeners = new Set<() => void>();
  const connection = new LiveConnection({
    authorization,
    liveUrl: () => 'wss://server.example/v1/phone/live',
    subscribeIdentityChange: (listener) => {
      identityListeners.add(listener);
      return () => identityListeners.delete(listener);
    },
  });
  return {
    connection,
    authorization,
    changeIdentity: () => {
      for (const listener of identityListeners) listener();
    },
  };
}

describe('LiveConnection', () => {
  let sockets: TestSocket[];

  beforeEach(() => {
    sockets = stubSockets();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens one socket for two registrations and subscribes only new rooms', async () => {
    const { connection } = createConnection();
    const first: unknown[] = [];
    const second: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => first.push(event));
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });

    await connection.register([{ '#h': [ROOM_A, ROOM_B] }], (event) => second.push(event));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] }),
      JSON.stringify({ type: 'subscribe', roomIds: [ROOM_B] }),
    ]);
    expect(second).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    expect(first).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);

    connection.dispose();
  });

  it('hands a room whose subscribe is still in flight exactly one subscribed frame', async () => {
    const { connection } = createConnection();
    const deck: unknown[] = [];
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => deck.push(event));
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);

    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));
    expect(room).toEqual([]);
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);

    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    expect(room).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    expect(deck).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);

    connection.dispose();
  });

  it('retires a room whose last holder left before the server confirmed it', async () => {
    const { connection } = createConnection();
    const room: unknown[] = [];
    const stop = await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);

    stop();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);

    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] }),
      JSON.stringify({ type: 'unsubscribe', roomId: ROOM_A }),
    ]);

    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    const rejoined: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => rejoined.push(event));
    expect(rejoined).toEqual([]);

    connection.dispose();
  });

  it('synthesises subscribed and replays cached overlays to a late room join', async () => {
    const { connection } = createConnection();
    const deck: unknown[] = [];
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => deck.push(event));
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    sockets[0]!.emit({
      type: 'thought',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'thinking',
    });
    sockets[0]!.emit({
      type: 'presence',
      roomId: ROOM_A,
      agentId: 'agent',
      status: 'online',
      observedAt: 42,
    });

    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);
    expect(room).toEqual([
      { monolithLive: { type: 'subscribed', roomId: ROOM_A } },
      {
        monolithLive: {
          type: 'draft',
          roomId: ROOM_A,
          agentId: 'agent',
          turnId: 'turn-1',
          text: 'streaming',
        },
      },
      {
        monolithLive: {
          type: 'thought',
          roomId: ROOM_A,
          agentId: 'agent',
          turnId: 'turn-1',
          text: 'thinking',
        },
      },
      {
        monolithLive: {
          type: 'presence',
          roomId: ROOM_A,
          agentId: 'agent',
          status: 'online',
          observedAt: 42,
        },
      },
    ]);

    connection.dispose();
  });

  it('does not replay a draft whose turn already ended', async () => {
    const { connection } = createConnection();
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    sockets[0]!.emit({
      type: 'turn-delta',
      roomId: ROOM_A,
      turn: { requestId: 'turn-1', agentPubkey: 'agent', status: 'failed', createdAt: 1 },
    });

    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));

    expect(room).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    connection.dispose();
  });

  it('does not replay a draft older than the live window', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    sockets[0]!.emit({
      type: 'presence',
      roomId: ROOM_A,
      agentId: 'agent',
      status: 'online',
      observedAt: 42,
    });

    await vi.advanceTimersByTimeAsync(90_000);
    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));

    expect(room).toEqual([
      { monolithLive: { type: 'subscribed', roomId: ROOM_A } },
      {
        monolithLive: {
          type: 'presence',
          roomId: ROOM_A,
          agentId: 'agent',
          status: 'online',
          observedAt: 42,
        },
      },
    ]);
    connection.dispose();
  });

  it('does not re-subscribe a room whose first subscribe is still unacknowledged', async () => {
    const { connection } = createConnection();
    const room: unknown[] = [];

    const stop = await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);

    stop();
    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);

    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    expect(room).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);

    connection.dispose();
  });

  it('does not replay a retracted draft to a late listener', async () => {
    const { connection } = createConnection();
    const room: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({
      type: 'draft',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      text: 'streaming',
    });
    sockets[0]!.emit({
      type: 'retract',
      roomId: ROOM_A,
      agentId: 'agent',
      turnId: 'turn-1',
      kind: 'draft',
    });

    await connection.register([{ '#h': [ROOM_A] }], (event) => room.push(event));

    expect(room).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);
    connection.dispose();
  });

  it('keeps a no-room registration and ticks it with an empty room id', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const received: unknown[] = [];

    await connection.register([], (event) => received.push(event));
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(received).toEqual([
      { monolithLive: { type: 'invalidate', roomId: '', reason: 'poll' } },
    ]);

    connection.dispose();
  });

  it('does not poll Room-bearing registrations', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const first: unknown[] = [];
    const second: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => first.push(event));
    await connection.register([{ '#h': [ROOM_B] }], (event) => second.push(event));
    sockets[0]!.open();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(first).toEqual([]);
    expect(second).toEqual([]);

    connection.dispose();
  });

  it('keeps Room-bearing registrations poll-free across multiple intervals', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const early: unknown[] = [];
    const late: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => early.push(event));
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(20_000);
    await connection.register([{ '#h': [ROOM_B] }], (event) => late.push(event));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(early).toHaveLength(0);
    expect(late).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(early).toEqual([]);
    expect(late).toEqual([]);

    connection.dispose();
  });

  it('unsubscribes when the last holder leaves and keeps the socket open', async () => {
    const { connection } = createConnection();
    const stopFirst = await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    const stopSecond = await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });

    stopFirst();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);
    expect(sockets[0]!.closed).toBe(false);

    stopSecond();
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] }),
      JSON.stringify({ type: 'unsubscribe', roomId: ROOM_A }),
    ]);
    expect(sockets[0]!.closed).toBe(false);

    const reentered: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => reentered.push(event));
    expect(reentered).toEqual([]);
    expect(sockets[0]!.sent.at(-1)).toBe(JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] }));

    connection.dispose();
  });

  it('fans an event only to live registrations that hold that room', async () => {
    const { connection } = createConnection();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const stopFirst = await connection.register([{ '#h': [ROOM_A] }], (event) => first.push(event));
    await connection.register([{ '#h': [ROOM_B] }], (event) => second.push(event));
    sockets[0]!.open();

    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message' });
    expect(first).toEqual([
      { monolithLive: { type: 'invalidate', roomId: ROOM_A, reason: 'message' } },
    ]);
    expect(second).toEqual([]);

    stopFirst();
    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message' });
    expect(first).toHaveLength(1);

    connection.dispose();
  });

  it('resubscribes every current room after the socket drops', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await connection.register([{ '#h': [ROOM_B] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.drop();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([
      JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A, ROOM_B] }),
    ]);

    connection.dispose();
  });

  it('resets reconnect backoff after a successful open', async () => {
    vi.useFakeTimers();
    const authorization = vi.fn();
    authorization.mockRejectedValueOnce(new Error('session refresh failed'));
    authorization.mockResolvedValue('phone-session');
    const { connection } = createConnection(authorization);

    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    connection.dispose();
  });

  it('closes the socket and clears registrations on identity change', async () => {
    vi.useFakeTimers();
    const { connection, changeIdentity } = createConnection();
    const received: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => received.push(event));
    sockets[0]!.open();

    changeIdentity();
    expect(sockets[0]!.closed).toBe(true);

    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);

    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message' });
    expect(received).toEqual([]);

    connection.dispose();
  });

  it('routes trace-painted to the registration that sent trace-paint', async () => {
    const { connection } = createConnection();
    const first: Array<{
      acknowledgePaint?: () => void;
      monolithLive: { type: string; id?: string };
    }> = [];
    const second: Array<{ monolithLive: { type: string; id?: string } }> = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) =>
      first.push(event as (typeof first)[number]),
    );
    await connection.register([{ '#h': [ROOM_A] }], (event) =>
      second.push(event as (typeof second)[number]),
    );
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'message-delta',
      roomId: ROOM_A,
      message: { id: 'message', text: 'done' },
      trace: { id: 'trace-direct', startedAt: 10, databaseAt: 11, emittedAt: 12 },
    });

    first[0]!.acknowledgePaint?.();
    expect(sockets[0]!.sent.at(-1)).toBe(
      JSON.stringify({ type: 'trace-paint', id: 'trace-direct' }),
    );

    sockets[0]!.emit({
      type: 'trace-painted',
      id: 'trace-direct',
      databaseAt: 11,
      upperBoundMs: 4,
    });
    expect(first.filter((event) => event.monolithLive.type === 'trace-painted')).toHaveLength(1);
    expect(second.some((event) => event.monolithLive.type === 'trace-painted')).toBe(false);

    sockets[0]!.emit({
      type: 'trace-painted',
      id: 'trace-direct',
      databaseAt: 11,
      upperBoundMs: 4,
    });
    expect(first.filter((event) => event.monolithLive.type === 'trace-painted')).toHaveLength(1);

    connection.dispose();
  });

  it('does not let a closed registration acknowledge paint on a later socket', async () => {
    const { connection } = createConnection();
    const received: Array<{ acknowledgePaint?: () => void }> = [];
    const stop = await connection.register([{ '#h': [ROOM_A] }], (event) =>
      received.push(event as (typeof received)[number]),
    );
    sockets[0]!.open();
    sockets[0]!.emit({
      type: 'turn-delta',
      roomId: ROOM_A,
      turn: { requestId: 'request', agentId: 'agent', status: 'working', createdAt: 1 },
      trace: {
        id: 'trace-database-clock',
        databaseAt: 10,
        emittedAt: 12,
        paintAck: 'database-clock',
      },
    });
    expect(received[0]!.acknowledgePaint).toEqual(expect.any(Function));
    received[0]!.acknowledgePaint?.();
    expect(sockets[0]!.sent.at(-1)).toBe(
      JSON.stringify({ type: 'trace-paint', id: 'trace-database-clock' }),
    );

    stop();
    const sentAfterStop = sockets[0]!.sent.length;
    received[0]!.acknowledgePaint?.();
    expect(sockets[0]!.sent).toHaveLength(sentAfterStop);

    connection.dispose();
  });
});
