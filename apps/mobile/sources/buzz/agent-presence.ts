import { TAG_AGENT_PRESENCE, newerAgentPresence, type AgentPresence } from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';

type UnknownRecord = Record<string, unknown>;

function rawPayload(event: SessionEvent): UnknownRecord | undefined {
  return event.type === 'raw' && event.payload && typeof event.payload === 'object'
    ? (event.payload as UnknownRecord)
    : undefined;
}

/** Accept only an agent's self-signed presence marker; a forged agent tag is ignored. */
export function agentPresenceFromSessionEvent(event: SessionEvent): AgentPresence | undefined {
  const payload = rawPayload(event);
  const tags = payload?.tags;
  const pubkey = payload?.pubkey;
  const createdAt = payload?.createdAt ?? payload?.created_at;
  if (!Array.isArray(tags) || typeof pubkey !== 'string' || typeof createdAt !== 'number') {
    return undefined;
  }
  const safeTags = tags.filter(
    (tag): tag is string[] => Array.isArray(tag) && tag.every((value) => typeof value === 'string'),
  );
  if (!safeTags.some((tag) => tag[0] === 't' && tag[1] === TAG_AGENT_PRESENCE)) {
    return undefined;
  }
  const agentPubkey = safeTags.find((tag) => tag[0] === 'agent')?.[1];
  const status = safeTags.find((tag) => tag[0] === 'status')?.[1];
  if (agentPubkey !== pubkey || (status !== 'online' && status !== 'offline')) return undefined;
  return {
    agentPubkey,
    status,
    observedAt: createdAt < 1_000_000_000_000 ? createdAt * 1_000 : createdAt,
  };
}

export function mergeAgentPresence(
  current: Readonly<Record<string, AgentPresence>>,
  incoming: AgentPresence,
): Record<string, AgentPresence> {
  const next = newerAgentPresence(current[incoming.agentPubkey], incoming);
  if (next === current[incoming.agentPubkey]) return current as Record<string, AgentPresence>;
  return { ...current, [incoming.agentPubkey]: next };
}

export function presenceMapFromSessionEvents(
  events: readonly SessionEvent[],
): Record<string, AgentPresence> {
  return events.reduce<Record<string, AgentPresence>>((presence, event) => {
    const signal = agentPresenceFromSessionEvent(event);
    return signal ? mergeAgentPresence(presence, signal) : presence;
  }, {});
}
