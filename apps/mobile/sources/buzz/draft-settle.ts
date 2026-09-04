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
 * The request id behind a live draft row's stable presentation id
 * (`live-turn:<id>` from the overlay, `active-turn-stream:<id>` from the joined
 * lane). Anything else is not a draft and has no request to settle.
 */
export function draftRequestId(messageId: string): string | undefined {
  const match = /^(?:live-turn|active-turn-stream):(.+)$/.exec(messageId);
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
