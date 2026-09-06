/**
 * Who may address an agent — ONE vocabulary and ONE decision function.
 *
 * The policy is a property of the AGENT, stored server-side on `agents.access_policy`
 * and read by the server on every path that has to decide: the daemon's per-message
 * authority round trip (`getRoomAuthority`), and the send path that inscribes a
 * refusal when a mention is dropped. A helper's own runtime record is a pairing-time
 * seed, never the authority — a policy the owner changes in the app must take effect
 * on a helper that is already running, with no reconnect and no restart.
 *
 * `everyone` is the default because an agent that silently ignores a Room member is
 * indistinguishable from a dead one. `creator` is the cost/safety lever: only the
 * owner who connected the agent may spend its subscription. `allowlist` is explicit
 * delegation — authority is exactly the stored list, and the owner is not implicitly
 * in it.
 */

export type AgentAccessPolicy = 'everyone' | 'creator' | 'allowlist';

/** Every access policy this build understands. */
export const AGENT_ACCESS_POLICIES = ['everyone', 'creator', 'allowlist'] as const;

/**
 * The default for a NEWLY CONNECTED agent. An agent nobody can address reads as
 * broken, so the product default is that anyone in the Room may ask; an owner who
 * wants the narrow gate turns it off in the members page.
 */
export const DEFAULT_AGENT_ACCESS_POLICY: AgentAccessPolicy = 'everyone';

/** The stored jsonb shape on `agents.access_policy`. */
export type AgentAccessPolicyRecord =
  | { readonly type: 'everyone' }
  | { readonly type: 'creator' }
  | { readonly type: 'allowlist'; readonly allow: readonly string[] };

export const MAX_ACCESS_ALLOWLIST_ENTRIES = 64;

export function isAgentAccessPolicy(value: unknown): value is AgentAccessPolicy {
  return (AGENT_ACCESS_POLICIES as readonly string[]).includes(value as string);
}

/**
 * Read a stored `access_policy` row. An unreadable row is a bug, and the narrow
 * policy is the safe reading of one — silence is no longer the consequence, since a
 * dropped mention is inscribed in the Room either way.
 */
export function parseAgentAccessPolicy(value: unknown): AgentAccessPolicyRecord {
  const record = value as { type?: unknown; allow?: unknown } | null | undefined;
  if (!record || typeof record !== 'object') return { type: 'creator' };
  if (record.type === 'everyone') return { type: 'everyone' };
  if (record.type === 'allowlist') {
    const allow = Array.isArray(record.allow)
      ? record.allow.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { type: 'allowlist', allow };
  }
  return { type: 'creator' };
}

export function agentAccessPolicyRecord(
  policy: AgentAccessPolicy,
  allow: readonly string[] = [],
): AgentAccessPolicyRecord {
  return policy === 'allowlist' ? { type: 'allowlist', allow: [...allow] } : { type: policy };
}

/**
 * Whether `senderId` may drive the agent this policy belongs to. Fail-closed: only a
 * sender the policy explicitly allows returns true. Agent senders are not gated here
 * — an agent is a server-validated Room member and answers to the Room, not to the
 * owner's cost policy.
 */
export function senderMayAddressAgent(
  policy: AgentAccessPolicyRecord,
  senderId: string,
  ownerId: string | undefined,
): boolean {
  if (!senderId) return false;
  switch (policy.type) {
    case 'everyone':
      return true;
    case 'creator':
      return Boolean(ownerId) && senderId === ownerId;
    case 'allowlist':
      return policy.allow.includes(senderId);
  }
}

/**
 * A helper is reachable while its newest presence says `online` and is younger than
 * this. The same horizon `releaseReadiness` calls a daemon `ready`, so "unreachable"
 * in a Room and "not ready" on the release gate can never disagree.
 */
export const AGENT_REACHABLE_HORIZON_MS = 90_000;

/**
 * A dropped mention is inscribed at most once per bucket per (Room, agent, sender,
 * reason). Bucketing rather than a sliding window keeps the guard stateless: the
 * line's id is derived from the bucket, so a repeat inside it collides and writes
 * nothing.
 */
export const ACCESS_NOTICE_WINDOW_MS = 10 * 60_000;

export function accessNoticeBucket(now: number): number {
  return Math.floor(now / ACCESS_NOTICE_WINDOW_MS);
}
