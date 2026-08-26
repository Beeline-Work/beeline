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

/**
 * Sustained-absence grace before an agent reads DORMANT rather than merely
 * OFFLINE.
 *
 * The lease stays the single liveness truth: the instant it lapses the agent
 * renders offline everywhere. Dormancy is NOT a second liveness signal — it is
 * a statement about how LONG the lease has been dark, derived from the same
 * record. One heartbeat interval of relay quota rejection (a 429 is not
 * retried by `publishEvent`), one daemon restart gap, or one network flake
 * all look identical to elapsed time inside the lease window and comfortably
 * inside this grace, so nothing below it may imply the agent cannot receive
 * work; at this magnitude (24h) every observed cause of a missed renewal has
 * long since resolved or the daemon really is gone.
 */
export const AGENT_PRESENCE_DORMANT_MS = 24 * 60 * 60_000;

export type AgentPresenceStatus = 'online' | 'offline';

/**
 * The three presence tiers every consumer must share.
 *
 * - `online`: the lease is currently held.
 * - `offline`: the lease has lapsed (or an explicit offline marker stands).
 * - `dormant`: the lease has been dark past AGENT_PRESENCE_DORMANT_MS — the
 *   roster identity stays, but affordances implying the agent can receive
 *   work right now (mention autocomplete, active-target lists) omit it.
 *
 * Eviction is deliberately NOT a tier here: removing an agent key from a
 * Room's roster is durable RELAY truth (membership removal), never something
 * elapsed time may conclude. See `resolveAgentRosterStanding`.
 */
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

/**
 * Resolve the presence tier from the SAME record the lease reads.
 *
 * Invariants pinned here because every surface consumes this door:
 * - An expired lease can NEVER read online, regardless of restart, cache
 *   hydration, clock boundary, reconnect, or out-of-order updates — callers
 *   hand this function one already-reduced record (`newerAgentPresence`), so
 *   a stale duplicate cannot resurrect a lapsed lease either.
 * - Clock skew tolerances match `isAgentPresenceOnline` exactly: a future
 *   `observedAt` inside the lease window is ordinary skew and stays online,
 *   and a far-future stamp yields NEGATIVE elapsed time, which can never
 *   reach dormancy — a reader whose clock is behind must not age agents into
 *   dormancy from its own defect.
 * - A missing record is `offline`, not `dormant`: dormancy requires a
 *   last-observed instant to measure absence from. Knowing nothing about an
 *   agent is not knowing it has been gone a day.
 */
export function resolveAgentPresenceTier(
  presence: AgentPresence | undefined,
  now = Date.now(),
): AgentPresenceTier {
  if (!presence || presence.status !== 'online') return 'offline';
  const elapsed = now - presence.observedAt;
  // Same two-sided lease check as `isAgentPresenceOnline`: |now - observedAt|
  // within the window means the heartbeat still speaks.
  if (Math.abs(elapsed) <= AGENT_PRESENCE_STALE_MS) return 'online';
  if (elapsed >= AGENT_PRESENCE_DORMANT_MS) return 'dormant';
  return 'offline';
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
