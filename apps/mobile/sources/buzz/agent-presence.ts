import {
  AGENT_PRESENCE_DORMANT_MS,
  AGENT_PRESENCE_STALE_MS,
  isAgentPresenceOnline,
  newerAgentPresence,
  resolveAgentPresenceTier,
  type AgentPresence,
  type AgentPresenceTier,
} from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';

export type RoomAgentPresence = AgentPresence & { generationId?: string };

/** Maximum lifetime of reconnect bookkeeping; it never extends the lease verdict. */
export const AGENT_PRESENCE_BACKGROUND_GRACE_MS = AGENT_PRESENCE_STALE_MS;

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

/** Preserve the existing call shape while resolving liveness strictly from the lease. */
export function isAgentPresenceOnlineWithReconnectGrace(
  presence: RoomAgentPresence | undefined,
  now = Date.now(),
  reconnectGraceUntil = 0,
): boolean {
  void reconnectGraceUntil;
  return isAgentPresenceOnline(presence, now);
}

export function nextAgentPresenceTransitionAt(
  presences: Readonly<Record<string, RoomAgentPresence | AgentPresence>>,
  now = Date.now(),
): number | undefined {
  let next: number | undefined;
  for (const presence of Object.values(presences)) {
    const deadlines = [
      ...(presence.status === 'online' ? [presence.observedAt + AGENT_PRESENCE_STALE_MS] : []),
      presence.observedAt + AGENT_PRESENCE_DORMANT_MS,
    ];
    for (const deadline of deadlines) {
      if (!Number.isFinite(deadline) || deadline <= now) continue;
      next = next === undefined ? deadline : Math.min(next, deadline);
    }
  }
  return next;
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
  if (event.type !== 'read-model' || event.event.type !== 'session-update') return undefined;
  const update = event.event.update;
  if (update.kind !== 'presence') return undefined;
  return {
    agentPubkey: update.agentPubkey,
    status: update.status,
    observedAt: event.event.createdAt * 1_000,
    ...(update.generationId ? { generationId: update.generationId } : {}),
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
    // kind:30078 is the sole liveness authority. Chat, activity, draft, and
    // control events can describe work but may never mint or renew a lease.
    const signal = agentPresenceFromSessionEvent(event);
    return signal ? mergeAgentPresence(presence, signal) : presence;
  }, {});
}

/**
 * One online/offline verdict per agent pubkey, resolved once per render.
 *
 * The transcript's renderItem needs each speaker's liveness for the byline
 * ring, but reading the three raw inputs (heartbeat map, wall clock,
 * reconnect grace) directly recreated the callback on EVERY heartbeat and on
 * every streamed batch, rebuilding every visible ledger row for no visible
 * change. Collapsing them to a flat boolean record lets the screen preserve
 * identity with `useStable` while no verdict actually flips — rows then
 * re-render only when an agent genuinely went online or offline.
 */
export function onlineVerdicts(
  presences: Readonly<Record<string, RoomAgentPresence>>,
  pubkeys: readonly string[],
  now: number,
  reconnectGrace: Readonly<Record<string, number>> = {},
): Record<string, boolean> {
  const verdicts: Record<string, boolean> = {};
  for (const pubkey of pubkeys) {
    verdicts[pubkey] = isAgentPresenceOnlineWithReconnectGrace(
      presences[pubkey],
      now,
      reconnectGrace[pubkey],
    );
  }
  return verdicts;
}

/** Reinstall relay delivery before reading the current replaceable presence snapshot. */
export async function reconnectPresenceAfterForeground(
  installSubscription: () => Promise<void>,
  backfill: () => Promise<readonly SessionEvent[]>,
): Promise<Record<string, RoomAgentPresence>> {
  await installSubscription();
  return presenceMapFromSessionEvents(await backfill());
}
