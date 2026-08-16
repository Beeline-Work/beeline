import { TAG_AGENT_DRAFT } from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';

type UnknownRecord = Record<string, unknown>;

export type AgentDraft = {
  requestId: string;
  sessionId: string;
  agentPubkey: string;
  text: string;
  observedAt: number;
};

function rawPayload(event: SessionEvent): UnknownRecord | undefined {
  return event.type === 'raw' && event.payload && typeof event.payload === 'object'
    ? (event.payload as UnknownRecord)
    : undefined;
}

/**
 * Parse a Room's live agent reply draft from the parameterized-replaceable
 * `#t=agent-draft` record. Accepts only the agent's own self-signed marker,
 * mirroring `agentPresenceFromSessionEvent`.
 */
export function agentDraftFromSessionEvent(event: SessionEvent): AgentDraft | undefined {
  const payload = rawPayload(event);
  const tags = payload?.tags;
  const pubkey = payload?.pubkey;
  const createdAt = payload?.createdAt ?? payload?.created_at;
  const content = payload?.content;
  if (
    !Array.isArray(tags) ||
    typeof pubkey !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof content !== 'string'
  ) {
    return undefined;
  }
  const safeTags = tags.filter(
    (tag): tag is string[] => Array.isArray(tag) && tag.every((value) => typeof value === 'string'),
  );
  if (!safeTags.some((tag) => tag[0] === 't' && tag[1] === TAG_AGENT_DRAFT)) return undefined;
  const agentPubkey = safeTags.find((tag) => tag[0] === 'agent')?.[1];
  const sessionId = safeTags.find((tag) => tag[0] === 'session')?.[1];
  const requestId = safeTags.find((tag) => tag[0] === 'request')?.[1];
  if (agentPubkey !== pubkey || !sessionId || !requestId) return undefined;
  return {
    requestId,
    sessionId,
    agentPubkey,
    text: content,
    observedAt: createdAt < 1_000_000_000_000 ? createdAt * 1_000 : createdAt,
  };
}
