import type { AgentGrantDecision } from './agent-grants.js';

/**
 * Inline notification actions: what a person can do from a push without
 * opening the app. The server names the category on the push (`categoryId`
 * in the FCM data map, `aps.category` for APNs); the phone registers the same
 * categories and answers each action through the ordinary phone operations
 * (`decideAgentGrant`, `sendRoomReply`), so the notification is only another
 * place to press the in-app control, never a separate authority.
 */
export const PUSH_ACTION_CATEGORIES = {
  grant: 'beeline-grant',
  reply: 'beeline-reply',
} as const;

/** One button per in-app grant card choice (`No` / `Once` / `Always`). */
export const GRANT_PUSH_ACTIONS: Readonly<Record<AgentGrantDecision, string>> = {
  deny: 'grant-deny',
  once: 'grant-once',
  always: 'grant-always',
};

export const REPLY_PUSH_ACTION = 'reply';

export type PushActionPayload =
  | {
      readonly kind: 'grant';
      readonly grantId: string;
      readonly grantKind: string;
      readonly grantTarget: string;
      readonly agentName: string;
    }
  | { readonly kind: 'reply'; readonly authorName: string };

/** The string-only data fields a push carries for its action. */
export function pushActionData(action: PushActionPayload | undefined): Record<string, string> {
  if (!action) return {};
  if (action.kind === 'grant')
    return {
      categoryId: PUSH_ACTION_CATEGORIES.grant,
      grantId: action.grantId,
      grantKind: action.grantKind,
      grantTarget: action.grantTarget,
      agentName: action.agentName,
    };
  return { categoryId: PUSH_ACTION_CATEGORIES.reply, authorName: action.authorName };
}

export function grantDecisionForPushAction(actionId: string): AgentGrantDecision | null {
  for (const [decision, id] of Object.entries(GRANT_PUSH_ACTIONS))
    if (id === actionId) return decision as AgentGrantDecision;
  return null;
}

/**
 * A silent iOS push: the recipient read these Rooms or corners on some
 * device, so the phone removes their notifications from the shade and
 * recounts its badge. It carries ids only, never text.
 */
export const READ_CLEAR_PUSH_TYPE = 'read-clear';

export function readClearPushData(channelIds: readonly string[]): {
  type: typeof READ_CLEAR_PUSH_TYPE;
  channelIds: string[];
} {
  return { type: READ_CLEAR_PUSH_TYPE, channelIds: [...channelIds] };
}

/**
 * The channel ids a read-clear push names, or `null` for any other push. The
 * phone's background task may hand the payload over flat, under `data`, or
 * as a `dataString` JSON body, so each of those shapes is searched.
 */
export function readClearChannelIds(payload: unknown, depth = 0): string[] | null {
  if (!payload || typeof payload !== 'object' || depth > 3) return null;
  const record = payload as Record<string, unknown>;
  if (record.type === READ_CLEAR_PUSH_TYPE) {
    const ids = Array.isArray(record.channelIds)
      ? record.channelIds
      : typeof record.channelIds === 'string'
        ? record.channelIds.split(',')
        : [];
    return ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  }
  if (typeof record.dataString === 'string') {
    try {
      const parsed = readClearChannelIds(JSON.parse(record.dataString), depth + 1);
      if (parsed) return parsed;
    } catch {
      // Not JSON: fall through to the nested shapes.
    }
  }
  for (const key of ['data', 'body', 'notification'])
    if (key in record) {
      const parsed = readClearChannelIds(record[key], depth + 1);
      if (parsed) return parsed;
    }
  return null;
}
