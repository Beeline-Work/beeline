/**
 * Presence uses the relay's existing parameterized-replaceable application
 * kind, so each agent/Room retains one current record instead of crowding chat
 * history. A heartbeat every 45s is cheap enough for a multi-Room daemon while
 * a 120s lease tolerates transient relay reconnects without leaving a dead
 * daemon looking online for long.
 */
import { TAG_AGENT_PRESENCE } from './kinds.js';

export const AGENT_PRESENCE_HEARTBEAT_MS = 45_000;
export const AGENT_PRESENCE_STALE_MS = 120_000;

export type AgentPresenceStatus = 'online' | 'offline';

/**
 * The `d` of an agent's presence record for one Room.
 *
 * Presence is a parameterized-replaceable kind:30078 event, and the relay
 * indexes those by `d` — a `#h` filter over kind 30078 matches NOTHING, even
 * though the record does carry an `h` tag. Every reader that got this right
 * had spelled the key out by hand; the one that reached for `#h` (the
 * Workspace-wide agents directory, which fans across every Room) therefore
 * found no presence for any agent, ever, and showed a serving daemon with a
 * four-second-old `online` heartbeat as OFFLINE.
 *
 * One builder so the publisher and every reader cannot drift again.
 */
export function agentPresenceKey(channelId: string): string {
  return `${TAG_AGENT_PRESENCE}:${channelId}`;
}

export type AgentPresence = {
  agentPubkey: string;
  status: AgentPresenceStatus;
  observedAt: number;
};

export function isAgentPresenceOnline(
  presence: AgentPresence | undefined,
  now = Date.now(),
): boolean {
  // The daemon and the reader (mobile device or another daemon) are
  // independent clocks. A heartbeat's `observedAt` landing slightly ahead of
  // the reader's own `now` is ordinary skew, not staleness — rejecting it
  // outright (a plain `now - observedAt >= 0` check) makes every heartbeat
  // look "future" forever whenever the daemon's clock merely runs ahead,
  // which reads as a permanently offline agent that is actually live.
  return (
    presence?.status === 'online' &&
    Math.abs(now - presence.observedAt) <= AGENT_PRESENCE_STALE_MS
  );
}

/** Keep the newest signal; an explicit offline marker wins a same-second tie. */
export function newerAgentPresence(
  current: AgentPresence | undefined,
  incoming: AgentPresence,
): AgentPresence {
  if (!current || incoming.observedAt > current.observedAt) return incoming;
  if (incoming.observedAt === current.observedAt && incoming.status === 'offline') {
    return incoming;
  }
  return current;
}
