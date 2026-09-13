import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  clearLegacyPresentedNotificationsOnce,
  dismissPresentedNotificationsForChannel,
  presentedNotificationIdentifierTag,
  presentedNotificationMatchesChannel,
  reconcilePresentedNotificationBadge,
  type PresentedNotification,
} from './presented-notifications';

function notification(identifier: string, data: Record<string, unknown>): PresentedNotification {
  return { request: { identifier, content: { data } } };
}

const appLayoutSource = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');

describe('presented notification dismissal', () => {
  const roomA = '11111111-1111-4111-8111-111111111111';
  const roomB = '22222222-2222-4222-8222-222222222222';

  it('parses only Expo foreign-notification tags', () => {
    expect(
      presentedNotificationIdentifierTag(
        `expo-notifications://foreign_notifications?id=0&tag=${roomA}`,
      ),
    ).toBe(roomA);
    expect(presentedNotificationIdentifierTag('ordinary-expo-identifier')).toBeNull();
    expect(
      presentedNotificationIdentifierTag(
        'expo-notifications://foreign_notifications?tag=%E0%A4%A&id=0',
      ),
    ).toBeNull();
  });

  it('matches Android foreign rows by the open Room or a corner parent', () => {
    const tagged = notification(`expo-notifications://foreign_notifications?tag=${roomA}&id=0`, {
      'android.title': 'Beeline',
    });
    expect(presentedNotificationMatchesChannel(tagged, roomA)).toBe(true);
    expect(presentedNotificationMatchesChannel(tagged, roomB)).toBe(false);
    expect(presentedNotificationMatchesChannel(tagged, 'corner-a', roomA)).toBe(true);
  });

  it('keeps data-based matching for Expo-presented rows', () => {
    const presented = notification('expo-row', {
      type: 'channel-activity',
      target: 'corner',
      channelId: 'corner-a',
      roomId: roomA,
      cornerId: 'corner-a',
    });
    expect(presentedNotificationMatchesChannel(presented, roomA)).toBe(true);
    expect(presentedNotificationMatchesChannel(presented, 'corner-a')).toBe(true);
    expect(presentedNotificationMatchesChannel(presented, roomB)).toBe(false);
  });

  it('dismisses only unattributable legacy rows once', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const dismissNotificationAsync = vi.fn(async () => undefined);
    const api = {
      getPresentedNotificationsAsync: vi.fn(async () => [
        notification(`expo-notifications://foreign_notifications?tag=${roomA}&id=0`, {
          'android.title': 'Beeline',
        }),
        notification('expo-notifications://foreign_notifications?tag=legacy-message-tag&id=0', {
          'android.title': 'Beeline',
        }),
        notification('expo-presented', {
          type: 'message',
          channelId: roomB,
          roomId: roomB,
        }),
      ]),
      dismissNotificationAsync,
      setBadgeCountAsync: vi.fn(async () => true),
    };

    await clearLegacyPresentedNotificationsOnce(api, 'android', storage);
    await clearLegacyPresentedNotificationsOnce(api, 'android', storage);

    expect(dismissNotificationAsync.mock.calls).toEqual([
      ['expo-notifications://foreign_notifications?tag=legacy-message-tag&id=0'],
    ]);
    expect(api.getPresentedNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('dismisses a tagged foreign row for the open Room but keeps another Room', async () => {
    const dismissNotificationAsync = vi.fn(async () => undefined);
    await dismissPresentedNotificationsForChannel(
      roomA,
      {
        getPresentedNotificationsAsync: async () => [
          notification(`expo-notifications://foreign_notifications?tag=${roomA}&id=0`, {
            'android.title': 'Beeline',
          }),
          notification(`expo-notifications://foreign_notifications?tag=${roomB}&id=0`, {
            'android.title': 'Beeline',
          }),
        ],
        dismissNotificationAsync,
        setBadgeCountAsync: vi.fn(async () => true),
      },
      'android',
    );

    expect(dismissNotificationAsync).toHaveBeenCalledOnce();
    expect(dismissNotificationAsync).toHaveBeenCalledWith(
      `expo-notifications://foreign_notifications?tag=${roomA}&id=0`,
    );
  });

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

  it('forces the badge to zero on every platform when push is off', async () => {
    const getPresentedNotificationsAsync = vi.fn(() => Promise.resolve([]));
    const setBadgeCountAsync = vi.fn(() => Promise.resolve(true));
    await reconcilePresentedNotificationBadge(
      {
        getPresentedNotificationsAsync,
        dismissNotificationAsync: vi.fn(() => Promise.resolve()),
        setBadgeCountAsync,
      },
      'android',
      'off',
    );
    expect(setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(getPresentedNotificationsAsync).not.toHaveBeenCalled();
  });

  it('runs badge reconciliation at launch and on app foreground', () => {
    expect(appLayoutSource).toContain('clearLegacyPresentedNotificationsOnce(');
    expect(appLayoutSource).toContain('reconcileBadge();');
    expect(appLayoutSource).toContain("AppState.addEventListener('change', reconcileBadge)");
    expect(appLayoutSource).toContain('loadStoredPushLevel(identity.publicKey)');
    expect(appLayoutSource).toContain("pushLevel !== 'off' && getOpenBuzzChannelId()");
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
