import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AttachmentReference, ChatListItem } from '@beeline/buzz-client';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Text: host('Text'), View: host('View') };
});
vi.mock('react-native-unistyles', () => {
  const value: any = new Proxy({}, { get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : value) });
  return {
    StyleSheet: { create: (factory: (theme: unknown) => unknown) => factory({ buzz: value }) },
  };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { identityHandle } from '@beeline/api-contract/phone';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import {
  roomRowShowsCornerMark,
  NO_ACTIVITY_PREVIEW,
  roomRowName,
  roomRowAttentionReason,
  roomRowNeedsAttention,
  roomRowPreview,
  roomListSections,
  directMessagePresence,
  personLastSeen,
} from './room-list-row';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

describe('Room list sections', () => {
  const chat = (
    id: string,
    updatedAt: number,
    direct = false,
    latestMessageAt?: number,
  ): ChatListItem =>
    ({
      room: { id, name: id, updatedAt },
      ...(latestMessageAt === undefined
        ? {}
        : {
            latestMessage: {
              id: `message-${id}`,
              text: id,
              createdAt: latestMessageAt,
              author: { pubkey: 'author', kind: 'human', name: 'Author' },
            },
          }),
      ...(direct
        ? { directMessage: { peer: { pubkey: `peer-${id}`, kind: 'human', name: id } } }
        : {}),
    }) as ChatListItem;

  it('keeps Rooms first and sorts direct messages by latest message', () => {
    const older = chat('older-dm', 30, true, 10);
    const newer = chat('newer-dm', 20, true, 40);
    const sections = roomListSections([older, chat('room-a', 50), newer, chat('room-b', 5)]);

    expect(sections.map((section) => section.title)).toEqual(['Rooms', 'Direct messages']);
    expect(sections[0]?.data.map((item) => item.room.id)).toEqual(['room-a', 'room-b']);
    expect(sections[1]?.data.map((item) => item.room.id)).toEqual(['newer-dm', 'older-dm']);
  });

  it('renders the Messages header between the Room and DM rows', () => {
    const sections = roomListSections([chat('dm', 2, true), chat('room', 1)]);
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        React.createElement(
          React.Fragment,
          null,
          ...sections.flatMap((section) => [
            ...(section.title
              ? [
                  React.createElement(RoomListSectionHeader, {
                    key: `header-${section.kind}`,
                    title: section.title,
                  }),
                ]
              : []),
            ...section.data.map((item) =>
              React.createElement('RoomRow', { key: item.room.id, roomId: item.room.id }),
            ),
          ]),
        ),
      );
    });

    const orderedRows = tree.root.findAll(
      (node) => node.type === 'Text' || node.type === 'RoomRow',
    );
    expect(
      orderedRows.map((node) => (node.type === 'Text' ? node.props.children : node.props.roomId)),
    ).toEqual(['ROOMS', 'room', 'DIRECT MESSAGES', 'dm']);
  });

  it('omits the Messages heading when there are no direct messages', () => {
    expect(roomListSections([chat('room-a', 1)])).toEqual([
      { kind: 'rooms', title: 'Rooms', data: [chat('room-a', 1)] },
    ]);
  });

  it('keeps empty sections available for creation actions when requested', () => {
    expect(roomListSections([], true)).toEqual([
      { kind: 'rooms', title: 'Rooms', data: [] },
      { kind: 'messages', title: 'Direct messages', data: [] },
    ]);
  });

  it('hides closed Rooms and DMs from the deck while retaining them in the source view', () => {
    const closedRoom = { ...chat('closed-room', 3), closed: true };
    const closedDm = { ...chat('closed-dm', 4, true), closed: true };
    const openRoom = chat('open-room', 2);
    const openDm = chat('open-dm', 1, true);
    const source = [closedRoom, closedDm, openRoom, openDm];

    expect(roomListSections(source).flatMap((section) => section.data)).toEqual([openRoom, openDm]);
    expect(source).toHaveLength(4);
  });
});

describe('Room row attention reason', () => {
  const author = {
    pubkey: 'author',
    kind: 'human' as const,
    name: 'Chloropine',
    handle: '@chloropine',
  };

  it('prefers an approval and names its actor', () => {
    expect(
      roomRowAttentionReason({
        unread: false,
        agentState: 'needs-you',
        attentionReason: { kind: 'approval', actor: 'Hoots' },
      }),
    ).toBe('approval · Hoots');
  });

  it('uses only a server-resolved mention fact', () => {
    expect(
      roomRowAttentionReason({
        unread: true,
        latestMessage: { id: 'message', text: 'hello', createdAt: 1, author, mentionsViewer: true },
      }),
    ).toBe('mention · @chloropine');
    expect(
      roomRowAttentionReason({
        unread: true,
        latestMessage: { id: 'message', text: '@viewer as prose', createdAt: 1, author },
      }),
    ).toBeNull();
  });

  it('drops a mention once the viewer has read it', () => {
    const mention = {
      id: 'message',
      text: '@viewer the avatar is saved',
      createdAt: 1,
      author,
      mentionsViewer: true as const,
    };
    expect(roomRowAttentionReason({ unread: true, latestMessage: mention })).toBe(
      'mention · @chloropine',
    );
    expect(roomRowAttentionReason({ unread: false, latestMessage: mention })).toBeNull();
  });

  it('keeps an approval whatever the read state', () => {
    expect(
      roomRowAttentionReason({
        unread: false,
        agentState: 'needs-you',
        attentionReason: { kind: 'approval', actor: 'Hoots' },
      }),
    ).toBe('approval · Hoots');
  });
});

describe('direct-message presence', () => {
  const peer = (kind: 'human' | 'agent', status: 'online' | 'offline', observedAt: number) =>
    ({
      directMessage: {
        peer: { pubkey: kind, kind, name: kind },
        presence: { status, observedAt },
      },
    }) as Pick<ChatListItem, 'directMessage' | 'agentState'>;

  it('reports an agent only while it is working, never idle or offline', () => {
    const observedAt = Math.floor(NOW / 1000);
    expect(
      directMessagePresence({ ...peer('agent', 'online', observedAt), agentState: 'working' }, NOW),
    ).toEqual({ label: 'working' });
    expect(directMessagePresence(peer('agent', 'online', observedAt), NOW)).toBeNull();
    expect(directMessagePresence(peer('agent', 'offline', observedAt), NOW)).toBeNull();
    // An idle helper waiting on its socket has no recent HTTP evidence.
    expect(directMessagePresence(peer('agent', 'online', observedAt - 120), NOW)).toBeNull();
  });

  it('reports person online and formats last-seen buckets', () => {
    const nowSeconds = Math.floor(NOW / 1000);
    expect(directMessagePresence(peer('human', 'online', nowSeconds), NOW)?.label).toBe('online');
    expect(personLastSeen(nowSeconds - 2 * 3_600, NOW)).toBe('last seen 2h');
    expect(personLastSeen(Math.floor(Date.UTC(2026, 0, 14, 20) / 1000), NOW)).toBe('yesterday');
    expect(personLastSeen(Math.floor(Date.UTC(2026, 0, 3, 20) / 1000), NOW)).toBe('Jan 3');
  });
});

// ── The Speakeasy index row (captain decision 2026-09-03) ────────────────────

const VIEWER = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const ROOM_ID = '7d111868-52eb-43ab-98ae-8a6c49b92da8';
const room = {
  id: ROOM_ID,
  workspaceId: ROOM_ID,
  name: 'design',
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};
const ada = { pubkey: PEER, kind: 'human' as const, name: 'Ada', handle: 'ada@usebeeline.app' };
const beebee = { pubkey: PEER, kind: 'agent' as const, name: 'Beebee' };
const squire = {
  pubkey: 's'.repeat(64),
  kind: 'human' as const,
  name: 'Trusty Squire',
  handle: 'trusty-squire',
};
const imageAttachment: AttachmentReference = {
  url: 'https://usebeeline.app/media/photo',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 1,
};
const documentAttachment: AttachmentReference = {
  ...imageAttachment,
  name: 'notes.pdf',
  mimeType: 'application/pdf',
};
const message = (
  author: typeof ada | typeof beebee,
  text = 'Hello',
  attachments?: readonly AttachmentReference[],
) => ({
  id: 'c'.repeat(64),
  text,
  createdAt: 2,
  author,
  ...(attachments ? { attachments } : {}),
});

describe('roomRowName — the sigil is the name’s first glyph', () => {
  it('names a Room `#` + its stored name', () => {
    expect(roomRowName({ room })).toEqual({ sigil: '#', name: 'design' });
  });

  it('never double-marks a stored name that already carries the mark', () => {
    expect(roomRowName({ room: { ...room, name: '#design' } }).name).toBe('design');
  });

  it('names a DM `@` + its peer handle without list-only identity data', () => {
    expect(
      roomRowName({ room: { ...room, name: 'Direct message' }, directMessage: { peer: ada } }),
    ).toEqual({
      sigil: '@',
      name: 'ada',
    });
    expect(roomRowName({ room, directMessage: { peer: beebee } })).toEqual({
      sigil: '@',
      name: 'Beebee',
    });
  });

  it('falls back to the Room id rather than an empty name', () => {
    expect(roomRowName({ room: { ...room, name: '  ' } }).name).toBe(ROOM_ID);
  });
});

describe('identityHandle in the Room list', () => {
  it('uses the connector name instead of its machine handle', () => {
    expect(identityHandle(squire)).toBe('Trusty Squire');
    expect(roomRowName({ room, directMessage: { peer: squire } })).toEqual({
      sigil: '@',
      name: 'Trusty Squire',
    });
  });
  it('names every fixed-logo bot in the Messages list', () => {
    for (const [name, handle] of [
      ['Wallet', 'wallet'],
      ['System', 'system'],
      ['Google Calendar', 'google-calendar'],
    ]) {
      const peer = { name, handle, avatar: `https://server.test/v1/connectors/logo/${handle}.svg` };
      expect(identityHandle(peer)).toBe(name);
      expect(
        roomRowName({ room, directMessage: { peer: { ...peer, pubkey: handle, kind: 'human' } } })
          .name,
      ).toBe(name);
    }
  });
  it('uses the local part of a nip05 handle, stripping any leading @', () => {
    expect(identityHandle({ name: 'Ada', handle: '@ada@usebeeline.app' })).toBe('ada');
  });

  it('falls back to the display name without a handle', () => {
    expect(identityHandle(beebee)).toBe('Beebee');
  });
});

describe('roomRowPreview — attribution', () => {
  it('attributes a warm cached grant DM to Trusty Squire even with an old agent author', () => {
    expect(
      roomRowPreview(
        {
          directMessage: { peer: squire },
          latestMessage: message(beebee, '@Beebee asked you for Squire'),
        },
        VIEWER,
      ),
    ).toEqual({
      attribution: 'other',
      handle: 'Trusty Squire',
      text: '@Beebee asked you for Squire',
    });
  });
  it('reads `you:` for the viewer’s own last message', () => {
    expect(roomRowPreview({ latestMessage: message({ ...ada, pubkey: VIEWER }) }, VIEWER)).toEqual({
      attribution: 'self',
      text: 'Hello',
    });
  });

  it('reads `@handle:` for anyone else, agents included', () => {
    expect(roomRowPreview({ latestMessage: message(ada) }, VIEWER)).toEqual({
      attribution: 'other',
      handle: 'ada',
      text: 'Hello',
    });
    expect(roomRowPreview({ latestMessage: message(beebee) }, VIEWER)).toEqual({
      attribution: 'other',
      handle: 'Beebee',
      text: 'Hello',
    });
  });

  it('reads `No messages yet` with no attribution for an empty Room', () => {
    expect(roomRowPreview({}, VIEWER)).toEqual({ attribution: 'none', text: 'No messages yet' });
    expect(roomRowPreview({ latestMessage: message(ada, '   ') }, VIEWER)).toEqual({
      attribution: 'none',
      text: NO_ACTIVITY_PREVIEW,
    });
  });

  it('labels an attachment-only last message with its sender', () => {
    expect(
      roomRowPreview({ latestMessage: message(ada, '   ', [imageAttachment]) }, VIEWER),
    ).toEqual({
      attribution: 'other',
      handle: 'ada',
      text: 'Image',
    });
    expect(
      roomRowPreview(
        { latestMessage: message({ ...ada, pubkey: VIEWER }, '', [documentAttachment]) },
        VIEWER,
      ),
    ).toEqual({ attribution: 'self', text: 'Attachment' });
  });

  it('keeps text as the preview when a message also has an attachment', () => {
    expect(
      roomRowPreview({ latestMessage: message(ada, 'Look here', [imageAttachment]) }, VIEWER),
    ).toEqual({
      attribution: 'other',
      handle: 'ada',
      text: 'Look here',
    });
  });
});

describe('roomRowNeedsAttention — the one brass square', () => {
  it('lights for unread and for a corner waiting on a human', () => {
    expect(roomRowNeedsAttention({ unread: true })).toBe(true);
    expect(roomRowNeedsAttention({ unread: false, agentState: 'needs-you' })).toBe(true);
  });

  it('stays dark for a quiet or merely working Room', () => {
    expect(roomRowNeedsAttention({ unread: false })).toBe(false);
    expect(roomRowNeedsAttention({ unread: false, agentState: 'working' })).toBe(false);
  });

  it('never hides unread behind a working agent', () => {
    expect(roomRowNeedsAttention({ unread: true, agentState: 'working' })).toBe(true);
  });

  it('lights for an unread mention and goes dark once it is read', () => {
    const latestMessage = {
      id: 'message',
      text: '@viewer the avatar is saved',
      createdAt: 1,
      author: { pubkey: 'speedy', kind: 'agent' as const, name: 'Speedy', handle: '@speedy' },
      mentionsViewer: true as const,
    };
    expect(roomRowNeedsAttention({ unread: true, latestMessage })).toBe(true);
    expect(roomRowNeedsAttention({ unread: false, latestMessage })).toBe(false);
  });

  it('keeps a corner waiting on a human lit after the Room is read', () => {
    expect(roomRowNeedsAttention({ unread: false, agentState: 'needs-you' })).toBe(true);
  });
});

describe('the corner-mark tip row', () => {
  const mine = { id: 'mine', name: 'My corner', state: 'working' as const, mine: true };
  const other = { id: 'other', name: 'Other corner', state: 'working' as const };
  const room = { room: { id: 'room', name: 'Room', updatedAt: 1 } } as unknown as ChatListItem;
  const direct = {
    ...room,
    directMessage: { peer: { pubkey: 'peer', kind: 'human', name: 'Peer' } },
  } as unknown as ChatListItem;
  const summary = (openCorners: NonNullable<ChatListItem['openCorners']>) =>
    ({ cornerCount: 5, openCorners });

  it('hides the mark when no viewer corners are listed despite a positive total', () => {
    expect(roomRowShowsCornerMark(room, summary([other]))).toBe(false);
    expect(roomRowShowsCornerMark(room, summary([]))).toBe(false);
    expect(roomRowShowsCornerMark(room, undefined)).toBe(false);
  });

  it('shows the mark when a viewer corner is listed, including a partial list', () => {
    expect(roomRowShowsCornerMark(room, summary([mine]))).toBe(true);
    expect(roomRowShowsCornerMark(room, summary([other, mine]))).toBe(true);
  });

  it('never shows the Room mark on a direct message', () => {
    expect(roomRowShowsCornerMark(direct, summary([mine]))).toBe(false);
  });
});
