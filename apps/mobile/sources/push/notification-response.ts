import type { Router } from 'expo-router';
import {
  getBuzzNotificationTargetFromData,
  navigateToBuzzTargetFromNotification,
  type BuzzNotificationTarget,
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
 * is overwritten by it), the suppression of a landing replace still pending
 * after that wait times out, and the navigation itself.
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

function readIdentifier(response: TappedNotificationResponse): string | undefined {
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
  const id = readIdentifier(response);
  if (id && entries.consumedResponses && (await entries.consumedResponses.has(id))) {
    entries.log?.(`[PUSH ROUTING] Skipping leftover ${entry} notification response: ${id}`);
    return;
  }
  if (!active()) return;
  await entries.route(response, entry);
}

/** Wire every Expo response entry path to the same payload resolver. */
export function startNotificationResponseEntries(entries: NotificationResponseEntries): () => void {
  let active = true;
  const stillActive = () => active;
  const subscription = entries.addResponseListener((response) => {
    const entry = entries.getAppState() === 'active' ? 'foreground' : 'background';
    void dispatchNotificationResponse(entries, response, entry, stillActive).catch((error) =>
      entries.log?.('Failed to route notification response:', error),
    );
  });
  void entries
    .getLastResponse()
    .then((response) => {
      if (!active) return;
      if (!response) {
        entries.log?.('[PUSH ROUTING] cold getLastResponse is null');
        return;
      }
      return dispatchNotificationResponse(entries, response, 'cold', stillActive);
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
  /** Resolves once the landing route has committed, or reports a timeout. */
  waitForInitialLanding: () => Promise<InitialLandingResult>;
  /** Claims the destination for this push: the app root's pending landing replace must not run. */
  suppressPendingInitialLanding: () => void;
  /** Clears the retained native "last response" once it has been routed. */
  clearLastResponse: () => Promise<void>;
  resolveTarget: (target: BuzzNotificationTarget) => Promise<BuzzNotificationTarget>;
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
    const landing = await routing.waitForInitialLanding();
    if (landing === 'timeout') {
      log('[PUSH ROUTING] Initial landing did not commit before timeout; routing directly');
    }

    const buzzTarget = getBuzzNotificationTargetFromData(
      response.notification?.request?.content?.data,
    );
    if (buzzTarget) {
      // This push now owns the destination — including on the timeout path,
      // where the app root's landing replace may still be pending. Suppress it
      // before resolving (which persists the Workspace selection and can take
      // its own time), or a late replace would land the deck over the Room.
      routing.suppressPendingInitialLanding();
      const resolvedTarget = await routing.resolveTarget(buzzTarget);
      navigateToBuzzTargetFromNotification(routing.router, resolvedTarget, responseId!);
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
