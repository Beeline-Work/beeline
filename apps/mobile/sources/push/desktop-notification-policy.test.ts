import { describe, expect, it } from 'vitest';
import type { ChatListItem, RoomViewMessage } from '@beeline/buzz-client';
import { desktopMessageMayNotify } from './desktop-notification-policy';

const me = 'viewer';
const message = {
  id: 'new-message',
  text: 'Please look',
  createdAt: 100,
  presentation: 'message',
  author: { pubkey: 'other', name: 'Other', kind: 'human' },
} as RoomViewMessage;
const room = {
  room: { id: 'room-1', name: 'Room' },
  unread: true,
} as ChatListItem;
const base = {
  message,
  room,
  viewerPubkey: me,
  level: 'default' as const,
  openChannelId: null,
  windowFocused: false,
};

describe('native desktop message display policy', () => {
  it('notifies a signed-in background DM and an exact tag or reply', () => {
    expect(
      desktopMessageMayNotify({ ...base, room: { ...room, directMessage: {} } as ChatListItem }),
    ).toBe(true);
    expect(
      desktopMessageMayNotify({ ...base, message: { ...message, mentionPubkeys: [me] } }),
    ).toBe(true);
    expect(desktopMessageMayNotify({ ...base, repliedToViewer: true })).toBe(true);
  });

  it('keeps focus, open Room, push level and author suppression', () => {
    const tagged = { ...base, message: { ...message, mentionPubkeys: [me] } };
    expect(desktopMessageMayNotify({ ...tagged, windowFocused: true })).toBe(false);
    expect(desktopMessageMayNotify({ ...tagged, openChannelId: 'room-1' })).toBe(false);
    expect(desktopMessageMayNotify({ ...tagged, level: 'off' })).toBe(false);
    expect(
      desktopMessageMayNotify({
        ...tagged,
        message: { ...tagged.message, author: { ...message.author, pubkey: me } },
      }),
    ).toBe(false);
    expect(
      desktopMessageMayNotify({
        ...base,
        message: { ...message, mentionPubkeys: ['someone-else'] },
      }),
    ).toBe(false);
  });

  it.each(['off', 'default', 'full'] as const)(
    'covers ordinary human/final/intermediate/own messages at %s',
    (level) => {
      const input = { ...base, level };
      expect(desktopMessageMayNotify(input)).toBe(level === 'full');
      const agent = {
        ...message,
        author: { ...message.author, kind: 'agent' as const },
        requestId: 'turn',
      };
      expect(desktopMessageMayNotify({ ...input, message: agent, finalAgentTurn: true })).toBe(
        level === 'full',
      );
      expect(desktopMessageMayNotify({ ...input, message: agent })).toBe(false);
      expect(
        desktopMessageMayNotify({
          ...input,
          message: { ...message, author: { ...message.author, pubkey: me } },
        }),
      ).toBe(false);
      expect(
        desktopMessageMayNotify({ ...input, message: { ...message, mentionPubkeys: [me] } }),
      ).toBe(level !== 'off');
    },
  );

  it('never draws deleted, activity, or relayed-up rows', () => {
    const direct = { ...base, room: { ...room, directMessage: {} } as ChatListItem };
    expect(desktopMessageMayNotify({ ...direct, message: { ...message, deleted: true } })).toBe(
      false,
    );
    expect(
      desktopMessageMayNotify({ ...direct, message: { ...message, presentation: 'activity' } }),
    ).toBe(false);
  });
});
