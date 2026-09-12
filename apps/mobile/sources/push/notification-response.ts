import type { Router } from 'expo-router';
import {
  getBuzzNotificationTargetFromData,
  navigateToBuzzTargetFromNotification,
  type BuzzNotificationTarget,
} from '@/utils/notificationRouting';

/**
 * Routing a tapped push, independent of React so the whole rule is testable.
 *
 * The root layout owns the two delivery paths (the warm listener and the
 * cold-start replay) and hands both to this function. Everything a tap can
 * turn on lives here: the once-per-process guard, the default-action check,
 * the wait for the app root's landing decision (see
 * `navigation/initial-landing.ts` — a push routed before that decision lands
 * is overwritten by it), and the navigation itself.
 */

export type TappedNotificationResponse = {
  actionIdentifier?: string;
  notification?: { request?: { identifier?: string; content?: { data?: unknown } } };
};

export type NotificationEntryPath = 'cold' | 'background' | 'foreground';

export type NotificationResponseEntries = {
  addResponseListener: (listener: (response: TappedNotificationResponse) => void) => {
    remove(): void;
  };
  getLastResponse: () => Promise<TappedNotificationResponse | null>;
  getAppState: () => string;
  route: (response: TappedNotificationResponse, entry: NotificationEntryPath) => Promise<unknown>;
  log?: (message: string, error: unknown) => void;
};

/** Wire every Expo response entry path to the same payload resolver. */
export function startNotificationResponseEntries(entries: NotificationResponseEntries): () => void {
  let active = true;
  const subscription = entries.addResponseListener((response) => {
    const entry = entries.getAppState() === 'active' ? 'foreground' : 'background';
    void entries.route(response, entry);
  });
  void entries
    .getLastResponse()
    .then((response) => {
      if (active && response) return entries.route(response, 'cold');
    })
    .catch((error) => entries.log?.('Failed to read last notification response:', error));
  return () => {
    active = false;
    subscription.remove();
  };
}

export type NotificationResponseRouting = {
  router: Pick<Router, 'navigate'>;
  /** Response ids already routed in this process; each is acted on once. */
  handled: Set<string>;
  /** expo-notifications' identifier for a tap on the notification body. */
  defaultActionIdentifier: string;
  /** Resolves once the app root has chosen its landing route. */
  waitForInitialLanding: () => Promise<void>;
  /** Clears the retained native "last response" once it has been routed. */
  clearLastResponse: () => Promise<void>;
  resolveTarget: (target: BuzzNotificationTarget) => Promise<BuzzNotificationTarget>;
  log?: (message: string) => void;
};

function stringifyNotificationPayload(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? String(value);
  } catch (error) {
    return `[unserializable notification payload: ${error instanceof Error ? error.message : 'Unknown error'}]`;
  }
}

function readIdentifier(response: TappedNotificationResponse): string | undefined {
  const identifier = response.notification?.request?.identifier;
  return typeof identifier === 'string' && identifier ? identifier : undefined;
}

/**
 * Route one notification response. Returns the target it opened, or null when
 * the response was a duplicate, a non-default action, or carried no Room.
 */
export async function routeBuzzNotificationResponse(
  response: TappedNotificationResponse | null | undefined,
  routing: NotificationResponseRouting,
): Promise<BuzzNotificationTarget | null> {
  const log = routing.log ?? ((message: string) => console.log(message));
  if (!response) {
    log('[PUSH ROUTING] Notification response is null');
    return null;
  }

  log('[PUSH ROUTING] Full notification response:\n' + stringifyNotificationPayload(response));

  const responseId = readIdentifier(response);
  if (responseId) {
    if (routing.handled.has(responseId)) {
      log(`[PUSH ROUTING] Duplicate notification response ignored: ${responseId}`);
      return null;
    }
    routing.handled.add(responseId);
  }

  try {
    if (response.actionIdentifier !== routing.defaultActionIdentifier) {
      log(`[PUSH ROUTING] Ignoring non-default action: ${response.actionIdentifier}`);
      return null;
    }

    log(
      '[PUSH ROUTING] notification.request.content.data:\n' +
        stringifyNotificationPayload(response.notification?.request?.content?.data),
    );

    // The app root replaces whatever route is current when its landing check
    // finishes, so opening the Room before then loses it. On a running app
    // this is already settled and the tap navigates in the same tick.
    await routing.waitForInitialLanding();

    const buzzTarget = getBuzzNotificationTargetFromData(
      response.notification?.request?.content?.data,
    );
    if (buzzTarget) {
      const resolvedTarget = await routing.resolveTarget(buzzTarget);
      navigateToBuzzTargetFromNotification(routing.router, resolvedTarget, responseId!);
      log(
        `[PUSH ROUTING] Navigating to Beeline ${resolvedTarget.target}: ${resolvedTarget.channelId ?? resolvedTarget.workspaceId}`,
      );
      return resolvedTarget;
    }
    log('[PUSH ROUTING] No supported route found in notification.request.content.data');
    return null;
  } finally {
    try {
      await routing.clearLastResponse();
    } catch (error) {
      log(`Failed to clear last notification response: ${String(error)}`);
    }
  }
}
