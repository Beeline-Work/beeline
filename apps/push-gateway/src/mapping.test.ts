import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import { isSuppressedFixtureNotification, mapEventToNotification } from './mapping.js';

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
});
