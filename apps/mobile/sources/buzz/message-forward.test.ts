import { describe, expect, it, vi } from 'vitest';
import {
  formatForwardedMessage,
  forwardedMessageParts,
  forwardMessageToRoom,
  forwardTargets,
} from './message-forward';
import type { ChatListItem } from '@beeline/buzz-client';

describe('message forwarding', () => {
  it('quotes every source line and separates the Room caption', () => {
    const text = formatForwardedMessage('first\nsecond', 'general');
    expect(text).toBe('> first\n> second\n\nFORWARDED FROM #general');
    expect(forwardedMessageParts(text)).toEqual({
      body: '> first\n> second',
      caption: 'FORWARDED FROM #general',
    });
    expect(formatForwardedMessage('first', '#general')).toBe(
      '> first\n\nFORWARDED FROM #general',
    );
  });

  it('posts the quoted source into the chosen Room', async () => {
    const send = vi.fn(async () => undefined);
    await forwardMessageToRoom(send, 'room-two', { text: 'ship it' }, 'general');
    expect(send).toHaveBeenCalledWith({
      roomId: 'room-two',
      text: '> ship it\n\nFORWARDED FROM #general',
    });
  });

  it('carries the source attachments into the forwarded message', async () => {
    const send = vi.fn(async () => undefined);
    const attachments = [
      {
        url: 'https://server.test/v1/media/m1',
        name: 'spec.pdf',
        mimeType: 'application/pdf',
        size: 12,
      },
    ];
    await forwardMessageToRoom(send, 'room-two', { text: '', attachments }, 'general');
    expect(send).toHaveBeenCalledWith({
      roomId: 'room-two',
      text: '> \n\nFORWARDED FROM #general',
      attachments,
    });
  });

  it('omits the attachment field when the source message has none', async () => {
    const send = vi.fn(async () => undefined);
    await forwardMessageToRoom(send, 'room-two', { text: 'hi', attachments: [] }, 'general');
    expect(send).toHaveBeenCalledWith({
      roomId: 'room-two',
      text: '> hi\n\nFORWARDED FROM #general',
    });
  });
});

describe('forward targets', () => {
  const room = (overrides: {
    id: string;
    name: string;
    parentId?: string;
    archived?: boolean;
    directMessage?: ChatListItem['directMessage'];
  }): ChatListItem =>
    ({
      room: { id: overrides.id, name: overrides.name, parentId: overrides.parentId, archived: overrides.archived },
      directMessage: overrides.directMessage,
    }) as ChatListItem;

  it('offers every top-level live Room including DMs, named like the Room list', () => {
    const targets = forwardTargets(
      [
        room({ id: 'r1', name: 'general' }),
        room({
          id: 'dm1',
          name: 'Direct message',
          directMessage: { peer: { pubkey: 'p', name: 'Bee', handle: '@bee', kind: 'agent' } },
        }),
      ],
      'here',
    );
    expect(targets).toEqual([
      { id: 'r1', label: '#general' },
      { id: 'dm1', label: '@bee' },
    ]);
  });

  it('excludes the source Room, corners, and archived Rooms', () => {
    const targets = forwardTargets(
      [
        room({ id: 'here', name: 'source' }),
        room({ id: 'corner', name: 'fix', parentId: 'here' }),
        room({ id: 'old', name: 'old', archived: true }),
        room({ id: 'r2', name: 'keep' }),
      ],
      'here',
    );
    expect(targets).toEqual([{ id: 'r2', label: '#keep' }]);
  });
});
