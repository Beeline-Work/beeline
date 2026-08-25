import { getBuzzNotificationTargetFromData } from '@/utils/notificationRouting';

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
 * - Suppress whenever React Native AppState is 'active' — the person is
 *   already looking at the app; a heads-up banner over it is noise.
 * - Always suppress when the notification's channel/Room id is the currently
 *   open Room, regardless of app state — even mid-transition they are already
 *   reading exactly that conversation.
 * - Background/unrelated notifications keep their existing display behavior.
 *
 * This is display policy ONLY. Deep-link routing of notification responses
 * (`notificationRouting.ts`) and background delivery are untouched.
 */

export type ForegroundNotificationDecisionReason =
  | 'open-room-match'
  | 'app-active'
  | 'app-inactive';

export type ForegroundNotificationDecision = {
  /** Whether the OS may present the notification at all in the foreground. */
  shouldPresent: boolean;
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

  // Open-Room suppression wins regardless of the broader app-state signal.
  const trimmedOpenChannelId = typeof openChannelId === 'string' ? openChannelId.trim() : '';
  if (trimmedOpenChannelId) {
    const { channelId, roomId } = foregroundNotificationChannelIds(data);
    if (
      (channelId && channelId === trimmedOpenChannelId) ||
      (roomId && roomId === trimmedOpenChannelId)
    ) {
      return { shouldPresent: false, reason: 'open-room-match' };
    }
  }

  if (appState === 'active') {
    return { shouldPresent: false, reason: 'app-active' };
  }

  return { shouldPresent: true, reason: 'app-inactive' };
}
