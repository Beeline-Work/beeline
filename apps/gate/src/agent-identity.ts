/** Gate-side lookup for the durable, self-signed agent identity marker. */
import { KIND_STREAM_MESSAGE, TAG_AGENT, hasAgentIdentityMarker } from '@beeline/buzz-client';
import { queryEvents } from './relay.js';

/**
 * True when `pubkey` has self-signed a valid first-class agent record.
 * This classification is independent of channel roles and cannot be overridden
 * by granting the agent admin/owner or configuring it as trustedReviewer.
 */
export async function isRegisteredAgentIdentity(pubkey: string, queryAs: string): Promise<boolean> {
  const events = await queryEvents(
    [
      {
        kinds: [KIND_STREAM_MESSAGE],
        authors: [pubkey],
        '#t': [TAG_AGENT],
        limit: 50,
      },
    ],
    queryAs,
  );
  return events.some((event) => event.pubkey === pubkey && hasAgentIdentityMarker(event));
}
