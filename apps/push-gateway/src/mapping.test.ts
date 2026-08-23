import { fallbackPersonName } from '@beeline/buzz-client';
import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import {
  isSuppressedFixtureNotification,
  mapEventToNotification,
  mapMembershipJoinToNotification,
  membershipJoin,
  mentionsMember,
} from './mapping.js';

function event(tags: string[][], content = '  Ship the preview now.  '): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1,
    kind: 9,
    tags,
    content,
    sig: 'c'.repeat(128),
  };
}

describe('mapEventToNotification', () => {
  it('fails closed unless the Room is durably linked to a non-fixture Workspace', () => {
    const relayEvent = event([['h', 'room']]);
    expect(isSuppressedFixtureNotification(relayEvent, { roomName: 'Roadmap' })).toBe(true);
    expect(
      isSuppressedFixtureNotification(relayEvent, {
        roomName: 'Roadmap',
        workspaceName: 'Product Engineering',
        persistentWorkspaceRoom: true,
      }),
    ).toBe(false);
    expect(
      isSuppressedFixtureNotification(relayEvent, {
        roomName: 'Roadmap',
        workspaceName: 'Push test workspace',
        persistentWorkspaceRoom: true,
      }),
    ).toBe(true);
  });

  it.each([
    'ui-demo-uidemo-123',
    'research-no-findings-xyz',
    'review-corner-navigation',
    'repository-uidemo-123',
    'room-invite-repair-abc',
    'room-invite-visibility-abc',
  ])('suppresses fixture room or repository name %s', (fixtureName) => {
    expect(
      isSuppressedFixtureNotification(event([['h', 'fixture']]), {
        roomName: fixtureName,
        workspaceName: 'Product Engineering',
        persistentWorkspaceRoom: true,
      }),
    ).toBe(true);
    expect(
      isSuppressedFixtureNotification(
        event([
          ['h', 'fixture'],
          ['repo', `${'d'.repeat(64)}/${fixtureName}`],
        ]),
        {
          roomName: 'Roadmap',
          workspaceName: 'Product Engineering',
          persistentWorkspaceRoom: true,
        },
      ),
    ).toBe(true);
  });

  it('suppresses explicit message and resolved Room fixture markers', () => {
    const context = {
      roomName: 'Roadmap',
      workspaceName: 'Product Engineering',
      persistentWorkspaceRoom: true,
    };
    expect(
      isSuppressedFixtureNotification(
        event([
          ['h', 'room'],
          ['fixture', 'anything'],
        ]),
        context,
      ),
    ).toBe(true);
    expect(
      isSuppressedFixtureNotification(
        event([
          ['h', 'room'],
          ['t', 'ui-test'],
        ]),
        context,
      ),
    ).toBe(true);
    expect(
      isSuppressedFixtureNotification(event([['h', 'room']]), {
        ...context,
        fixtureMarkers: ['change-review-manifest'],
      }),
    ).toBe(true);
  });

  it('maps a named channel message to a Slack-style title and sender-prefixed preview', () => {
    const result = mapEventToNotification(
      event([['h', 'channel-123']], 'just for 2 people please'),
      {
        roomName: 'chodeclaw',
        senderName: 'Milo',
      },
    );

    expect(result).toEqual({
      channelId: 'channel-123',
      title: '#chodeclaw',
      body: 'Milo: just for 2 people please',
      data: { channelId: 'channel-123', roomName: 'chodeclaw', type: 'channel-activity' },
    });
  });

  it('does not double-prefix a channel name that already starts with #', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']]), {
      roomName: '#chodeclaw',
      senderName: 'Milo',
    });

    expect(result?.title).toBe('#chodeclaw');
    expect(result?.body).toBe('Milo: Ship the preview now.');
  });

  it('keeps direct messages person-titled with a plain message body', () => {
    const result = mapEventToNotification(event([['h', 'dm-123']]), {
      roomName: 'Direct message',
      senderName: 'Milo',
      isDirectMessage: true,
    });

    expect(result?.title).toBe('Milo');
    expect(result?.body).toBe('Ship the preview now.');
  });

  it('falls back to the resolved sender when a channel name or authored sender name is absent', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']]), {});

    expect(result?.title).not.toMatch(/^#/);
    expect(result?.title).not.toBe('New message');
    expect(result?.body).toBe(`${result?.title}: Ship the preview now.`);
    expect(result?.data.roomName).toBe('Room');
  });

  it('truncates long previews to 120 characters with an ellipsis', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']], 'x'.repeat(121)), {
      roomName: 'Demo channel',
      senderName: 'Ada',
    });

    expect(result?.body).toBe(`Ada: ${'x'.repeat(119)}…`);
  });

  it('keeps hide-preview policy localized and falls back to the room for an unknown sender', () => {
    const result = mapEventToNotification(
      event([['h', 'channel-123']]),
      { roomName: 'Demo channel' },
      { showMessagePreview: false },
    );

    expect(result?.title).toBe('#Demo channel');
    expect(result?.body).toBe('New message in Demo channel');
  });

  it('maps body merge metadata to an approval request', () => {
    const result = mapEventToNotification(
      event([
        ['h', 'channel-123'],
        ['t', 'body-control'],
        ['repo', 'owner/repo'],
        ['branch', 'feature/push'],
        ['tip', 'd'.repeat(40)],
      ]),
      { roomName: 'Push work', senderName: 'Ada' },
    );

    expect(result?.title).toBe('Merge approval requested');
    expect(result?.body).toBe('Review requested in Push work');
    expect(result?.data.type).toBe('merge-approval-request');
    expect(result?.data.cornerId).toBe('channel-123');
  });

  it('ignores activity frames, approval grants, and non-request control events', () => {
    const context = { roomName: 'Room' };
    expect(
      mapEventToNotification(
        event([
          ['h', 'c'],
          ['t', 'agent-activity'],
        ]),
        context,
      ),
    ).toBeNull();
    expect(
      mapEventToNotification(
        event([
          ['h', 'c'],
          ['t', 'buzz-merge-approval'],
        ]),
        context,
      ),
    ).toBeNull();
    expect(
      mapEventToNotification(
        event([
          ['h', 'c'],
          ['t', 'body-control'],
        ]),
        context,
      ),
    ).toBeNull();
  });

  it('ignores agent identity records and other structured control events', () => {
    const context = { roomName: 'Workspace', senderName: 'Rhea' };
    expect(
      mapEventToNotification(
        event(
          [
            ['h', 'workspace-123'],
            ['t', 'buzz-agent'],
            ['d', 'agent-1'],
            ['p', 'b'.repeat(64)],
          ],
          JSON.stringify({ displayName: 'Rhea' }),
        ),
        context,
      ),
    ).toBeNull();
    expect(
      mapEventToNotification(
        event([
          ['h', 'room-123'],
          ['t', 'buzz-agent-cancel'],
        ]),
        context,
      ),
    ).toBeNull();
    expect(
      mapEventToNotification(
        event([
          ['h', 'room-123'],
          ['t', 'unknown-control-record'],
        ]),
        context,
      ),
    ).toBeNull();
  });

  it('keeps known tagged chat messages notifiable', () => {
    const context = { roomName: 'Room', senderName: 'Joy' };
    expect(
      mapEventToNotification(
        event([
          ['h', 'room-123'],
          ['t', 'agent-message'],
        ]),
        context,
      )?.title,
    ).toBe('#Room');
    expect(
      mapEventToNotification(
        event([
          ['h', 'room-123'],
          ['t', 'buzz-attachment'],
        ]),
        context,
      )?.title,
    ).toBe('#Room');
  });

  it('ignores events without a channel', () => {
    expect(mapEventToNotification(event([]), { roomName: 'Room' })).toBeNull();
  });

  it('still suppresses a throwaway-named self-referencing Workspace group', () => {
    // The self-referencing fix makes the group's own name the workspace name;
    // the throwaway pattern must keep guarding that surface.
    const relayEvent = event([
      ['h', 'ws-channel'],
      ['t', 'agent-message'],
    ]);
    expect(
      isSuppressedFixtureNotification(relayEvent, {
        roomName: 'test',
        workspaceName: 'test',
        persistentWorkspaceRoom: true,
      }),
    ).toBe(true);
  });
});

describe('mention and member-join mapping', () => {
  const ROOM_CONTEXT = {
    roomName: 'Roadmap',
    workspaceName: 'Product Engineering',
    persistentWorkspaceRoom: true,
  };

  it('detects the app p-tag mention encoding for a kind:9 recipient', () => {
    const mentioned = event([
      ['h', 'room'],
      ['p', 'a'.repeat(64)],
      ['t', 'agent-message'],
    ]);
    expect(mentionsMember(mentioned, 'a'.repeat(64))).toBe(true);
    expect(mentionsMember(mentioned, 'b'.repeat(64))).toBe(false);
    // Mentions are a chat-message concept; a put-user p tag is not one.
    expect(mentionsMember({ ...mentioned, kind: 9000 }, 'a'.repeat(64))).toBe(false);
  });

  it('renders higher-signal mention copy while keeping the room title', () => {
    const relayEvent = event([
      ['h', 'room'],
      ['p', 'a'.repeat(64)],
      ['t', 'agent-message'],
    ]);
    expect(
      mapEventToNotification(relayEvent, { ...ROOM_CONTEXT, senderName: 'Ada' }, {
        recipientMentioned: true,
      }),
    ).toMatchObject({
      title: '#Roadmap',
      body: 'Ada mentioned you: Ship the preview now.',
      data: { type: 'mention', channelId: 'room' },
    });
    expect(
      mapEventToNotification(
        { ...relayEvent, content: '' },
        { ...ROOM_CONTEXT, senderName: 'Ada', isDirectMessage: true },
        { recipientMentioned: true },
      ),
    ).toMatchObject({
      title: 'Ada',
      body: 'Ada mentioned you',
      data: { type: 'mention' },
    });
  });

  it('keeps plain-chat copy when the message is not a mention', () => {
    const relayEvent = event([['h', 'room'], ['t', 'agent-message']]);
    expect(mapEventToNotification(relayEvent, { ...ROOM_CONTEXT, senderName: 'Ada' })).toMatchObject({
      title: '#Roadmap',
      body: 'Ada: Ship the preview now.',
      data: { type: 'channel-activity' },
    });
  });

  it('parses a real-shaped NIP-29 join and maps the bounded card', () => {
    const join = membershipJoin({
      id: 'a'.repeat(64),
      pubkey: 'c'.repeat(64),
      created_at: 1,
      kind: 9000,
      tags: [
        ['h', 'room-1234'],
        ['p', 'd'.repeat(64)],
        ['role', 'member'],
      ],
      content: '',
      sig: 'e'.repeat(128),
    });
    expect(join).toEqual({ channelId: 'room-1234', joinerPubkey: 'd'.repeat(64), role: 'member' });
    expect(membershipJoin(event([['h', 'room']]))).toBeNull();
    expect(membershipJoin({ ...event([['h', 'room']]), kind: 9000 })).toBeNull();

    expect(mapMembershipJoinToNotification({ ...event([]), kind: 9000 }, ROOM_CONTEXT)).toBeNull();
    expect(
      mapMembershipJoinToNotification(
        { ...event([['h', 'room-1234'], ['p', 'd'.repeat(64)], ['role', 'member']]), kind: 9000 },
        ROOM_CONTEXT,
        'Nova',
      ),
    ).toEqual({
      channelId: 'room-1234',
      title: '#Roadmap',
      body: 'Nova joined Roadmap',
      data: { channelId: 'room-1234', roomName: 'Roadmap', type: 'member-join' },
    });
    // A missing name falls back to the deterministic seed name, never blank.
    const fallback = mapMembershipJoinToNotification(
      { ...event([['h', 'room'], ['p', 'd'.repeat(64)]]), kind: 9000 },
      ROOM_CONTEXT,
    );
    expect(fallback?.body).toBe(`${fallbackPersonName('d'.repeat(64))} joined Roadmap`);
  });
});
