import {
  TAG_AGENT_PRESENCE,
  isAgentPresenceOnline,
  newerAgentPresence,
  type AgentPresence,
} from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';

type UnknownRecord = Record<string, unknown>;
export type RoomAgentPresence = AgentPresence & { generationId?: string };

/** Keep only a previously-online agent optimistic while foreground reconnection is pending. */
export function isAgentPresenceOnlineWithReconnectGrace(
  presence: RoomAgentPresence | undefined,
  now = Date.now(),
  reconnectGraceUntil = 0,
): boolean {
  if (presence?.status !== 'online') return false;
  return isAgentPresenceOnline(presence, now) || now <= reconnectGraceUntil;
}

function rawPayload(event: SessionEvent): UnknownRecord | undefined {
  return event.type === 'raw' && event.payload && typeof event.payload === 'object'
    ? (event.payload as UnknownRecord)
    : undefined;
}

/** Accept only an agent's self-signed presence marker; a forged agent tag is ignored. */
export function agentPresenceFromSessionEvent(event: SessionEvent): RoomAgentPresence | undefined {
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
  const generationId = safeTags.find((tag) => tag[0] === 'generation')?.[1];
  if (agentPubkey !== pubkey || (status !== 'online' && status !== 'offline')) return undefined;
  return {
    agentPubkey,
    status,
    observedAt: createdAt < 1_000_000_000_000 ? createdAt * 1_000 : createdAt,
    ...(generationId ? { generationId } : {}),
  };
}

/** A working turn belongs only to the currently online daemon generation. */
export function isAgentTurnActive(
  turn: NonNullable<ChatDisplayMessage['agentTurn']>,
  presence: RoomAgentPresence | undefined,
  now = Date.now(),
  reconnectGraceUntil = 0,
): boolean {
  if (
    turn.status !== 'working' ||
    !isAgentPresenceOnlineWithReconnectGrace(presence, now, reconnectGraceUntil)
  ) {
    return false;
  }
  return !presence?.generationId || turn.generationId === presence.generationId;
}

export function mergeAgentPresence(
  current: Readonly<Record<string, RoomAgentPresence>>,
  incoming: RoomAgentPresence,
): Record<string, RoomAgentPresence> {
  const next = newerAgentPresence(current[incoming.agentPubkey], incoming);
  if (next === current[incoming.agentPubkey]) return current as Record<string, RoomAgentPresence>;
  return { ...current, [incoming.agentPubkey]: next };
}

export function presenceMapFromSessionEvents(
  events: readonly SessionEvent[],
): Record<string, RoomAgentPresence> {
  return events.reduce<Record<string, RoomAgentPresence>>((presence, event) => {
    const signal = agentPresenceFromSessionEvent(event);
    return signal ? mergeAgentPresence(presence, signal) : presence;
  }, {});
}

/** Reinstall relay delivery before reading the current replaceable presence snapshot. */
export async function reconnectPresenceAfterForeground(
  installSubscription: () => Promise<void>,
  backfill: () => Promise<readonly SessionEvent[]>,
): Promise<Record<string, RoomAgentPresence>> {
  await installSubscription();
  return presenceMapFromSessionEvents(await backfill());
}
