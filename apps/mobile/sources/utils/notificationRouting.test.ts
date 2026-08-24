import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  isLegacySessionNotificationData,
  isLegacySessionNotificationResponse,
  getBuzzChannelIdFromNotificationData,
  navigateToBuzzChannelFromNotification,
} from './notificationRouting';

const buzzChatSource = readFileSync(
  new URL('../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);

describe('isLegacySessionNotificationData', () => {
  it('recognizes a retired session notification by id', () => {
    expect(isLegacySessionNotificationData({ sessionId: 'session-123' })).toBe(true);
  });

  it('ignores notifications without a legacy session target', () => {
    expect(isLegacySessionNotificationData({ kind: 'done' })).toBe(false);
  });

  it('ignores empty session ids', () => {
    expect(isLegacySessionNotificationData({ sessionId: '   ' })).toBe(false);
  });

  it('recognizes a retired session URL', () => {
    expect(isLegacySessionNotificationData({ url: '/session/session-123' })).toBe(true);
  });
});

describe('isLegacySessionNotificationResponse', () => {
  it('reads the legacy target from content data', () => {
    expect(
      isLegacySessionNotificationResponse({
        notification: {
          request: {
            content: {
              data: { sessionId: 'session-123' },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it('returns false when content data is missing', () => {
    expect(
      isLegacySessionNotificationResponse({
        notification: {
          request: {
            content: {},
          },
        },
      }),
    ).toBe(false);
  });
});

describe('getBuzzChannelIdFromNotificationData', () => {
  it('routes merge approval notifications to their corner instead of a parent Room', () => {
    expect(
      getBuzzChannelIdFromNotificationData({
        channelId: 'parent-room',
        cornerId: 'review-corner',
        type: 'merge-approval-request',
      }),
    ).toBe('review-corner');
  });

  it('keeps ordinary channel activity on its channel', () => {
    expect(
      getBuzzChannelIdFromNotificationData({
        channelId: 'room-123',
        type: 'channel-activity',
      }),
    ).toBe('room-123');
  });

  it('routes an agent attention transition to its named corner', () => {
    expect(
      getBuzzChannelIdFromNotificationData({
        channelId: 'parent-room',
        cornerId: 'waiting-corner',
        type: 'agent-attention',
      }),
    ).toBe('waiting-corner');
  });
});

describe('navigateToBuzzChannelFromNotification', () => {
  it('reuses the room route and refreshes it for each notification response', () => {
    const navigate = vi.fn();

    navigateToBuzzChannelFromNotification({ navigate }, 'room-123', 'notification-456');

    expect(navigate).toHaveBeenCalledWith(
      {
        pathname: '/buzz/chat/[channelId]',
        params: {
          channelId: 'room-123',
          notificationResponseId: 'notification-456',
        },
      },
      { dangerouslySingular: true },
    );
  });

  it('uses the notification response id to invalidate the retained room backfill', () => {
    expect(buzzChatSource).toMatch(
      /const \{ channelId, notificationResponseId[^}]*\} = useLocalSearchParams/,
    );
    // The hydration effect must re-run when a notification re-opens the
    // same channel. Assert that dependency, not the whole literal list —
    // the rest of the list is free to change with the effect's internals.
    const hydrationDeps = buzzChatSource.match(
      /\}, \[decodedId, notificationResponseId[^\]]*\]\);/,
    );
    expect(
      hydrationDeps,
      'room hydration effect must depend on notificationResponseId',
    ).not.toBeNull();
  });
});
