import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import {
  isSuppressedFixtureNotification,
  isWaitingOnHumanEvent,
  mapEventToNotification,
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

  it('suppresses ambient Room chat by default', () => {
    expect(
      mapEventToNotification(event([['h', 'channel-123']]), {
        roomName: 'chodeclaw',
        senderName: 'Milo',
      }),
    ).toBeNull();
  });

  it('never pushes repository activity, even when its text looks like an agent question', () => {
    const repositoryActivity = event(
      [
        ['h', 'channel-123'],
        ['t', 'agent-message'],
        ['t', 'github-event'],
        ['repo', 'acme/widget'],
      ],
      'lena opened issue #4: Should this page move?',
    );
    expect(isWaitingOnHumanEvent(repositoryActivity)).toBe(false);
    expect(
      mapEventToNotification(repositoryActivity, {
        roomName: 'Widget',
        senderName: 'Beeline events',
      }),
    ).toBeNull();
  });

  it('keeps direct messages person-titled with a plain message body', () => {
    const result = mapEventToNotification(event([['h', 'dm-123']]), {
      roomName: 'Direct message',
      senderName: 'Milo',
      isDirectMessage: true,
    });

    expect(result?.title).toBe('Milo');
    expect(result?.body).toBe('Ship the preview now.');
    expect(result?.data.type).toBe('direct-message');
  });

  it('falls back to the resolved sender when a channel name or authored sender name is absent', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']]), {
      isDirectMessage: true,
    });

    expect(result?.title).not.toMatch(/^#/);
    expect(result?.title).not.toBe('New message');
    expect(result?.body).toBe('Ship the preview now.');
    expect(result?.data.roomName).toBe('Room');
  });

  it('truncates long previews to 120 characters with an ellipsis', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']], 'x'.repeat(121)), {
      roomName: 'Demo channel',
      senderName: 'Ada',
      isDirectMessage: true,
    });

    expect(result?.body).toBe(`${'x'.repeat(119)}…`);
  });

  it('keeps hide-preview policy localized and falls back to the room for an unknown sender', () => {
    const result = mapEventToNotification(
      event([['h', 'channel-123']]),
      { roomName: 'Demo channel', senderName: 'Ada', isDirectMessage: true },
      { showMessagePreview: false },
    );

    expect(result?.title).toBe('Ada');
    expect(result?.body).toBe('New direct message from Ada');
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
      { roomName: 'Push work', senderName: 'Ada', parentChannelId: 'room-123' },
    );

    expect(result?.title).toBe('Merge approval requested');
    expect(result?.body).toBe('Review requested in Push work');
    expect(result?.data).toMatchObject({
      type: 'merge-approval-request',
      target: 'approval',
      roomId: 'room-123',
      channelId: 'channel-123',
      cornerId: 'channel-123',
      eventId: 'a'.repeat(64),
      approvalId: 'a'.repeat(64),
    });
  });

  it('maps a fresh agent question and needs-attention transition to attention', () => {
    const question = event(
      [
        ['h', 'corner-question'],
        ['t', 'agent-message'],
      ],
      'Which target branch should I use?',
    );
    expect(isWaitingOnHumanEvent(question)).toBe(true);
    expect(
      mapEventToNotification(question, {
        roomName: 'Question',
        senderName: 'Codex',
        parentChannelId: 'parent-room',
      }),
    ).toMatchObject({
      body: 'Codex needs your reply: Which target branch should I use?',
      data: {
        type: 'agent-question',
        target: 'message',
        roomId: 'parent-room',
        channelId: 'corner-question',
        cornerId: 'corner-question',
        eventId: 'a'.repeat(64),
        messageId: 'a'.repeat(64),
      },
    });

    const transition = event([
      ['h', 'parent-room'],
      ['t', 'body-control'],
      ['display-status', 'needs-attention'],
      ['subchannel', 'corner-waiting'],
    ]);
    expect(isWaitingOnHumanEvent(transition)).toBe(true);
    expect(
      mapEventToNotification(transition, { roomName: 'Roadmap', senderName: 'Ox' }),
    ).toMatchObject({
      data: {
        type: 'agent-attention',
        target: 'corner',
        roomId: 'parent-room',
        channelId: 'corner-waiting',
        cornerId: 'corner-waiting',
        eventId: 'a'.repeat(64),
      },
    });
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

  it('keeps ordinary agent narration and attachments in-app only', () => {
    const context = { roomName: 'Room', senderName: 'Joy' };
    expect(
      mapEventToNotification(
        event([
          ['h', 'room-123'],
          ['t', 'agent-message'],
        ]),
        context,
      ),
    ).toBeNull();
    expect(
      mapEventToNotification(
        event([
          ['h', 'room-123'],
          ['t', 'buzz-attachment'],
        ]),
        context,
      ),
    ).toBeNull();
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

describe('mention mapping', () => {
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
      mapEventToNotification(
        relayEvent,
        { ...ROOM_CONTEXT, senderName: 'Ada' },
        {
          recipientMentioned: true,
        },
      ),
    ).toMatchObject({
      title: '#Roadmap',
      body: 'Ada mentioned you: Ship the preview now.',
      data: {
        type: 'mention',
        target: 'message',
        roomId: 'room',
        channelId: 'room',
        eventId: 'a'.repeat(64),
        messageId: 'a'.repeat(64),
      },
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

  it('keeps the same plain chat in-app only when the recipient is not mentioned', () => {
    const relayEvent = event([
      ['h', 'room'],
      ['t', 'agent-message'],
    ]);
    expect(mapEventToNotification(relayEvent, { ...ROOM_CONTEXT, senderName: 'Ada' })).toBeNull();
  });
});
