import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getBuzzNotificationTargetFromData } from '@/utils/notificationRouting';
import { prefetchPushRoom } from './push-room-prefetch';

/** Begin the cold push read as the JS bundle starts, before the root mounts. */
export function prefetchLastPushedRoom(): void {
  if (Platform.OS !== 'android') return;
  try {
    const response = Notifications.getLastNotificationResponse();
    if (response?.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const responseId = response.notification.request.identifier;
    const target = getBuzzNotificationTargetFromData(response.notification.request.content.data);
    if (
      responseId && target?.target === 'message' && target.workspaceId &&
      target.roomId === target.channelId && !target.cornerId
    ) {
      prefetchPushRoom(responseId, target.channelId);
    }
  } catch {
    // Native response replay still runs from the root layout if the sync
    // getter is unavailable in this runtime.
  }
}
