import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  dismissPresentedNotificationsForChannel,
  reconcilePresentedNotificationBadge,
  type PresentedNotification,
} from './presented-notifications';

function notification(identifier: string, data: Record<string, unknown>): PresentedNotification {
  return { request: { identifier, content: { data } } };
}

const appLayoutSource = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');

describe('presented notification dismissal', () => {
  it('dismisses every notification for the exact Room or DM that opened', async () => {
    const dismissNotificationAsync = vi.fn(() => Promise.resolve());
    const setBadgeCountAsync = vi.fn(() => Promise.resolve(true));
    await dismissPresentedNotificationsForChannel(
      'room-a',
      {
        getPresentedNotificationsAsync: () =>
          Promise.resolve([
            notification('first', { type: 'message', channelId: 'room-a', roomId: 'room-a' }),
            notification('second', { type: 'mention', channelId: 'room-a', roomId: 'room-a' }),
            notification('third', { type: 'message', channelId: 'room-a', roomId: 'room-a' }),
            notification('other', { type: 'message', channelId: 'room-b', roomId: 'room-b' }),
          ]),
        dismissNotificationAsync,
        setBadgeCountAsync,
      },
      'ios',
    );

    expect(dismissNotificationAsync.mock.calls).toEqual([['first'], ['second'], ['third']]);
    expect(setBadgeCountAsync).toHaveBeenCalledWith(1);
  });

  it('sets the iOS badge to zero after viewing the last presented notification', async () => {
    const setBadgeCountAsync = vi.fn(() => Promise.resolve(true));

    await dismissPresentedNotificationsForChannel(
      'room-a',
      {
        getPresentedNotificationsAsync: () =>
          Promise.resolve([
            notification('last', { type: 'message', channelId: 'room-a', roomId: 'room-a' }),
          ]),
        dismissNotificationAsync: vi.fn(() => Promise.resolve()),
        setBadgeCountAsync,
      },
      'ios',
    );

    expect(setBadgeCountAsync).toHaveBeenCalledWith(0);
  });

  it('dismisses corner pushes on the parent Room or exact corner, never a sibling', async () => {
    const dismissNotificationAsync = vi.fn(() => Promise.resolve());
    const presented = [
      notification('corner', {
        type: 'agent-attention',
        target: 'corner',
        channelId: 'room-a',
        roomId: 'room-a',
        cornerId: 'corner-a',
      }),
    ];
    const api = {
      getPresentedNotificationsAsync: () => Promise.resolve(presented),
      dismissNotificationAsync,
      setBadgeCountAsync: vi.fn(() => Promise.resolve(true)),
    };

    await dismissPresentedNotificationsForChannel('corner-b', api, 'android');
    expect(dismissNotificationAsync).not.toHaveBeenCalled();
    await dismissPresentedNotificationsForChannel('room-a', api, 'android');
    expect(dismissNotificationAsync).toHaveBeenCalledWith('corner');

    await dismissPresentedNotificationsForChannel('corner-a', api, 'android');
    expect(dismissNotificationAsync).toHaveBeenCalledWith('corner');
    expect(api.setBadgeCountAsync).not.toHaveBeenCalled();
  });

  it('reconciles the iOS badge to the presented count', async () => {
    const setBadgeCountAsync = vi.fn(() => Promise.resolve(true));
    await reconcilePresentedNotificationBadge(
      {
        getPresentedNotificationsAsync: async () => [
          notification('first', { type: 'message', channelId: 'room-a' }),
          notification('second', { type: 'message', channelId: 'room-b' }),
        ],
        dismissNotificationAsync: vi.fn(() => Promise.resolve()),
        setBadgeCountAsync,
      },
      'ios',
    );

    expect(setBadgeCountAsync).toHaveBeenCalledWith(2);
  });

  it('leaves Android badge ownership unchanged', async () => {
    const getPresentedNotificationsAsync = vi.fn(() => Promise.resolve([]));
    const setBadgeCountAsync = vi.fn(() => Promise.resolve(true));
    await reconcilePresentedNotificationBadge(
      {
        getPresentedNotificationsAsync,
        dismissNotificationAsync: vi.fn(() => Promise.resolve()),
        setBadgeCountAsync,
      },
      'android',
    );

    expect(getPresentedNotificationsAsync).not.toHaveBeenCalled();
    expect(setBadgeCountAsync).not.toHaveBeenCalled();
  });

  it('runs badge reconciliation at launch and on app foreground', () => {
    expect(appLayoutSource).toContain('reconcileBadge();');
    expect(appLayoutSource).toContain("AppState.addEventListener('change', reconcileBadge)");
  });
});

it('clears a Room stack including its summary, while retaining other Rooms', async () => {
  const dismissNotificationAsync = vi.fn(async () => undefined);
  await dismissPresentedNotificationsForChannel(
    'room-a',
    {
      getPresentedNotificationsAsync: async () => [
        notification('summary-a', {
          type: 'channel-activity',
          roomId: 'room-a',
          channelId: 'room-a',
          threadId: 'room-a',
          groupSummary: true,
        }),
        notification('corner-a', {
          type: 'channel-activity',
          roomId: 'room-a',
          channelId: 'corner-a',
          cornerId: 'corner-a',
          threadId: 'room-a',
        }),
        notification('room-b', {
          type: 'channel-activity',
          roomId: 'room-b',
          channelId: 'room-b',
          threadId: 'room-b',
        }),
      ],
      dismissNotificationAsync,
      setBadgeCountAsync: vi.fn(() => Promise.resolve(true)),
    },
    'android',
  );
  expect(dismissNotificationAsync.mock.calls).toEqual([['summary-a'], ['corner-a']]);
});
