import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@beeline/nostr';
import { mapEventToNotification } from './mapping.js';

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
  it('maps a channel message to its sender and trimmed plaintext preview', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']]), {
      roomName: 'Demo channel',
      senderName: 'Ada',
    });

    expect(result).toEqual({
      channelId: 'channel-123',
      title: 'Ada',
      body: 'Ship the preview now.',
      data: { channelId: 'channel-123', roomName: 'Demo channel', type: 'channel-activity' },
    });
  });

  it('truncates long previews to 120 characters with an ellipsis', () => {
    const result = mapEventToNotification(event([['h', 'channel-123']], 'x'.repeat(121)), {
      roomName: 'Demo channel',
      senderName: 'Ada',
    });

    expect(result?.body).toHaveLength(120);
    expect(result?.body).toBe(`${'x'.repeat(119)}…`);
  });

  it('keeps hide-preview policy localized and falls back to the room for an unknown sender', () => {
    const result = mapEventToNotification(
      event([['h', 'channel-123']]),
      { roomName: 'Demo channel' },
      { showMessagePreview: false },
    );

    expect(result?.title).toBe('Demo channel');
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
    ).toBe('Joy');
    expect(
      mapEventToNotification(
        event([
          ['h', 'room-123'],
          ['t', 'buzz-attachment'],
        ]),
        context,
      )?.title,
    ).toBe('Joy');
  });

  it('ignores events without a channel', () => {
    expect(mapEventToNotification(event([]), { roomName: 'Room' })).toBeNull();
  });
});
