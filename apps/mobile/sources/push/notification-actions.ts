import {
  GRANT_PUSH_ACTIONS,
  PUSH_ACTION_CATEGORIES,
  REPLY_PUSH_ACTION,
  grantDecisionForPushAction,
  type AgentGrantDecision,
} from '@beeline/api-contract/phone';
import { grantAskLine } from '@/buzz/agent-grant-copy';

/**
 * Inline notification actions: a grant card's No / Once / Always and a Reply
 * field, answered from the notification without opening the app.
 *
 * The server names the category on the push (`push-actions.ts` in the
 * contract); this file registers the matching categories and turns one tapped
 * action into the SAME phone operation the in-app control calls
 * (`decideAgentGrant`, `sendRoomReply`), then rewrites the notification with
 * the outcome. The phone never decides anything the server would refuse.
 *
 * Android keeps the notification and rewrites it in place. iOS closes a
 * notification the moment an action is tapped and offers no way to edit a
 * delivered one, so its outcome is a new notification: quiet (passive, no
 * sound) on success, ordinary on failure because the person must act.
 *
 * Every function here takes its platform effects as arguments so the whole
 * path is testable without a device.
 */

export const NOTIFICATION_ACTION_TASK = 'beeline-notification-action';
/** Low-importance Android channel for rewritten outcomes, so they never re-alert. */
export const NOTIFICATION_OUTCOME_CHANNEL = 'beeline-notification-outcomes';

type Platform = 'android' | 'ios';

export interface CategoryAction {
  identifier: string;
  buttonTitle: string;
  textInput?: { submitButtonTitle: string; placeholder: string };
  options: {
    opensAppToForeground: false;
    isDestructive?: boolean;
    /** iOS only: Face ID / passcode before the action runs (captain decision D2). */
    isAuthenticationRequired?: boolean;
  };
}

/**
 * The categories, in each platform's order. Android reads left to right like
 * the in-app card (No · Once · Always) and has no unlock flag at all; iOS lists
 * the destructive choice last and asks for Face ID first, because the sign-in
 * token is only readable while the iPhone is unlocked.
 */
export function notificationActionCategories(
  platform: Platform,
): { identifier: string; actions: CategoryAction[] }[] {
  const ios = platform === 'ios';
  const options = (isDestructive = false): CategoryAction['options'] => ({
    opensAppToForeground: false,
    ...(isDestructive ? { isDestructive: true } : {}),
    ...(ios ? { isAuthenticationRequired: true } : {}),
  });
  const deny: CategoryAction = {
    identifier: GRANT_PUSH_ACTIONS.deny,
    buttonTitle: 'No',
    options: options(true),
  };
  const once: CategoryAction = {
    identifier: GRANT_PUSH_ACTIONS.once,
    buttonTitle: 'Once',
    options: options(),
  };
  const always: CategoryAction = {
    identifier: GRANT_PUSH_ACTIONS.always,
    buttonTitle: 'Always',
    options: options(),
  };
  return [
    {
      identifier: PUSH_ACTION_CATEGORIES.grant,
      actions: ios ? [always, once, deny] : [deny, once, always],
    },
    {
      identifier: PUSH_ACTION_CATEGORIES.reply,
      actions: [
        {
          identifier: REPLY_PUSH_ACTION,
          buttonTitle: 'Reply',
          textInput: { submitButtonTitle: 'Send', placeholder: 'Reply' },
          options: options(),
        },
      ],
    },
  ];
}

/** The fields of an expo notification response this path reads. */
export interface ActionResponseLike {
  actionIdentifier?: unknown;
  userText?: unknown;
  notification?: {
    request?: {
      identifier?: unknown;
      content?: { title?: unknown; body?: unknown; data?: unknown };
    };
  };
}

type Data = Record<string, string>;

export type NotificationActionRequest =
  | {
      kind: 'grant';
      /** Notification identifier + action: a response is answered at most once. */
      key: string;
      notificationId: string;
      decision: AgentGrantDecision;
      grantId: string;
      body: string;
      data: Data;
    }
  | {
      kind: 'reply';
      key: string;
      notificationId: string;
      roomId: string;
      parentMessageId: string;
      text: string;
      body: string;
      data: Data;
    };

function stringData(value: unknown): Data {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const data: Data = {};
  for (const [key, entry] of Object.entries(parsed))
    if (typeof entry === 'string') data[key] = entry;
  return data;
}

/** Accepts a notification response or the Android task payload wrapping one. */
export function readNotificationAction(payload: unknown): NotificationActionRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const response = payload as ActionResponseLike;
  const actionId = typeof response.actionIdentifier === 'string' ? response.actionIdentifier : '';
  const request = response.notification?.request;
  const notificationId = typeof request?.identifier === 'string' ? request.identifier : '';
  if (!actionId || !notificationId) return null;
  const data = stringData(request?.content?.data);
  const body =
    typeof request?.content?.body === 'string' && request.content.body
      ? request.content.body
      : (data.message ?? '');
  // `attempt` is bumped each time a failure re-offers the action, so a retry
  // on the same notification is a new response to the at-most-once memory.
  const key = `${notificationId}:${actionId}:${data.attempt ?? '0'}`;
  const decision = grantDecisionForPushAction(actionId);
  if (decision) {
    if (data.categoryId !== PUSH_ACTION_CATEGORIES.grant || !data.grantId) return null;
    return { kind: 'grant', key, notificationId, decision, grantId: data.grantId, body, data };
  }
  if (actionId === REPLY_PUSH_ACTION) {
    const text = typeof response.userText === 'string' ? response.userText.trim() : '';
    const roomId = data.cornerId ?? data.channelId;
    if (data.categoryId !== PUSH_ACTION_CATEGORIES.reply || !roomId || !data.messageId || !text)
      return null;
    return {
      kind: 'reply',
      key,
      notificationId,
      roomId,
      parentMessageId: data.messageId,
      text,
      body,
      data,
    };
  }
  return null;
}

export type NotificationActionOutcome = 'done' | 'settled' | 'failed';

/** Shown in place of the tapped notification (Android) or as a new one (iOS). */
export interface OutcomeNotification {
  /** Android rewrites the tapped notification; iOS posts a new one. */
  identifier: string;
  title: string;
  body: string;
  subtitle?: string;
  data: Data;
  categoryIdentifier?: string;
  quiet: boolean;
}

const GRANT_DONE: Readonly<Record<AgentGrantDecision, string>> = {
  once: 'Allowed once',
  always: 'Always allowed',
  deny: 'Denied',
};

function withoutAction(data: Data): Data {
  const { categoryId: _categoryId, ...rest } = data;
  return rest;
}

function grantSubject(data: Data): string {
  const agent = data.agentName ? `@${data.agentName.replace(/^@/, '')}` : 'The agent';
  if (!data.grantKind || !data.grantTarget) return agent;
  const ask = grantAskLine({
    kind: data.grantKind as Parameters<typeof grantAskLine>[0]['kind'],
    target: data.grantTarget,
  });
  return `${agent} can ${ask}`;
}

export function outcomeNotification(
  request: NotificationActionRequest,
  outcome: NotificationActionOutcome,
  platform: Platform,
): OutcomeNotification {
  const android = platform === 'android';
  // A failure re-offers the action. Android rewrites the same notification: one
  // whose inline reply is still spinning cannot be taken down, only updated.
  // iOS already closed it, so its retry is a new notification.
  const attempt = String(Number(request.data.attempt ?? '0') + 1);
  const retryId = android
    ? request.notificationId
    : `${request.notificationId.replace(/#.*$/, '')}#retry-${attempt}`;
  if (request.kind === 'grant') {
    if (outcome === 'done')
      return android
        ? {
            identifier: request.notificationId,
            title: 'Beeline',
            body: request.body,
            subtitle: GRANT_DONE[request.decision],
            data: withoutAction(request.data),
            quiet: true,
          }
        : {
            identifier: `${request.notificationId}#done`,
            title: 'Beeline',
            body: `${GRANT_DONE[request.decision]} · ${grantSubject(request.data)}`,
            data: withoutAction(request.data),
            quiet: true,
          };
    if (outcome === 'settled')
      return android
        ? {
            identifier: request.notificationId,
            title: 'Beeline',
            body: request.body,
            subtitle: 'Already answered · tap to open',
            data: withoutAction(request.data),
            quiet: true,
          }
        : {
            identifier: `${request.notificationId}#done`,
            title: 'Beeline',
            body: `Already answered · ${request.body} · tap to open`,
            data: withoutAction(request.data),
            quiet: false,
          };
    return android
      ? {
          identifier: retryId,
          title: 'Beeline',
          body: request.body,
          subtitle: "Couldn't send · tap to open",
          data: { ...request.data, attempt },
          categoryIdentifier: PUSH_ACTION_CATEGORIES.grant,
          quiet: true,
        }
      : {
          identifier: retryId,
          title: 'Beeline',
          body: `Couldn't answer · ${request.body} · tap to open`,
          data: { ...request.data, attempt },
          categoryIdentifier: PUSH_ACTION_CATEGORIES.grant,
          quiet: false,
        };
  }
  if (outcome === 'done') {
    const author = request.data.authorName || 'them';
    return android
      ? {
          identifier: request.notificationId,
          title: 'Beeline',
          body: `${request.body}\nYou: ${request.text}`,
          subtitle: 'Replied',
          data: withoutAction(request.data),
          quiet: true,
        }
      : {
          identifier: `${request.notificationId}#done`,
          title: 'Beeline',
          body: `Replied to ${author} · ${request.text}`,
          data: withoutAction(request.data),
          quiet: true,
        };
  }
  // A failed reply keeps Reply so it can be retried from the notification, and
  // carries the typed text so a tap opens the Room with it in the composer.
  const data = { ...request.data, replyDraft: request.text, attempt };
  return android
    ? {
        identifier: retryId,
        title: 'Beeline',
        body: request.body,
        subtitle: "Couldn't send · tap to open",
        data,
        categoryIdentifier: PUSH_ACTION_CATEGORIES.reply,
        quiet: true,
      }
    : {
        identifier: retryId,
        title: 'Beeline',
        body: `Couldn't send your reply to ${request.data.authorName || 'them'} · tap to open`,
        data,
        categoryIdentifier: PUSH_ACTION_CATEGORIES.reply,
        quiet: false,
      };
}

/** Durable at-most-once memory for tapped actions (a response can reach JS twice). */
export interface HandledActionStore {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
}

const HANDLED_ACTIONS_KEY = '@beeline/push/handled-notification-actions';
const HANDLED_ACTIONS_LIMIT = 200;

export function createHandledActionStore(storage: {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}): HandledActionStore {
  const read = async (): Promise<string[]> => {
    try {
      const parsed: unknown = JSON.parse((await storage.getItem(HANDLED_ACTIONS_KEY)) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    has: async (key) => (await read()).includes(key),
    add: async (key) => {
      const keys = (await read()).filter((existing) => existing !== key);
      keys.push(key);
      await storage.setItem(
        HANDLED_ACTIONS_KEY,
        JSON.stringify(keys.slice(-HANDLED_ACTIONS_LIMIT)),
      );
    },
  };
}

export interface NotificationActionDeps {
  platform: Platform;
  decideGrant(grantId: string, decision: AgentGrantDecision): Promise<unknown>;
  sendReply(input: {
    roomId: string;
    parentMessageId: string;
    text: string;
    messageId: string;
  }): Promise<unknown>;
  newMessageId(): string;
  present(notification: OutcomeNotification): Promise<void>;
  handled: HandledActionStore;
  /** Responses being answered right now in this JS runtime. */
  inFlight: Set<string>;
  log?(message: string): void;
}

/** HTTP 409 is the server's "this grant was already decided" answer. */
function isSettledGrant(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: unknown }).status === 409,
  );
}

/**
 * Answer one tapped action. Returns null when the payload is not one of ours
 * or this response was already answered (the Android task and a live listener
 * can both see the same tap).
 */
export async function handleNotificationAction(
  payload: unknown,
  deps: NotificationActionDeps,
): Promise<NotificationActionOutcome | null> {
  const request = readNotificationAction(payload);
  if (!request) return null;
  // Claimed synchronously, before any await, so two deliveries of the same
  // tap in one runtime cannot both pass the check.
  if (deps.inFlight.has(request.key)) return null;
  deps.inFlight.add(request.key);
  try {
    if (await deps.handled.has(request.key)) return null;
    // Spent before the call: a response is answered once, never replayed on a
    // later app start. A retry is a new response on the failure notification.
    await deps.handled.add(request.key);
    let outcome: NotificationActionOutcome;
    try {
      if (request.kind === 'grant') await deps.decideGrant(request.grantId, request.decision);
      else
        await deps.sendReply({
          roomId: request.roomId,
          parentMessageId: request.parentMessageId,
          text: request.text,
          messageId: deps.newMessageId(),
        });
      outcome = 'done';
    } catch (error) {
      outcome = request.kind === 'grant' && isSettledGrant(error) ? 'settled' : 'failed';
      deps.log?.(
        `[PUSH ACTION] ${request.kind} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await deps.present(outcomeNotification(request, outcome, deps.platform));
    return outcome;
  } finally {
    deps.inFlight.delete(request.key);
  }
}

/** The failed reply's text, for the composer the tap opens. */
export function replyDraftFromResponse(payload: unknown): { roomId: string; text: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = stringData((payload as ActionResponseLike).notification?.request?.content?.data);
  const roomId = data.cornerId ?? data.channelId;
  return roomId && data.replyDraft ? { roomId, text: data.replyDraft } : null;
}
