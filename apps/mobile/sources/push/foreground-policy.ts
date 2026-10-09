import { getBuzzNotificationTargetFromData } from '@/utils/notificationRouting';
import { ACTION_OUTCOME_DATA_KEY } from './notification-actions';

/**
 * Foreground banner policy for remote push notifications.
 *
 * This module is the earliest client-side decision about whether a
 * notification received while the app is foregrounded may be displayed as a
 * banner (`Notifications.setNotificationHandler`). It is deliberately PURE:
 * the app state and the currently open Room id are passed in by the caller
 * (the root layout handler reads them from `AppState` and the open-room
 * tracker), so the whole rule is unit-testable without React Native.
 *
 * Contracts:
 * - While React Native AppState is 'active', a push for another conversation
 *   is shown and kept in the notification list, but silently: no sound and no
 *   vibration. It stays there until its conversation is opened.
 * - Always suppress when the notification's channel/Room id is the currently
 *   open Room, regardless of app state — even mid-transition they are already
 *   reading exactly that conversation.
 * - Always present an Android rewrite of a notification whose action was just
 *   answered; suppressing it leaves an inline reply spinning in the shade.
 * - Background/unrelated notifications keep their existing display behavior.
 *
 * This is display policy ONLY. Deep-link routing of notification responses
 * (`notificationRouting.ts`) and background delivery are untouched.
 */

export type ForegroundNotificationDecisionReason =
  | 'action-outcome'
  | 'open-room-match'
  | 'app-active'
  | 'app-inactive';

export type ForegroundNotificationDecision = {
  /** Whether the OS may present the notification at all in the foreground. */
  shouldPresent: boolean;
  /** Whether presenting it may ring or vibrate. */
  shouldPlaySound: boolean;
  reason: ForegroundNotificationDecisionReason;
};

export type ForegroundNotificationInput = {
  /** React Native `AppState.currentState` ('active' | 'background' | ...). */
  appState?: string | null;
  /** Channel id of the chat screen currently open on top, if any. */
  openChannelId?: string | null;
  /** The notification's `request.content.data`, string JSON or object. */
  data?: unknown;
};

/** Resolve which channel ids this notification is "about" for room matching. */
export function foregroundNotificationChannelIds(data: unknown): {
  channelId: string | null;
  roomId: string | null;
} {
  const target = getBuzzNotificationTargetFromData(data);
  if (!target) {
    return { channelId: null, roomId: null };
  }
  return { channelId: target.channelId ?? null, roomId: target.roomId ?? null };
}

/**
 * Decide whether a notification delivered while the app is foregrounded may
 * be displayed. Missing channel metadata can never match an open Room, so it
 * falls through to the broader app-state rule alone.
 */
export function decideForegroundNotificationDisplay(
  input: ForegroundNotificationInput,
): ForegroundNotificationDecision {
  const { appState, openChannelId, data } = input;

  if (
    data &&
    typeof data === 'object' &&
    (data as Record<string, unknown>)[ACTION_OUTCOME_DATA_KEY] === 'true'
  ) {
    return { shouldPresent: true, shouldPlaySound: true, reason: 'action-outcome' };
  }

  // Open-Room suppression wins regardless of the broader app-state signal.
  const trimmedOpenChannelId = typeof openChannelId === 'string' ? openChannelId.trim() : '';
  if (trimmedOpenChannelId) {
    const { channelId, roomId } = foregroundNotificationChannelIds(data);
    if (
      (channelId && channelId === trimmedOpenChannelId) ||
      (roomId && roomId === trimmedOpenChannelId)
    ) {
      return { shouldPresent: false, shouldPlaySound: false, reason: 'open-room-match' };
    }
  }

  if (appState === 'active') {
    return { shouldPresent: true, shouldPlaySound: false, reason: 'app-active' };
  }

  return { shouldPresent: true, shouldPlaySound: true, reason: 'app-inactive' };
}

/** Map a decision onto the behavior `Notifications.setNotificationHandler` returns. */
export function foregroundNotificationBehavior(decision: ForegroundNotificationDecision): {
  shouldShowAlert: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
  shouldShowBanner: boolean;
  shouldShowList: boolean;
} {
  return {
    shouldShowAlert: decision.shouldPresent,
    shouldPlaySound: decision.shouldPresent && decision.shouldPlaySound,
    shouldSetBadge: decision.shouldPresent,
    shouldShowBanner: decision.shouldPresent,
    shouldShowList: decision.shouldPresent,
  };
}

/** The fields of an Expo `Notification` the foreground re-presentation reads. */
export type ReceivedNotification = {
  request: {
    identifier: string;
    content: {
      title?: string | null;
      subtitle?: string | null;
      body?: string | null;
      data?: unknown;
      categoryIdentifier?: string | null;
    };
    trigger?: unknown;
  };
};

/** The `Notifications.scheduleNotificationAsync` request that re-presents a push. */
export type ForegroundRepresentation = {
  identifier: string;
  content: {
    title?: string;
    subtitle?: string;
    body: string;
    data: Record<string, unknown>;
    categoryIdentifier?: string;
  };
  trigger: null;
};

function isAndroidDataOnlyPush(trigger: unknown): boolean {
  if (!trigger || typeof trigger !== 'object') return false;
  const { type, remoteMessage } = trigger as { type?: unknown; remoteMessage?: unknown };
  if (type !== 'push' || !remoteMessage || typeof remoteMessage !== 'object') return false;
  return (remoteMessage as { notification?: unknown }).notification == null;
}

/**
 * expo-notifications 55 does not call `handleNotification` for an Android
 * data-only push received in the foreground (`NotificationsHandler` returns
 * early), so nothing posts it. Beeline's Android pushes are data-only, so the
 * received listener re-presents one as a local notification when this policy
 * allows it. The local notification keeps the push's identifier (its tag), so
 * it replaces, never duplicates, a post of the same push; it then passes
 * through `handleNotification` like any local notification. Its data is the
 * push's data, so a tap routes and dedupes as a background push does.
 *
 * Returns null for anything else: other platforms, a push Expo presents itself
 * (it has a `notification` block), a local notification (including this
 * re-presentation), a silent push with no text, or a push the policy hides.
 */
export function foregroundDataOnlyRepresentation(
  notification: ReceivedNotification,
  input: { platform: string; appState?: string | null; openChannelId?: string | null },
): ForegroundRepresentation | null {
  if (input.platform !== 'android') return null;
  const { identifier, content, trigger } = notification.request;
  if (!isAndroidDataOnlyPush(trigger)) return null;
  if (!content.title && !content.body) return null;
  const data =
    content.data && typeof content.data === 'object'
      ? (content.data as Record<string, unknown>)
      : {};
  const decision = decideForegroundNotificationDisplay({
    appState: input.appState,
    openChannelId: input.openChannelId,
    data,
  });
  if (!decision.shouldPresent) return null;
  return {
    identifier,
    content: {
      ...(content.title ? { title: content.title } : {}),
      ...(content.subtitle ? { subtitle: content.subtitle } : {}),
      body: content.body ?? '',
      data,
      ...(content.categoryIdentifier ? { categoryIdentifier: content.categoryIdentifier } : {}),
    },
    trigger: null,
  };
}
