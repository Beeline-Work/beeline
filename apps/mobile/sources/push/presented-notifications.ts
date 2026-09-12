import { getBuzzNotificationTargetFromData } from '@/utils/notificationRouting';

export type PresentedNotification = {
  request: {
    identifier: string;
    content?: { data?: unknown };
  };
};

export type PresentedNotificationApi = {
  getPresentedNotificationsAsync(): Promise<readonly PresentedNotification[]>;
  dismissNotificationAsync(identifier: string): Promise<void>;
};

/** Dismiss every presented push whose Room or corner is now open. */
export async function dismissPresentedNotificationsForChannel(
  channelId: string,
  api: PresentedNotificationApi,
): Promise<void> {
  const openedChannelId = channelId.trim();
  if (!openedChannelId) return;

  const presented = await api.getPresentedNotificationsAsync();
  const matchingIds = presented.flatMap((notification) => {
    const target = getBuzzNotificationTargetFromData(notification.request.content?.data);
    return target &&
      target.target !== 'workspace' &&
      (target.channelId === openedChannelId || target.roomId === openedChannelId)
      ? [notification.request.identifier]
      : [];
  });
  await Promise.all(matchingIds.map((identifier) => api.dismissNotificationAsync(identifier)));
}
