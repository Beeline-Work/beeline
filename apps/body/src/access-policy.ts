/**
 * Per-agent access policy — who may drive a paired agent, and what a
 * non-permitted questioner hears instead of silence.
 *
 * The policy is set by the inviter at pairing time and enforced by the daemon:
 * before an agent replies to an addressed Room/DM message it checks the message
 * *sender pubkey* against the policy. The check is fail-closed — an unknown or
 * unmatched sender is treated as NOT permitted.
 *
 * `creator` is the primary cost/safety lever: only the inviting owner may
 * address the agent, so no one else spends the operator's subscription or
 * triggers the owner's commands. It is also the default for newly paired
 * agents (see DEFAULT_ACCESS_POLICY below). `allowlist` is the explicit
 * delegation policy: only the configured identities may assign work. The
 * creator is not implicitly included; authority is exactly the stored list.
 */

export type AgentAccessPolicy = 'everyone' | 'creator' | 'allowlist';

/** Every access policy this build understands. */
export const AGENT_ACCESS_POLICIES = ['everyone', 'creator', 'allowlist'] as const;
export const MAX_ACCESS_ALLOWLIST_ENTRIES = 64;

/**
 * Default for a NEWLY PAIRED agent: only the inviting owner may address it,
 * so no other Room member can spend the operator's subscription or trigger
 * the owner's commands. The inviter opts out explicitly by choosing
 * `everyone` at pairing (`--access everyone` / the pairing prompt).
 *
 * This constant must NOT be used as a read-time fallback for a runtime record
 * carrying no policy: every pre-policy pairing ran as `everyone`, and falling
 * back to this constant would silently re-gate those agents. Read-time
 * fallbacks use LEGACY_ACCESS_POLICY instead, and the one-time migration in
 * `runtime.ts` (`migrateRuntimeRecordAccessPolicy`) stamps an explicit policy
 * onto pre-existing records so they stop depending on any constant at all.
 */
export const DEFAULT_ACCESS_POLICY: AgentAccessPolicy = 'creator';

/**
 * The frozen pre-policy behaviour: `everyone`. Every agent paired before
 * per-agent access policies shipped has been running with no gating, and an
 * already-paired agent must keep answering exactly the senders it answered
 * before. Used by the one-time record migration and by read-time fallbacks
 * for records that carry no explicit policy — never for a new pairing.
 */
export const LEGACY_ACCESS_POLICY: AgentAccessPolicy = 'everyone';

export function isAgentAccessPolicy(value: unknown): value is AgentAccessPolicy {
  return (AGENT_ACCESS_POLICIES as readonly string[]).includes(value as string);
}

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
