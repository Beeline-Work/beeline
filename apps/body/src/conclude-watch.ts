/** Legacy persisted shape retained only for durable-state compatibility. */
export interface ConcludeEpisode {
  quietSince?: number;
  nudges: number;
  lastNudgeAt?: number;
  stalledNotified?: boolean;
}

export function freshConcludeEpisode(): ConcludeEpisode {
  return { nudges: 0 };
}

/** Whether the newest decisive transcript event is an unanswered model ask. */
export function standingAskFromEvents(
  events: readonly NostrEventLike[],
  agentPubkey: string,
): boolean {
  const sorted = [...events].sort(
    (a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id),
  );
  for (const event of sorted) {
    if (event.pubkey !== agentPubkey) return false;
    const marker = event.tags?.find((tag) => tag[0] === 't')?.[1];
    if (marker === 'agent-message' && event.content.includes('?')) return true;
  }
  return false;
}

interface NostrEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags?: string[][];
}
