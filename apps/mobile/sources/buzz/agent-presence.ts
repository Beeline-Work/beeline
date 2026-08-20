import {
  TAG_AGENT_PRESENCE,
  isAgentPresenceOnline,
  newerAgentPresence,
  type AgentPresence,
} from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import {
  mentionedAgentPubkey,
  selectedMentionAgentPubkey,
  type MentionableAgent,
} from './room-participants';
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
  const payload = sessionEventPayload(event);
  const pubkey = payload?.pubkey;
  const createdAt = payload?.createdAt ?? payload?.created_at;
  if (typeof pubkey !== 'string' || typeof createdAt !== 'number') return undefined;
  if (!agentPubkeys.has(pubkey)) return undefined;
  // A presence record is handled by `agentPresenceFromSessionEvent`, which
  // reads its explicit status; reading it here too would turn an authoritative
  // `offline` marker into an `online` observation of the same instant.
  if (sessionEventHasTag(event, 't', TAG_AGENT_PRESENCE)) return undefined;
  return {
    agentPubkey: pubkey,
    status: 'online',
    observedAt: createdAt < 1_000_000_000_000 ? createdAt * 1_000 : createdAt,
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
 * A user just addressed an agent (an explicit @mention, or the corner's own
 * agent) whose presence reads offline/stale. The daemon cannot speak for
 * itself here — a fully down daemon publishes nothing, not even an error —
 * so this is a client-rendered notice from detected staleness, not a
 * message either party sent. `null` when the agent is online: never render
 * a notice for a healthy agent.
 */
export function addressedAgentOfflineNotice(agentName: string, online: boolean): string | null {
  if (online) return null;
  return `${agentName} seems offline right now — its host machine may be off.`;
}

/**
 * How long one agent's offline notice stands for. A second notice inside the
 * window is the same fact restated, not new information.
 */
export const OFFLINE_NOTICE_REPEAT_WINDOW_MS = 5 * 60_000;

export type OfflineNoticeSend = {
  /** Exactly the text handed to the relay, mention prefix and all. */
  sentText: string;
  /** A Corner addresses its one administering agent implicitly. */
  cornerAgentPubkey?: string;
  /** Room roster used to resolve a typed @mention; ignored in a Corner. */
  mentionableAgents?: readonly MentionableAgent[];
  /** Handles the user picked from the mention dropdown, handle → pubkey. */
  selectedMentions?: ReadonlyMap<string, string>;
};

/**
 * Which agent — if any — this send actually addressed.
 *
 * A Corner has exactly one administering agent, so every message there
 * addresses it. A Room only addresses an agent when the text that was SENT
 * names it: neither a stale dropdown selection nor a reply shortcut counts on
 * its own, because the notice must describe the message the reader just
 * watched leave, not the conversation's history.
 */
export function offlineNoticeAddressee(send: OfflineNoticeSend): string | undefined {
  if (send.cornerAgentPubkey) return send.cornerAgentPubkey;
  return (
    (send.selectedMentions
      ? selectedMentionAgentPubkey(send.sentText, send.selectedMentions)
      : undefined) ?? mentionedAgentPubkey(send.sentText, [...(send.mentionableAgents ?? [])])
  );
}

/**
 * Decide whether this send earns a client-rendered offline notice, and for
 * whom. `null` means stay silent.
 *
 * Three gates, each one a separate way the notice turned into per-turn spam:
 *
 *  - **addressed** — see `offlineNoticeAddressee`. An offline agent nobody
 *    spoke to is not news; the Room's own OFFLINE banner already says it.
 *  - **presence resolved** — an absent presence lease is UNKNOWN, not offline
 *    (the same distinction `isAgentOfflineAfterPresenceResolved` draws for the
 *    banner). The presence backfill is one independent step of the room-entry
 *    fan-out, so a send during hydration would otherwise accuse a perfectly
 *    healthy agent of being down.
 *  - **not already said** — the notice restates a standing condition, so
 *    repeating it once per message buries the conversation. One notice per
 *    agent per `OFFLINE_NOTICE_REPEAT_WINDOW_MS`; `noticedAt` is the caller's
 *    record of when that agent was last told about.
 */
export function offlineNoticeForSend(input: {
  send: OfflineNoticeSend;
  presenceResolved: boolean;
  isOnline: (agentPubkey: string) => boolean;
  agentName: (agentPubkey: string) => string;
  noticedAt?: ReadonlyMap<string, number>;
  now?: number;
  repeatWindowMs?: number;
}): { agentPubkey: string; text: string } | null {
  if (!input.presenceResolved) return null;
  const agentPubkey = offlineNoticeAddressee(input.send);
  if (!agentPubkey) return null;
  const text = addressedAgentOfflineNotice(input.agentName(agentPubkey), input.isOnline(agentPubkey));
  if (!text) return null;
  const last = input.noticedAt?.get(agentPubkey);
  const now = input.now ?? Date.now();
  const window = input.repeatWindowMs ?? OFFLINE_NOTICE_REPEAT_WINDOW_MS;
  if (last !== undefined && now - last < window) return null;
  return { agentPubkey, text };
}

/** Reinstall relay delivery before reading the current replaceable presence snapshot. */
export async function reconnectPresenceAfterForeground(
  installSubscription: () => Promise<void>,
  backfill: () => Promise<readonly SessionEvent[]>,
): Promise<Record<string, RoomAgentPresence>> {
  await installSubscription();
  return presenceMapFromSessionEvents(await backfill());
}
