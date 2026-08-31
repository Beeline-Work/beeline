import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from './identity.js';
import { RelayWs, reconnectDelayWithJitter, wsQueryEvents } from './ws.js';
import type { NostrEvent } from '@beeline/nostr';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  /** When > 0, the next N connections are refused (error+close, never open). */
  static refuseNext = 0;
  readyState = 0;
  readonly sent: unknown[][] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.refuseNext > 0) {
      FakeWebSocket.refuseNext -= 1;
      queueMicrotask(() => {
        this.emit('error', {});
        this.readyState = 3;
        this.emit('close', {});
      });
      return;
    }
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown[]);
  }

  /** Simulate a transport error WITHOUT a clean close (e.g. half-open TCP). */
  failWithoutClose(): void {
    this.emit('error', {});
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', {});
  }

  receive(message: unknown[]): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fakeEvent(id: string): NostrEvent {
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: 100,
    kind: 9,
    tags: [],
    content: id,
    sig: 'b'.repeat(128),
  };
}

/** REQ frames sent for a given subId across every FakeWebSocket instance seen so far. */
function reqFramesFor(subId: string): unknown[][] {
  return FakeWebSocket.instances
    .flatMap((socket) => socket.sent)
    .filter((frame) => frame[0] === 'REQ' && frame[1] === subId);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWebSocket.instances = [];
  FakeWebSocket.refuseNext = 0;
});

describe('wsQueryEvents', () => {
  it('signs NIP-42 for a Host-canonicalizing proxy instead of its loopback TCP route', async () => {
    const identity = createIdentity('ws-public-auth-origin');
    const ws = new RelayWs({
      wsUrl: 'ws://127.0.0.1:3010',
      authRelayUrl: 'ws://10.0.2.2:3010',
      identity,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const connecting = ws.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.receive(['AUTH', 'canonical-tenant-challenge']);
    await vi.waitFor(() => expect(socket.sent[0]?.[0]).toBe('AUTH'));

    const auth = socket.sent[0]?.[1] as NostrEvent;
    expect(auth.tags).toContainEqual(['relay', 'ws://10.0.2.2:3010']);
    socket.receive(['OK', auth.id, true]);
    await connecting;
    ws.close();
  });

  it('resolves with the collected events on EOSE and never leaves the subId subscribed', async () => {
    const identity = createIdentity('ws-query-eose');
    const ws = new RelayWs({
      wsUrl: 'wss://relay.test',
      identity,
      skipAuth: true,
      reconnectDelayMs: 1,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    await ws.connect();
    const socket = FakeWebSocket.instances[0]!;

    const pending = wsQueryEvents(ws, [{ kinds: [9], limit: 10 }]);
    const subId = socket.sent.find((frame) => frame[0] === 'REQ')![1] as string;

    socket.receive(['EVENT', subId, fakeEvent('one')]);
    socket.receive(['EVENT', subId, fakeEvent('two')]);
    socket.receive(['EOSE', subId]);

    const events = await pending;
    expect(events.map((event) => event.id)).toEqual(['one', 'two']);
    expect(socket.sent).toContainEqual(['CLOSE', subId]);

    // Regression: a later reconnect must not replay this one-shot REQ as a
    // live subscription — resubscribeLiveRequests() only resends whatever is
    // still tracked in RelayWs.subscriptions.
    socket.close();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(1));
    const reconnected = FakeWebSocket.instances[1]!;
    await vi.waitFor(() => expect(reconnected.readyState).toBe(1));
    expect(reqFramesFor(subId)).toHaveLength(1); // only the original REQ, no replay

    ws.close();
  });

  it('rejects on timeout and unsubscribes so a later reconnect does not replay the REQ', async () => {
    vi.useFakeTimers();
    const identity = createIdentity('ws-query-timeout');
    const ws = new RelayWs({
      wsUrl: 'wss://relay.test',
      identity,
      skipAuth: true,
      reconnectDelayMs: 1,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const connecting = ws.connect();
    await vi.advanceTimersByTimeAsync(0);
    await connecting;
    const socket = FakeWebSocket.instances[0]!;

    const pending = wsQueryEvents(ws, [{ kinds: [9] }], 50);
    const subId = socket.sent.find((frame) => frame[0] === 'REQ')![1] as string;

    const result = expect(pending).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(socket.sent).toContainEqual(['CLOSE', subId]);

    socket.close();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(1));
    const reconnected = FakeWebSocket.instances[1]!;
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(reconnected.readyState).toBe(1));
    expect(reqFramesFor(subId)).toHaveLength(1);

    ws.close();
  });

  it('rejects and unsubscribes when the socket closes before EOSE', async () => {
    const identity = createIdentity('ws-query-close');
    const ws = new RelayWs({
      wsUrl: 'wss://relay.test',
      identity,
      skipAuth: true,
      reconnectDelayMs: 1,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    await ws.connect();
    const socket = FakeWebSocket.instances[0]!;

    const pending = wsQueryEvents(ws, [{ kinds: [9] }]);
    const subId = socket.sent.find((frame) => frame[0] === 'REQ')![1] as string;

    socket.close();
    await expect(pending).rejects.toThrow(/socket closed/);

    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(1));
    const reconnected = FakeWebSocket.instances[1]!;
    await vi.waitFor(() => expect(reconnected.readyState).toBe(1));
    expect(reqFramesFor(subId)).toHaveLength(1);

    ws.close();
  });
});

/**
 * Every client that loses its socket to the SAME relay event used to come back
 * on the SAME schedule: 500ms, then 1s, 2s, 4s, exactly. That is a synchronised
 * herd arriving precisely while the relay is least able to take it, and every
 * failed round re-synchronises it. One daemon multiplies this by its Room count
 * before any other client is counted.
 */
describe('reconnect spacing does not put every client back at the door together', () => {
  it('spreads a round of reconnects across a window as wide as the delay', () => {
    const delays = [0, 0.25, 0.5, 0.75, 0.999].map((roll) =>
      reconnectDelayWithJitter(500, 0, 10_000, () => roll),
    );
    expect(new Set(delays).size).toBe(delays.length);
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThanOrEqual(400);
  });

  it('never retries sooner than half the schedule, so backoff still backs off', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const exact = Math.min(500 * 2 ** attempt, 10_000);
      for (const roll of [0, 0.5, 0.999]) {
        const delay = reconnectDelayWithJitter(500, attempt, 10_000, () => roll);
        expect(delay).toBeGreaterThanOrEqual(Math.round(exact * 0.5));
        expect(delay).toBeLessThanOrEqual(Math.round(exact * 1.5));
      }
    }
  });

  it('still grows with the attempt count and still respects the cap', () => {
    const mid = (attempt: number) => reconnectDelayWithJitter(500, attempt, 10_000, () => 0.5);
    expect(mid(1)).toBeGreaterThan(mid(0));
    expect(mid(2)).toBeGreaterThan(mid(1));
    // Capped before jitter, so the very longest wait stays bounded.
    expect(reconnectDelayWithJitter(500, 20, 10_000, () => 0.999)).toBeLessThanOrEqual(15_000);
  });

  it('never returns a zero delay, which would be a busy loop', () => {
    expect(reconnectDelayWithJitter(1, 0, 10_000, () => 0)).toBeGreaterThan(0);
  });
});

describe('idle WebSocket keepalive', () => {
  it('emits traffic on the timer and stops it when the socket closes', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const ws = new RelayWs({
      wsUrl: 'wss://relay.test',
      identity: createIdentity('ws-keepalive'),
      skipAuth: true,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const connecting = ws.connect();
    await vi.advanceTimersByTimeAsync(0);
    await connecting;
    const socket = FakeWebSocket.instances[0]!;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(socket.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const subId = socket.sent[0]?.[1];
    expect(subId).toMatch(/^keepalive-/);
    expect(socket.sent).toEqual([
      ['REQ', subId, { kinds: [0], limit: 0 }],
      ['CLOSE', subId],
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent).toHaveLength(4);

    ws.close();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(socket.sent).toHaveLength(4);
  });

  it('replaces rather than multiplies the timer after reconnect', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const ws = new RelayWs({
      wsUrl: 'wss://relay.test',
      identity: createIdentity('ws-keepalive-reconnect'),
      skipAuth: true,
      reconnectDelayMs: 1,
      keepaliveIntervalMs: 100,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const connecting = ws.connect();
    await vi.advanceTimersByTimeAsync(0);
    await connecting;
    const original = FakeWebSocket.instances[0]!;

    await vi.advanceTimersByTimeAsync(50);
    original.close();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    const replacement = FakeWebSocket.instances[1]!;

    await vi.advanceTimersByTimeAsync(99);
    expect(original.sent).toEqual([]);
    expect(replacement.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(original.sent).toEqual([]);
    expect(replacement.sent).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(replacement.sent).toHaveLength(4);

    ws.close();
  });
});

/**
 * Reproduction of the 2026-08-23 production darkness: a relay restart severs
 * every daemon socket, and the client must re-dial forever, replay its live
 * subscriptions on the replacement socket, and deliver events that arrive only
 * after the relay comes back.
 */
describe('relay connection loss is retried forever', () => {
  const waitFor = async (check: () => boolean, label: string, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  function lastSocket(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error('no FakeWebSocket instance');
    return socket;
  }

  async function connectedWs(): Promise<{
    ws: RelayWs;
    identity: ReturnType<typeof createIdentity>;
  }> {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const identity = createIdentity('ws-reconnect');
    const ws = new RelayWs({
      wsUrl: 'ws://relay.test',
      identity,
      skipAuth: true,
      reconnectDelayMs: 5,
    });
    await ws.connect();
    return { ws, identity };
  }

  it('re-dials after a server restart, replays the REQ, and delivers a post-reconnect event', async () => {
    const { ws } = await connectedWs();
    const received: NostrEvent[] = [];
    ws.subscribe([{ kinds: [9], '#h': ['room'] }], (event) => received.push(event));
    const initialReq = lastSocket().sent.find((frame) => frame[0] === 'REQ');
    lastSocket().receive(['EVENT', initialReq![1] as string, fakeEvent('before')]);
    expect(received.map((event) => event.id)).toEqual(['before']);

    try {
      // The relay restarts: a clean server-side close.
      lastSocket().close();

      // The client must dial again on its own — no external connect() call.
      await waitFor(() => FakeWebSocket.instances.length >= 2 && ws.connected, 're-dial');
      const replacement = lastSocket();
      expect(replacement).not.toBe(FakeWebSocket.instances[0]);

      // The live subscription is replayed on the replacement socket.
      const replayedReq = replacement.sent.find((frame) => frame[0] === 'REQ');
      expect(replayedReq).toEqual(['REQ', expect.any(String), { kinds: [9], '#h': ['room'] }]);

      // An event that arrives only after the reconnect is delivered.
      replacement.receive(['EVENT', replayedReq![1] as string, fakeEvent('after')]);
      expect(received.map((event) => event.id)).toEqual(['before', 'after']);
    } finally {
      ws.close();
    }
  });

  it('keeps dialing through refused connections and recovers when the relay returns', async () => {
    const { ws } = await connectedWs();
    const received: NostrEvent[] = [];
    ws.subscribe([{ kinds: [9], '#h': ['room'] }], (event) => received.push(event));
    try {
      // The outage: this close and the next three dials all fail.
      lastSocket().close();
      FakeWebSocket.refuseNext = 3;

      // The relay comes back after the refused window; the schedule is bounded
      // (5ms base here) so recovery happens without an unbounded wait, and the
      // attempts NEVER stop in between.
      await waitFor(
        () => FakeWebSocket.instances.length >= 5 && ws.connected,
        'recovery past refused dials',
        5_000,
      );
      const req = lastSocket().sent.find((frame) => frame[0] === 'REQ');
      expect(req).toBeDefined();
      lastSocket().receive(['EVENT', req![1] as string, fakeEvent('back')]);
      expect(received.map((event) => event.id)).toEqual(['back']);
    } finally {
      ws.close();
    }
  });

  it('treats a transport error on a live socket as connection loss and reconnects', async () => {
    const { ws } = await connectedWs();
    const received: NostrEvent[] = [];
    ws.subscribe([{ kinds: [9], '#h': ['room'] }], (event) => received.push(event));
    try {
      // Half-open TCP: the peer vanished without any close frame reaching us.
      lastSocket().failWithoutClose();

      await waitFor(
        () => FakeWebSocket.instances.length >= 2 && ws.connected,
        'post-error re-dial',
      );
      const req = lastSocket().sent.find((frame) => frame[0] === 'REQ');
      expect(req).toBeDefined();
      lastSocket().receive(['EVENT', req![1] as string, fakeEvent('resurrected')]);
      expect(received.map((event) => event.id)).toEqual(['resurrected']);
    } finally {
      ws.close();
    }
  });
});
