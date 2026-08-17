import {
  TAG_AGENT_PRESENCE,
  isAgentPresenceOnline,
  newerAgentPresence,
  type AgentPresence,
} from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import {
  sessionEventHasTag,
  sessionEventPayload,
  sessionEventTagValue,
  type ChatDisplayMessage,
} from '@/sync/transport/buzz-event-projection';

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

/**
 * An empty presence map during bootstrap is unknown, not an offline verdict.
 * Only a completed snapshot with a real lease for every Room agent may mark a
 * steer as deferred.
 */
export function isAgentOfflineAfterPresenceResolved(
  presenceResolved: boolean,
  roomAgentCount: number,
  knownAgentPresenceCount: number,
  onlineAgentCount: number,
): boolean {
  return (
    presenceResolved &&
    roomAgentCount > 0 &&
    knownAgentPresenceCount === roomAgentCount &&
    onlineAgentCount === 0
  );
}

/** Accept only an agent's self-signed presence marker; a forged agent tag is ignored. */
export function agentPresenceFromSessionEvent(event: SessionEvent): RoomAgentPresence | undefined {
  const payload = sessionEventPayload(event);
  const pubkey = payload?.pubkey;
  const createdAt = payload?.createdAt ?? payload?.created_at;
  if (typeof pubkey !== 'string' || typeof createdAt !== 'number') return undefined;
  if (!sessionEventHasTag(event, 't', TAG_AGENT_PRESENCE)) return undefined;
  const agentPubkey = sessionEventTagValue(event, 'agent');
  const status = sessionEventTagValue(event, 'status');
  const generationId = sessionEventTagValue(event, 'generation');
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
  void now;
  void reconnectGraceUntil;
  if (turn.status !== 'working') return false;

  // Turn lifecycle and liveness are independent relay streams. A signed
  // working event is enough to render the Room progress row while the
  // replaceable presence lease is still loading or briefly quota-delayed.
  // An explicit offline marker, or a different current daemon generation,
  // is the only evidence that may close it before complete/failed arrives.
  if (presence?.status === 'offline') return false;
  if (presence?.generationId) return turn.generationId === presence.generationId;
  return true;
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
