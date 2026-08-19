import {
  AGENT_PRESENCE_STALE_MS,
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

/**
 * Latest transcript timestamp at which each pubkey published a relay message
 * into this channel. First-hand evidence of life, on a stream (kind:9 message
 * delivery) entirely independent of the replaceable presence lease.
 */
export function latestUtteranceByPubkey(
  messages: readonly Pick<
    ChatDisplayMessage,
    'pubkey' | 'timestamp' | 'isUser' | 'isSystemNotice'
  >[],
): Record<string, number> {
  return messages.reduce<Record<string, number>>((latest, message) => {
    // A client-only notice was never signed by anyone, and the viewer's own
    // message says nothing about whoever it addresses.
    if (message.isSystemNotice || message.isUser || !message.pubkey) return latest;
    const seen = latest[message.pubkey];
    if (seen === undefined || message.timestamp > seen) latest[message.pubkey] = message.timestamp;
    return latest;
  }, {});
}

/**
 * Whether an addressed agent may be presumed alive. Absence of a heartbeat is
 * not proof of absence: the presence lease and reply delivery are independent
 * relay streams, so a lease this client never read — or read once and let go
 * stale — says nothing while the agent is visibly answering. Both of those
 * used to render the offline notice on every single send of a live
 * conversation, and nothing the agent published could falsify it.
 *
 * Evidence that may close it: an explicit `offline` marker the daemon
 * published on shutdown, or an expired lease with nothing from the agent
 * since. Everything else is unknown, and unknown never accuses.
 */
export function isAddressedAgentPresumedLive(
  presence: RoomAgentPresence | undefined,
  now: number,
  reconnectGraceUntil: number,
  lastSpokeAt: number | undefined,
  presenceResolved: boolean,
): boolean {
  if (isAgentPresenceOnlineWithReconnectGrace(presence, now, reconnectGraceUntil)) return true;
  // A graceful shutdown published after the agent last spoke is the one signal
  // that outranks the transcript: the daemon itself said it was going away.
  if (
    presence?.status === 'offline' &&
    (lastSpokeAt === undefined || presence.observedAt >= lastSpokeAt)
  ) {
    return false;
  }
  // Two-sided, for the same reason `isAgentPresenceOnline` compares an
  // absolute difference: the daemon and this device are independent clocks.
  if (lastSpokeAt !== undefined && Math.abs(now - lastSpokeAt) <= AGENT_PRESENCE_STALE_MS) {
    return true;
  }
  // No completed presence snapshot yet — the bootstrap read is still in
  // flight, which is unknown, not an offline verdict.
  return !presenceResolved;
}

/**
 * A user just addressed an agent (an explicit @mention, or the corner's own
 * agent) that `isAddressedAgentPresumedLive` found real evidence is down. The
 * daemon cannot speak for itself here — a fully down daemon publishes nothing,
 * not even an error — so this is a client-rendered notice from detected
 * staleness, not a message either party sent. `null` whenever the agent may be
 * live: never render a notice a healthy agent would contradict.
 */
export function addressedAgentOfflineNotice(
  agentName: string,
  presumedLive: boolean,
): string | null {
  if (presumedLive) return null;
  return `${agentName} seems offline right now — its host machine may be off.`;
}

/**
 * The notice is a one-time explanation of an outage, not a per-send stamp. It
 * used to be re-inserted on every single message addressed to the agent, so a
 * long conversation with one briefly-unreachable agent filled the transcript
 * with identical rows saying the same thing.
 *
 * `noticed` carries the agents already told about. An agent that reads live
 * again is dropped from it, so a genuine second outage explains itself once
 * more rather than staying silent forever after the first.
 */
export function offlineNoticeDecision(
  noticed: ReadonlySet<string>,
  agentPubkey: string,
  presumedLive: boolean,
): { notify: boolean; noticed: ReadonlySet<string> } {
  const alreadyNoticed = noticed.has(agentPubkey);
  if (presumedLive) {
    if (!alreadyNoticed) return { notify: false, noticed };
    const cleared = new Set(noticed);
    cleared.delete(agentPubkey);
    return { notify: false, noticed: cleared };
  }
  if (alreadyNoticed) return { notify: false, noticed };
  return { notify: true, noticed: new Set(noticed).add(agentPubkey) };
}

/** Reinstall relay delivery before reading the current replaceable presence snapshot. */
export async function reconnectPresenceAfterForeground(
  installSubscription: () => Promise<void>,
  backfill: () => Promise<readonly SessionEvent[]>,
): Promise<Record<string, RoomAgentPresence>> {
  await installSubscription();
  return presenceMapFromSessionEvents(await backfill());
}
