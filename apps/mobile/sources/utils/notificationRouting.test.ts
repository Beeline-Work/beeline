import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  getBuzzNotificationTargetFromData,
  getBuzzChannelIdFromNotificationData,
  navigateToBuzzChannelFromNotification,
  navigateToBuzzNotificationResponse,
  navigateToBuzzTargetFromNotification,
} from './notificationRouting';

const buzzChatSource = readFileSync(
  new URL('../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const roomSurfaceSessionSource = readFileSync(
  new URL('../app/(app)/buzz/chat/useRoomSurfaceSession.ts', import.meta.url),
  'utf8',
);
const appLayoutSource = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');

describe('getBuzzChannelIdFromNotificationData', () => {
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

describe('getBuzzNotificationTargetFromData', () => {
  it('keeps the parent Room, corner, and message anchor from a corner push', () => {
    expect(
      getBuzzNotificationTargetFromData({
        type: 'agent-question',
        target: 'message',
        roomId: 'parent-room',
        channelId: 'corner-123',
        cornerId: 'corner-123',
        eventId: 'event-456',
        messageId: 'event-456',
      }),
    ).toEqual({
      type: 'agent-question',
      target: 'message',
      roomId: 'parent-room',
      channelId: 'corner-123',
      cornerId: 'corner-123',
      eventId: 'event-456',
      messageId: 'event-456',
    });
  });
});

describe('navigateToBuzzNotificationResponse', () => {
  it('opens a Room notification on exactly that Room, with no corner back-stack hints', () => {
    const navigate = vi.fn();

    const target = navigateToBuzzNotificationResponse(
      { navigate },
      {
        notification: {
          request: {
            identifier: 'response-room',
            content: {
              // The gateway's exact serialization for a Room mention
              // (see push-gateway mapping.test.ts).
              data: {
                type: 'mention',
                target: 'message',
                roomId: 'room-123',
                channelId: 'room-123',
                roomName: 'Roadmap',
                eventId: 'event-1',
                messageId: 'event-1',
              },
            },
          },
        },
      },
    );

    expect(target).toMatchObject({ channelId: 'room-123', roomId: 'room-123' });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      {
        pathname: '/buzz/chat/[channelId]',
        params: {
          channelId: 'room-123',
          notificationMessageId: 'event-1',
          notificationResponseId: 'response-room',
          notificationTarget: 'message',
        },
      },
      { dangerouslySingular: true },
    );
  });

  it.each(['cold', 'warm'])('%s tap opens the exact corner message', () => {
    const navigate = vi.fn();

    const target = navigateToBuzzNotificationResponse(
      { navigate },
      {
        notification: {
          request: {
            identifier: 'response-789',
            content: {
              data: {
                type: 'agent-question',
                target: 'message',
                roomId: 'parent-room',
                channelId: 'corner-123',
                cornerId: 'corner-123',
                eventId: 'event-456',
                messageId: 'event-456',
              },
            },
          },
        },
      },
    );

    expect(target).toMatchObject({ channelId: 'corner-123', messageId: 'event-456' });
    expect(navigate).toHaveBeenCalledWith(
      {
        pathname: '/buzz/chat/[channelId]',
        params: {
          channelId: 'corner-123',
          parent: 'parent-room',
          notificationFallbackChannelId: 'parent-room',
          notificationMessageId: 'event-456',
          notificationResponseId: 'response-789',
          notificationTarget: 'message',
        },
      },
      { dangerouslySingular: true },
    );
  });

  it('opens the parent Room when the corner target no longer exists', () => {
    const navigate = vi.fn();

    navigateToBuzzTargetFromNotification(
      { navigate },
      {
        type: 'agent-attention',
        target: 'corner',
        roomId: 'parent-room',
        channelId: 'corner-gone',
        cornerId: 'corner-gone',
        eventId: 'event-456',
      },
      'response-789',
      { targetExists: false },
    );

    expect(navigate).toHaveBeenCalledWith(
      {
        pathname: '/buzz/chat/[channelId]',
        params: {
          channelId: 'parent-room',
          notificationResponseId: 'response-789',
        },
      },
      { dangerouslySingular: true },
    );
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
    expect(buzzChatSource).toMatch(/notificationResponseId,[\s\S]*= useLocalSearchParams/);
    expect(buzzChatSource).toContain('notificationResponseId ? { notificationResponseId }');
    // The hydration effect must re-run when a notification re-opens the
    // same channel. Assert that dependency, not the whole literal list —
    // the rest of the list is free to change with the effect's internals.
    const hydrationEffect = roomSurfaceSessionSource.slice(
      roomSurfaceSessionSource.indexOf("useEffect(() => {\n    if (!channelId) return;"),
      roomSurfaceSessionSource.indexOf('const outbox = useMemo'),
    );
    expect(
      hydrationEffect,
      'room hydration effect must depend on notificationResponseId',
    ).toContain('notificationResponseId,');
  });

  it('wires the same precise handler to warm taps and cold-start responses', () => {
    expect(appLayoutSource).toContain('Notifications.addNotificationResponseReceivedListener');
    expect(appLayoutSource).toContain('Notifications.getLastNotificationResponseAsync()');
    expect(appLayoutSource.match(/handleNotificationResponse\(response\)/g)).toHaveLength(2);
    expect(appLayoutSource).toContain('navigateToBuzzNotificationResponse(router, response)');
  });

  it('anchors messages, then replaces a missing corner with its parent Room', () => {
    expect(buzzChatSource).toMatch(/scrollToIndex\(\{\s*index: visibleIndex/);
    expect(buzzChatSource).toContain('canonicalCornerStatus === \'archived\'');
    expect(buzzChatSource).toContain('roomSurface.parent === undefined');
    expect(buzzChatSource).toContain('params: { channelId: fallbackId, notificationResponseId }');
  });
});
