import { describe, expect, it, vi } from 'vitest';
import {
  dismissPresentedNotificationsForChannel,
  type PresentedNotification,
} from './presented-notifications';

function notification(identifier: string, data: Record<string, unknown>): PresentedNotification {
  return { request: { identifier, content: { data } } };
}

describe('presented notification dismissal', () => {
  it('dismisses every notification for the exact Room or DM that opened', async () => {
    const dismissNotificationAsync = vi.fn(() => Promise.resolve());
    await dismissPresentedNotificationsForChannel('room-a', {
      getPresentedNotificationsAsync: () =>
        Promise.resolve([
          notification('first', { type: 'message', channelId: 'room-a', roomId: 'room-a' }),
          notification('second', { type: 'mention', channelId: 'room-a', roomId: 'room-a' }),
          notification('other', { type: 'message', channelId: 'room-b', roomId: 'room-b' }),
        ]),
      dismissNotificationAsync,
    });

    expect(dismissNotificationAsync.mock.calls).toEqual([['first'], ['second']]);
  });

  it('dismisses a corner notification only when that exact corner opens', async () => {
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
    };

    await dismissPresentedNotificationsForChannel('room-a', api);
    expect(dismissNotificationAsync).not.toHaveBeenCalled();

    await dismissPresentedNotificationsForChannel('corner-a', api);
    expect(dismissNotificationAsync).toHaveBeenCalledWith('corner');
  });
});
