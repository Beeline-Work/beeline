import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { readClearChannelIds } from '@beeline/api-contract/phone';
import { dismissPresentedNotificationsForChannels } from './presented-notifications';

export const READ_CLEAR_TASK = 'beeline-read-clear';

/**
 * Handle one background notification payload: when it is the server's silent
 * read-clear push, remove those Rooms' and corners' notifications from the
 * shade and recount the badge. Any other payload is left alone.
 */
export async function handleReadClearPayload(
  payload: unknown,
  api: Parameters<typeof dismissPresentedNotificationsForChannels>[1] = Notifications,
  platform: string = Platform.OS,
): Promise<boolean> {
  const channelIds = readClearChannelIds(payload);
  if (!channelIds?.length) return false;
  await dismissPresentedNotificationsForChannels(channelIds, api, platform);
  return true;
}

let installed = false;

/**
 * iOS wakes the app for the server's silent read-clear push (a Room read on
 * another device). Defined while the bundle loads, like the action task, so a
 * background launch finds it. An older binary without expo-task-manager
 * simply keeps clearing only when this device opens the Room.
 */
export function installReadClearTask(): void {
  if (installed || Platform.OS !== 'ios') return;
  installed = true;
  let TaskManager: typeof import('expo-task-manager');
  try {
    TaskManager = require('expo-task-manager') as typeof import('expo-task-manager');
  } catch {
    return;
  }
  try {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(
      READ_CLEAR_TASK,
      async ({ data }) => {
        const cleared = await handleReadClearPayload(data).catch((error: unknown) => {
          console.warn('[PUSH READ] clear failed', error);
          return false;
        });
        return cleared
          ? Notifications.BackgroundNotificationTaskResult.NewData
          : Notifications.BackgroundNotificationTaskResult.NoData;
      },
    );
  } catch (error) {
    console.warn('[PUSH READ] task definition failed', error);
    return;
  }
  void Notifications.registerTaskAsync(READ_CLEAR_TASK).catch((error: unknown) =>
    console.warn('[PUSH READ] task registration failed', error),
  );
}
