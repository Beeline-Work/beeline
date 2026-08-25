import { CORNER_ACTIVITY_FRESHNESS_MS } from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';

export type AgentDraft = {
  requestId: string;
  sessionId: string;
  agentPubkey: string;
  text: string;
  observedAt: number;
};

/**
 * Parse a Room's live agent reply draft from the parameterized-replaceable
 * `#t=agent-draft` record. Accepts only the agent's own self-signed marker,
 * mirroring `agentPresenceFromSessionEvent`.
 */
export function agentDraftFromSessionEvent(
  event: SessionEvent,
  now = Date.now(),
): AgentDraft | undefined {
  if (event.type !== 'read-model' || event.event.type !== 'session-update') return undefined;
  const update = event.event.update;
  if (update.kind !== 'draft' || update.closed || !update.text) return undefined;
  const observedAt = event.event.createdAt * 1_000;
  if (now - observedAt < 0 || now - observedAt > CORNER_ACTIVITY_FRESHNESS_MS) return undefined;
  return {
    requestId: update.requestId,
    sessionId: event.event.sessionId,
    agentPubkey: update.agentPubkey,
    text: update.text,
    observedAt,
  };
}
