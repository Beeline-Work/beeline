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
 * recounts its badge. It carries ids and read cursors only, never text.
 */
export const READ_CLEAR_PUSH_TYPE = 'read-clear';

/**
 * One Room or corner a read-clear push names, with its server read cursor
 * (the last read message's id) and the ids of the other read messages the
 * server pushed to this device. The phone dismisses only those messages'
 * notifications, so a newer, unread message keeps its notification even when
 * iOS presented both at the same second. A `null` cursor means the payload
 * gave none.
 */
export type ReadClear = {
  channelId: string;
  messageId: string | null;
  readMessageIds: string[];
};

export function readClearPushData(
  reads: readonly { channelId: string; messageId: string; readMessageIds?: readonly string[] }[],
): {
  type: typeof READ_CLEAR_PUSH_TYPE;
  channelIds: string[];
  messageIds: string[];
  readMessageIds: string[][];
} {
  return {
    type: READ_CLEAR_PUSH_TYPE,
    channelIds: reads.map((read) => read.channelId),
    messageIds: reads.map((read) => read.messageId),
    readMessageIds: reads.map((read) => [...(read.readMessageIds ?? [])]),
  };
}

/**
 * The Rooms and corners a read-clear push names, or `null` for any other
 * push. The phone's background task may hand the payload over flat, under
 * `data`, or as a `dataString` JSON body, so each of those shapes is searched.
 */
export function readClearReads(payload: unknown, depth = 0): ReadClear[] | null {
  if (!payload || typeof payload !== 'object' || depth > 3) return null;
  const record = payload as Record<string, unknown>;
  if (record.type === READ_CLEAR_PUSH_TYPE) {
    const ids = Array.isArray(record.channelIds)
      ? record.channelIds
      : typeof record.channelIds === 'string'
        ? record.channelIds.split(',')
        : [];
    const messageIds = Array.isArray(record.messageIds) ? record.messageIds : [];
    const readMessageIds = Array.isArray(record.readMessageIds) ? record.readMessageIds : [];
    return ids.flatMap((id, index): ReadClear[] => {
      if (typeof id !== 'string' || id.trim() === '') return [];
      const messageId = messageIds[index];
      const read = readMessageIds[index];
      return [
        {
          channelId: id,
          messageId: typeof messageId === 'string' && messageId ? messageId : null,
          readMessageIds: Array.isArray(read)
            ? read.filter((value): value is string => typeof value === 'string' && value !== '')
            : [],
        },
      ];
    });
  }
  if (typeof record.dataString === 'string') {
    try {
      const parsed = readClearReads(JSON.parse(record.dataString), depth + 1);
      if (parsed) return parsed;
    } catch {
      // Not JSON: fall through to the nested shapes.
    }
  }
  for (const key of ['data', 'body', 'notification'])
    if (key in record) {
      const parsed = readClearReads(record[key], depth + 1);
      if (parsed) return parsed;
    }
  return null;
}
