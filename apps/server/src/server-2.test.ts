import { phoneFetch, AddressInfo, WebSocket, describe, expect, it, vi, WorkspaceSkillNotFoundError, LiveHub, createBeelineServer, canReadRoomsFrom, nextSocketMessage, expectNoSocketMessageOfType, expectNoSocketMessage, fixtureScope2, fixtureScope3, fixtureScope4, type TokenAuth, type PhoneService, type DaemonService } from './server.test-support.js';

describe('daemon live command push', () => {
const scope2 = fixtureScope2();


  it('refreshes commands for a command addressed to this agent or one another agent released', async () => {
    const roomId = 'room-live';
    const agentId = 'agent-live';
    const live = new LiveHub();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomInbox') return { items: [], cursor: undefined };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      throw new Error(`unexpected operation ${name}`);
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticateDaemon: vi.fn().mockResolvedValue(agentId),
      } as unknown as TokenAuth,
      phone: { canReadRoom: vi.fn().mockResolvedValue(true), canReadRooms: canReadRoomsFrom(async () => true) } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    scope2.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const subscribed = nextSocketMessage(socket, 'subscribed');
    const initialCommands = nextSocketMessage(socket, 'commands');
    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await Promise.all([subscribed, initialCommands]);

    const commandCalls = () =>
      execute.mock.calls.filter(([name]) => name === 'getAgentCommands').length;
    const inboxCalls = () => execute.mock.calls.filter(([name]) => name === 'getRoomInbox').length;
    expect(commandCalls()).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);

    live.publish({ type: 'presence', roomId, agentId, status: 'online', observedAt: 1 });
    live.publish({ type: 'draft', roomId, agentId, turnId: 'turn', text: 'draft' });
    live.publish({ type: 'thought', roomId, agentId, turnId: 'turn', text: 'thought' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);
    // A broad table hint carries no message-owned context and cannot admit a read.
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);
    const messageTrace = { id: 'trace-message', databaseAt: 50, emittedAt: 75 };
    const replayed = nextSocketMessage(socket, 'inbox');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:messages',
      messageId: 'actual-committed-message',
      trace: messageTrace,
    });
    await expect(replayed).resolves.toEqual(
      expect.objectContaining({
        type: 'inbox',
        trigger: { reason: 'postgres:messages', trace: messageTrace },
      }),
    );
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_commands',
      targetAgentId: 'another-agent',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(commandCalls()).toBe(1);

    // The worker's command ending releases a review wake held for this agent.
    const released = nextSocketMessage(socket, 'commands');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_commands',
      targetAgentId: 'another-agent',
      commandReleased: true,
    });
    await expect(released).resolves.toMatchObject({ type: 'commands', roomId });
    expect(commandCalls()).toBe(2);

    const pushed = nextSocketMessage(socket, 'commands');
    const trace = { id: 'trace-command', databaseAt: 100, emittedAt: 125 };
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_commands',
      targetAgentId: agentId,
      trace,
    });
    await expect(pushed).resolves.toEqual(
      expect.objectContaining({
        type: 'commands',
        trigger: { reason: 'postgres:agent_commands', trace },
      }),
    );
    expect(commandCalls()).toBe(3);
  });


  it('answers a phone ping with a pong without touching the database', async () => {
    const query = vi.fn();
    const server = createBeelineServer({
      database: { query, transaction: vi.fn() },
      auth: { authenticatePhone: vi.fn().mockResolvedValue('reader') } as unknown as TokenAuth,
      phone: { canReadRooms: canReadRoomsFrom(async () => true) } as unknown as PhoneService,
      daemon: { execute: vi.fn() } as unknown as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone-token']);
    scope2.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    query.mockClear();
    const pong = nextSocketMessage(socket, 'pong');
    socket.send(JSON.stringify({ type: 'ping' }));
    await expect(pong).resolves.toEqual({ type: 'pong' });
    const synced = nextSocketMessage(socket, 'sync-ok');
    socket.send(JSON.stringify({ type: 'sync' }));
    await expect(synced).resolves.toEqual({ type: 'sync-ok' });
    expect(query).not.toHaveBeenCalled();
  });


  it('sends read-mark reconciliation to reader devices without replaying a daemon inbox', async () => {
    const roomId = 'room-live';
    const live = new LiveHub();
    const liveDraftSnapshot = vi.fn().mockResolvedValue([]);
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomInbox') return { items: [], cursor: undefined };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      throw new Error(`unexpected operation ${name}`);
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticateDaemon: vi.fn().mockResolvedValue('agent-live'),
        authenticatePhone: vi.fn().mockResolvedValue('reader'),
      } as unknown as TokenAuth,
      phone: {
        canReadRooms: canReadRoomsFrom(async () => true),
        liveDraftSnapshot,
      } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const connect = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, [`bearer.${token}`]);
      scope2.sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const subscribed = nextSocketMessage(socket, 'subscribed');
      const initialInbox = token.startsWith('bdt_') ? nextSocketMessage(socket, 'inbox') : null;
      socket.send(JSON.stringify({ type: 'subscribe', roomId }));
      await subscribed;
      if (initialInbox) await initialInbox;
      return socket;
    };
    const daemonSocket = await connect('bdt_test');
    const phoneA = await connect('phone-a');
    const phoneB = await connect('phone-b');
    const inboxCalls = () => execute.mock.calls.filter(([name]) => name === 'getRoomInbox').length;
    expect(inboxCalls()).toBe(1);

    const first = nextSocketMessage(phoneA, 'invalidate');
    const second = nextSocketMessage(phoneB, 'invalidate');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:room_read_marks', readerId: 'reader' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ reason: 'postgres:room_read_marks' }),
      expect.objectContaining({ reason: 'postgres:room_read_marks' }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);

    const replayed = nextSocketMessage(daemonSocket, 'inbox');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'actual-committed-message' });
    await replayed;
    expect(inboxCalls()).toBe(2);
  });


  it('pushes config-changed only to the changed agent, without an inbox replay', async () => {
    const roomId = 'room-config';
    const agentId = 'agent-config';
    const live = new LiveHub();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomInbox') return { items: [], cursor: undefined };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      throw new Error(`unexpected operation ${name}`);
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticateDaemon: vi.fn().mockResolvedValue(agentId),
      } as unknown as TokenAuth,
      phone: { canReadRoom: vi.fn().mockResolvedValue(true), canReadRooms: canReadRoomsFrom(async () => true) } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    scope2.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const subscribed = nextSocketMessage(socket, 'subscribed');
    const initialCommands = nextSocketMessage(socket, 'commands');
    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await Promise.all([subscribed, initialCommands]);

    const inboxCalls = () => execute.mock.calls.filter(([name]) => name === 'getRoomInbox').length;
    expect(inboxCalls()).toBe(1);

    // Another agent's selection change must not wake this daemon.
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'agent-config',
      targetAgentId: 'another-agent',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(inboxCalls()).toBe(1);

    const changed = nextSocketMessage(socket, 'config-changed');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'agent-config',
      targetAgentId: agentId,
    });
    await expect(changed).resolves.toEqual({ type: 'config-changed', roomId });
    // The wake carries no transcript: the durable fact is the agent-model
    // system line, and the daemon needs no inbox replay to retire sessions.
    expect(inboxCalls()).toBe(1);
  });


  it('pushes scoped rooms-changed, connector-assignment, and corner lifecycle events', async () => {
    const roomId = 'room-live';
    const agentId = 'agent-live';
    const live = new LiveHub();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomInbox') return { items: [], cursor: undefined };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      throw new Error(`unexpected operation ${name}`);
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticateDaemon: vi.fn().mockResolvedValue(agentId),
      } as unknown as TokenAuth,
      phone: {
        canReadRoom: vi.fn().mockResolvedValue(true),
        canReadRooms: canReadRoomsFrom(async () => true),
      } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    scope2.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const subscribed = nextSocketMessage(socket, 'subscribed');
    const initialCommands = nextSocketMessage(socket, 'commands');
    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await Promise.all([subscribed, initialCommands]);

    const roomsChanged = nextSocketMessage(socket, 'rooms-changed');
    live.publish({
      type: 'invalidate',
      roomId: 'corner-1',
      reason: 'postgres:memberships',
      targetAgentId: agentId,
      operation: 'INSERT',
      parentRoomId: roomId,
      openedBy: 'opener-agent',
    });
    await expect(roomsChanged).resolves.toEqual({
      type: 'rooms-changed',
      roomId: 'corner-1',
      parentRoomId: roomId,
      openedBy: 'opener-agent',
    });

    // A command queued for a corner this helper has never watched carries
    // its own parent/opener, so the agent-wide wake can start it directly
    // instead of waiting for the next discovery reconciliation.
    const commandPushedCorner = nextSocketMessage(socket, 'rooms-changed');
    live.publish({
      type: 'invalidate',
      roomId: 'corner-2',
      reason: 'postgres:agent_commands',
      targetAgentId: agentId,
      parentRoomId: roomId,
      openedBy: 'opener-agent',
    });
    await expect(commandPushedCorner).resolves.toEqual({
      type: 'rooms-changed',
      roomId: 'corner-2',
      parentRoomId: roomId,
      openedBy: 'opener-agent',
    });

    // A command queued for a top-level Room needs no push: every desired
    // Room already starts eagerly on membership alone. (Its own existing
    // per-room subscription still answers with a `commands` refresh.)
    const noPushForRoom = expectNoSocketMessageOfType(socket, 'rooms-changed');
    const roomCommandsEcho = nextSocketMessage(socket, 'commands');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:agent_commands',
      targetAgentId: agentId,
    });
    await Promise.all([noPushForRoom, roomCommandsEcho]);

    const repositoryChanged = nextSocketMessage(socket, 'rooms-changed');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:rooms',
      repositoryChanged: true });
    await expect(repositoryChanged).resolves.toEqual({ type: 'rooms-changed', roomId,
      repositoryChanged: true });

    const connector = nextSocketMessage(socket, 'connector-assignment');
    live.publish({
      type: 'invalidate',
      roomId: '',
      reason: 'connector-assignment',
      targetAgentId: agentId,
    });
    await expect(connector).resolves.toEqual({ type: 'connector-assignment' });

    // A child corner's status hint is for corner lists, never an inbox replay.
    live.publish({ type: 'invalidate', roomId, reason: 'corner-status' });

    const closed = nextSocketMessage(socket, 'corner-complete');
    live.publish({
      type: 'invalidate',
      roomId,
      reason: 'postgres:corner_facts',
      closeRequested: true,
    });
    await expect(closed).resolves.toEqual({ type: 'corner-complete', roomId });
    expect(execute.mock.calls.filter(([name]) => name === 'getRoomInbox')).toHaveLength(1);
  });


  it("forwards only this agent's @agent login start and code steps to its helper", async () => {
    const roomId = 'room-live';
    const agentId = 'agent-live';
    const live = new LiveHub();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getRoomInbox') return { items: [], cursor: undefined };
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      throw new Error(`unexpected operation ${name}`);
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticateDaemon: vi.fn().mockResolvedValue(agentId) } as unknown as TokenAuth,
      phone: {
        canReadRoom: vi.fn().mockResolvedValue(true),
        canReadRooms: canReadRoomsFrom(async () => true),
      } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live,
      mediaMaximumBytes: 1,
    });
    scope2.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.bdt_test']);
    scope2.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const subscribed = nextSocketMessage(socket, 'subscribed');
    socket.send(JSON.stringify({ type: 'subscribe', roomId }));
    await subscribed;

    const frames: Record<string, unknown>[] = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === 'agent-sign-in') frames.push(message);
    });
    const usageFrames: unknown[] = [];
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'usage-refresh') usageFrames.push(frame);
    });
    live.publish({ type: 'usage-refresh', roomId: '', agentId: 'other-agent' });
    live.publish({ type: 'usage-refresh', roomId: '', agentId });
    await vi.waitFor(() => expect(usageFrames).toEqual([{ type: 'usage-refresh' }]));
    const attemptId = '00000000-0000-4000-8000-000000000001';
    const base = { type: 'agent-sign-in', roomId: '', attemptId } as const;
    live.publish({ ...base, agentId: 'another-agent', step: 'start', cardId: 'c'.repeat(64) });
    live.publish({
      ...base,
      agentId,
      step: 'link',
      link: { kind: 'paste-code', authorizeUrl: 'https://claude.com/x' },
    });
    live.publish({ ...base, agentId, step: 'result', outcome: 'signed-in' });
    live.publish({ ...base, agentId, step: 'start', cardId: 'c'.repeat(64) });
    live.publish({ ...base, agentId, step: 'code', code: 'abc#state' });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames).toEqual([
      { type: 'agent-sign-in', step: 'start', attemptId, cardId: 'c'.repeat(64) },
      { type: 'agent-sign-in', step: 'code', attemptId, code: 'abc#state' },
    ]);
  });
});
describe('daemon operation presence evidence', () => {
const scope3 = fixtureScope3();


  it('answers a missing Workspace procedure slug with 404 and the slug, not 503', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new WorkspaceSkillNotFoundError('never-saved-procedure'));
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticatePhone: vi.fn().mockResolvedValue(null),
        authenticateDaemon: vi.fn().mockResolvedValue('agent'),
      } as unknown as TokenAuth,
      phone: {} as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live: new LiveHub(),
      mediaMaximumBytes: 1,
    });
    scope3.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await phoneFetch(
      `http://127.0.0.1:${port}/v1/daemon/operations/loadWorkspaceSkill`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer bdt_${'t'.repeat(43)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ roomId: 'room', slug: 'never-saved-procedure' }),
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'workspace skill never-saved-procedure not found',
    });
  });


  it('does not hold a command read behind a blocked durable evidence refresh', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const evidence = vi.fn(() => blocked);
    const execute = vi.fn().mockResolvedValue({ commandProtocol: 1, commands: [] });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {
        authenticatePhone: vi.fn().mockResolvedValue(null),
        authenticateDaemon: vi.fn().mockResolvedValue('agent'),
      } as unknown as TokenAuth,
      phone: {} as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live: new LiveHub(),
      connectionPresence: { evidence } as never,
      mediaMaximumBytes: 1,
    });
    scope3.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await phoneFetch(`http://127.0.0.1:${port}/v1/daemon/operations/getAgentCommands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer bdt_${'t'.repeat(43)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ roomId: 'room' }),
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ commandProtocol: 1, commands: [] });
    expect(evidence).toHaveBeenCalledWith('room', 'agent');
    release();
  });
});
describe('phone committed-row live delivery', () => {
const scope4 = fixtureScope4();


  it('sends complete small messages to opted-in offscreen Room caches', async () => {
    const delta = { type: 'message-delta', roomId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      message: { id: 'b'.repeat(64), text: 'new arrival', createdAt: 1, presentation: 'message',
        author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' } } };
    const { live, socket } = await scope4.connect(vi.fn().mockResolvedValue(delta),
      undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, {}, true, delta.roomId);
    const frame = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId: delta.roomId, reason: 'message', messageId: 'small' });
    const wire = await frame;
    expect(wire).toMatchObject(delta);

  });


  it('NET-HOL-1 sends bounded previews only to opted-in offscreen subscriptions', async () => {
    const roomId = 'room-live';
    const text = 'B'.repeat(128 * 1024);
    const read = vi.fn().mockResolvedValue({ type: 'message-delta', roomId,
      message: { id: 'large', text, createdAt: 1, presentation: 'message',
        author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' },
        mentionPubkeys: ['viewer'], attachments: [{ data: text }] } });
    const legacy = await scope4.connect(read);
    const modern = await scope4.connect(read, undefined, undefined, false, undefined,
      undefined, undefined, undefined, undefined, {}, true);
    const legacyFrame = nextSocketMessage(legacy.socket, 'message-delta');
    const previewFrame = nextSocketMessage(modern.socket, 'sidebar-preview');
    legacy.live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: 'large' });
    modern.live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: 'large' });
    expect((await legacyFrame).message.text).toHaveLength(128 * 1024);
    const preview = await previewFrame;
    expect(preview.preview.text).toHaveLength(240);
    expect(preview.preview.mentionsViewer).toBe(true);
    expect(preview).not.toHaveProperty('message');
    expect(preview.preview).not.toHaveProperty('attachments');
    expect(JSON.stringify(preview).length).toBeLessThan(2000);
  });


  it('keeps viewed Room messages complete after opting into sidebar previews', async () => {
    const roomId = '00000000-0000-4000-8000-000000000123';
    // This is the legacy message/sidebar wire path. Viewing still publishes
    // an aggregate overlay revision when the server router is enabled.
    const query = vi.fn().mockImplementation(async (sql: string) => ({ rowCount: 1,
      rows: sql.includes('FROM helper_overlay_demand') ? [{ revision: '1', viewing: true }] : [] }));
    const read = vi.fn().mockImplementation(async () => ({ type: 'message-delta', roomId,
      message: { id: 'viewed', text: 'V'.repeat(128 * 1024), createdAt: 1,
        presentation: 'message', author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' } } }));
    const { live, socket } = await scope4.connect(read, undefined, undefined, false, query);
    const subscribed = nextSocketMessage(socket, 'subscribed');
    socket.send(JSON.stringify({ type: 'viewing', roomId, viewing: true }));
    socket.send(JSON.stringify({ type: 'subscribe', roomId, sidebarPreviews: true }));
    await subscribed;
    const frame = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: 'viewed' });
    expect((await frame).message.text).toHaveLength(128 * 1024);
    socket.send(JSON.stringify({ type: 'viewing', roomId, viewing: false }));
    await vi.waitFor(() => expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM room_push_views'))).toBe(true));
    const preview = nextSocketMessage(socket, 'sidebar-preview');
    read.mockResolvedValueOnce({ type: 'message-delta', roomId, message: {
      id: 'after-leaving', text: 'S'.repeat(128 * 1024), createdAt: 2, presentation: 'message',
      author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' } } });
    live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: 'after-leaving' });
    expect((await preview).preview.text).toHaveLength(240);
  });


  it('projects a parent corner status into one compact frame', async () => {
    const status = { cornerCount: 1, waitingCornerCount: 1,
      openCorners: [{ id: 'corner', name: 'Fix', state: 'waiting' as const }],
      agentState: 'needs-you' as const };
    const project = vi.fn().mockResolvedValue(status);
    const { live, roomId, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false, undefined,
      project as PhoneService['liveChatCornerStatus']);
    const frame = nextSocketMessage(socket, 'corner-status');
    live.publish({ type: 'invalidate', roomId, reason: 'corner-status' });
    await expect(frame).resolves.toEqual({ type: 'corner-status', roomId, ...status });
    expect(project).toHaveBeenCalledWith(roomId, 'viewer');
    const noDuplicate = expectNoSocketMessage(socket);
    live.publish({ type: 'invalidate', roomId, reason: 'corner-status' });
    await noDuplicate;
    expect(project).toHaveBeenCalledTimes(2);
  });


  it('drops a message projection whose version is not newer than the one sent', async () => {
    const roomId = 'room-live';
    const delta = (text: string) => ({ type: 'message-delta' as const, roomId,
      version: 1, message: { id: 'edited', text, createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } });
    const batch = vi.fn()
      .mockImplementationOnce(async (_roomId, viewers: string[]) =>
        new Map(viewers.map((viewer) => [viewer, delta('first')])))
      .mockImplementationOnce(async (_roomId, viewers: string[]) =>
        new Map(viewers.map((viewer) => [viewer, delta('other content')])));
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const first = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    await expect(first).resolves.toMatchObject({ version: 1, message: { text: 'first' } });
    const nothingEqual = expectNoSocketMessageOfType(socket, 'message-delta', 100);
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    await nothingEqual;
    expect(batch).toHaveBeenCalledTimes(2);
  });


  it.each([1, 2, 8])('reads a cross-process row once for %i sockets', async (count) => {
    const roomId = 'room-live';
    const delta = { type: 'message-delta' as const, roomId,
      message: { id: 'one-row', text: 'hello', createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } };
    const batch = vi.fn().mockImplementation(async (_roomId, viewers: string[]) =>
      new Map(viewers.map((viewer) => [viewer, delta])));
    const read = vi.fn().mockRejectedValue(new Error('per-socket read'));
    const { live, socket, port } = await scope4.connect(
      read as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const viewers = [socket];
    for (let index = 1; index < count; index++) {
      const next = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.phone']);
      scope4.sockets.push(next);
      await new Promise<void>((resolve, reject) => {
        next.once('open', resolve);
        next.once('error', reject);
      });
      const subscribed = nextSocketMessage(next, 'subscribed');
      next.send(JSON.stringify({ type: 'subscribe', roomId }));
      await subscribed;
      viewers.push(next);
    }
    const frames = viewers.map((viewer) => nextSocketMessage(viewer, 'message-delta'));
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
      operation: 'INSERT', messageId: 'one-row' });
    for (const frame of frames) await expect(frame).resolves.toMatchObject(delta);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    await Promise.all(viewers.map((viewer) => expectNoSocketMessage(viewer, 50)));
  });


  it('sends a same-machine turn with the rolled-up agent state of the row read', async () => {
    const roomId = 'room-live';
    const turnDelta = { type: 'turn-delta' as const, roomId, agentState: 'working' as const,
      turn: { agentId: 'agent', requestId: 'request', status: 'working' as const,
        startedAt: 1, createdAt: 1 } };
    const batch = vi.fn(async (_roomId: string, viewers: string[]) =>
      new Map(viewers.map((viewer) => [viewer, turnDelta])));
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as unknown as PhoneService['readLiveDeltas']);
    const frame = nextSocketMessage(socket, 'turn-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'turn', agentId: 'agent',
      requestId: 'request', committedRow: { type: 'turn', row: {
        room_id: roomId, request_id: 'request', agent_id: 'agent', status: 'working',
        started_at: new Date(1), created_at: new Date(1), generation_id: null,
        requested_by: null } } });
    await expect(frame).resolves.toMatchObject({ type: 'turn-delta', agentState: 'working' });
    expect(batch).toHaveBeenCalledTimes(1);
  });


  it('never sends an older projection of a message after a newer one', async () => {
    const roomId = 'room-live';
    const delta = (text: string, version: number) => ({ type: 'message-delta' as const, roomId,
      version, message: { id: 'edited', text, createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } });
    let releaseOlder!: () => void;
    const olderRead = new Promise<void>((resolve) => { releaseOlder = resolve; });
    // The first edit's read starts first but finishes after the second edit's read.
    const batch = vi.fn()
      .mockImplementationOnce(async (_roomId, viewers: string[]) => {
        await olderRead;
        return new Map(viewers.map((viewer) => [viewer, delta('first edit', 1)]));
      })
      .mockImplementationOnce(async (_roomId, viewers: string[]) =>
        new Map(viewers.map((viewer) => [viewer, delta('second edit', 2)])));
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const newer = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    await expect(newer).resolves.toMatchObject({ version: 2, message: { text: 'second edit' } });
    const nothingOlder = expectNoSocketMessageOfType(socket, 'message-delta', 100);
    releaseOlder();
    await nothingOlder;
    expect(batch).toHaveBeenCalledTimes(2);
  });


  it('keeps a message version while its older read is in flight past 256 other rows', async () => {
    const roomId = 'room-live';
    const delta = (id: string, text: string, version: number) => ({
      type: 'message-delta' as const, roomId, version, message: { id, text, createdAt: 1,
        author: { pubkey: 'agent', kind: 'agent' as const, name: 'Agent' },
        presentation: 'message' as const } });
    let releaseOlder!: () => void;
    const olderRead = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const batch = vi.fn()
      .mockImplementationOnce(async (_roomId, viewers: string[]) => {
        await olderRead;
        return new Map(viewers.map((viewer) => [viewer, delta('edited', 'first edit', 1)]));
      })
      .mockImplementationOnce(async (_roomId, viewers: string[]) =>
        new Map(viewers.map((viewer) => [viewer, delta('edited', 'second edit', 2)])))
      .mockImplementation(async (_roomId, viewers: string[], target: { messageId: string }) =>
        new Map(viewers.map((viewer) => [viewer, delta(target.messageId, 'other', 1)])));
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, batch as PhoneService['readLiveDeltas']);
    const newer = nextSocketMessage(socket, 'message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages', messageId: 'edited' });
    await expect(newer).resolves.toMatchObject({ version: 2, message: { text: 'second edit' } });
    const others: unknown[] = [];
    const sawOthers = new Promise<void>((resolve) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== 'message-delta') return;
        others.push(frame);
        if (others.length === 256) resolve();
      });
    });
    for (let index = 0; index < 256; index++)
      live.publish({ type: 'invalidate', roomId, reason: 'postgres:messages',
        messageId: `other-${index}` });
    await sawOthers;
    const nothingOlder = expectNoSocketMessageOfType(socket, 'message-delta', 100);
    releaseOlder();
    await nothingOlder;
  });


  it('sends owner-scoped resource changes on the shared phone socket', async () => {
    const { live, socket } = await scope4.connect(vi.fn() as PhoneService['readLiveDelta']);
    const frame = nextSocketMessage(socket, 'resource-change');
    live.publish({ type: 'resource-change', roomId: '', ownerId: 'viewer',
      resource: 'workbench', resourceId: 'connection' });
    await expect(frame).resolves.toEqual({ type: 'resource-change', roomId: '',
      resource: 'workbench', resourceId: 'connection' });
    const noLeak = expectNoSocketMessage(socket, 100);
    live.publish({ type: 'resource-change', roomId: '', ownerId: 'other',
      resource: 'agent', resourceId: 'other-agent' });
    await noLeak;
  });


  it('sends a Workspace header change only to its members, reading it once', async () => {
    const liveWorkspaceChange = vi.fn()
      .mockResolvedValueOnce({ workspace: { id: 'workspace', name: 'Renamed' },
        viewers: new Set(['viewer']) })
      .mockResolvedValueOnce({ workspace: { id: 'other', name: 'Theirs' },
        viewers: new Set(['someone-else']) });
    const { live, socket } = await scope4.connect(
      vi.fn() as PhoneService['readLiveDelta'], undefined, undefined, false,
      undefined, undefined, undefined, undefined, undefined,
      { liveWorkspaceChange } as Partial<PhoneService>);
    const frame = nextSocketMessage(socket, 'workspace-changed');
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:workspaces',
      workspaceId: 'workspace' });
    await expect(frame).resolves.toEqual({ type: 'workspace-changed', roomId: '',
      workspace: { id: 'workspace', name: 'Renamed' } });
    const noLeak = expectNoSocketMessage(socket, 100);
    live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:workspaces',
      workspaceId: 'other' });
    await noLeak;
    expect(liveWorkspaceChange).toHaveBeenCalledTimes(2);
  });
});
