import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  getBuzzNotificationTargetFromData,
  getBuzzChannelIdFromNotificationData,
  navigateToBuzzChannelFromNotification,
  navigateToBuzzNotificationResponse,
  navigateToBuzzTargetFromNotification,
  resolveBuzzNotificationTarget,
} from './notificationRouting';

const buzzChatSource = readFileSync(
  new URL('../app/(app)/beeline/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const roomSurfaceSessionSource = readFileSync(
  new URL('../app/(app)/beeline/chat/useRoomSurfaceSession.ts', import.meta.url),
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
  it('keeps a push test non-routable', () => {
    expect(getBuzzNotificationTargetFromData({ type: 'test' })).toBeNull();
  });

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

  it('prefers the corner when a retained message push names its parent as the channel', () => {
    expect(
      getBuzzNotificationTargetFromData({
        type: 'mention',
        target: 'message',
        roomId: 'parent-room',
        channelId: 'parent-room',
        cornerId: 'corner-123',
        messageId: 'event-456',
      }),
    ).toMatchObject({
      target: 'message',
      roomId: 'parent-room',
      channelId: 'corner-123',
      cornerId: 'corner-123',
      messageId: 'event-456',
    });
  });
});

describe('navigateToBuzzNotificationResponse', () => {
  it('opens a workspace join on the exact Workspace and Room from the server payload', () => {
    const navigate = vi.fn();

    const target = navigateToBuzzNotificationResponse(
      { navigate },
      {
        notification: {
          request: {
            identifier: 'response-workspace-join',
            content: {
              data: {
                type: 'workspace-join',
                target: 'message',
                workspaceId: 'workspace-default',
                roomId: 'room-welcome',
                channelId: 'room-welcome',
              },
            },
          },
        },
      },
    );

    expect(target).toMatchObject({
      workspaceId: 'workspace-default',
      roomId: 'room-welcome',
      channelId: 'room-welcome',
    });
    expect(navigate).toHaveBeenCalledWith(
      {
        pathname: '/beeline/chat/[channelId]',
        params: {
          channelId: 'room-welcome',
          communityId: 'workspace-default',
          notificationResponseId: 'response-workspace-join',
          notificationTarget: 'message',
        },
      },
      { dangerouslySingular: true },
    );
  });

  it('opens a Workspace-only join on the Workspace rather than the last-open deck', () => {
    const navigate = vi.fn();

    const target = navigateToBuzzNotificationResponse(
      { navigate },
      {
        notification: {
          request: {
            identifier: 'response-workspace-only',
            content: {
              data: {
                type: 'workspace-join',
                target: 'workspace',
                workspaceId: 'workspace-default',
              },
            },
          },
        },
      },
    );

    expect(target).toEqual({
      type: 'workspace-join',
      target: 'workspace',
      workspaceId: 'workspace-default',
    });
    expect(navigate).toHaveBeenCalledWith(
      {
        pathname: '/beeline/channels',
        params: {
          communityId: 'workspace-default',
          notificationResponseId: 'response-workspace-only',
        },
      },
      { dangerouslySingular: true },
    );
  });

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
        pathname: '/beeline/chat/[channelId]',
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
        pathname: '/beeline/chat/[channelId]',
        params: {
          channelId: 'corner-123',
          parent: 'parent-room',
          notificationMessageId: 'event-456',
          notificationResponseId: 'response-789',
          notificationTarget: 'message',
        },
      },
      { dangerouslySingular: true },
    );
  });
});

describe('resolveBuzzNotificationTarget', () => {
  const roomTruth = (overrides: Record<string, unknown> = {}) => ({
    room: { id: 'room-1', workspaceId: 'workspace-1', archived: false },
    ...overrides,
  });

  it.each([
    [
      'Room mention',
      {
        type: 'channel-activity',
        target: 'message' as const,
        workspaceId: 'workspace-1',
        roomId: 'room-1',
        channelId: 'room-1',
        messageId: 'message-1',
      },
    ],
    [
      'DM',
      {
        type: 'channel-activity',
        target: 'message' as const,
        workspaceId: 'workspace-1',
        roomId: 'room-1',
        channelId: 'room-1',
        messageId: 'message-1',
      },
    ],
    [
      'system DM',
      {
        type: 'channel-activity',
        target: 'message' as const,
        workspaceId: 'workspace-1',
        roomId: 'room-1',
        channelId: 'room-1',
        messageId: 'message-1',
      },
    ],
    [
      'workspace join Room',
      {
        type: 'workspace-join',
        target: 'message' as const,
        workspaceId: 'workspace-1',
        roomId: 'room-1',
        channelId: 'room-1',
      },
    ],
  ])('switches Workspace before resolving a %s payload', async (_kind, target) => {
    const order: string[] = [];
    const resolved = await resolveBuzzNotificationTarget(target, {
      activateWorkspace: async (id) => {
        order.push(`workspace:${id}`);
      },
      readRoom: async (id) => {
        order.push(`room:${id}`);
        return roomTruth();
      },
    });
    expect(order).toEqual(['workspace:workspace-1', 'room:room-1']);
    expect(resolved.channelId).toBe('room-1');
  });

  it('resolves corner-open to the live corner', async () => {
    const resolved = await resolveBuzzNotificationTarget(
      {
        type: 'channel-activity',
        target: 'corner',
        workspaceId: 'workspace-2',
        roomId: 'parent-room',
        channelId: 'corner-1',
        cornerId: 'corner-1',
        messageId: 'card-1',
      },
      {
        activateWorkspace: async () => undefined,
        readRoom: async () =>
          roomTruth({
            room: {
              id: 'corner-1',
              workspaceId: 'workspace-2',
              parentId: 'parent-room',
              archived: false,
            },
            parent: { id: 'parent-room' },
          }),
      },
    );
    expect(resolved).toMatchObject({
      target: 'corner',
      roomId: 'parent-room',
      channelId: 'corner-1',
    });
  });

  it.each(['corner message', 'pull-request-opened', 'actionable-failure'])(
    'resolves a live %s payload to the named corner',
    async (type) => {
      const resolved = await resolveBuzzNotificationTarget(
        {
          type,
          target: type === 'corner message' ? 'message' : 'corner',
          workspaceId: 'workspace-2',
          roomId: 'parent-room',
          channelId: 'corner-1',
          cornerId: 'corner-1',
          messageId: 'message-1',
        },
        {
          activateWorkspace: async () => undefined,
          readRoom: async () =>
            roomTruth({
              room: {
                id: 'corner-1',
                workspaceId: 'workspace-2',
                parentId: 'parent-room',
                archived: false,
              },
              parent: { id: 'parent-room' },
            }),
        },
      );
      expect(resolved).toMatchObject({
        roomId: 'parent-room',
        channelId: 'corner-1',
        cornerId: 'corner-1',
      });
    },
  );

  it('switches a Workspace-only join without trying to read a Room', async () => {
    const activateWorkspace = vi.fn().mockResolvedValue(undefined);
    const readRoom = vi.fn();
    await expect(
      resolveBuzzNotificationTarget(
        { type: 'workspace-join', target: 'workspace', workspaceId: 'workspace-2' },
        { activateWorkspace, readRoom },
      ),
    ).resolves.toMatchObject({ target: 'workspace', workspaceId: 'workspace-2' });
    expect(activateWorkspace).toHaveBeenCalledWith('workspace-2');
    expect(readRoom).not.toHaveBeenCalled();
  });

  it.each(['archived corner-close', 'unavailable old corner'])(
    '%s falls back to the parent Room',
    async (kind) => {
      const target = {
        type: 'channel-activity',
        target: 'corner' as const,
        workspaceId: 'workspace-2',
        roomId: 'parent-room',
        channelId: 'corner-1',
        cornerId: 'corner-1',
        messageId: 'card-1',
      };
      const resolved = await resolveBuzzNotificationTarget(target, {
        activateWorkspace: async () => undefined,
        readRoom: async () => {
          if (kind.startsWith('unavailable')) throw new Error('gone');
          return roomTruth({
            room: {
              id: 'corner-1',
              workspaceId: 'workspace-2',
              parentId: 'parent-room',
              archived: true,
            },
            parent: { id: 'parent-room' },
            cornerLifecycle: { lifecycle: 'done' },
          });
        },
        isUnavailableError: () => true,
      });
      expect(resolved).toMatchObject({
        target: 'message',
        roomId: 'parent-room',
        channelId: 'parent-room',
      });
      expect(resolved).not.toHaveProperty('messageId');
    },
  );

  it('keeps the exact named route on a transient resolution failure', async () => {
    const target = {
      type: 'channel-activity',
      target: 'corner' as const,
      roomId: 'parent-room',
      channelId: 'corner-1',
    };
    await expect(
      resolveBuzzNotificationTarget(target, {
        activateWorkspace: async () => undefined,
        readRoom: async () => {
          throw new Error('offline');
        },
        isUnavailableError: () => false,
      }),
    ).resolves.toEqual(target);
  });
});

describe('navigateToBuzzChannelFromNotification', () => {
  it('reuses the room route and refreshes it for each notification response', () => {
    const navigate = vi.fn();

    navigateToBuzzChannelFromNotification({ navigate }, 'room-123', 'notification-456');

    expect(navigate).toHaveBeenCalledWith(
      {
        pathname: '/beeline/chat/[channelId]',
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
      roomSurfaceSessionSource.indexOf('useEffect(() => {\n    if (!channelId) return;'),
      roomSurfaceSessionSource.indexOf('const outbox = useMemo'),
    );
    expect(
      hydrationEffect,
      'room hydration effect must depend on notificationResponseId',
    ).toContain('notificationResponseId,');
  });

  it('wires the same precise handler to warm taps and cold-start responses', () => {
    expect(appLayoutSource).toContain('Notifications.addNotificationResponseReceivedListener');
    expect(appLayoutSource).toContain('Notifications.getLastNotificationResponseAsync');
    expect(appLayoutSource).toContain('startNotificationResponseEntries({');
    // The routing itself lives in push/notification-response.ts, which owns the
    // once-per-response guard and the wait for the app root's landing route;
    // push/notification-response.test.ts covers what a tap does.
    expect(appLayoutSource).toContain('routeBuzzNotificationResponse(response, {');
  });

  it('leaves message anchoring in the screen but keeps fallback in the resolver', () => {
    expect(buzzChatSource).toMatch(/scrollToIndex\(\{\s*index: visibleIndex/);
    expect(buzzChatSource).not.toContain('notificationFallbackChannelId');
  });
});
