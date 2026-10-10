import { getBuzzNotificationTargetFromData } from '@/utils/notificationRouting';
import type { PushLevel } from '@beeline/api-contract/phone';

export type PresentedNotification = {
  /** When iOS presented it: epoch seconds on iOS, milliseconds on Android. */
  date?: number;
  request: {
    identifier: string;
    content?: { data?: unknown };
  };
};

export type PresentedNotificationApi = {
  getPresentedNotificationsAsync(): Promise<readonly PresentedNotification[]>;
  dismissNotificationAsync(identifier: string): Promise<void>;
  setBadgeCountAsync(count: number): Promise<unknown>;
};

export type PresentedNotificationStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

const LEGACY_PRESENTED_NOTIFICATIONS_CLEARED_KEY = '@beeline/push/android-room-tag-migration/v1';
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read the Android notification tag Expo retains for system-presented rows. */
export function presentedNotificationIdentifierTag(identifier: string): string | null {
  const prefix = 'expo-notifications://foreign_notifications?';
  if (!identifier.startsWith(prefix)) return null;
  const query = identifier.slice(prefix.length).split('#', 1)[0] ?? '';
  for (const field of query.split('&')) {
    const separator = field.indexOf('=');
    if (separator < 0 || field.slice(0, separator) !== 'tag') continue;
    try {
      const tag = decodeURIComponent(field.slice(separator + 1).replace(/\+/g, ' ')).trim();
      return tag || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Match data-rich Expo rows first, then Android's data-less foreign-row tag.
 * Only the conversation that opened matches: a Room never claims its corners'
 * pushes, and a corner never claims its Room's.
 */
export function presentedNotificationMatchesChannel(
  notification: PresentedNotification,
  openedChannelId: string,
): boolean {
  const target = getBuzzNotificationTargetFromData(notification.request.content?.data);
  if (target) {
    return (
      target.target !== 'workspace' &&
      (target.channelId === openedChannelId || target.cornerId === openedChannelId)
    );
  }
  return presentedNotificationIdentifierTag(notification.request.identifier) === openedChannelId;
}

/** Remove pre-Room-tag Android rows once; their original destination is unrecoverable. */
export async function clearLegacyPresentedNotificationsOnce(
  api: PresentedNotificationApi,
  platform: string,
  storage: PresentedNotificationStorage,
): Promise<void> {
  if (platform !== 'android') return;
  if (await storage.getItem(LEGACY_PRESENTED_NOTIFICATIONS_CLEARED_KEY)) return;

  const presented = await api.getPresentedNotificationsAsync();
  const legacyIds = presented.flatMap((notification) => {
    const target = getBuzzNotificationTargetFromData(notification.request.content?.data);
    const tag = presentedNotificationIdentifierTag(notification.request.identifier);
    return !target && (!tag || !ROOM_ID.test(tag)) ? [notification.request.identifier] : [];
  });
  await Promise.all(legacyIds.map((identifier) => api.dismissNotificationAsync(identifier)));
  await storage.setItem(LEGACY_PRESENTED_NOTIFICATIONS_CLEARED_KEY, '1');
}

/** Keep iOS's app icon badge aligned with the notifications still in its shade. */
export async function reconcilePresentedNotificationBadge(
  api: PresentedNotificationApi,
  platform: string,
  pushLevel: PushLevel = 'mine',
): Promise<void> {
  if (pushLevel === 'off') {
    await api.setBadgeCountAsync(0);
    return;
  }
  if (platform !== 'ios') return;
  const presented = await api.getPresentedNotificationsAsync();
  await api.setBadgeCountAsync(presented.length);
}

/** Dismiss every presented push for the Room or corner that is now open. */
export async function dismissPresentedNotificationsForChannel(
  channelId: string,
  api: PresentedNotificationApi,
  platform: string,
): Promise<void> {
  await dismissPresentedNotificationsForChannels([{ channelId }], api, platform);
}

/** A presented notification's time in epoch milliseconds, or null when unknown. */
function presentedAtMs(notification: PresentedNotification): number | null {
  const date = notification.date;
  if (typeof date !== 'number' || !Number.isFinite(date) || date <= 0) return null;
  // Expo reports seconds on iOS and milliseconds on Android.
  return date < 1e11 ? date * 1000 : date;
}

/**
 * Dismiss presented pushes for these Rooms or corners — the ones opened here,
 * or read on another device — and recount iOS's badge from the shade. With a
 * `readAt`, only notifications presented at or before that read go: a newer
 * message arrived after the read and is still unread.
 */
export async function dismissPresentedNotificationsForChannels(
  reads: readonly { channelId: string; readAt?: number | null }[],
  api: PresentedNotificationApi,
  platform: string,
): Promise<void> {
  const readChannels = reads.flatMap((read) => {
    const channelId = read.channelId.trim();
    return channelId ? [{ channelId, readAt: read.readAt ?? null }] : [];
  });
  if (readChannels.length === 0) return;

  const presented = await api.getPresentedNotificationsAsync();
  const matchingIds = presented.flatMap((notification) =>
    readChannels.some(({ channelId, readAt }) => {
      if (!presentedNotificationMatchesChannel(notification, channelId)) return false;
      if (readAt === null) return true;
      const presentedAt = presentedAtMs(notification);
      return presentedAt !== null && presentedAt <= readAt;
    })
      ? [notification.request.identifier]
      : [],
  );
  await Promise.all(matchingIds.map((identifier) => api.dismissNotificationAsync(identifier)));
  if (platform === 'ios') await api.setBadgeCountAsync(presented.length - matchingIds.length);
}
