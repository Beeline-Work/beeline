import { markRoomOpen } from '@/buzz/room-open-trace';
import {
  getBuzzNotificationTargetFromData,
  navigateToBuzzTargetFromNotification,
  type BuzzNotificationTarget,
  type NotificationNavigator,
} from '@/utils/notificationRouting';
import type { InitialLandingResult } from '@/navigation/initial-landing';

/**
 * Routing a tapped push, independent of React so the whole rule is testable.
 *
 * The root layout owns the two delivery paths (the warm listener and the
 * cold-start replay) and hands both to this function. Everything a tap can
 * turn on lives here: the once-per-process guard, the durable leftover-id skip
 * (Expo Android synthesizes a DEFAULT response from `google.message_id` extras
 * on Activity onCreate, including a launcher reopen), the default-action check,
 * the wait for the app root's landing decision (see
 * `navigation/initial-landing.ts` — a push routed before that decision lands
 * is overwritten by it), the suppression of a pending landing replace, and the navigation itself.
 */

export type TappedNotificationResponse = {
  actionIdentifier?: string;
  notification?: { request?: { identifier?: string; content?: { data?: unknown } } };
};

export type NotificationEntryPath = 'cold' | 'background' | 'foreground';

export type ConsumedNotificationResponseStore = {
  has(id: string): Promise<boolean>;
  add(id: string): Promise<void>;
};

export type NotificationResponseIdStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export const CONSUMED_NOTIFICATION_RESPONSE_IDS_KEY =
  '@beeline/push/consumed-notification-response-ids';
const MAX_CONSUMED_NOTIFICATION_RESPONSE_IDS = 32;

export type NotificationResponseEntries = {
  addResponseListener: (listener: (response: TappedNotificationResponse) => void) => {
    remove(): void;
  };
  getLastResponse: () => Promise<TappedNotificationResponse | null>;
  getAppState: () => string;
  route: (response: TappedNotificationResponse, entry: NotificationEntryPath) => Promise<unknown>;
  /** Durably remembered response ids; a leftover cold replay of one already routed is not a tap. */
  consumedResponses?: ConsumedNotificationResponseStore;
  log?: (message: string, error?: unknown) => void;
};

function parseConsumedResponseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Use the same decoded payload for deduplication, prefetch and navigation.
 * Expo's request identifier may be a reused Android notification slot.
 */
export function getNotificationResponseId(response: TappedNotificationResponse): string | undefined {
  const target = getBuzzNotificationTargetFromData(response.notification?.request?.content?.data);
  if (target?.messageId) return target.messageId;
  const identifier = response.notification?.request?.identifier;
  return typeof identifier === 'string' && identifier ? identifier : undefined;
}

/** Persist routed Expo response ids so a later process cannot replay the same leftover extras. */
export function createConsumedNotificationResponseStore(
  storage: NotificationResponseIdStorage,
): ConsumedNotificationResponseStore {
  let loaded: string[] | undefined;
  const load = async (): Promise<string[]> => {
    loaded ??= parseConsumedResponseIds(
      await storage.getItem(CONSUMED_NOTIFICATION_RESPONSE_IDS_KEY),
    );
    return loaded;
  };
  return {
    async has(id: string): Promise<boolean> {
      return (await load()).includes(id);
    },
    async add(id: string): Promise<void> {
      const ids = await load();
      if (ids.includes(id)) return;
      ids.push(id);
      if (ids.length > MAX_CONSUMED_NOTIFICATION_RESPONSE_IDS) {
        ids.splice(0, ids.length - MAX_CONSUMED_NOTIFICATION_RESPONSE_IDS);
      }
      loaded = ids;
      await storage.setItem(CONSUMED_NOTIFICATION_RESPONSE_IDS_KEY, JSON.stringify(ids));
    },
  };
}

async function dispatchNotificationResponse(
  entries: NotificationResponseEntries,
  response: TappedNotificationResponse,
  entry: NotificationEntryPath,
  active: () => boolean,
): Promise<void> {
  markRoomOpen('push-entry-dispatch');
  const id = getNotificationResponseId(response);
  if (id && entries.consumedResponses && (await entries.consumedResponses.has(id))) {
    entries.log?.(`[PUSH ROUTING] Skipping leftover ${entry} notification response: ${id}`);
    return;
  }
  markRoomOpen('push-entry-deduped');
  if (!active()) return;
  await entries.route(response, entry);
}

/** Wire every Expo response entry path to the same payload resolver. */
export function startNotificationResponseEntries(entries: NotificationResponseEntries): () => void {
  let active = true;
  let receivedLiveResponse = false;
  const stillActive = () => active;
  const subscription = entries.addResponseListener((response) => {
    receivedLiveResponse = true;
    markRoomOpen('push-entry-event');
    const entry = entries.getAppState() === 'active' ? 'foreground' : 'background';
    void dispatchNotificationResponse(entries, response, entry, stillActive).catch((error) =>
      entries.log?.('Failed to route notification response:', error),
    );
  });
  void entries
    .getLastResponse()
    .then((response) => {
      // The native getter may have captured an older response before a live
      // tap arrived. That replay must never overwrite the newer destination.
      if (!active || receivedLiveResponse) return;
      if (!response) {
        entries.log?.('[PUSH ROUTING] cold getLastResponse is null');
        return;
      }
      return dispatchNotificationResponse(entries, response, 'cold', () => active && !receivedLiveResponse);
    })
    .catch((error) => entries.log?.('Failed to read last notification response:', error));
  return () => {
    active = false;
    subscription.remove();
  };
}

export type NotificationResponseRouting = {
  /** Opens the target on top of its fixed ancestry (see `notificationStackRoutes`). */
  navigator: NotificationNavigator;
  /** Response ids already routed in this process; each is acted on once. */
  handled: Set<string>;
  /** expo-notifications' identifier for a tap on the notification body. */
  defaultActionIdentifier: string;
  /** Route only after the root navigator has rendered; prefetch may run sooner. */
  waitForRootReady?: () => Promise<void>;
  /** Resolves once the landing route has committed. */
  waitForInitialLanding: () => Promise<InitialLandingResult>;
  /** Claims the destination for this push: the app root's pending landing replace must not run. */
  suppressPendingInitialLanding: () => void;
  /** Clears the retained native "last response" once it has been routed. */
  clearLastResponse: () => Promise<void>;
  resolveTarget: (target: BuzzNotificationTarget) => Promise<BuzzNotificationTarget>;
  /** Optional read started before landing; it never gates navigation. */
  prefetchRoom?: (responseId: string, roomId: string, messageId?: string) => void;
  /** Same durable ids the entry adapter consults; a leftover replay is not a new tap. */
  consumedResponses?: ConsumedNotificationResponseStore;
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

/**
 * Route one notification response. Returns the target it opened, or null when
 * the response was a duplicate, a non-default action, or carried no Room.
 */
export async function routeBuzzNotificationResponse(
  response: TappedNotificationResponse | null | undefined,
  routing: NotificationResponseRouting,
): Promise<BuzzNotificationTarget | null> {
  markRoomOpen('push-route-entry');
  const log = routing.log ?? ((message: string) => console.log(message));
  if (!response) {
    log('[PUSH ROUTING] Notification response is null');
    return null;
  }

  log('[PUSH ROUTING] Full notification response:\n' + stringifyNotificationPayload(response));

  // Inline actions belong to the action runtime. They must neither claim the
  // body's message id nor clear the native response it may still be reading.
  if (response.actionIdentifier !== routing.defaultActionIdentifier) {
    log(`[PUSH ROUTING] Ignoring non-default action: ${response.actionIdentifier}`);
    return null;
  }

  const responseId = getNotificationResponseId(response);
  if (responseId) {
    if (routing.handled.has(responseId)) {
      log(`[PUSH ROUTING] Duplicate notification response ignored: ${responseId}`);
      return null;
    }
    routing.handled.add(responseId);
    if (routing.consumedResponses && (await routing.consumedResponses.has(responseId))) {
      log(`[PUSH ROUTING] Skipping leftover notification response: ${responseId}`);
      try {
        await routing.clearLastResponse();
      } catch (error) {
        log(`Failed to clear last notification response: ${String(error)}`);
      }
      return null;
    }
  }

  try {
    log(
      '[PUSH ROUTING] notification.request.content.data:\n' +
        stringifyNotificationPayload(response.notification?.request?.content?.data),
    );

    const buzzTarget = getBuzzNotificationTargetFromData(
      response.notification?.request?.content?.data,
    );
    const directRoom =
      buzzTarget?.target === 'message' &&
      Boolean(buzzTarget.workspaceId) &&
      buzzTarget.roomId === buzzTarget.channelId &&
      !buzzTarget.cornerId;
    if (responseId && directRoom && buzzTarget?.channelId) {
      try {
        const messageId = buzzTarget.messageId ?? buzzTarget.eventId;
        if (messageId) routing.prefetchRoom?.(responseId, buzzTarget.channelId, messageId);
        else routing.prefetchRoom?.(responseId, buzzTarget.channelId);
      } catch (error) {
        log(`Could not prefetch pushed Room: ${String(error)}`);
      }
    }
    await routing.waitForRootReady?.();

    // The Room read may finish during startup, but navigation must wait until
    // the landing route has committed. Root navigator readiness alone can
    // precede that first usable destination on a killed-app push.
    if (directRoom && buzzTarget) {
      await routing.waitForInitialLanding();
      // This payload already has the exact top-level Room and Workspace. Its
      // route carries the Workspace id, and the Room's own read persists
      // server truth. A cold AsyncStorage selection write need not keep the
      // Room behind the landing screen.
      routing.suppressPendingInitialLanding();
      navigateToBuzzTargetFromNotification(routing.navigator, buzzTarget, responseId!);
      void routing.resolveTarget(buzzTarget).catch((error) =>
        log(`Could not persist pushed Workspace selection: ${String(error)}`),
      );
      if (responseId) await routing.consumedResponses?.add(responseId);
      log(`[PUSH ROUTING] Navigating to Beeline ${buzzTarget.target}: ${buzzTarget.channelId}`);
      return buzzTarget;
    }

    if (!directRoom) {
      await routing.waitForInitialLanding();
    }

    if (buzzTarget) {
      // This push now owns the destination. Suppress a later Home replace
      // before resolving (which persists the Workspace selection and can take
      // its own time), or that replace would land the deck over the Room.
      routing.suppressPendingInitialLanding();
      const resolvedTarget = await routing.resolveTarget(buzzTarget);
      navigateToBuzzTargetFromNotification(routing.navigator, resolvedTarget, responseId!);
      if (responseId) await routing.consumedResponses?.add(responseId);
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
