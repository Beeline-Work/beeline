import {
  SignedEventOutbox,
  loadIdentityFromSecret,
  type RoomViewMessage,
} from '@beeline/buzz-client';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { fetch: controls.fetch },
}));

import { MonolithRigTransport } from './monolith-rig-transport';

const ROOM = 'bb91a1c7-7cad-4fde-aafc-94fccb651ac8';
const identity = loadIdentityFromSecret(new Uint8Array(32).fill(1));

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
  let persisted: readonly unknown[] = [];
  const outbox = new SignedEventOutbox({
    load: async () => [],
    save: async (records) => {
      persisted = records;
    },
  });
  const preparedEvent = await compose();
  await outbox.enqueue(preparedEvent, optimisticRow(preparedEvent, preparedEvent.content));
  await outbox.attempted(preparedEvent.id);
  expect(outbox.get(preparedEvent.id)).toMatchObject({ status: 'pending', attempts: 1 });
  await transport.publishPreparedMessage(preparedEvent);
  expect(persisted).toHaveLength(1);
  return preparedEvent;
}

describe('monolith Room send path', () => {
  beforeEach(() => {
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

    expect(verifyEvent(event)).toBe(true);
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

    expect(verifyEvent(event)).toBe(true);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(event);
    expect(controls.fetch).toHaveBeenCalledWith(
      'https://server.example/v1/phone/operations/sendRoomReply',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
