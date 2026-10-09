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

/** `Sign in to Google again` — a `'reconnect'` offer asks nothing; it names
 *  what stalled. `provider` is Squire's own value (e.g. `'google'`), omitted
 *  for an `oauth_sign_in` wall, where Squire names no provider. */
export function connectorOfferReconnectTitle(provider?: string): string {
  if (!provider) return 'Sign in again';
  return `Sign in to ${provider[0]!.toUpperCase()}${provider.slice(1)} again`;
}

/** `Switch Trusty Squire's Google account?` — a `'switch'` offer asks to
 *  replace the account an already-connected tool is signed in with. */
export function connectorOfferSwitchTitle(connectorName: string, provider = 'google'): string {
  return `Switch ${connectorName}'s ${provider[0]!.toUpperCase()}${provider.slice(1)} account?`;
}

/** `✓ Switch account` — the one action on a `'switch'` offer. */
export const CONNECTOR_OFFER_SWITCH_ACTION = '✓ Switch account';

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

/** `added by @zeke · 12:04` (`switched by` for a `'switch'` offer) — the
 *  settled record; null while the offer is open. */
export function connectorOfferOutcomeLine(
  offer: Pick<ConnectorOfferCardView, 'status' | 'acceptedBy' | 'acceptedAt' | 'intent'>,
): string | null {
  if (offer.status !== 'accepted') return null;
  const who = offer.acceptedBy?.handle
    ? `@${offer.acceptedBy.handle.replace(/^@/, '')}`
    : (offer.acceptedBy?.name ?? 'someone');
  const stamp = offer.acceptedAt !== undefined ? ` · ${clock(offer.acceptedAt)}` : '';
  return `${offer.intent === 'switch' ? 'switched' : 'added'} by ${who}${stamp}`;
}

/** `connecting for @zeke` (`switching for` for a `'switch'` offer) — the
 *  accepted offer whose sign-in is not complete yet. */
export function connectorOfferConnectingLine(
  offer: Pick<ConnectorOfferCardView, 'status' | 'acceptedBy' | 'intent'>,
): string | null {
  if (offer.status !== 'connecting') return null;
  const who = offer.acceptedBy?.handle
    ? `@${offer.acceptedBy.handle.replace(/^@/, '')}`
    : (offer.acceptedBy?.name ?? 'someone');
  return `${offer.intent === 'switch' ? 'switching' : 'connecting'} for ${who}`;
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
