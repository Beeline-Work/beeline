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

function replaceableEvent(id: string, dKey: string, kind = 30078): NostrEvent {
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: 100,
    kind,
    tags: [['d', dKey]],
    content: '',
    sig: 'b'.repeat(128),
  };
}

function firstKeyOnlyMatches(
  filters: readonly Record<string, unknown>[],
  events: readonly NostrEvent[],
): NostrEvent[] {
  const matched = filters.flatMap((filter) => {
    const requested = (filter['#d'] as string[] | undefined) ?? [];
    const answered = requested.length > 1 ? requested.slice(0, 1) : requested;
    return events.filter((event) =>
      event.tags.some((tag) => tag[0] === 'd' && answered.includes(tag[1]!)),
    );
  });
  return [...new Map(matched.map((event) => [event.id, event])).values()];
}

function deliverFirstKeyOnlyMatches(
  socket: ReconnectingTestWebSocket,
  events: readonly NostrEvent[],
): void {
  const request = socket.sent.find((frame) => frame[0] === 'REQ')!;
  const subscriptionId = request[1] as string;
  const filters = request.slice(2) as Record<string, unknown>[];
  for (const event of firstKeyOnlyMatches(filters, events)) {
    socket.receive(['EVENT', subscriptionId, event]);
  }
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

describe('replaceable multi-lane reads', () => {
  it('backfills both draft lanes through one batch when multi-key #d filters answer partially', async () => {
    const identity = createIdentity('draft-reader');
    const events = [
      replaceableEvent('draft', 'agent-draft:room'),
      replaceableEvent('thought', 'agent-thought:room'),
    ];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const filters = JSON.parse(String(init?.body)) as Record<string, unknown>[];
      return new Response(JSON.stringify(firstKeyOnlyMatches(filters, events)), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity });

    await expect(client.agentDraftBackfill('room')).resolves.toEqual(events);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('backfills every corner state through one batch when multi-key #d filters answer partially', async () => {
    const identity = createIdentity('corner-state-reader');
    const events = [
      replaceableEvent('corner-1', 'buzz-corner-state:corner-1'),
      replaceableEvent('corner-2', 'buzz-corner-state:corner-2'),
    ];
    let requestedFilters: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedFilters = JSON.parse(String(init?.body)) as Record<string, unknown>[];
      return new Response(JSON.stringify(firstKeyOnlyMatches(requestedFilters, events)), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity });

    await expect(client.cornerStateBackfill(['corner-1', 'corner-1', 'corner-2'])).resolves.toEqual(
      events,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedFilters).toHaveLength(2);
  });

  it('subscribes to both draft lanes with independently answerable filters', async () => {
    const client = createBuzzClient({
      baseUrl: 'https://relay.test',
      identity: createIdentity('draft-subscriber'),
      skipAuth: true,
      WebSocketImpl: ReconnectingTestWebSocket,
    });
    const events = [
      replaceableEvent('draft', 'agent-draft:room'),
      replaceableEvent('thought', 'agent-thought:room'),
    ];
    const received: string[] = [];
    const unsubscribe = await client.agentDraftSubscribe('room', (event) =>
      received.push(event.id),
    );

    deliverFirstKeyOnlyMatches(ReconnectingTestWebSocket.instances[0]!, events);
    expect(received).toEqual(['draft', 'thought']);

    unsubscribe();
    client.disconnect();
  });

  it('subscribes to every corner state with independently answerable filters', async () => {
    const client = createBuzzClient({
      baseUrl: 'https://relay.test',
      identity: createIdentity('corner-state-subscriber'),
      skipAuth: true,
      WebSocketImpl: ReconnectingTestWebSocket,
    });
    const events = [
      replaceableEvent('corner-1', 'buzz-corner-state:corner-1'),
      replaceableEvent('corner-2', 'buzz-corner-state:corner-2'),
    ];
    const received: string[] = [];
    const unsubscribe = await client.cornerStateSubscribe(
      ['corner-1', 'corner-1', 'corner-2'],
      (event) => received.push(event.id),
    );

    const socket = ReconnectingTestWebSocket.instances[0]!;
    deliverFirstKeyOnlyMatches(socket, events);
    expect(received).toEqual(['corner-1', 'corner-2']);
    expect(socket.sent.find((frame) => frame[0] === 'REQ')!.slice(2)).toHaveLength(2);

    unsubscribe();
    client.disconnect();
  });

  it('does not declare an opaque surface subscription ready until initial replay reaches EOSE', async () => {
    const client = createBuzzClient({
      baseUrl: 'https://relay.test',
      identity: createIdentity('surface-subscriber'),
      skipAuth: true,
      WebSocketImpl: ReconnectingTestWebSocket,
    });
    const received: string[] = [];
    let ready = false;
    const pending = client
      .surfaceSubscribe([{ kinds: [9], '#h': ['room'] }], (event) => received.push(event.id))
      .then((unsubscribe) => {
        ready = true;
        return unsubscribe;
      });

    await vi.waitFor(() => expect(ReconnectingTestWebSocket.instances).toHaveLength(1));
    const socket = ReconnectingTestWebSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent.some((frame) => frame[0] === 'REQ')).toBe(true));
    const request = socket.sent.find((frame) => frame[0] === 'REQ')!;
    const subscriptionId = request[1] as string;
    socket.receive(['EVENT', subscriptionId, streamEvent('replay', 100, 'stored')]);
    await Promise.resolve();
    expect(received).toEqual(['replay']);
    expect(ready).toBe(false);

    socket.receive(['EOSE', subscriptionId]);
    const unsubscribe = await pending;
    expect(ready).toBe(true);

    unsubscribe();
    client.disconnect();
  });

  it('starts loopback surface subscriptions when the open relay sends no AUTH challenge', async () => {
    const client = createBuzzClient({
      baseUrl: 'http://127.0.0.1:3010',
      identity: createIdentity('local-open-surface-subscriber'),
      WebSocketImpl: ReconnectingTestWebSocket,
    });
    const pending = client.surfaceSubscribe([{ kinds: [9], '#h': ['room'] }], () => undefined);

    await vi.waitFor(() => expect(ReconnectingTestWebSocket.instances).toHaveLength(1));
    const socket = ReconnectingTestWebSocket.instances[0]!;
    await vi.waitFor(() => expect(socket.sent.some((frame) => frame[0] === 'REQ')).toBe(true));
    const request = socket.sent.find((frame) => frame[0] === 'REQ')!;
    socket.receive(['EOSE', request[1]]);

    const unsubscribe = await pending;
    unsubscribe();
    client.disconnect();
  });

  it('installs each opaque surface filter as an independently live REQ', async () => {
    const client = createBuzzClient({
      baseUrl: 'https://relay.test',
      identity: createIdentity('multi-filter-surface-subscriber'),
      skipAuth: true,
      WebSocketImpl: ReconnectingTestWebSocket,
    });
    const received: string[] = [];
    const pending = client.surfaceSubscribe(
      [
        { kinds: [9], '#h': ['room-reconnect'] },
        { kinds: [0], authors: ['a'.repeat(64)] },
      ],
      (event) => received.push(event.id),
    );

    await vi.waitFor(() => expect(ReconnectingTestWebSocket.instances).toHaveLength(1));
    const socket = ReconnectingTestWebSocket.instances[0]!;
    await vi.waitFor(() =>
      expect(socket.sent.filter((frame) => frame[0] === 'REQ')).toHaveLength(2),
    );
    const requests = socket.sent.filter((frame) => frame[0] === 'REQ');
    expect(requests.every((frame) => frame.slice(2).length === 1)).toBe(true);

    const event = streamEvent('overlap', 101, 'one dirty signal');
    for (const request of requests) {
      socket.receive(['EVENT', request[1], event]);
      socket.receive(['EOSE', request[1]]);
    }
    const unsubscribe = await pending;
    expect(received).toEqual(['overlap']);

    unsubscribe();
    client.disconnect();
  });

  it('expands a multi-channel surface watch into one live REQ per channel', async () => {
    const client = createBuzzClient({
      baseUrl: 'https://relay.test',
      identity: createIdentity('multi-channel-surface-subscriber'),
      skipAuth: true,
      WebSocketImpl: ReconnectingTestWebSocket,
    });
    const received: string[] = [];
    const pending = client.surfaceSubscribe(
      [{ kinds: [9], '#h': ['room-reconnect', 'corner-reconnect'] }],
      (event) => received.push(event.id),
    );

    await vi.waitFor(() => expect(ReconnectingTestWebSocket.instances).toHaveLength(1));
    const socket = ReconnectingTestWebSocket.instances[0]!;
    await vi.waitFor(() =>
      expect(socket.sent.filter((frame) => frame[0] === 'REQ')).toHaveLength(2),
    );
    const requests = socket.sent.filter((frame) => frame[0] === 'REQ');
    expect(requests.map((frame) => frame[2])).toEqual([
      { kinds: [9], '#h': ['room-reconnect'] },
      { kinds: [9], '#h': ['corner-reconnect'] },
    ]);

    const roomEvent = streamEvent('room-event', 101, 'room changed');
    const cornerEvent = {
      ...streamEvent('corner-event', 102, 'corner changed'),
      tags: [['h', 'corner-reconnect']],
    };
    socket.receive(['EVENT', requests[0]![1], roomEvent]);
    socket.receive(['EVENT', requests[1]![1], cornerEvent]);
    for (const request of requests) socket.receive(['EOSE', request[1]]);
    const unsubscribe = await pending;
    expect(received).toEqual(['room-event', 'corner-event']);

    unsubscribe();
    client.disconnect();
  });

  it('expands multi-key d surface watches into one live REQ per exact key', async () => {
    const client = createBuzzClient({
      baseUrl: 'https://relay.test',
      identity: createIdentity('multi-key-surface-subscriber'),
      skipAuth: true,
      WebSocketImpl: ReconnectingTestWebSocket,
    });
    const pending = client.surfaceSubscribe(
      [{ kinds: [30078], '#d': ['workspace:agent-one', 'workspace:agent-two'] }],
      () => undefined,
    );

    await vi.waitFor(() => expect(ReconnectingTestWebSocket.instances).toHaveLength(1));
    const socket = ReconnectingTestWebSocket.instances[0]!;
    await vi.waitFor(() =>
      expect(socket.sent.filter((frame) => frame[0] === 'REQ')).toHaveLength(2),
    );
    const requests = socket.sent.filter((frame) => frame[0] === 'REQ');
    expect(requests.map((frame) => frame[2])).toEqual([
      { kinds: [30078], '#d': ['workspace:agent-one'] },
      { kinds: [30078], '#d': ['workspace:agent-two'] },
    ]);
    for (const request of requests) socket.receive(['EOSE', request[1]]);
    const unsubscribe = await pending;
    unsubscribe();
    client.disconnect();
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

describe('succession-aware communityMembers', () => {
  const communityId = '33333333-3333-4333-8333-333333333333';

  function rosterResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function stubFetch(handlers: {
    predecessors?: string[] | Error;
    onQuery?: (filter: Record<string, unknown>) => unknown[] | undefined;
  }): { fetchMock: ReturnType<typeof vi.fn>; predecessorCalls: () => number } {
    let predecessorCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/oidc/predecessors/')) {
        predecessorCount += 1;
        if (handlers.predecessors instanceof Error) throw handlers.predecessors;
        return rosterResponse({ predecessors: handlers.predecessors ?? [] });
      }
      const filter = JSON.parse(String(init?.body))[0] as Record<string, unknown>;
      const served = handlers.onQuery?.(filter);
      return rosterResponse(served ?? []);
    });
    return { fetchMock, predecessorCalls: () => predecessorCount };
  }

  it('lazily loads the succession chain once and inherits the create author role', async () => {
    const identity = createIdentity('succession-client');
    const predecessor = createIdentity('succession-predecessor');
    const create = signEvent(
      {
        pubkey: predecessor.publicKey,
        created_at: 1_700_000_000,
        kind: 9007,
        tags: [
          ['h', communityId],
          ['name', 'Builders'],
          ['community', communityId],
        ],
        content: '',
      },
      predecessor.secretKey,
    );
    const members = signEvent(
      {
        pubkey: predecessor.publicKey,
        created_at: 1_700_000_001,
        kind: 39002,
        tags: [
          ['d', communityId],
          ['p', predecessor.publicKey],
        ],
        content: '',
      },
      predecessor.secretKey,
    );
    const { fetchMock, predecessorCalls } = stubFetch({
      predecessors: [predecessor.publicKey],
      onQuery: (filter) => {
        if ((filter.kinds as number[])?.includes(9007)) return [create];
        if ((filter.kinds as number[])?.includes(39002)) return [members];
        return [];
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity });

    const roles = await client.communityMembers(communityId);
    expect(roles).toEqual([{ pubkey: identity.publicKey, role: 'owner' }]);

    // A second read reuses the cached chain — one auth probe per client.
    await client.communityMembers(communityId);
    expect(predecessorCalls()).toBe(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('degrades to published roles when the auth service is unreachable', async () => {
    const identity = createIdentity('succession-offline');
    const owner = createIdentity('succession-owner');
    const create = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: 1_700_000_000,
        kind: 9007,
        tags: [
          ['h', communityId],
          ['name', 'Builders'],
          ['community', communityId],
        ],
        content: '',
      },
      owner.secretKey,
    );
    const members = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: 1_700_000_001,
        kind: 39002,
        tags: [
          ['d', communityId],
          ['p', owner.publicKey],
          ['p', identity.publicKey],
        ],
        content: '',
      },
      owner.secretKey,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/auth/oidc/predecessors/')) throw new Error('auth down');
        const filter = JSON.parse(String(init?.body))[0] as Record<string, unknown>;
        if ((filter.kinds as number[])?.includes(9007)) return rosterResponse([create]);
        if ((filter.kinds as number[])?.includes(39002)) return rosterResponse([members]);
        return rosterResponse([]);
      }),
    );

    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity });
    const roles = await client.communityMembers(communityId);
    const byPubkey = new Map(roles.map((member) => [member.pubkey, member.role]));
    expect(byPubkey.get(owner.publicKey)).toBe('owner');
    expect(byPubkey.get(identity.publicKey)).toBe('member');
  });

  it('honors an explicitly seeded chain without touching the auth service', async () => {
    const identity = createIdentity('succession-seeded');
    const adminPredecessor = createIdentity('succession-admin');
    const owner = createIdentity('succession-owner2');
    const create = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: 1_700_000_000,
        kind: 9007,
        tags: [
          ['h', communityId],
          ['name', 'Builders'],
          ['community', communityId],
        ],
        content: '',
      },
      owner.secretKey,
    );
    const admins = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: 1_700_000_001,
        kind: 39001,
        tags: [
          ['d', communityId],
          ['p', owner.publicKey, 'owner'],
          ['p', adminPredecessor.publicKey, 'admin'],
        ],
        content: '',
      },
      owner.secretKey,
    );
    const members = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: 1_700_000_002,
        kind: 39002,
        tags: [
          ['d', communityId],
          ['p', owner.publicKey],
        ],
        content: '',
      },
      owner.secretKey,
    );
    const { fetchMock, predecessorCalls } = stubFetch({
      predecessors: [adminPredecessor.publicKey],
      onQuery: (filter) => {
        if ((filter.kinds as number[])?.includes(9007)) return [create];
        if ((filter.kinds as number[])?.includes(39001)) return [admins];
        if ((filter.kinds as number[])?.includes(39002)) return [members];
        return [];
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createBuzzClient({ baseUrl: 'https://relay.test', identity });
    client.setSuccessionPredecessors([adminPredecessor.publicKey]);

    const roles = await client.communityMembers(communityId);
    const byPubkey = new Map(roles.map((member) => [member.pubkey, member.role]));
    expect(byPubkey.get(identity.publicKey)).toBe('admin');
    expect(byPubkey.has(adminPredecessor.publicKey)).toBe(false);
    expect(predecessorCalls()).toBe(0); // seeded chain never fetched
  });
});
