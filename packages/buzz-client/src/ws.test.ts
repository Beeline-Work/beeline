import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from './identity.js';
import { RelayWs, wsQueryEvents } from './ws.js';
import type { NostrEvent } from '@beeline/nostr';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: unknown[][] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
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
});

describe('wsQueryEvents', () => {
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
