import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { stageCornerComposerDraft } from '@/buzz/message-corner-forward';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import {
  NOTIFICATION_ACTION_TASK,
  NOTIFICATION_OUTCOME_CHANNEL,
  createHandledActionStore,
  handleNotificationAction,
  notificationActionCategories,
  replyDraftFromResponse,
  type NotificationActionDeps,
  type OutcomeNotification,
} from './notification-actions';

/**
 * Wires `notification-actions.ts` to the device. Imported from the app entry
 * (`index.ts`) so it runs in every JS runtime the app starts, including the
 * headless one Android starts for a notification action while the app is not
 * running:
 *
 * - Android, app not in the foreground: expo-notifications runs the
 *   registered task (`NOTIFICATION_ACTION_TASK`) for a tapped action.
 * - Android in the foreground, and iOS always: the response listener. iOS
 *   never runs the task for an action; an iOS app woken for a background
 *   action emits the response before JS listens, so the last response is also
 *   read once at start.
 *
 * The at-most-once memory absorbs the overlap between those paths.
 */

const platform = Platform.OS === 'ios' ? 'ios' : 'android';

function newMessageId(): string {
  return [...getRandomBytes(32)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function present(notification: OutcomeNotification): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: notification.identifier,
    content: {
      title: notification.title,
      body: notification.body,
      ...(notification.subtitle ? { subtitle: notification.subtitle } : {}),
      data: notification.data,
      ...(notification.categoryIdentifier
        ? { categoryIdentifier: notification.categoryIdentifier }
        : {}),
      sound: notification.quiet ? false : 'default',
      ...(platform === 'ios' && notification.quiet
        ? { interruptionLevel: 'passive' as const }
        : {}),
    },
    trigger:
      platform === 'android' && notification.quiet
        ? { channelId: NOTIFICATION_OUTCOME_CHANNEL }
        : null,
  });
}

const deps: NotificationActionDeps = {
  platform,
  decideGrant: (grantId, decision) =>
    monolithPhoneOperation('decideAgentGrant', { grantId, decision }),
  sendReply: ({ roomId, parentMessageId, text, messageId }) =>
    monolithPhoneOperation('sendRoomReply', {
      roomId,
      parentMessageId,
      text,
      messageId,
      mentions: [],
      attachments: [],
    }),
  newMessageId,
  present,
  handled: createHandledActionStore(AsyncStorage),
  inFlight: new Set(),
  log: (message) => console.warn(message),
};

function answer(payload: unknown): Promise<unknown> {
  return handleNotificationAction(payload, deps).catch((error: unknown) => {
    console.warn('[PUSH ACTION] unhandled failure', error);
    return null;
  });
}

/** A tap on a failed reply opens its Room with the typed text in the composer. */
function stageFailedReply(payload: unknown): void {
  const draft = replyDraftFromResponse(payload);
  if (draft) stageCornerComposerDraft(draft.roomId, draft.text);
}

function onResponse(response: Notifications.NotificationResponse): void {
  if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
    stageFailedReply(response);
    return;
  }
  void answer(response);
}

/**
 * expo-task-manager is native. An older binary reached by an over-the-air
 * update (a compatibility runtime) lacks it, and importing it there throws at
 * load, so it is required lazily and its absence switches actions off.
 */
function loadTaskManager(): typeof import('expo-task-manager') | null {
  try {
    return require('expo-task-manager') as typeof import('expo-task-manager');
  } catch {
    return null;
  }
}

let installed = false;

export function installNotificationActions(): void {
  if (installed || (Platform.OS !== 'android' && Platform.OS !== 'ios')) return;
  installed = true;

  if (Platform.OS === 'android') {
    // Without the task an action tapped while the app is closed would wait for
    // the next app start to run, so an Android binary without it offers none.
    const TaskManager = loadTaskManager();
    if (!TaskManager) return;
    try {
      TaskManager.defineTask<Notifications.NotificationTaskPayload>(
        NOTIFICATION_ACTION_TASK,
        async ({ data }) => {
          // Every push reaches this task too; only a tapped action is ours.
          if (data && typeof data === 'object' && 'actionIdentifier' in data) await answer(data);
          return Notifications.BackgroundNotificationTaskResult.NoData;
        },
      );
    } catch (error) {
      console.warn('[PUSH ACTION] task definition failed', error);
      return;
    }
    void Notifications.registerTaskAsync(NOTIFICATION_ACTION_TASK).catch((error: unknown) =>
      console.warn('[PUSH ACTION] task registration failed', error),
    );
    void Notifications.setNotificationChannelAsync(NOTIFICATION_OUTCOME_CHANNEL, {
      name: 'Notification replies and answers',
      importance: Notifications.AndroidImportance.LOW,
    }).catch(() => undefined);
  }

  for (const category of notificationActionCategories(platform))
    void Notifications.setNotificationCategoryAsync(category.identifier, category.actions).catch(
      (error: unknown) => console.warn('[PUSH ACTION] category registration failed', error),
    );

  Notifications.addNotificationResponseReceivedListener(onResponse);
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (response) onResponse(response);
    })
    .catch(() => undefined);
}
