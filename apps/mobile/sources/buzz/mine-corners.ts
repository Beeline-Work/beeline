import type { CornerListItem } from '@beeline/buzz-client';

/**
 * The corners page's "Mine" section: corners the viewer follows, the same rule
 * as push's Followed level (opened, requested, posted, steered or tagged), plus
 * any corner waiting on the viewer. `commissioned_by` only ever records a
 * human, the author of the message that started the work.
 */
export function isMineCorner(
  item: Pick<CornerListItem, 'initiator' | 'awaitsViewer' | 'followsViewer'>,
  viewerPubkey: string | undefined,
): boolean {
  return (
    item.followsViewer === true ||
    item.awaitsViewer === true ||
    (!!viewerPubkey && item.initiator?.pubkey === viewerPubkey)
  );
}
