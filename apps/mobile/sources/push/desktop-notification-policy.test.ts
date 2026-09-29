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
  level: 'mine' as const,
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

  it('never draws deleted, activity, or relayed-up rows', () => {
    const direct = { ...base, room: { ...room, directMessage: {} } as ChatListItem };
    expect(desktopMessageMayNotify({ ...direct, message: { ...message, deleted: true } })).toBe(
      false,
    );
    expect(
      desktopMessageMayNotify({ ...direct, message: { ...message, presentation: 'activity' } }),
    ).toBe(false);
    expect(
      desktopMessageMayNotify({
        ...direct,
        message: { ...message, relay: { direction: 'up' } as RoomViewMessage['relay'] },
      }),
    ).toBe(false);
  });
});
