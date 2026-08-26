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

/**
 * An agent event is itself proof the agent was alive when it signed it.
 *
 * The heartbeat is not the only evidence of liveness, and it is the least
 * reliable piece: `publishEvent` does not retry a relay quota rejection, and
 * the captain's daemon log shows heartbeats coming back
 * `HTTP 429 rate-limited` at Room start. Two swallowed heartbeats against a
 * 120s lease is enough for a live agent to read offline — while it is visibly
 * answering in the transcript, which is the "X seems offline when it is
 * plainly not" report.
 *
 * A kind:9 event carrying this agent's own signature is stronger evidence than
 * a heartbeat: it says the daemon was up, authenticated, and doing its job at
 * that moment. It is merged through `newerAgentPresence` exactly like a
 * heartbeat, so a NEWER explicit `offline` marker still wins and an older one
 * correctly loses — an implicit signal can never contradict a later
 * deliberate statement.
 *
 * Deliberately not derived for a `generationId`: only the daemon's own
 * heartbeat knows which generation is current, and guessing one would let a
 * stale turn re-open (see `isAgentTurnActive`).
 */
export function agentLivenessFromSessionEvent(
  event: SessionEvent,
  agentPubkeys: ReadonlySet<string>,
): RoomAgentPresence | undefined {
  if (event.type !== 'read-model' || event.event.type === 'unknown') return undefined;
  const typed = event.event;
  if (typed.scope !== 'channel' || !agentPubkeys.has(typed.authorPubkey)) return undefined;
  // A presence record is handled by `agentPresenceFromSessionEvent`, which
  // reads its explicit status; reading it here too would turn an authoritative
  // `offline` marker into an `online` observation of the same instant.
  if (typed.type === 'session-update' && typed.update.kind === 'presence') return undefined;
  return {
    agentPubkey: typed.authorPubkey,
    status: 'online',
    observedAt: typed.createdAt * 1_000,
  };
}

export function presenceMapFromSessionEvents(
  events: readonly SessionEvent[],
  /** Registered agents of this Room, so only a real agent's own signature counts. */
  agentPubkeys: ReadonlySet<string> = new Set(),
): Record<string, RoomAgentPresence> {
  return events.reduce<Record<string, RoomAgentPresence>>((presence, event) => {
    const signal =
      agentPresenceFromSessionEvent(event) ?? agentLivenessFromSessionEvent(event, agentPubkeys);
    return signal ? mergeAgentPresence(presence, signal) : presence;
  }, {});
}

/**
 * The presence map an agent's own visible output is allowed to correct.
 *
 * `presences` is what the heartbeat stream says; `messages` is the transcript
 * already on screen. An agent message signed at time T proves the daemon was
 * alive at T, so it is merged as an implicit `online` observation through the
 * same `newerAgentPresence` ordering — a later explicit `offline` marker still
 * wins, an earlier one correctly does not.
 *
 * This is what closes the gap between "the heartbeat did not get through" and
 * "the agent is down". Heartbeats are dropped for real: a relay quota
 * rejection is not retried by `publishEvent`, and two missed against a 120s
 * lease is all it takes for a Room to accuse an agent that is answering in the
 * same breath.
 */
export function presenceWithMessageLiveness(
  presences: Readonly<Record<string, RoomAgentPresence>>,
  messages: readonly ChatDisplayMessage[],
  agentPubkeys: ReadonlySet<string>,
): Record<string, RoomAgentPresence> {
  if (agentPubkeys.size === 0) return presences as Record<string, RoomAgentPresence>;
  // Newest first: one pass, and an agent is settled by its most recent message.
  const newest = new Map<string, number>();
  for (const message of messages) {
    const pubkey = message.pubkey;
    if (!pubkey || !agentPubkeys.has(pubkey)) continue;
    // A client-only row (the offline notice itself, a queued-steer receipt) is
    // not something the agent signed and proves nothing about it.
    if (message.isSystemNotice) continue;
    const at = message.timestamp;
    if (!Number.isFinite(at)) continue;
    if ((newest.get(pubkey) ?? 0) < at) newest.set(pubkey, at);
  }
  let next = presences as Record<string, RoomAgentPresence>;
  for (const [agentPubkey, observedAt] of newest) {
    next = mergeAgentPresence(next, { agentPubkey, status: 'online', observedAt });
  }
  return next;
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
