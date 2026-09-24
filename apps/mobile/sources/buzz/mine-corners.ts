import type { CornerListItem } from '@beeline/buzz-client';

/**
 * The corners page's "Mine" section: corners the viewer commissioned, plus any
 * corner waiting on the viewer. `commissioned_by` only ever records a human,
 * the author of the message that started the work (the person who said "go").
 */
export function isMineCorner(
  item: Pick<CornerListItem, 'initiator' | 'awaitsViewer'>,
  viewerPubkey: string | undefined,
): boolean {
  return item.awaitsViewer === true || (!!viewerPubkey && item.initiator?.pubkey === viewerPubkey);
}
