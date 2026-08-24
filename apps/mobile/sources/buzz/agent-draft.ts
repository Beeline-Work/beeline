import { CORNER_ACTIVITY_FRESHNESS_MS, TAG_AGENT_DRAFT } from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import {
  sessionEventHasTag,
  sessionEventPayload,
  sessionEventTagValue,
} from '@/sync/transport/buzz-event-projection';

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
  const payload = sessionEventPayload(event);
  const pubkey = payload?.pubkey;
  const createdAt = payload?.createdAt ?? payload?.created_at;
  const content = payload?.content;
  if (typeof pubkey !== 'string' || typeof createdAt !== 'number' || typeof content !== 'string') {
    return undefined;
  }
  if (!sessionEventHasTag(event, 't', TAG_AGENT_DRAFT)) return undefined;
  if (sessionEventTagValue(event, 'status') === 'closed') return undefined;
  const agentPubkey = sessionEventTagValue(event, 'agent');
  const sessionId = sessionEventTagValue(event, 'session');
  const requestId = sessionEventTagValue(event, 'request');
  if (agentPubkey !== pubkey || !sessionId || !requestId) return undefined;
  const observedAt = createdAt < 1_000_000_000_000 ? createdAt * 1_000 : createdAt;
  if (now - observedAt < 0 || now - observedAt > CORNER_ACTIVITY_FRESHNESS_MS) return undefined;
  return {
    requestId,
    sessionId,
    agentPubkey,
    text: content,
    observedAt,
  };
}
