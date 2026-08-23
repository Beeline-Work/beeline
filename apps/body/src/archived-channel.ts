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
 * Canonical home for the classifier. `supervisor.ts` re-exports it for its
 * Room-quarantine path; `body.ts` consumes it directly (supervisor imports
 * body, so body cannot import supervisor without a cycle).
 */
export function isArchivedChannelError(error: unknown): boolean {
  return /channel is archived/i.test(error instanceof Error ? error.message : String(error));
}
