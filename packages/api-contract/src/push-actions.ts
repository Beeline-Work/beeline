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
