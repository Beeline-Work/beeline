/**
 * The relay's authoritative, terminal verdict that a channel is archived.
 *
 * Observed verbatim as a Room-serving failure, as a corner-session state
 * publish after a landed corner was archived, and as a Room-delete failure:
 * `publishEvent kind=9002 failed: HTTP 400 {"error":"invalid: channel is archived"}`.
 * A signed event has a stable id and an archived channel accepts no writes,
 * so re-sending can only produce the identical refusal — this is a fact about
 * the channel, not a transient transport condition, and it must never be
 * retried on a loop or reported as an unexpected error.
 *
 * Canonical home for the classifier (shared by every `@beeline/buzz-client`
 * consumer). `apps/body/src/archived-channel.ts` re-exports it for Body's
 * Room-quarantine and corner-archive paths.
 */
import { asRelayPublishError } from './relay-error.js';

export function isArchivedChannelError(error: unknown): boolean {
  return asRelayPublishError(error).kind === 'ROOM_ARCHIVED';
}
