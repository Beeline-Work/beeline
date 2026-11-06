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
