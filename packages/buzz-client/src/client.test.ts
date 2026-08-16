import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import { signEvent, type NostrEvent } from '@beeline/nostr';

class ReconnectingTestWebSocket {
  static instances: ReconnectingTestWebSocket[] = [];
  readyState = 0;
  readonly sent: unknown[][] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(_url: string) {
    ReconnectingTestWebSocket.instances.push(this);
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

function streamEvent(id: string, createdAt: number, content: string): NostrEvent {
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: createdAt,
    kind: 9,
    tags: [['h', 'room-reconnect']],
    content,
    sig: 'b'.repeat(128),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  ReconnectingTestWebSocket.instances = [];
});

describe('Agent write permission', () => {
  it('signs a response bound to the permission, request, and agent', async () => {
    const identity = createIdentity('write-permission-client');
    let published: NostrEvent | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published = JSON.parse(String(init?.body)) as NostrEvent;
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity });

    await client.respondToWritePermission(
      'room-id',
      'permission-id',
      'request-id',
      'b'.repeat(64),
      'allow',
      'lunchboxfortwo/buzzy',
    );

    expect(published).toMatchObject({
      kind: 9,
      content: 'Allowed editing on lunchboxfortwo/buzzy.',
    });
    expect(published!.tags).toContainEqual(['h', 'room-id']);
    expect(published!.tags).toContainEqual(['p', 'b'.repeat(64)]);
    expect(published!.tags).toContainEqual(['t', 'buzz-write-permission-response']);
    expect(published!.tags).toContainEqual(['permission', 'permission-id']);
    expect(published!.tags).toContainEqual(['request', 'request-id']);
    expect(published!.tags).toContainEqual(['decision', 'allow']);
    expect(published!.tags).toContainEqual(['repo', 'lunchboxfortwo/buzzy']);
  });
});

describe('Agent presence', () => {
  it('queries replaceable Room presence by its d tag without the stream h filter', async () => {
    const reader = createIdentity('presence-reader');
    const agent = createIdentity('presence-agent');
    const roomId = 'presence-room';
    const event = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: 42,
        kind: 30078,
        tags: [
          ['d', `agent-presence:${roomId}`],
          ['h', roomId],
          ['t', 'agent-presence'],
          ['agent', agent.publicKey],
          ['status', 'online'],
        ],
        content: '',
      },
      agent.secretKey,
    );
    let filters: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        filters = JSON.parse(String(init?.body));
        return new Response(JSON.stringify([event]), { status: 200 });
      }),
    );
    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity: reader });

    await expect(client.agentPresenceBackfill(roomId)).resolves.toHaveLength(1);
    expect(filters).toEqual([
      {
        kinds: [30078],
        '#d': [`agent-presence:${roomId}`],
        limit: 20,
      },
    ]);
  });
});

describe('live Room subscriptions', () => {
  it('reissues its REQ from the last event cursor after a dropped socket', async () => {
    vi.useFakeTimers();
    const identity = createIdentity('reconnect-reader');
    const client = createBuzzClient({
      baseUrl: 'https://relay.test',
      identity,
      skipAuth: true,
      reconnectDelayMs: 1,
      WebSocketImpl: ReconnectingTestWebSocket,
    });
    const received: string[] = [];
    const unsubscribe = await client.sessionEventsSubscribe('room-reconnect', (event) => {
      received.push(event.content);
    });
    const firstSocket = ReconnectingTestWebSocket.instances[0]!;
    const initialReq = firstSocket.sent.find((frame) => frame[0] === 'REQ')!;
    const subId = initialReq[1] as string;

    firstSocket.receive(['EVENT', subId, streamEvent('first', 100, 'before drop')]);
    firstSocket.close();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTicks();

    const reconnectedSocket = ReconnectingTestWebSocket.instances[1]!;
    const resumedReq = reconnectedSocket.sent.find((frame) => frame[0] === 'REQ')!;
    expect(resumedReq).toEqual([
      'REQ',
      subId,
      { kinds: [9], '#h': ['room-reconnect'], since: 100 },
    ]);

    // This was published during the disconnect. The resumed request delivers
    // it without reopening the Room, and the cursor replay does not duplicate
    // the event from the last completed second.
    reconnectedSocket.receive(['EVENT', subId, streamEvent('gap', 101, 'during drop')]);
    reconnectedSocket.receive(['EVENT', subId, streamEvent('first', 100, 'before drop')]);
    expect(received).toEqual(['before drop', 'during drop']);

    unsubscribe();
    client.disconnect();
  });
});
