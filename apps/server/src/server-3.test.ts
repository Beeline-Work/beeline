import { phoneFetch, AddressInfo, WebSocket, describe, expect, it, vi, LiveHub, createBeelineServer, maxLiveDbTasks, canReadRoomsFrom, nextSocketMessage, nextSocketMessages, expectNoSocketMessage, fixtureScope4, type TokenAuth, type PhoneService, type DaemonService } from './server.test-support.js';

describe('phone committed-row live delivery', () => {
const scope4 = fixtureScope4();


  it('sends a person change to who shares a scope, and the push level only to its owner', async () => {
    const person = { pubkey: 'mate', kind: 'human' as const, name: 'Mate Renamed' };
    const self = { pubkey: 'viewer', kind: 'human' as const, name: 'Viewer' };
    const livePersonChange = vi.fn().mockImplementation(async (personId: string) =>
      personId === 'mate' ? { person, pushLevel: 'full', viewers: new Set(['mate', 'viewer']) }
        : personId === 'viewer' ? { person: self, pushLevel: 'off', viewers: new Set(['viewer']) }
          : { person: { ...person, pubkey: 'stranger' }, pushLevel: 'attention',
            viewers: new Set(['stranger']) });
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, undefined, undefined, undefined,
      { livePersonChange } as Partial<PhoneService>);
    const mate = nextSocketMessage(socket, 'person-changed');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:identities', personId: 'mate' });
    await expect(mate).resolves.toEqual({ type: 'person-changed', roomId: '', person });
    const own = nextSocketMessage(socket, 'person-changed');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:identities', personId: 'viewer' });
    await expect(own).resolves.toEqual({ type: 'person-changed', roomId: '', person: self,
      pushLevel: 'off' });
    const noLeak = expectNoSocketMessage(socket, 100);
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:identities',
      personId: 'stranger' });
    await noLeak;
  });


  it('reads a bookmark once and sends the typed change to both devices', async () => {
    const bookmark = { messageId: 'saved', workspaceId: 'workspace', roomId: 'room-live',
      roomName: 'Room', roomKind: 'room' as const, messageCreatedAt: 1,
      bookmarkedAt: 2, available: true };
    const read = vi.fn().mockResolvedValue(bookmark);
    const { live, socket, port } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, undefined, read as PhoneService['readLiveBookmark']);
    const second = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    scope4.sockets.push(second);
    await new Promise<void>((resolve, reject) => {
      second.once('open', resolve);
      second.once('error', reject);
    });
    const firstFrame = nextSocketMessage(socket, 'bookmark-delta');
    const secondFrame = nextSocketMessage(second, 'bookmark-delta');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:message_bookmarks',
      readerId: 'viewer', workspaceId: 'workspace', messageId: 'saved' });
    await expect(firstFrame).resolves.toMatchObject({ bookmark, messageId: 'saved' });
    await expect(secondFrame).resolves.toMatchObject({ bookmark, messageId: 'saved' });
    expect(read).toHaveBeenCalledTimes(1);
    const removed = nextSocketMessage(socket, 'bookmark-delta');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:message_bookmarks',
      readerId: 'viewer', workspaceId: 'workspace', messageId: 'saved', operation: 'DELETE' });
    await expect(removed).resolves.toMatchObject({ messageId: 'saved', bookmark: null });
    expect(read).toHaveBeenCalledTimes(1);
  });


  it('sends one server-derived Needs-you room slice to each device', async () => {
    const roomId = 'room-live';
    const message = { id: 'ask', text: '@viewer please review', createdAt: 1,
      author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
      presentation: 'message' as const, mentionPubkeys: ['viewer'] };
    const batch = vi.fn().mockImplementation(async (_roomId, viewers: string[]) =>
      new Map(viewers.map((viewer) => [viewer,
        { type: 'message-delta', roomId, message }])));
    const needs = { workspaceId: 'workspace', count: 1,
      items: [{ messageId: 'ask', workspaceId: 'workspace', roomId,
        roomName: 'Room', roomKind: 'room', text: 'please review', createdAt: 1 }] };
    const readNeeds = vi.fn().mockResolvedValue(needs);
    const { live, socket, port } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas'],
      undefined, readNeeds as PhoneService['liveNeedsYou']);
    const second = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    scope4.sockets.push(second);
    await new Promise<void>((resolve, reject) => {
      second.once('open', resolve);
      second.once('error', reject);
    });
    const subscribed = nextSocketMessage(second, 'subscribed');
    second.send(JSON.stringify({ type: 'subscribe', roomId }));
    await subscribed;
    const first = nextSocketMessage(socket, 'needs-you-delta');
    const next = nextSocketMessage(second, 'needs-you-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
      operation: 'INSERT', messageId: 'ask', needsYouCandidate: true,
      agentId: 'agent' });
    await expect(first).resolves.toMatchObject({ type: 'needs-you-delta', count: 1,
      sourceRoomId: roomId, items: needs.items });
    await expect(next).resolves.toMatchObject({ type: 'needs-you-delta', count: 1 });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(readNeeds).toHaveBeenCalledTimes(1);
  });


  it('sends one fallback for a row that projects no delta', async () => {
    const { live, roomId, socket } = await scope4.connect(
      vi.fn().mockResolvedValue(null) as PhoneService['readLiveDelta'],
    );
    const invalidated = nextSocketMessage(socket, 'invalidate');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:messages',
      operation: 'UPDATE',
      messageId: 'message-hidden',
    });

    await expect(invalidated).resolves.toMatchObject({
      reason: 'delta-fallback:postgres:messages',
    });
    await expectNoSocketMessage(socket, 100);
  });


  it.each([
    ['deleted', vi.fn().mockResolvedValue(null)],
    ['failed', vi.fn().mockRejectedValue(new Error('row read failed'))],
  ])(
    'sends one fallback when the delta read is %s',
    async (_case, read) => {
      const { live, roomId, socket } = await scope4.connect(read as PhoneService['readLiveDelta']);
      const fallbackFrame = nextSocketMessage(socket, 'invalidate');

      live.publish({
        type: 'invalidate',
        roomId,
        reason: 'postgres:messages',
        operation: 'DELETE',
        messageId: 'message-fallback',
      });

      const fallback = await fallbackFrame;
      // A deleted row or failed read still reaches a list waiting on the row.
      expect(fallback).toMatchObject({
        type: 'invalidate',
        roomId,
        reason: 'delta-fallback:postgres:messages',
      });
      expect(fallback).not.toHaveProperty('messageId');
      await expectNoSocketMessage(socket, 100);
    },
  );


  it('scales live admission with the app pool and leaves ordinary requests four', () => {
    expect(maxLiveDbTasks(undefined)).toBe(2);
    expect(maxLiveDbTasks(5)).toBe(2);
    expect(maxLiveDbTasks(10)).toBe(6);
  });


  it('turns a named phone-write into a message-delta for an already-open Room', async () => {
    const delta = {
      type: 'message-delta' as const,
      roomId: 'room-live',
      message: {
        id: 'posted-message',
        text: 'hello',
        createdAt: 1,
        author: { pubkey: 'human', kind: 'human' as const, name: 'Captain' },
        presentation: 'message' as const,
      },
    };
    const read = vi.fn().mockResolvedValue(delta);
    const { live, roomId, socket } = await scope4.connect(read as PhoneService['readLiveDelta']);
    const painted = nextSocketMessage(socket, 'message-delta');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'phone-write',
      messageId: 'posted-message',
    });

    await expect(painted).resolves.toEqual({ ...delta });
    await expectNoSocketMessage(socket, 100);
    expect(read).toHaveBeenCalledWith(roomId, 'viewer', {
      type: 'message',
      messageId: 'posted-message',
    });
  });


  it('falls back to an authoritative invalidation when committed-row projection fails', async () => {
    const read = vi.fn();
    const project = vi.fn(() => {
      throw new Error('projection failed');
    });
    const { live, roomId, socket } = await scope4.connect(
      read as PhoneService['readLiveDelta'],
      project as PhoneService['projectCommittedLiveDelta'],
    );
    const fallback = nextSocketMessage(socket, 'invalidate');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      messageId: 'message-fallback',
      committedRow: {
        type: 'message',
        row: { room_id: roomId } as never,
      },
    });

    await expect(fallback).resolves.toMatchObject({
      type: 'invalidate',
      roomId,
      reason: 'delta-fallback:message',
    });
    expect(read).not.toHaveBeenCalled();
  });


  it('keeps later committed deltas direct when an earlier lookup stalls', async () => {
    const read = vi.fn(
      async (_roomId: string, _viewerId: string, target: { messageId: string }) => {
        if (target.messageId === 'message-1') return new Promise<never>(() => undefined);
        return {
          type: 'message-delta' as const,
          roomId: 'room-live',
          message: {
            id: target.messageId,
            text: target.messageId,
            createdAt: Number(target.messageId.at(-1)),
            author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
            presentation: 'message' as const,
          },
        };
      },
    );
    const { live, roomId, socket } = await scope4.connect(read as PhoneService['readLiveDelta']);
    const received = nextSocketMessages(socket, 2);
    const startedAt = Date.now();

    for (const messageId of ['message-1', 'message-2', 'message-3']) {
      live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId });
    }

    const messages = await received;
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(messages.map((message) => message.type)).toEqual(['message-delta', 'message-delta']);
    expect(
      messages.map((message) => (message.message as { id: string }).id),
    ).toEqual(['message-2', 'message-3']);
    expect(read).toHaveBeenCalledTimes(3);
  });


  it.each([
    [
      'SYNC-01',
      {
        reason: 'postgres:messages',
        messageId: 'message-stalled',
      },
    ],
    [
      'STOP-01',
      {
        reason: 'postgres:agent_turns',
        agentId: 'agent-stopped',
        requestId: 'request-stopped',
      },
    ],
  ])('keeps %s to one frame while its delta projection remains stalled', async (_id, row) => {
    let resolveRead!: (value: unknown) => void;
    const read = vi.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { live, roomId, socket } = await scope4.connect(read as PhoneService['readLiveDelta']);

    live.publish({ type: 'invalidate', roomId, ...row });
    await expectNoSocketMessage(socket, 100);
    const delivered = nextSocketMessage(socket, 'invalidate');
    resolveRead(null);
    await expect(delivered).resolves.toMatchObject({ type: 'invalidate', roomId,
      reason: `delta-fallback:${row.reason}` });
  });


  it('preserves the direct delta after the immediate invalidation for a slow projection', async () => {
    const delta = {
      type: 'message-delta' as const,
      roomId: 'room-live',
      message: {
        id: 'message-slow',
        text: 'slow but direct',
        createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
        presentation: 'message' as const,
      },
    };
    const read = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
      return delta;
    });
    const { live, roomId, socket } = await scope4.connect(read as PhoneService['readLiveDelta']);
    const received = nextSocketMessage(socket, 'message-delta');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:messages',
      messageId: 'message-slow',
    });

    await expect(received).resolves.toMatchObject({
      ...delta,
    });
  });


  it('suppresses the duplicate direct/PG projection of one committed row', async () => {
    const delta = {
      type: 'message-delta' as const,
      roomId: 'room-live',
      message: { id: 'message-duplicate', text: 'once', createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
        presentation: 'message' as const },
    };
    const read = vi.fn().mockResolvedValue(delta);
    const project = vi.fn().mockReturnValue(delta);
    const { live, roomId, socket } = await scope4.connect(
      read as PhoneService['readLiveDelta'], project as PhoneService['projectCommittedLiveDelta']);
    const first = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: delta.message.id,
      committedRow: { type: 'message', row: { room_id: roomId, id: delta.message.id } as never } });
    await expect(first).resolves.toEqual({ ...delta });
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
      operation: 'INSERT', messageId: delta.message.id });
    await expectNoSocketMessage(socket, 100);
    expect(read).not.toHaveBeenCalled();
    expect(project).toHaveBeenCalledTimes(1);
  });


  it('serializes only a public delta and drops a cross-Room committed row', async () => {
    const delta = {
      type: 'message-delta' as const,
      roomId: 'room-live',
      message: {
        id: 'message-public',
        text: 'public text',
        createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
        presentation: 'message' as const,
      },
    };
    const read = vi.fn().mockResolvedValue(null);
    const project = vi.fn((eventRoom: string, committed: { row: { room_id: string } }) =>
      committed.row.room_id === eventRoom ? delta : null,
    );
    const recordedEvents = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const { live, roomId, socket, port } = await scope4.connect(
      read as PhoneService['readLiveDelta'],
      project as PhoneService['projectCommittedLiveDelta'],
      vi.fn().mockResolvedValue(true),
      true,
      recordedEvents,
    );
    const rawMarker = 'raw-committed-row-must-not-cross-wire';
    const startedAt = Date.now();
    const trace = {
      id: 'same-clock-paint-proof',
      startedAt,
      databaseAt: startedAt,
      emittedAt: Date.now(),
    };
    socket.send(JSON.stringify({ type: 'trace-paint', id: 'never-emitted-on-this-socket' }));
    await expectNoSocketMessage(socket);
    const publicMessage = nextSocketMessage(socket, 'message-delta');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      messageId: delta.message.id,
      trace,
      committedRow: {
        type: 'message',
        row: { room_id: roomId, text: rawMarker } as never,
      },
    });
    const delivered = await publicMessage;
    expect(delivered).toEqual({ ...delta, trace });
    expect(JSON.stringify(delivered)).not.toContain(rawMarker);
    expect(delivered).not.toHaveProperty('committedRow');
    const otherSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    scope4.sockets.push(otherSocket);
    await new Promise<void>((resolve, reject) => {
      otherSocket.once('open', resolve);
      otherSocket.once('error', reject);
    });
    otherSocket.send(JSON.stringify({ type: 'trace-paint', id: trace.id }));
    await expectNoSocketMessage(otherSocket);
    const paintAck = nextSocketMessage(socket, 'trace-painted');
    socket.send(JSON.stringify({ type: 'trace-paint', id: trace.id }));
    await expect(paintAck).resolves.toMatchObject({
      type: 'trace-painted',
      id: trace.id,
      startedAt,
      databaseAt: startedAt,
      serverReceivedAt: expect.any(Number),
      upperBoundMs: expect.any(Number),
    });
    const acknowledged = await paintAck;
    expect(recordedEvents).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO operator_function_events'),
      ['message_delivery', expect.any(Number), false],
    );
    expect(acknowledged.serverReceivedAt as number).toBeGreaterThanOrEqual(startedAt);
    expect((acknowledged.serverReceivedAt as number) - startedAt).toBeLessThan(100);
    socket.send(JSON.stringify({ type: 'trace-paint', id: trace.id }));
    await expectNoSocketMessage(socket);

    let unexpected = false;
    const onMessage = () => {
      unexpected = true;
    };
    socket.on('message', onMessage);
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      messageId: 'message-cross-room',
      committedRow: {
        type: 'message',
        row: { room_id: 'another-room', text: rawMarker } as never,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.off('message', onMessage);
    expect(unexpected).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });


  it('takes one diagnostics-gated DB-clock sample after a cross-process paint', async () => {
    const databaseAt = 1_000;
    const databaseQuery = vi.fn().mockResolvedValue({
      rows: [{ clock_at: new Date(databaseAt + 240) }],
      rowCount: 1,
    });
    const delta = {
      type: 'turn-delta' as const,
      roomId: 'room-live',
      turn: {
        requestId: 'request',
        agentId: 'agent',
        status: 'working' as const,
        createdAt: 1,
      },
    };
    const { live, roomId, socket } = await scope4.connect(
      vi.fn().mockResolvedValue(delta),
      undefined,
      undefined,
      true,
      databaseQuery,
    );
    const delivered = nextSocketMessage(socket, 'turn-delta');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_turns',
      agentId: 'agent',
      requestId: 'request',
      trace: { id: 'database-clock-trace', databaseAt, emittedAt: databaseAt + 10 },
    });
    await expect(delivered).resolves.toMatchObject({
      trace: { id: 'database-clock-trace', paintAck: 'database-clock' },
    });

    const painted = nextSocketMessage(socket, 'trace-painted');
    socket.send(JSON.stringify({ type: 'trace-paint', id: 'database-clock-trace' }));
    await expect(painted).resolves.toMatchObject({
      type: 'trace-painted',
      id: 'database-clock-trace',
      databaseAt,
      databaseClockAt: databaseAt + 240,
      upperBoundMs: 240,
    });
    expect(databaseQuery).toHaveBeenCalledOnce();
    socket.send(JSON.stringify({ type: 'trace-paint', id: 'database-clock-trace' }));
    await expectNoSocketMessage(socket);
    expect(databaseQuery).toHaveBeenCalledOnce();
  });


  it('contains a failed paint-clock read and keeps serving HTTP', async () => {
    const query = vi.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const { live, roomId, socket, port } = await scope4.connect(
      vi.fn().mockResolvedValue({
        type: 'turn-delta',
        roomId: 'room-live',
        turn: { requestId: 'request', agentId: 'agent', status: 'working', createdAt: 1 },
      }),
      undefined,
      undefined,
      true,
      query,
    );
    const delivered = nextSocketMessage(socket, 'turn-delta');
    live.publish({
      type: 'invalidate', roomId, reason: 'postgres:agent_turns',
      agentId: 'agent', requestId: 'request',
      trace: { id: 'failed-clock', databaseAt: 1, emittedAt: 2 },
    });
    await delivered;
    const failed = new Promise<Record<string, unknown>>(resolve => socket.once('message', raw => resolve(JSON.parse(raw.toString()))));
    socket.send(JSON.stringify({ type: 'trace-paint', id: 'failed-clock' }));
    await expect(failed).resolves.toMatchObject({ t: 'res', id: 'failed-clock', ok: false, error: { code: 'unavailable' } });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(query).toHaveBeenCalledOnce();
    expect((await phoneFetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });


  it('never subscribes or projects a committed row for an unauthorized viewer', async () => {
    const read = vi.fn();
    const project = vi.fn();
    const roomId = 'room-live';
    const live = new LiveHub();
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: {
        canReadRoom: vi.fn().mockResolvedValue(false),
        canReadRooms: canReadRoomsFrom(async () => false),
        liveDraftSnapshot: vi.fn().mockResolvedValue([]),
        readLiveDelta: read,
        projectCommittedLiveDelta: project,
      } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    scope4.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    scope4.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    let received = false;
    socket.on('message', () => {
      received = true;
    });
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      messageId: 'secret-message',
      committedRow: {
        type: 'message',
        row: { room_id: roomId, text: 'raw-secret' } as never,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(received).toBe(false);
    expect(project).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });


  it('strips a raw committed row even when an invalidation has no delta target', async () => {
    const read = vi.fn();
    const project = vi.fn();
    const { live, roomId, socket } = await scope4.connect(
      read as PhoneService['readLiveDelta'],
      project as PhoneService['projectCommittedLiveDelta'],
    );
    const invalidation = nextSocketMessage(socket, 'invalidate');

    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'message',
      committedRow: {
        type: 'message',
        row: { room_id: roomId, text: 'raw-secret' } as never,
      },
    });

    const delivered = await invalidation;
    expect(delivered).toEqual({ type: 'invalidate', roomId, reason: 'message' });
    expect(JSON.stringify(delivered)).not.toContain('raw-secret');
    expect(project).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });


  it('authorizes a multi-Room subscribe batch with one canReadRooms call', async () => {
    const allowedRoom = 'room-allowed';
    const deniedRoom = 'room-denied';
    const canReadRooms = vi.fn(async (roomIds: readonly string[]) => {
      expect(roomIds).toEqual([allowedRoom, deniedRoom]);
      return new Set([allowedRoom]);
    });
    const read = vi.fn();
    const project = vi.fn().mockImplementation((_roomId: string, committed: { row: { id: string } }) => ({
      type: 'message-delta' as const,
      roomId: allowedRoom,
      message: {
        id: committed.row.id,
        text: 'ok',
        createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' },
        presentation: 'message' as const,
      },
    }));
    const live = new LiveHub();
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: {
        canReadRoom: vi.fn(),
        canReadRooms,
        liveDraftSnapshot: vi.fn().mockResolvedValue([]),
        readLiveDelta: read,
        projectCommittedLiveDelta: project,
      } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    scope4.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
    scope4.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const subscribed = nextSocketMessage(socket, 'subscribed');
    socket.send(JSON.stringify({ type: 'subscribe', roomIds: [allowedRoom, deniedRoom] }));
    await expect(subscribed).resolves.toMatchObject({ type: 'subscribed', roomId: allowedRoom });
    expect(canReadRooms).toHaveBeenCalledTimes(1);
    expect(canReadRooms).toHaveBeenCalledWith([allowedRoom, deniedRoom], 'viewer');
    await expectNoSocketMessage(socket);

    const allowedDelta = nextSocketMessage(socket, 'message-delta');
    live.publish({
      type: 'invalidate',
      roomId: allowedRoom,
      reason: 'message',
      messageId: 'allowed-message',
      committedRow: {
        type: 'message',
        row: { room_id: allowedRoom, id: 'allowed-message' },
      },
    });
    await expect(allowedDelta).resolves.toMatchObject({
      type: 'message-delta',
      roomId: allowedRoom,
    });

    live.publish({
      type: 'invalidate',
      roomId: deniedRoom,
      reason: 'message',
      messageId: 'secret-message',
      committedRow: {
        type: 'message',
        row: { room_id: deniedRoom, id: 'secret-message', text: 'raw-secret' },
      },
    });
    await expectNoSocketMessage(socket);
    expect(project).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });
});
describe('live reconnect admission', () => {
  it('accepts a large subscribe and keeps the phone open if its read fails', async () => {
    const canReadRooms = vi.fn().mockRejectedValue(new Error('read unavailable'));
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('viewer') } as unknown as TokenAuth,
      phone: { canReadRooms } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    let socket: WebSocket | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
      await new Promise<void>((resolve, reject) => {
        socket!.once('open', () => resolve());
        socket!.once('error', reject);
      });
      const reloaded = new Promise<Record<string, unknown>>(resolve => socket!.once('message', raw => resolve(JSON.parse(raw.toString()))));
      socket.send(JSON.stringify({
        type: 'subscribe', roomIds: Array.from({ length: 33 }, (_, index) => `room-${index}`),
      }));
      await expect(reloaded).resolves.toMatchObject({ type: 'reload', roomId: 'room-0' });
      expect(canReadRooms).toHaveBeenCalledOnce();
      const pong = new Promise<Record<string, unknown>>(resolve => {
        socket!.on('message', raw => { const value = JSON.parse(raw.toString()); if (value.type === 'pong') resolve(value); });
      });
      socket.send(JSON.stringify({ type: 'ping' }));
      await expect(pong).resolves.toEqual({ type: 'pong' });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket?.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it('admits a restarted helper over its zombie sockets and pongs while the database gate is full', async () => {
    const stalledReads: Array<() => void> = [];
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticateDaemon: vi.fn(async () => 'agent-restarted'),
        authenticatePhone: vi.fn(async (token: string) => token),
      } as unknown as TokenAuth,
      phone: {
        canReadRooms: vi.fn(() => new Promise<Set<string>>((resolve) => {
          stalledReads.push(() => resolve(new Set()));
        })),
      } as unknown as PhoneService,
      daemon: {} as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    const sockets: WebSocket[] = [];
    const open = (protocol: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, [protocol]);
      sockets.push(socket);
      return new Promise<WebSocket>((resolve, reject) => {
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
      });
    };
    let port = 0;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
      // Five helper processes died without their TCP connections closing.
      const zombies: WebSocket[] = [];
      const zombieClosed: Promise<void>[] = [];
      for (let restart = 0; restart < 5; restart++) {
        const zombie = await open('bearer.bdt_restarted');
        zombies.push(zombie);
        zombieClosed.push(new Promise((resolve) => zombie.once('close', () => resolve())));
      }
      const current = await open('bearer.bdt_restarted');
      expect(current.readyState).toBe(WebSocket.OPEN);
      await zombieClosed[0];
      await Promise.all(zombieClosed);
      expect(zombies.every((zombie) => zombie.readyState === WebSocket.CLOSED)).toBe(true);
      expect((await (await phoneFetch(`http://127.0.0.1:${port}/health`)).json()).live.sockets).toBe(1);

      // Saturate the live database gate with reads that never finish.
      for (const reader of ['phone-a', 'phone-b', 'phone-c']) {
        const phone = await open(`bearer.${reader}`);
        phone.send(JSON.stringify({ type: 'subscribe', roomId: `room-${reader}` }));
      }
      await vi.waitFor(() => expect(stalledReads).toHaveLength(2));
      const health = await (await phoneFetch(`http://127.0.0.1:${port}/health`)).json();
      expect(health.live).toMatchObject({ activeDbTasks: 2, waitingDbTasks: 1 });
      const pong = new Promise<string>((resolve) => current.once('pong', (data) => resolve(data.toString())));
      current.ping('still-there');
      await expect(pong).resolves.toBe('still-there');
      for (const finish of stalledReads.splice(0)) finish();
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
