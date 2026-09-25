import { describe, expect, it, vi } from 'vitest';
import {
  formatForwardedMessage,
  forwardedMessageParts,
  forwardMessageToRoom,
  forwardTargets,
  resolveForwardTargetRoom,
} from './message-forward';
import type { ChatListItem } from '@beeline/buzz-client';

describe('message forwarding', () => {
  it('quotes every source line and separates the Room caption', () => {
    const text = formatForwardedMessage('first\nsecond', 'general', {
      name: 'Alice Example',
      handle: '@alice@usebeeline.app',
    });
    expect(text).toBe('> first\n> second\n\nFORWARDED FROM #general · @alice');
    expect(forwardedMessageParts(text)).toEqual({
      body: '> first\n> second',
      caption: 'FORWARDED FROM #general · @alice',
    });
    expect(formatForwardedMessage('first', '#general', { name: 'Alice Example' })).toBe(
      '> first\n\nFORWARDED FROM #general · @Alice Example',
    );
  });

  it('keeps the original Room and poster when a forwarded message is forwarded again', () => {
    const original = formatForwardedMessage(
      'ship it',
      'general',
      { name: 'Alice', handle: 'alice' },
      { roomId: 'room-general', messageId: 'message-original' },
    );
    const forwardedAgain = formatForwardedMessage(
      original,
      'decisions',
      { name: 'Bob', handle: 'bob' },
      { roomId: 'room-decisions', messageId: 'message-forward' },
    );

    expect(forwardedMessageParts(forwardedAgain)).toEqual({
      body: '> > ship it',
      caption: 'FORWARDED FROM #general · @alice',
      source: { roomId: 'room-general', messageId: 'message-original' },
    });
    expect(forwardedAgain).not.toContain('#decisions');
    expect(forwardedAgain).not.toContain('@bob');
  });

  it('carries an exact source in a backward-compatible caption link', () => {
    const text = formatForwardedMessage(
      'open the source',
      'proof',
      { name: 'Alice', handle: 'alice' },
      { roomId: 'room-proof', messageId: 'message-source' },
    );

    expect(text).toBe(
      '> open the source\n\n[FORWARDED FROM #proof · @alice](beeline://message-source/room-proof/message-source)',
    );
    expect(forwardedMessageParts(text)).toEqual({
      body: '> open the source',
      caption: 'FORWARDED FROM #proof · @alice',
      source: { roomId: 'room-proof', messageId: 'message-source' },
    });
    expect(forwardedMessageParts('> legacy\n\nFORWARDED FROM #proof · @alice')).toEqual({
      body: '> legacy',
      caption: 'FORWARDED FROM #proof · @alice',
    });
  });

  it('posts the quoted source into the chosen Room', async () => {
    const send = vi.fn(async () => undefined);
    await forwardMessageToRoom(
      send,
      'room-two',
      {
        text: 'ship it',
        author: { name: 'Alice', handle: 'alice' },
        source: { roomId: 'room-one', messageId: 'message-one' },
      },
      'general',
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ roomId: 'room-two' });
    expect(forwardedMessageParts(send.mock.calls[0]![0].text)).toMatchObject({
      source: { roomId: 'room-one', messageId: 'message-one' },
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
    await forwardMessageToRoom(
      send,
      'room-two',
      { text: '', author: { name: 'Alice', handle: 'alice' }, attachments },
      'general',
    );
    expect(send).toHaveBeenCalledWith({
      roomId: 'room-two',
      text: '> \n\nFORWARDED FROM #general · @alice',
      attachments,
    });
  });

  it('omits the attachment field when the source message has none', async () => {
    const send = vi.fn(async () => undefined);
    await forwardMessageToRoom(
      send,
      'room-two',
      { text: 'hi', author: { name: 'Alice', handle: 'alice' }, attachments: [] },
      'general',
    );
    expect(send).toHaveBeenCalledWith({
      roomId: 'room-two',
      text: '> hi\n\nFORWARDED FROM #general · @alice',
    });
  });
});

describe('forward targets', () => {
  const workspace = {
    viewer: { identity: { pubkey: 'viewer', kind: 'human', name: 'Viewer' } },
    members: [
      { identity: { pubkey: 'viewer', kind: 'human', name: 'Viewer' }, role: 'owner' },
      {
        identity: { pubkey: 'person-new', kind: 'human', name: 'New Person', handle: '@new' },
        role: 'member',
      },
      {
        identity: { pubkey: 'person-dm', kind: 'human', name: 'DM Person', handle: '@dm' },
        role: 'member',
      },
    ],
    agents: [
      {
        identity: { pubkey: 'agent-new', kind: 'agent', name: 'Helper' },
        role: 'member',
      },
    ],
  } as const;

  const room = (overrides: {
    id: string;
    name: string;
    parentId?: string;
    archived?: boolean;
    directMessage?: ChatListItem['directMessage'];
  }): ChatListItem =>
    ({
      room: {
        id: overrides.id,
        name: overrides.name,
        parentId: overrides.parentId,
        archived: overrides.archived,
      },
      directMessage: overrides.directMessage,
    }) as ChatListItem;

  it('offers every top-level live Room including DMs, named like the Room list', () => {
    const targets = forwardTargets(
      [
        room({ id: 'r1', name: 'general' }),
        room({
          id: 'dm1',
          name: 'Direct message',
          directMessage: {
            peer: { pubkey: 'person-dm', name: 'Bee', handle: '@bee', kind: 'human' },
          },
        }),
        room({
          id: 'dm2',
          name: 'Direct message',
          directMessage: {
            peer: { pubkey: 'agent-dm', name: 'Scout', handle: '@scout', kind: 'agent' },
          },
        }),
      ],
      workspace,
      'here',
    );
    expect(targets).toEqual([
      { kind: 'room', id: 'r1', label: '#general', group: 'rooms' },
      { kind: 'room', id: 'dm1', label: '@bee', group: 'people' },
      { kind: 'room', id: 'dm2', label: '@scout', group: 'agents' },
      {
        kind: 'member',
        id: 'person-new',
        label: '@new',
        memberId: 'person-new',
        group: 'people',
      },
      {
        kind: 'member',
        id: 'agent-new',
        label: '@Helper',
        memberId: 'agent-new',
        group: 'agents',
      },
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
      { ...workspace, members: workspace.members.slice(0, 1), agents: [] },
      'here',
    );
    expect(targets).toEqual([{ kind: 'room', id: 'r2', label: '#keep', group: 'rooms' }]);
  });

  it('does not re-add the source DM peer as a member destination', () => {
    const targets = forwardTargets(
      [
        room({
          id: 'here',
          name: 'Direct message',
          directMessage: {
            peer: { pubkey: 'person-new', name: 'New Person', handle: '@new', kind: 'human' },
          },
        }),
      ],
      { ...workspace, members: workspace.members.slice(0, 2), agents: [] },
      'here',
    );
    expect(targets).toEqual([]);
  });

  it('resolves a member destination to a DM and leaves Room destinations unchanged', async () => {
    const resolveDirectMessage = vi.fn(async () => ({ channelId: 'new-dm' }));
    await expect(
      resolveForwardTargetRoom(
        {
          kind: 'member',
          id: 'person-new',
          label: '@new',
          memberId: 'person-new',
          group: 'people',
        },
        'workspace',
        resolveDirectMessage,
      ),
    ).resolves.toBe('new-dm');
    expect(resolveDirectMessage).toHaveBeenCalledWith('workspace', 'person-new');

    resolveDirectMessage.mockClear();
    await expect(
      resolveForwardTargetRoom(
        { kind: 'room', id: 'existing-room', label: '#general', group: 'rooms' },
        'workspace',
        resolveDirectMessage,
      ),
    ).resolves.toBe('existing-room');
    expect(resolveDirectMessage).not.toHaveBeenCalled();
  });
});
