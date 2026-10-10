import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
}));

import { LiveConnection } from './live-connection';
import { liveFrameEpoch } from './live-frame-epoch';

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
  const foregroundListeners = new Set<() => void>();
  const connection = new LiveConnection({
    authorization,
    liveUrl: () => 'wss://server.example/v1/phone/live',
    subscribeIdentityChange: (listener) => {
      identityListeners.add(listener);
      return () => identityListeners.delete(listener);
    },
    subscribeForeground: (listener) => {
      foregroundListeners.add(listener);
      return () => foregroundListeners.delete(listener);
    },
  });
  return {
    connection,
    authorization,
    changeIdentity: () => {
      for (const listener of identityListeners) listener();
    },
    foreground: () => {
      for (const listener of foregroundListeners) listener();
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

  it('dispatches identity-scoped workspace changes only to workspace registrations', async () => {
    const { connection } = createConnection();
    const workspace = vi.fn();
    const room = vi.fn();
    const stop = await connection.register([], workspace);
    await connection.register([{ '#h': [ROOM_A] }], room);
    sockets[0]!.open();
    workspace.mockClear();
    room.mockClear();
    const invalidation = { type: 'invalidate', roomId: '', reason: 'postgres:memberships' };
    sockets[0]!.emit(invalidation);
    expect(workspace).toHaveBeenCalledWith({ monolithLive: invalidation });
    expect(room).not.toHaveBeenCalled();
    const bookmark = { type: 'bookmark-delta', roomId: '', workspaceId: 'workspace',
      messageId: 'saved', bookmark: null };
    const needs = { type: 'needs-you-delta', roomId: '', workspaceId: 'workspace',
      sourceRoomId: ROOM_A, count: 0, items: [] };
    const resource = { type: 'resource-change', roomId: '', resource: 'workbench' };
    sockets[0]!.emit(bookmark);
    sockets[0]!.emit(needs);
    sockets[0]!.emit(resource);
    expect(workspace).toHaveBeenCalledWith({ monolithLive: bookmark });
    expect(workspace).toHaveBeenCalledWith({ monolithLive: needs });
    expect(workspace).toHaveBeenCalledWith({ monolithLive: resource });
    expect(room).not.toHaveBeenCalled();
    stop();
    workspace.mockClear();
    sockets[0]!.emit(invalidation);
    expect(workspace).not.toHaveBeenCalled();
    connection.dispose();
  });

  it('starts the first room read while live authorization is still pending', async () => {
    let authorize!: (token: string) => void;
    const authorization = vi.fn(() => new Promise<string>((resolve) => { authorize = resolve; }));
    const { connection } = createConnection(authorization);
    const fetch = vi.fn(async () => 'rooms');

    const registration = connection.register([{ '#h': [ROOM_A] }], () => undefined);
    const firstRead = registration.then(fetch);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledOnce();
    expect(await firstRead).toBe('rooms');
    expect(sockets).toHaveLength(0);

    authorize('phone-session');
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);
    (await registration)();
    connection.dispose();
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

  it('marks a late join as continuous when the held Room has a cursor', async () => {
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A,
      epoch: 'epoch-1', cursor: 0, resumed: false });
    const late = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], late);
    expect(late).toHaveBeenCalledWith({ monolithLive: { type: 'subscribed',
      roomId: ROOM_A, epoch: 'epoch-1', cursor: 0, resumed: true } });
    connection.dispose();
  });

  it('batches a large Room watch under the server frame limit', async () => {
    const { connection } = createConnection();
    const roomIds = Array.from({ length: 65 }, (_, index) => `room-${index}`);
    await connection.register([{ '#h': roomIds }], () => undefined);
    sockets[0]!.open();
    const frames = sockets[0]!.sent.map((frame) => JSON.parse(frame) as {
      type: string; roomIds: string[];
    });
    expect(frames.map((frame) => frame.roomIds.length)).toEqual([32, 32, 1]);
    expect(frames.flatMap((frame) => frame.roomIds)).toEqual(roomIds);
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

  it('rebuilds an append-only draft and replays the accumulated text to a late join', async () => {
    const { connection } = createConnection();
    const first: unknown[] = [];
    const late: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => first.push(event));
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({ type: 'draft', roomId: ROOM_A, agentId: 'agent',
      turnId: 'turn', text: 'Hello', revision: 0 });
    sockets[0]!.emit({ type: 'draft-append', roomId: ROOM_A, agentId: 'agent',
      turnId: 'turn', offset: 5, revision: 1, chunk: ' world' });
    expect(first.at(-1)).toEqual({ monolithLive: { type: 'draft', roomId: ROOM_A,
      agentId: 'agent', turnId: 'turn', text: 'Hello world', revision: 1,
      latestChunk: ' world' } });
    await connection.register([{ '#h': [ROOM_A] }], (event) => late.push(event));
    expect(late.at(-1)).toEqual(first.at(-1));
    connection.dispose();
  });

  it('resubscribes with a contiguous Room cursor and preserves overlays on resume', async () => {
    const { connection } = createConnection();
    const received: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => received.push(event));
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'server-1', cursor: 0,
      resumed: false });
    sockets[0]!.emit({ type: 'draft', roomId: ROOM_A, agentId: 'agent', turnId: 'turn',
      text: 'Hello', revision: 0, sequence: 1 });
    connection.reconnect();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ type: 'subscribe', roomIds: [ROOM_A],
      cursors: { [ROOM_A]: { epoch: 'server-1', base: 1, seen: [] } } });
    sockets[1]!.emit({ type: 'subscribed', roomId: ROOM_A, epoch: 'server-1', cursor: 1,
      resumed: true });
    const late: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => late.push(event));
    expect(late.at(-1)).toEqual({ monolithLive: { type: 'draft', roomId: ROOM_A,
      agentId: 'agent', turnId: 'turn', text: 'Hello', revision: 0, sequence: 1 } });
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

  it('covers a no-room registration once per reopened socket and never on a timer', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const received: unknown[] = [];

    await connection.register([], (event) => received.push(event));
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([]);
    // Its own first read covers the first socket.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(received).toEqual([]);

    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.open();
    expect(received).toEqual([
      { monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } },
    ]);

    connection.dispose();
  });
  it('sends and delivers nothing while an open Room sits idle', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const first: unknown[] = [];
    const second: unknown[] = [];

    await connection.register([{ '#h': [ROOM_A] }], (event) => first.push(event));
    await connection.register([{ '#h': [ROOM_B] }], (event) => second.push(event));
    sockets[0]!.open();
    const sent = [...sockets[0]!.sent];

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(sockets[0]!.sent).toEqual(sent);
    expect(sockets).toHaveLength(1);

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

  it('notifies subscribeConnected on first connect and every reconnect, never in between', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const connectedCalls: number[] = [];
    let calls = 0;
    const unsubscribe = connection.subscribeConnected(() => {
      calls += 1;
      connectedCalls.push(calls);
    });
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    expect(calls).toBe(0);
    sockets[0]!.open();
    expect(calls).toBe(1);

    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message' });
    expect(calls).toBe(1);

    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(calls).toBe(2);

    unsubscribe();
    sockets[1]!.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[2]!.open();
    expect(calls).toBe(2);

    connection.dispose();
  });

  it('keeps an open socket after the foreground sync echo', async () => {
    vi.useFakeTimers();
    const { connection, foreground } = createConnection();
    const received: unknown[] = [];
    await connection.register([{ '#h': [ROOM_A] }], (event) => received.push(event));
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });

    foreground();
    expect(sockets[0]!.sent.at(-1)).toBe(JSON.stringify({ type: 'sync' }));
    const epoch = liveFrameEpoch();
    sockets[0]!.emit({ type: 'sync-ok' });
    expect(liveFrameEpoch()).toBe(epoch);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets).toHaveLength(1);
    expect(received).toEqual([{ monolithLive: { type: 'subscribed', roomId: ROOM_A } }]);

    connection.dispose();
  });

  it('reconnects when the foreground sync receives no echo', async () => {
    vi.useFakeTimers();
    const { connection, foreground } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    foreground();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] })]);

    connection.dispose();
  });

  it('replaces a socket stuck opening instead of waiting on it forever', async () => {
    vi.useFakeTimers();
    const { connection, foreground } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toContain(JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] }));

    connection.dispose();
  });

  it('Reproduction R1: replaces a socket that never delivered a message a push named', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    const room = vi.fn();
    await connection.register([{ '#h': [ROOM_A] }], room);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });

    // The network path dies: no frame and no close event reach the app, and
    // the next message arrives only as a push.
    connection.notePushedMessage(ROOM_A, 'm'.repeat(64));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(2);

    room.mockClear();
    sockets[1]!.open();
    expect(sockets[1]!.sent).toContain(JSON.stringify({ type: 'subscribe', roomIds: [ROOM_A] }));
    sockets[1]!.emit({ type: 'subscribed', roomId: ROOM_A });
    expect(room).toHaveBeenCalledWith({ monolithLive: { type: 'subscribed', roomId: ROOM_A } });

    connection.dispose();
  });

  it('keeps a socket that delivered the message a push named, before or after the push', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.open();
    sockets[0]!.emit({ type: 'subscribed', roomId: ROOM_A });
    const delta = (id: string) => ({
      type: 'message-delta',
      roomId: ROOM_A,
      message: { id, text: 'hi', createdAt: 1, author: { pubkey: 'a'.repeat(64), kind: 'agent' } },
    });

    sockets[0]!.emit(delta('1'.repeat(64)));
    connection.notePushedMessage(ROOM_A, '1'.repeat(64));
    connection.notePushedMessage(ROOM_A, '2'.repeat(64));
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[0]!.emit({ type: 'invalidate', roomId: ROOM_A, reason: 'message', messageId: '2'.repeat(64) });
    // A push for a Room this socket does not carry judges nothing.
    connection.notePushedMessage(ROOM_B, '3'.repeat(64));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);

    connection.dispose();
  });
  it('tells the server which Rooms are on screen, once each way, and again on a new socket', async () => {
    vi.useFakeTimers();
    const { connection } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    // A Room comes on screen before the socket opens: the open carries it.
    const releaseA = connection.view(ROOM_A);
    sockets[0]!.open();
    const viewing = (roomId: string, on: boolean) =>
      JSON.stringify({ type: 'viewing', roomId, viewing: on });
    expect(sockets[0]!.sent).toContain(viewing(ROOM_A, true));

    // A second holder of the same Room says nothing new; the last one leaving does.
    const releaseAgain = connection.view(ROOM_A);
    const releaseB = connection.view(ROOM_B);
    releaseAgain();
    releaseB();
    releaseB();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sockets[0]!.sent.filter((frame) => frame.includes('"viewing"'))).toEqual([
      viewing(ROOM_A, true),
      viewing(ROOM_B, true),
      viewing(ROOM_B, false),
    ]);

    // The server ended the old socket's views when it closed.
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.open();
    expect(sockets[1]!.sent.filter((frame) => frame.includes('"viewing"'))).toEqual([
      viewing(ROOM_A, true),
    ]);
    releaseA();
    expect(sockets[1]!.sent).toContain(viewing(ROOM_A, false));

    connection.dispose();
  });
  it('skips the reconnect backoff on foreground', async () => {
    vi.useFakeTimers();
    const { connection, foreground } = createConnection();
    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(sockets).toHaveLength(1);

    foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(2);

    connection.dispose();
  });

  it('reconnects on demand when a read proves the socket missed events', async () => {
    const { connection } = createConnection();
    connection.reconnect();
    expect(sockets).toHaveLength(0);

    await connection.register([{ '#h': [ROOM_A] }], () => undefined);
    connection.reconnect();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();

    connection.reconnect();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0]!.closed).toBe(true);
    connection.reconnect();
    expect(sockets).toHaveLength(2);

    connection.dispose();
  });

  it('covers a no-room registration after the foreground sync times out', async () => {
    vi.useFakeTimers();
    const { connection, foreground } = createConnection();
    const received: unknown[] = [];
    await connection.register([], (event) => received.push(event));
    sockets[0]!.open();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(received).toEqual([]);

    foreground();
    expect(sockets[0]!.sent.at(-1)).toBe(JSON.stringify({ type: 'sync' }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(received).toEqual([]);
    sockets[1]!.open();
    expect(received).toEqual([
      { monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } },
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
