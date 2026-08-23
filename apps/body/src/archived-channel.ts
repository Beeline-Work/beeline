/**
 * The relay's authoritative, terminal verdict that a channel is archived.
 *
 * Observed verbatim as a Room-serving failure and as a corner-session state
 * publish after a landed corner was archived:
 * `publishEvent kind=9 failed: HTTP 400 {"error":"invalid: channel is archived"}`.
 * A signed event has a stable id and an archived channel accepts no writes,
 * so re-sending can only produce the identical refusal — this is a fact about
 * the channel, not a transient transport condition, and it must never be
 * retried on a loop or reported as an unexpected error.
 *
 * The implementation lives in `@beeline/buzz-client` (`archived-channel.ts`)
 * so client-side Room delete/leave paths share the exact same classifier;
 * this module re-exports it for Body's internal consumers. `supervisor.ts`
 * re-exports it for its Room-quarantine path; `body.ts` consumes it directly
 * (supervisor imports body, so body cannot import supervisor without a cycle).
 */
export { isArchivedChannelError } from '@beeline/buzz-client';
