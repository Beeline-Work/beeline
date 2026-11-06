import type { ConnectorOfferCardView } from '@beeline/api-contract/phone';

function clock(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
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
