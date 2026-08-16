import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';

export type CornerSessionState = 'working' | 'idle' | 'done';

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
