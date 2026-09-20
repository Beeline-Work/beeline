import type { ConnectorOfferCardView } from '@beeline/api-contract/phone';

/**
 * The words on a connector-offer card (R5). The server owns the one
 * consequence + boundary line (`ConnectorOfferCardView.consequence`) and the
 * agent's reason; the phone only composes the title question, the one action
 * word, and the settled record — which names WHO acted, because a Beeline Room
 * has many possible tappers where Grok's reference had one.
 */

/** `Add Trusty Squire as a tool?` — a question with one affirmative answer. */
export function connectorOfferTitle(connectorName: string): string {
  return `Add ${connectorName} as a tool?`;
}

/** `✓ Add Trusty Squire` — the one action, with the check glyph the captain photographed. */
export function connectorOfferActionLabel(connectorName: string): string {
  return `✓ Add ${connectorName}`;
}

function clock(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `added by @zeke · 12:04` — the settled record; null while the offer is open. */
export function connectorOfferOutcomeLine(
  offer: Pick<ConnectorOfferCardView, 'status' | 'acceptedBy' | 'acceptedAt'>,
): string | null {
  if (offer.status !== 'accepted') return null;
  const who = offer.acceptedBy?.handle
    ? `@${offer.acceptedBy.handle.replace(/^@/, '')}`
    : (offer.acceptedBy?.name ?? 'someone');
  const stamp = offer.acceptedAt !== undefined ? ` · ${clock(offer.acceptedAt)}` : '';
  return `added by ${who}${stamp}`;
}

/** `connecting for @zeke` — the accepted offer whose sign-in is not complete yet. */
export function connectorOfferConnectingLine(
  offer: Pick<ConnectorOfferCardView, 'status' | 'acceptedBy'>,
): string | null {
  if (offer.status !== 'connecting') return null;
  const who = offer.acceptedBy?.handle
    ? `@${offer.acceptedBy.handle.replace(/^@/, '')}`
    : (offer.acceptedBy?.name ?? 'someone');
  return `connecting for ${who}`;
}

/** `waiting for @zeke` — what a reader who cannot act sees under an open offer. */
export function connectorOfferWaitingLine(
  offer: Pick<ConnectorOfferCardView, 'addressee'>,
): string {
  const who = offer.addressee.handle
    ? `@${offer.addressee.handle.replace(/^@/, '')}`
    : offer.addressee.name;
  return `waiting for ${who}`;
}
