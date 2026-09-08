/** Durable agent availability; elapsed idle time never revokes online. */
import { TAG_AGENT_PRESENCE } from './kinds.js';

export const AGENT_PRESENCE_HEARTBEAT_MS = 45_000;
export const AGENT_PRESENCE_STALE_MS = 120_000;

/** An explicit offline fact ages into dormancy after a day. */
export const AGENT_PRESENCE_DORMANT_MS = 24 * 60 * 60_000;

export type AgentPresenceStatus = 'online' | 'offline';

export type AgentPresenceTier = 'online' | 'offline' | 'dormant';

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

/** Presence changes only on lifecycle announcements and failed deliveries. */
export function isAgentPresenceOnline(
  presence: AgentPresence | undefined,
  now = Date.now(),
): boolean {
  void now;
  return presence?.status === 'online';
}

export function resolveAgentPresenceTier(
  presence: AgentPresence | undefined,
  now = Date.now(),
): AgentPresenceTier {
  if (!presence) return 'offline';
  if (presence.status === 'online') return 'online';
  return now - presence.observedAt >= AGENT_PRESENCE_DORMANT_MS ? 'dormant' : 'offline';
}

/**
 * Current canonical Room-membership standing for one exact agent key.
 *
 * This mirrors the daemon-side corroborated tri-state read on purpose:
 * `member` / `not-member` come only from successful authoritative reads of
 * relay-signed membership truth (kind:9001 mutations folded into the 39002
 * projection). Every read failure, timeout, or degraded projection is
 * `unknown`.
 */
export type RoomMembershipStanding = 'member' | 'not-member' | 'unknown';

export type AgentRosterStanding =
  | {
      readonly tier: Exclude<AgentPresenceTier, 'evicted'>;
      readonly lastSeenAt?: number;
    }
  /**
   * Gone for good: the key was durably removed from THIS Room's roster by
   * signed relay authority. Reversible only through the normal re-add/
   * re-pair flow (membership restored); historical messages, corners,
   * authorship, and receipts are untouched — they render late-bound from the
   * signer pubkey and never consult current membership.
   */
  | { readonly tier: 'evicted' };

/**
 * Combine presence tiers with roster truth into the ONE standing every
 * consumer sees.
 *
 * Why transient flakes can never satisfy eviction:
 * - Elapsed absence is not evidence. A missed heartbeat (quota-rejected 429s
 *   are not retried by the publisher), a daemon restart, a relay outage, and
 *   death are indistinguishable by time alone, so NO duration of lease
 *   darkness ever evicts — worst case is `dormant`.
 * - A failed membership read is `unknown`, which degrades DOWNWARD to the
 *   presence tiers, never upward to evicted. Only a successful read saying
 *   `not-member` — signed kind:9001 removal authority — evicts.
 * - Membership wins over any presence record: a removed key's stale heartbeat
 *   (or a replayed one) cannot make an evicted agent look receivable.
 * - Eviction is idempotent by construction: it derives from the projection,
 *   so re-deriving is stable, and a renewed lease or restored membership
 *   returns the identity cleanly to the active tier with no duplicate roster
 *   entry (rosters key on pubkey).
 */
export function resolveAgentRosterStanding(params: {
  presence?: AgentPresence;
  membership?: RoomMembershipStanding;
  now?: number;
}): AgentRosterStanding {
  if (params.membership === 'not-member') return { tier: 'evicted' };
  const tier = resolveAgentPresenceTier(params.presence, params.now);
  return {
    tier,
    ...(params.presence ? { lastSeenAt: params.presence.observedAt } : {}),
  } satisfies AgentRosterStanding;
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
