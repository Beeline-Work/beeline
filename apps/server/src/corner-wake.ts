import type { LiveEvent } from './live.js';

/** Bounds a corner's wake long-poll so a stuck HTTP request always resolves. */
export const CORNER_WAKE_TIMEOUT_MS = 20_000;

/**
 * Floor between two consecutive wakes of the same corner. A burst of genuinely
 * external events is still one wake per floor, so no publisher — however
 * chatty — can spin the corner's intake loop.
 */
export const CORNER_WAKE_MIN_INTERVAL_MS = 400;

/**
 * Whether a live event is something a corner's intake loop can act on.
 *
 * A corner's Room id IS the corner id, so every live event the corner's own
 * agent publishes lands on the very channel its intake loop waits on. The loop
 * can act on none of it: it skips its own messages, and a draft, a thought,
 * their retraction, an activity row, a turn receipt and a presence beacon are
 * all the agent narrating the turn it is running right now. Waking on those
 * made a streaming turn hammer the server with a wake per delta, and made a
 * wake stop meaning "something new for you".
 *
 * Everything else wakes: any event authored by someone else (a human message,
 * a close request, the owner's grant decision), and every fact the server
 * itself publishes (a GitHub check, a schedule, a phone write), which carries
 * no author at all. The filter fails OPEN — an event with no `agentId` always
 * wakes — and the daemon's timed poll remains the recovery path regardless.
 */
export function wakesCorner(event: LiveEvent, agentId: string): boolean {
  return !isOwnTurnNarration(event, agentId);
}

function isOwnTurnNarration(event: LiveEvent, agentId: string): boolean {
  // Only `invalidate` carries a reason; every other variant is itself one of
  // the live-output/presence shapes an agent emits while narrating its turn.
  if (event.type !== 'invalidate') return event.agentId === agentId;
  return event.agentId === agentId && (event.reason === 'activity' || event.reason === 'turn');
}
