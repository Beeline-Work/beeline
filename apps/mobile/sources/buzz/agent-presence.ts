import {
  isAgentPresenceOnline,
  newerAgentPresence,
  type AgentPresence,
} from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';

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

/** Reinstall relay delivery before reading the current replaceable presence snapshot. */
export async function reconnectPresenceAfterForeground(
  installSubscription: () => Promise<void>,
  backfill: () => Promise<readonly SessionEvent[]>,
): Promise<Record<string, RoomAgentPresence>> {
  await installSubscription();
  return presenceMapFromSessionEvents(await backfill());
}
