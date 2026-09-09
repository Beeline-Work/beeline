import type { SystemEvent } from '@beeline/api-contract/daemon';

/**
 * The requester stopped this turn while it was running.
 *
 * Not a failure, and deliberately not reported as one: the server settled the
 * receipt `cancelled` and inscribed who stopped it when it accepted the stop,
 * so a `failed` receipt here would only try — and be refused — to restate a
 * turn that already has its ending, under a word that blames the helper for
 * obeying.
 */
export class TurnStoppedError extends Error {
  override readonly name = 'TurnStoppedError';
}

/**
 * The one predicate for "the requester stopped a turn", read by both turn loops.
 *
 * A stop reaches a helper as an ordinary intake item: a server-authored system
 * line of kind `turn-cancelled`, mentioning the agent so its daemon wakes, and
 * carrying the stopped turn's request id in the row's own `requestId`. Nothing
 * about it is parsed from prose — the kind is the contract and the request id
 * is a column, so rewording the line cannot break the stop.
 *
 * By the time this item arrives the stop is already a FACT: the server settled
 * that turn's receipt `cancelled` and inscribed who stopped it before the line
 * was written. So a helper reading this has nothing to publish and nothing to
 * report — only a session to cancel. That is also why the item needs no
 * authority check here: only the person who asked can produce one.
 *
 * The stopped turn is named by ITS OWN request id and never by "whatever is
 * running", so a stop pressed as one turn ends can never silence the next one.
 */
export function turnStopRequestId(
  item: {
    type: string;
    mentionIds: readonly string[];
    requestId?: string;
    systemEvent?: SystemEvent;
  },
  agentId: string,
): string | undefined {
  if (item.type !== 'system' || !item.mentionIds.includes(agentId)) return undefined;
  if (item.systemEvent?.kind !== 'turn-cancelled') return undefined;
  return item.requestId || undefined;
}
