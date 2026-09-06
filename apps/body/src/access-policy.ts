/**
 * Per-agent access policy as the HELPER holds it — the pairing-time seed and the
 * one read-time fallback, no longer the authority.
 *
 * The vocabulary and the decision live in `@beeline/api-contract/agent-access`, and
 * the live answer comes from the server on every candidate message
 * (`getRoomAuthority`.`mayAddressAgent`), so an owner's change in the members page
 * reaches a running helper with no reconnect and no restart. What stays here is
 * what the connect wizard writes into the runtime record and what a helper reads
 * when it is talking to a server too old to answer.
 *
 * `creator` is the cost/safety lever: only the inviting owner may address the
 * agent, so no one else spends the operator's subscription. `allowlist` is explicit
 * delegation: authority is exactly the stored list, and the creator is not
 * implicitly in it.
 */

import {
  DEFAULT_AGENT_ACCESS_POLICY,
  MAX_ACCESS_ALLOWLIST_ENTRIES,
  type AgentAccessPolicy,
} from '@beeline/api-contract/agent-access';

export {
  AGENT_ACCESS_POLICIES,
  MAX_ACCESS_ALLOWLIST_ENTRIES,
  isAgentAccessPolicy,
  type AgentAccessPolicy,
} from '@beeline/api-contract/agent-access';

/**
 * Default for a NEWLY PAIRED agent: `everyone`. An agent that silently ignores a
 * Room member is indistinguishable from a dead one, so the product default is that
 * anyone in the Room may ask, and an owner who wants the narrow gate turns it off
 * in the members page. The server row carries the same default
 * (`agents.access_policy`); this constant only seeds the runtime record the connect
 * wizard writes.
 *
 * This constant must NOT be used as a read-time fallback for a runtime record
 * carrying no policy: read-time fallbacks use LEGACY_ACCESS_POLICY, and the
 * one-time migration in `runtime.ts` (`migrateRuntimeRecordAccessPolicy`) stamps an
 * explicit policy onto pre-existing records so they stop depending on any constant
 * at all.
 */
export const DEFAULT_ACCESS_POLICY: AgentAccessPolicy = DEFAULT_AGENT_ACCESS_POLICY;

/**
 * The frozen pre-policy behaviour: `everyone`. Every agent paired before
 * per-agent access policies shipped has been running with no gating, and an
 * already-paired agent must keep answering exactly the senders it answered
 * before. Used by the one-time record migration and by read-time fallbacks
 * for records that carry no explicit policy — never for a new pairing.
 */
export const LEGACY_ACCESS_POLICY: AgentAccessPolicy = 'everyone';

/** Strict persisted form: unique lowercase hex pubkeys with a bounded cardinality. */
export function isAgentAccessAllowlist(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACCESS_ALLOWLIST_ENTRIES) {
    return false;
  }
  if (value.some((pubkey) => typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey))) {
    return false;
  }
  return new Set(value).size === value.length;
}

/**
 * The captain-specified default auto-response, verbatim. `<@owner_name>` is a
 * template variable resolved to the owner's display name / handle at send time.
 */
export const DEFAULT_ACCESS_AUTO_RESPONSE =
  'I only answer to senpai <@owner_name>, King of the Andals and the First Men. ' +
  'Ask His Grace for permission to address me, wildling.';

/**
 * One refusal per sender per window, so a public Room full of non-permitted
 * members can never turn the auto-response into a spam loop. One polite
 * refusal, then quiet for that sender.
 */
export const ACCESS_REFUSAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * Whether a message sender is permitted to drive this agent under `policy`.
 *
 * Fail-closed: only a sender the policy explicitly allows returns true. An
 * empty sender, an absent owner under `creator`, or an unknown policy value all
 * return false.
 */
export function isSenderPermitted(
  policy: AgentAccessPolicy,
  senderPubkey: string,
  ownerPubkey: string | undefined,
  allowlist: readonly string[] | undefined = undefined,
): boolean {
  if (!senderPubkey) return false;
  switch (policy) {
    case 'everyone':
      return true;
    case 'creator':
      return Boolean(ownerPubkey) && senderPubkey === ownerPubkey;
    case 'allowlist':
      return Boolean(allowlist?.includes(senderPubkey));
    default:
      // An unrecognized policy is treated as the most restrictive: deny.
      return false;
  }
}

/** Resolve the `<@owner_name>` / `<owner_name>` template variables. */
export function renderAccessAutoResponse(template: string, ownerName: string | undefined): string {
  const name = ownerName?.trim() || 'the owner';
  return template.replace(/<@owner_name>/g, `@${name}`).replace(/<owner_name>/g, name);
}

/**
 * Per-sender rate limiter for the access auto-response. In-memory per daemon —
 * a restart may emit one further refusal per sender, which is not a spam loop.
 */
export class AccessRefusalLimiter {
  private readonly lastBySender = new Map<string, number>();

  constructor(private readonly windowMs: number = ACCESS_REFUSAL_WINDOW_MS) {}

  /**
   * Returns true (and records the emission) when a refusal to `senderPubkey`
   * should be sent now; false while still inside the sender's quiet window.
   */
  shouldEmit(senderPubkey: string, now: number = Date.now()): boolean {
    const last = this.lastBySender.get(senderPubkey);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.lastBySender.set(senderPubkey, now);
    return true;
  }
}
