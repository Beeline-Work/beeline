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
 * triggers the owner's commands. `allowlist` is intentionally reserved here so
 * a future explicit-pubkey mode lands without a runtime-record migration.
 */

export type AgentAccessPolicy = 'everyone' | 'creator';

/** Every access policy this build understands. `allowlist` is reserved (see above). */
export const AGENT_ACCESS_POLICIES = ['everyone', 'creator'] as const;

/**
 * Default when a runtime record carries no policy (every pre-policy pairing,
 * and the deliberate "no gating, current behaviour" choice). `everyone`
 * preserves the shipped behaviour where any Room member may @-mention the
 * agent; opting into `creator` is what adds the boundary.
 */
export const DEFAULT_ACCESS_POLICY: AgentAccessPolicy = 'everyone';

export function isAgentAccessPolicy(value: unknown): value is AgentAccessPolicy {
  return (AGENT_ACCESS_POLICIES as readonly string[]).includes(value as string);
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
): boolean {
  if (!senderPubkey) return false;
  switch (policy) {
    case 'everyone':
      return true;
    case 'creator':
      return Boolean(ownerPubkey) && senderPubkey === ownerPubkey;
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
