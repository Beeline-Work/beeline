import {
  AGENT_PRESENCE_DORMANT_MS,
  AGENT_PRESENCE_STALE_MS,
  newerAgentPresence,
  resolveAgentPresenceTier,
  type AgentPresence,
  type AgentPresenceTier,
  type RoomViewAgentTurn,
} from '@beeline/buzz-client';

export type RoomAgentPresence = AgentPresence & { generationId?: string };

/** Maximum lifetime of reconnect bookkeeping and authenticated online evidence. */
export const AGENT_PRESENCE_BACKGROUND_GRACE_MS = AGENT_PRESENCE_STALE_MS;
/** A missing terminal receipt must never leave a dead daemon visibly working forever. */
export const AGENT_TURN_FRESHNESS_MS = 90_000;

/**
 * One tier answer for every surface. Thin over the canonical SDK door so all
 * consumers share the same invariants; kept here because mobile resolves the
 * SDK through its built `dist/` and every screen already imports this module.
 */
export function agentPresenceTier(
  presence: AgentPresence | undefined,
  now = Date.now(),
): AgentPresenceTier {
  return resolveAgentPresenceTier(presence, now);
}

/**
 * Active mention/autocomplete targets: candidates minus DORMANT agents.
 *
 * A merely-offline agent stays addressable (messages wait for its daemon to
 * reconnect); a dormant one has been dark past the sustained-absence grace,
 * so affordances implying it can receive work right now omit it. Historical
 * references are untouched — transcript rows resolve identity late-bound from
 * the signer pubkey and never consult this list.
 */
export function activeMentionCandidates<T extends { pubkey: string }>(
  candidates: readonly T[],
  presences: Readonly<Record<string, RoomAgentPresence | AgentPresence>>,
  now = Date.now(),
): T[] {
  return candidates.filter((candidate) => {
    const presence = presences[candidate.pubkey];
    // Unknown presence is NOT dormant (dormancy requires a measurable
    // last-seen instant), so an unobserved agent stays mentionable.
    return !presence || agentPresenceTier(presence, now) !== 'dormant';
  });
}

export function nextAgentPresenceTransitionAt(
  presences: Readonly<Record<string, RoomAgentPresence | AgentPresence>>,
  now = Date.now(),
): number | undefined {
  let next: number | undefined;
  for (const presence of Object.values(presences)) {
    const observedAt = presence.observedAt * 1_000;
    const deadlines = [
      ...(presence.status === 'online' ? [observedAt + AGENT_PRESENCE_STALE_MS] : []),
      observedAt + AGENT_PRESENCE_DORMANT_MS,
    ];
    for (const deadline of deadlines) {
      if (!Number.isFinite(deadline) || deadline <= now) continue;
      next = next === undefined ? deadline : Math.min(next, deadline);
    }
  }
  return next;
}

export function nextAgentTurnExpiryAt(
  turns: readonly RoomViewAgentTurn[],
  now = Date.now(),
): number | undefined {
  let next: number | undefined;
  for (const turn of turns) {
    if (turn.status !== 'working') continue;
    const deadline = turn.createdAt * 1_000 + AGENT_TURN_FRESHNESS_MS;
    if (!Number.isFinite(deadline) || deadline <= now) continue;
    next = next === undefined ? deadline : Math.min(next, deadline);
  }
  return next;
}

/** A working turn belongs only to the currently online daemon generation. */
export function isAgentTurnActive(
  turn: RoomViewAgentTurn,
  presence: RoomAgentPresence | undefined,
  now = Date.now(),
  reconnectGraceUntil = 0,
): boolean {
  void reconnectGraceUntil;
  if (turn.status !== 'working') return false;
  const age = now - turn.createdAt * 1_000;
  if (age < -AGENT_TURN_FRESHNESS_MS || age >= AGENT_TURN_FRESHNESS_MS) return false;

  // Turn lifecycle and availability are independent relay streams. A signed
  // working event is enough to render the Room progress row while the durable
  // availability record is still loading.
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

/** A server refetch may race a newer availability transition; newest time wins. */
export function mergeAgentPresenceBatch(
  current: Readonly<Record<string, RoomAgentPresence>>,
  incoming: readonly RoomAgentPresence[],
): Record<string, RoomAgentPresence> {
  return incoming.reduce(mergeAgentPresence, current as Record<string, RoomAgentPresence>);
}
