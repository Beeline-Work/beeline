/**
 * Session memory of what the reader was shown while an agent was still
 * writing (C98).
 *
 * The durable reply and the streamed draft are two different transcript rows:
 * the request-id handoff removes the draft the moment its final lands. That
 * handoff stays exactly as it is — but the row that replaces the draft can
 * only cross-fade if it still knows what the reader was reading. This is that
 * memory, and nothing more.
 *
 * Deliberately module-scoped, consume-once, never persisted — the same shape
 * as `buzz/message-reveal.ts`. Reading it spends it, so one settled reply
 * plays exactly one settle transition however often its row remounts.
 */

/** Enough for the handful of turns that can be in flight in one Room. */
const PROVISIONAL_LIMIT = 16;

const provisional = new Map<string, string>();

/** `<agent pubkey>:<request id>` — the same join the handoff itself uses. */
export function provisionalDraftKey(agentPubkey: string, requestId: string): string {
  return `${agentPubkey}:${requestId}`;
}

/**
 * The one shape of a live draft row's stable presentation id, and its parser.
 *
 * The AUTHOR is half that identity. Two agents answering the same human
 * message run two turns under ONE request id — `monolith-room-turn.ts` posts
 * `requestId: item.id`, the triggering message — so `live-turn:<request>`
 * named both agents' rows. `mergeDisplayPages` keys the transcript by id, so
 * the second agent's draft silently replaced the first agent's and one
 * streaming answer vanished mid-sentence. Both halves, always.
 */
export function liveDraftRowId(agentPubkey: string, requestId: string): string {
  return `live-turn:${agentPubkey}:${requestId}`;
}

/** The same identity for the joined lane `projectActiveTurnStream` emits. */
export function joinedTurnRowId(agentPubkey: string, requestId: string): string {
  return `active-turn-stream:${agentPubkey}:${requestId}`;
}

/**
 * The request id behind a live draft row's stable presentation id
 * (`liveDraftRowId` from the overlay, `joinedTurnRowId` from the joined lane).
 * Anything else is not a draft and has no request to settle.
 */
export function draftRequestId(messageId: string): string | undefined {
  const match = /^(?:live-turn|active-turn-stream):[^:]+:(.+)$/.exec(messageId);
  return match?.[1];
}

export function rememberProvisionalDraft(key: string, text: string): void {
  if (!text) return;
  provisional.delete(key);
  provisional.set(key, text);
  while (provisional.size > PROVISIONAL_LIMIT) {
    const oldest = provisional.keys().next();
    if (oldest.done) break;
    provisional.delete(oldest.value);
  }
}

/** Reads and spends the memory: a settle transition plays at most once. */
export function takeProvisionalDraft(key: string): string | undefined {
  const text = provisional.get(key);
  if (text !== undefined) provisional.delete(key);
  return text;
}

/** Test seam only. */
export function resetProvisionalDrafts(): void {
  provisional.clear();
}
