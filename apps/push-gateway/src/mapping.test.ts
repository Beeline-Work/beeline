import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import {
  isActionableHumanFailureEvent,
  isSuppressedFixtureNotification,
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
        fixtureMarkers: ['ui-demo'],
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

  it('never turns replaceable model draft chunks into pushes', () => {
    const draft = {
      ...event([
        ['h', 'corner-123'],
        ['p', 'recipient'],
        ['t', 'agent-draft'],
      ]),
      kind: 30078,
    };
    expect(
      mapEventToNotification(
        draft,
        { roomName: 'Corner', persistentWorkspaceRoom: true },
        { recipientMentioned: true },
      ),
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
    expect(isActionableHumanFailureEvent(repositoryActivity)).toBe(false);
    expect(
      mapEventToNotification(repositoryActivity, {
        roomName: 'Widget',
        senderName: 'Beeline events',
      }),
    ).toBeNull();
  });

  it('keeps direct messages person-titled with the compact handle body', () => {
    const result = mapEventToNotification(event([['h', 'dm-123']]), {
      roomName: 'Direct message',
      senderHandle: 'milo-dev',
      senderName: 'Milo Example',
      isDirectMessage: true,
    });

    expect(result?.title).toBe('Milo Example');
    expect(result?.body).toBe('@milo-dev: Ship the preview now.');
    expect(result?.data.type).toBe('direct-message');
  });

  it('falls back to the resolved sender when a channel name or authored sender name is absent', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']]), {
      isDirectMessage: true,
    });

    expect(result?.title).not.toMatch(/^#/);
    expect(result?.title).not.toBe('New message');
    expect(result?.body).toMatch(/^@.+: Ship the preview now\.$/);
    expect(result?.data.roomName).toBe('Room');
  });

  it('truncates long previews to 120 characters with an ellipsis', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']], 'x'.repeat(121)), {
      roomName: 'Demo channel',
      senderName: 'Ada',
      isDirectMessage: true,
    });

    expect(result?.body).toBe(`@Ada: ${'x'.repeat(119)}…`);
  });

  it('keeps hide-preview policy localized and falls back to the room for an unknown sender', () => {
    const result = mapEventToNotification(
      event([['h', 'channel-123']]),
      { roomName: 'Demo channel', senderName: 'Ada', isDirectMessage: true },
      { showMessagePreview: false },
    );

    expect(result?.title).toBe('Ada');
    expect(result?.body).toBe('@Ada: New message');
  });

  it('keeps replies and non-actionable attention cards in-app, but maps a blocked terminal failure', () => {
    const agentReply = event(
      [
        ['h', 'corner-question'],
        ['t', 'agent-message'],
      ],
      "Yep, I'm here. What do you need?",
    );
    expect(isActionableHumanFailureEvent(agentReply)).toBe(false);
    expect(
      mapEventToNotification(agentReply, {
        roomName: 'Question',
        senderName: 'Codex',
        parentChannelId: 'parent-room',
      }),
    ).toBeNull();

    const nothingReady = event(
      [
        ['h', 'parent-room'],
        ['t', 'body-control'],
        ['display-status', 'needs-attention'],
        ['subchannel', 'corner-waiting'],
      ],
      'Nothing committed is ready for review.',
    );
    expect(
      mapEventToNotification(nothingReady, { roomName: 'Roadmap', senderName: 'Ox' }),
    ).toBeNull();

    const reviewPreparationExhausted = event(
      [
        ['h', 'corner-waiting'],
        ['t', 'merge-not-ready'],
        ['status', 'needs-attention'],
        ['tip', 'd'.repeat(40)],
      ],
      "Couldn't prepare this change for review after 3 attempts: relay unavailable.",
    );
    expect(
      mapEventToNotification(reviewPreparationExhausted, { roomName: 'Roadmap', senderName: 'Ox' }),
    ).toBeNull();

    const terminalFailure = event(
      [
        ['h', 'parent-room'],
        ['t', 'body-control'],
        ['status', 'failed'],
        ['display-status', 'needs-attention'],
        ['retry', 'blocked'],
        ['subchannel', 'corner-waiting'],
      ],
      'Could not follow the latest merge on the target branch. Open corner for details.',
    );
    expect(isActionableHumanFailureEvent(terminalFailure)).toBe(true);
    expect(
      mapEventToNotification(terminalFailure, { roomName: 'Roadmap', senderName: 'Ox' }),
    ).toMatchObject({
      body: '@Ox: Could not follow the latest merge on the target branch. Open corner for details.',
      data: {
        type: 'actionable-failure',
        target: 'corner',
        roomId: 'parent-room',
        channelId: 'corner-waiting',
        cornerId: 'corner-waiting',
        eventId: 'a'.repeat(64),
      },
    });
  });

  describe('channel-naming convention (captain, 2026-08)', () => {
    const ROOM_CONTEXT = {
      roomName: 'Roadmap',
      workspaceName: 'Product Engineering',
      persistentWorkspaceRoom: true,
    };
    const cornerContext = {
      roomName: 'fix-login-loop',
      parentChannelId: 'room-1',
      parentRoomName: 'Launch room',
      cornerName: 'fix-login-loop',
      senderName: 'Codex',
      persistentWorkspaceRoom: true as const,
    };

    it('titles a Room notification #<room>', () => {
      expect(
        mapEventToNotification(
          event([
            ['h', 'room-1'],
            ['p', 'a'.repeat(64)],
            ['t', 'agent-message'],
          ]),
          { ...ROOM_CONTEXT, senderName: 'Ada' },
          { recipientMentioned: true },
        )?.title,
      ).toBe('#Roadmap');
    });

    it('titles a Corner notification #<room>/<corner> from the PARENT Room display name', () => {
      const result = mapEventToNotification(
        event(
          [
            ['h', 'corner-1'],
            ['p', 'a'.repeat(64)],
            ['t', 'agent-message'],
          ],
          'Which target branch should I use?',
        ),
        cornerContext,
        { recipientMentioned: true },
      );
      // The Room half is the resolved parent's current display name, not the
      // corner name duplicated and never invented.
      expect(result?.title).toBe('#Launch room/fix-login-loop');
      expect(result?.body).toBe('@Codex: Which target branch should I use?');
    });

    it('serializes the exact routing payload a corner tap needs', () => {
      expect(
        mapEventToNotification(
          event([
            ['h', 'corner-1'],
            ['p', 'a'.repeat(64)],
            ['t', 'agent-message'],
          ]),
          { ...cornerContext, workspaceName: 'Product Engineering' },
          { recipientMentioned: true },
        )?.data,
      ).toEqual({
        type: 'mention',
        target: 'message',
        roomId: 'room-1',
        channelId: 'corner-1',
        cornerId: 'corner-1',
        eventId: 'a'.repeat(64),
        messageId: 'a'.repeat(64),
        roomName: 'fix-login-loop',
      });
    });

    it('falls back honestly when the parent Room metadata is absent or deleted', () => {
      // No fabricated room name: the title keeps this gateway's long-standing
      // shape — the event channel's own resolved name.
      expect(
        mapEventToNotification(
          event(
            [
              ['h', 'corner-1'],
              ['p', 'a'.repeat(64)],
              ['t', 'agent-message'],
            ],
            'Which target branch should I use?',
          ),
          { ...cornerContext, parentRoomName: undefined },
          { recipientMentioned: true },
        )?.title,
      ).toBe('#fix-login-loop');
      // With no resolvable name at all, the sender fallback stands.
      expect(
        mapEventToNotification(
          event(
            [
              ['h', 'corner-1'],
              ['p', 'a'.repeat(64)],
              ['t', 'agent-message'],
            ],
            'Which target branch should I use?',
          ),
          {
            ...cornerContext,
            parentRoomName: undefined,
            cornerName: undefined,
            roomName: undefined,
          },
          { recipientMentioned: true },
        )?.title,
      ).toBe('Codex');
    });

    it('titles a subchannel terminal-failure card #<room>/<corner> with both resolved names', () => {
      const transition = event([
        ['h', 'parent-room'],
        ['t', 'body-control'],
        ['status', 'failed'],
        ['display-status', 'needs-attention'],
        ['retry', 'blocked'],
        ['subchannel', 'corner-waiting'],
      ]);
      expect(
        mapEventToNotification(transition, {
          roomName: 'Roadmap',
          senderName: 'Ox',
          cornerName: 'waiting-corner',
          parentRoomName: 'Roadmap',
        })?.title,
      ).toBe('#Roadmap/waiting-corner');
    });

    it('leaves direct-message titles untouched', () => {
      expect(
        mapEventToNotification(event([['h', 'dm-1']]), {
          ...cornerContext,
          isDirectMessage: true,
          cornerName: undefined,
          parentRoomName: undefined,
          parentChannelId: undefined,
        })?.title,
      ).toBe('Codex');
    });
  });

  it('ignores activity frames and non-request control events', () => {
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
        { ...ROOM_CONTEXT, senderHandle: 'ada-labs', senderName: 'Ada' },
        {
          recipientMentioned: true,
        },
      ),
    ).toMatchObject({
      title: '#Roadmap',
      body: '@ada-labs: Ship the preview now.',
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
      body: '@Ada: New message',
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
