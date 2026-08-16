import { resolveCornerCardAgentPubkey } from '@/buzz/agent-display';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';

export type CornerSessionState = 'working' | 'idle' | 'done';

/**
 * The corner view's own header identity. `agentTurn.agentPubkey` is declared
 * data (the same `agent` tag, or its signer fallback, that `corner.agentPubkey`
 * uses) and can be a stale/legacy pubkey even when a later message in the same
 * transcript is actually signed by the current registered agent. Apply the
 * same roster-preferring precedence the in-Room corner card uses
 * (`resolveCornerCardAgentPubkey`), so this surface can never show a
 * pubkey-hash placeholder name (e.g. "Alden") for an agent the transcript
 * already proves is registered (e.g. "Beebee").
 */
export function resolveCornerViewAgentPubkey(
  messages: readonly ChatDisplayMessage[],
  isRegisteredAgent: (pubkey: string) => boolean,
): string | undefined {
  const reversedMessages = [...messages].reverse();
  const declaredAgentPubkey = reversedMessages.find((message) => message.agentTurn)?.agentTurn
    ?.agentPubkey;
  const knownMessageSignerPubkey = reversedMessages.find(
    (message) => message.pubkey && isRegisteredAgent(message.pubkey),
  )?.pubkey;
  return resolveCornerCardAgentPubkey(declaredAgentPubkey, knownMessageSignerPubkey, isRegisteredAgent);
}

/** The edit session lifecycle is authoritative for the corner, never daemon presence. */
export function cornerSessionState(messages: readonly ChatDisplayMessage[]): CornerSessionState {
  const latestTurn = [...messages]
    .filter((message) => message.agentTurn)
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    .at(-1)?.agentTurn;
  if (!latestTurn) return 'idle';
  if (latestTurn.status === 'working') return 'working';
  return latestTurn.status === 'complete' ? 'done' : 'idle';
}

/** The durable agent response is the human-readable end-of-turn summary. */
export function latestCornerTurnSummary(
  messages: readonly ChatDisplayMessage[],
  agentPubkey?: string,
): string | undefined {
  const message = [...messages]
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    .reverse()
    .find(
      (item) =>
        !item.isUser &&
        !item.agentTurn &&
        !item.isAgentActivity &&
        !item.corner &&
        !item.isMergeSummary &&
        !item.isArchivedNotice &&
        (!agentPubkey || item.pubkey === agentPubkey) &&
        Boolean(item.text.trim()),
    );
  return message?.text.trim();
}
