import { type RoomViewMessage } from '@beeline/buzz-client';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ fetch: vi.fn(), authorization: vi.fn() }));
const mmkv = vi.hoisted(() => ({ stores: new Map<string, Map<string, string>>() }));

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
    monolithEnabled: true,
    monolithUrl: 'https://server.example',
    relayUrl: 'wss://legacy.example',
  }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { fetch: controls.fetch, authorization: controls.authorization },
}));
vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    private readonly values: Map<string, string>;

    constructor({ id }: { id: string }) {
      this.values = mmkv.stores.get(id) ?? new Map<string, string>();
      mmkv.stores.set(id, this.values);
    }

    getString(key: string) {
      return this.values.get(key);
    }

    set(key: string, value: string) {
      this.values.set(key, value);
    }

    delete(key: string) {
      this.values.delete(key);
    }

    getAllKeys() {
      return [...this.values.keys()];
    }
  },
}));

import { MonolithRigTransport } from './monolith-rig-transport';
import { BuzzRigTransport } from './buzz-rig-transport';
import { MonolithPhoneOperationError } from './monolith-operation';
import { clearMobileSurfaceStorage, createRoomOutbox } from '@/buzz/surface-storage';

const ROOM = 'bb91a1c7-7cad-4fde-aafc-94fccb651ac8';
const identity = { publicKey: 'monolith-viewer', secretKey: new Uint8Array() };

function optimisticRow(event: NostrEvent, text: string): RoomViewMessage {
  return {
    id: event.id,
    text,
    createdAt: event.created_at,
    author: { pubkey: identity.publicKey, kind: 'human', name: 'You' },
    presentation: 'message',
  };
}

async function driveHandleSendPath(
  transport: Pick<MonolithRigTransport, 'publishPreparedMessage'>,
  compose: () => Promise<NostrEvent>,
): Promise<NostrEvent> {
  const outbox = createRoomOutbox(identity, ROOM);
  const preparedEvent = await compose();
  await outbox.enqueue(preparedEvent, optimisticRow(preparedEvent, preparedEvent.content));
  await outbox.attempted(preparedEvent.id);
  expect(outbox.get(preparedEvent.id)).toMatchObject({ status: 'pending', attempts: 1 });
  await transport.publishPreparedMessage(preparedEvent);
  expect(outbox.list()).toHaveLength(1);
  return preparedEvent;
}

describe('monolith Room send path', () => {
  beforeEach(() => {
    clearMobileSurfaceStorage();
    controls.fetch.mockReset();
    controls.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body)) as { messageId: string };
      return new Response(JSON.stringify({ messageId: input.messageId }), { status: 200 });
    });
    controls.authorization.mockReset();
    controls.authorization.mockResolvedValue('phone-session');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects and resubscribes after a server deployment closes the live socket', async () => {
    vi.useFakeTimers();
    const sockets: Array<{
      sent: string[];
      closed: boolean;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
    }> = [];
    class TestWebSocket {
      sent: string[] = [];
      closed = false;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      constructor(
        readonly url: string,
        readonly protocols: string[],
      ) {
        sockets.push(this);
      }
      send(value: string) {
        this.sent.push(value);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal('WebSocket', TestWebSocket);
    const received: unknown[] = [];
    const stop = await new MonolithRigTransport(identity).surfaceSubscribe(
      [{ '#h': [ROOM] }],
      (event) => received.push(event),
    );
    expect(sockets).toHaveLength(1);
    sockets[0]!.onopen?.();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomId: ROOM })]);

    sockets[0]!.onclose?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.onopen?.();
    expect(sockets[1]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomId: ROOM })]);
    sockets[1]!.onmessage?.({
      data: JSON.stringify({
        type: 'invalidate',
        roomId: ROOM,
        reason: 'postgres:messages',
        trace: { id: 'trace-message', databaseAt: 100, emittedAt: 125 },
      }),
    });
    expect(received).toEqual([
      {
        monolithLive: {
          type: 'invalidate',
          roomId: ROOM,
          reason: 'postgres:messages',
          trace: { id: 'trace-message', databaseAt: 100, emittedAt: 125 },
        },
      },
    ]);

    sockets[1]!.onclose?.();
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(2);
  });

  it('retries authorization and resets reconnect backoff after opening', async () => {
    vi.useFakeTimers();
    const sockets: Array<{
      sent: string[];
      onopen?: () => void;
      onclose?: () => void;
      close: () => void;
    }> = [];
    class TestWebSocket {
      sent: string[] = [];
      onopen?: () => void;
      onclose?: () => void;
      constructor(
        readonly url: string,
        readonly protocols: string[],
      ) {
        sockets.push(this);
      }
      send(value: string) {
        this.sent.push(value);
      }
      close() {}
    }
    vi.stubGlobal('WebSocket', TestWebSocket);
    controls.authorization.mockRejectedValueOnce(new Error('session refresh failed'));

    const stop = await new MonolithRigTransport(identity).surfaceSubscribe(
      [{ '#h': [ROOM] }],
      () => {},
    );
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(1);
    sockets[0]!.onopen?.();
    sockets[0]!.onclose?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    stop();
  });

  it('acknowledges a traced delta only after paint and only on its originating socket', async () => {
    const sockets: Array<{
      sent: string[];
      readyState: number;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
    }> = [];
    class TestWebSocket {
      static readonly OPEN = 1;
      sent: string[] = [];
      readyState = TestWebSocket.OPEN;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      constructor(
        readonly url: string,
        readonly protocols: string[],
      ) {
        sockets.push(this);
      }
      send(value: string) {
        this.sent.push(value);
      }
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal('WebSocket', TestWebSocket);
    const received: Array<{ acknowledgePaint?: () => void; monolithLive: { type: string } }> = [];
    const stop = await new MonolithRigTransport(identity).surfaceSubscribe(
      [{ '#h': [ROOM] }],
      (event) => received.push(event as (typeof received)[number]),
    );
    sockets[0]!.onopen?.();
    const trace = { id: 'trace-direct', startedAt: 10, databaseAt: 11, emittedAt: 12 };
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: 'message-delta',
        roomId: ROOM,
        message: { id: 'message', text: 'done' },
        trace,
      }),
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.acknowledgePaint).toEqual(expect.any(Function));
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', roomId: ROOM })]);
    received[0]!.acknowledgePaint?.();
    expect(sockets[0]!.sent.at(-1)).toBe(JSON.stringify({ type: 'trace-paint', id: trace.id }));

    sockets[0]!.onclose?.();
    const sentBeforeStaleAck = sockets[0]!.sent.length;
    received[0]!.acknowledgePaint?.();
    expect(sockets[0]!.sent).toHaveLength(sentBeforeStaleAck);
    stop();
  });

  it('acknowledges a diagnostics-gated cross-machine trace without startedAt', async () => {
    const sockets: Array<{
      sent: string[];
      readyState: number;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
    }> = [];
    class TestWebSocket {
      static readonly OPEN = 1;
      sent: string[] = [];
      readyState = TestWebSocket.OPEN;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      constructor() {
        sockets.push(this);
      }
      send(value: string) {
        this.sent.push(value);
      }
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal('WebSocket', TestWebSocket);
    const received: Array<{ acknowledgePaint?: () => void }> = [];
    const stop = await new MonolithRigTransport(identity).surfaceSubscribe(
      [{ '#h': [ROOM] }],
      (event) => received.push(event as (typeof received)[number]),
    );
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: 'turn-delta',
        roomId: ROOM,
        turn: { requestId: 'request', agentId: 'agent', status: 'working', createdAt: 1 },
        trace: {
          id: 'trace-database-clock',
          databaseAt: 10,
          emittedAt: 12,
          paintAck: 'database-clock',
        },
      }),
    });

    expect(received[0]!.acknowledgePaint).toEqual(expect.any(Function));
    received[0]!.acknowledgePaint?.();
    expect(sockets[0]!.sent.at(-1)).toBe(
      JSON.stringify({ type: 'trace-paint', id: 'trace-database-clock' }),
    );
    stop();
  });

  it('stages a plain repo-less Room message before publishing it to the monolith', async () => {
    const transport = new MonolithRigTransport(identity);
    const publish = vi.spyOn(transport, 'publishPreparedMessage');
    const event = await driveHandleSendPath(transport, () =>
      transport.composeMessage({ sessionId: ROOM, text: 'Hello from the Room' }),
    );

    expect(event).toMatchObject({ id: '07'.repeat(32), sig: '' });
    expect(verifyEvent(event)).toBe(false);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(event);
    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/sendRoomMessage',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns the server-backed active-steer acknowledgement', async () => {
    controls.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messageId: '07'.repeat(32), activeSteerAgentIds: ['agent-1'] }),
        { status: 200 },
      ),
    );
    const transport = new MonolithRigTransport(identity);
    const event = await transport.composeMessage({ sessionId: ROOM, text: 'Change course' });

    await expect(transport.publishPreparedMessage(event)).resolves.toEqual({
      messageId: event.id,
      activeSteerAgentIds: ['agent-1'],
    });
  });

  it('stages a reply before publishing it to the monolith', async () => {
    const transport = new MonolithRigTransport(identity);
    const publish = vi.spyOn(transport, 'publishPreparedMessage');
    const event = await driveHandleSendPath(transport, () =>
      transport.composeReplyMessage('Reply from the Room', {
        channelId: ROOM,
        eventId: 'parent-message-id',
        rootId: 'parent-message-id',
      }),
    );

    expect(event).toMatchObject({ id: '07'.repeat(32), sig: '' });
    expect(verifyEvent(event)).toBe(false);
    expect(event.tags).toContainEqual(['monolith-parent', 'parent-message-id']);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(event);
    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/sendRoomReply',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(controls.fetch.mock.calls[0]![1]?.body))).toEqual({
      roomId: ROOM,
      messageId: event.id,
      text: 'Reply from the Room',
      mentions: [],
      attachments: [],
      parentMessageId: 'parent-message-id',
    });
  });

  it('dispatches the composer reply path through the monolith-only transport', async () => {
    const transport = new BuzzRigTransport(identity);
    const event = await driveHandleSendPath(transport, () =>
      transport.composeReplyMessage(
        '@Terra What is your soul?',
        {
          channelId: ROOM,
          eventId: 'terra-message-id',
          rootId: 'terra-message-id',
        },
        'terra-agent-id',
        [
          {
            url: 'https://server.example/v1/media/image-id',
            name: 'soul.png',
            mimeType: 'image/png',
            size: 42,
          },
        ],
        ['terra-agent-id'],
      ),
    );

    expect(JSON.parse(String(controls.fetch.mock.calls[0]![1]?.body))).toEqual({
      roomId: ROOM,
      messageId: event.id,
      text: '@Terra What is your soul?',
      mentions: ['terra-agent-id'],
      attachments: [
        {
          url: 'https://server.example/v1/media/image-id',
          name: 'soul.png',
          mimeType: 'image/png',
          size: 42,
        },
      ],
      parentMessageId: 'terra-message-id',
    });
  });

  it('still rejects an unsigned legacy Room event', async () => {
    const outbox = createRoomOutbox(identity, ROOM);
    const event: NostrEvent = {
      id: '08'.repeat(32),
      pubkey: identity.publicKey,
      created_at: 10,
      kind: 9,
      tags: [['h', ROOM]],
      content: 'Unsigned legacy message',
      sig: '',
    };

    await expect(outbox.enqueue(event, optimisticRow(event, event.content))).rejects.toThrow(
      'outbox requires one pre-signed event and its exact render id',
    );
    expect(outbox.list()).toEqual([]);
  });

  it('uploads raw media to the phone endpoint and adapts the shared attachment descriptor', async () => {
    controls.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: 'https://server.example/v1/media/media-id',
          name: 'upload',
          mimeType: 'image/png',
          size: 3,
          sha256: 'a'.repeat(64),
          thumbnailUrl: 'https://server.example/v1/media/thumb-id',
        }),
        { status: 201 },
      ),
    );
    const transport = new MonolithRigTransport(identity);

    await expect(transport.uploadMedia(new Uint8Array([1, 2, 3]), 'image/png')).resolves.toEqual({
      url: 'https://server.example/v1/media/media-id',
      type: 'image/png',
      size: 3,
      sha256: 'a'.repeat(64),
      thumb: 'https://server.example/v1/media/thumb-id',
    });
    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/media',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: expect.any(Uint8Array),
      }),
    );
  });

  it('reads the managed token identity instead of attempting a Nostr profile query', async () => {
    controls.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          personId: identity.publicKey,
          name: 'Monolith Person',
          handle: 'monolith-person',
          avatar: 'https://images.example/person.png',
        }),
        { status: 200 },
      ),
    );
    const client = await new MonolithRigTransport(identity).ensureClient();
    await expect(client.getGlobalPersonProfile()).resolves.toMatchObject({
      pubkey: identity.publicKey,
      name: 'Monolith Person',
      handle: 'monolith-person',
      avatar: 'https://images.example/person.png',
    });
    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/getManagedIdentity',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('preserves the server error code on a rejected phone operation', async () => {
    controls.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'GitHub identity is already linked' }), {
        status: 409,
      }),
    );
    const transport = new MonolithRigTransport(identity);
    await expect(transport.operation('completeGitHubIdentityBind', {})).rejects.toEqual(
      expect.objectContaining<Partial<MonolithPhoneOperationError>>({
        name: 'MonolithPhoneOperationError',
        status: 409,
        code: 'GitHub identity is already linked',
      }),
    );
  });

  it('closes a corner through the explicit operation without posting prose', async () => {
    controls.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const transport = new MonolithRigTransport(identity);

    await expect(transport.closeCorner(ROOM)).resolves.toBeUndefined();

    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/requestCornerClose',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ roomId: ROOM }),
      }),
    );
    expect(String(controls.fetch.mock.calls[0]![1]?.body)).not.toContain('Close this corner.');
  });

  it('returns the server refusal when a corner close request fails', async () => {
    controls.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'room access denied' }), { status: 403 }),
    );
    const transport = new MonolithRigTransport(identity);

    await expect(transport.closeCorner(ROOM)).rejects.toEqual(
      expect.objectContaining<Partial<MonolithPhoneOperationError>>({
        operation: 'requestCornerClose',
        status: 403,
        code: 'room access denied',
      }),
    );
  });

  it('translates the legacy BuzzClient soul field and accepts monolith no-content writes', async () => {
    controls.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    const client = await new MonolithRigTransport(identity).ensureClient();

    await expect(
      client.setAgentSoul('workspace-id', 'agent-id', {
        name: 'Honeybee',
        soul: 'Be precise and practical.',
        avatarSeed: 'honeybee-seed',
      }),
    ).resolves.toBeUndefined();

    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/updateAgentSoul',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'workspace-id',
          agentId: 'agent-id',
          name: 'Honeybee',
          instructions: 'Be precise and practical.',
          avatarSeed: 'honeybee-seed',
        }),
      }),
    );
  });

  it('passes the selected installed repository id through Room creation', async () => {
    controls.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: ROOM }), { status: 200 }),
    );
    const transport = new MonolithRigTransport(identity);

    await transport.createRoom('Repository Room', {
      communityId: 'workspace-id',
      repository: {
        key: 'github:77',
        name: 'owner/worker',
        remote: 'git://github.com/owner/worker',
        githubInstallationId: 42,
        defaultBranch: 'trunk',
      },
    });

    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/createRoom',
      expect.objectContaining({
        body: JSON.stringify({
          workspaceId: 'workspace-id',
          name: 'Repository Room',
          repositoryId: 77,
        }),
      }),
    );
  });

  it('omits repositoryId when creating a chat-only Room', async () => {
    controls.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: ROOM }), { status: 200 }),
    );
    const transport = new MonolithRigTransport(identity);

    await transport.createRoom('Chat Room', { communityId: 'workspace-id' });

    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/createRoom',
      expect.objectContaining({
        body: JSON.stringify({ workspaceId: 'workspace-id', name: 'Chat Room' }),
      }),
    );
  });

  it('preserves the shared repository and installation shapes used by the repo picker', async () => {
    controls.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/listGitHubRepositories')) {
        return Response.json({
          installed: true,
          installations: [
            {
              installationId: 77,
              accountId: '42',
              accountLogin: 'owner',
              accountType: 'User',
              repositorySelection: 'selected',
              status: 'active',
              repositoryCount: 1,
              manageUrl: 'https://github.com/settings/installations/77',
            },
          ],
          repositories: [
            { id: 101, fullName: 'owner/widgets', installationId: 77, defaultBranch: 'trunk' },
          ],
        });
      }
      const input = JSON.parse(String(init.body));
      return Response.json({
        channelId: ROOM,
        binding: {
          key: input.key,
          name: input.name,
          remote: input.remote,
          localOnly: false,
          githubInstallationId: input.githubInstallationId,
        },
        targetBranch: input.targetBranch,
        githubEventsEnabled: true,
        source: 'config',
        updatedAt: 123,
      });
    });
    const transport = new MonolithRigTransport(identity);

    await expect(transport.workspaceGitHubAccess()).resolves.toEqual({
      installed: true,
      installations: [expect.objectContaining({ installationId: 77, accountLogin: 'owner' })],
      candidates: [
        {
          key: 'github:101',
          name: 'owner/widgets',
          remote: 'git://github.com/owner/widgets',
          githubInstallationId: 77,
          defaultBranch: 'trunk',
        },
      ],
      githubReconnectNeeded: false,
    });
    const linked = await transport.roomRepositorySet(ROOM, {
      key: 'github:101',
      name: 'owner/widgets',
      remote: 'git://github.com/owner/widgets',
      targetBranch: 'trunk',
      githubInstallationId: 77,
    });
    expect(linked.binding.name).toBe('owner/widgets');
    expect(JSON.parse(String(controls.fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
      roomId: ROOM,
      key: 'github:101',
      name: 'owner/widgets',
      remote: 'git://github.com/owner/widgets',
      targetBranch: 'trunk',
      githubInstallationId: 77,
    });
  });
});
