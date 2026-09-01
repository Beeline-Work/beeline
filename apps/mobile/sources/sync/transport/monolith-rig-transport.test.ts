import { type RoomViewMessage } from '@beeline/buzz-client';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ fetch: vi.fn() }));
const mmkv = vi.hoisted(() => ({ stores: new Map<string, Map<string, string>>() }));

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { fetch: controls.fetch },
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
  transport: MonolithRigTransport,
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
});
