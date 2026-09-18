import { describe, expect, it } from 'vitest';
import {
  connectorOfferActionLabel,
  connectorOfferOutcomeLine,
  connectorOfferTitle,
  connectorOfferWaitingLine,
} from './connector-offer-copy';

describe('connector-offer copy (R5)', () => {
  const zeke = { pubkey: 'zeke', kind: 'human' as const, name: 'Zeke Adams', handle: 'zeke' };

  it('asks one question and offers one action with the check glyph', () => {
    expect(connectorOfferTitle('Trusty Squire')).toBe('Add Trusty Squire as a tool?');
    expect(connectorOfferActionLabel('Trusty Squire')).toBe('✓ Add Trusty Squire');
  });

  it('names the actor by handle on the settled record, and nothing while the offer is open', () => {
    expect(connectorOfferOutcomeLine({ status: 'pending' })).toBeNull();
    expect(
      connectorOfferOutcomeLine({ status: 'accepted', acceptedBy: zeke, acceptedAt: 1_756_900_060 }),
    ).toMatch(/^added by @zeke · \d{1,2}:\d{2}/);
    // A handle is an address and unique; a display name is neither. Only a
    // person with no handle at all is named by their name.
    expect(
      connectorOfferOutcomeLine({
        status: 'accepted',
        acceptedBy: { pubkey: 'x', kind: 'human', name: 'Nameless' },
      }),
    ).toBe('added by Nameless');
  });

  it('tells a reader who cannot act whom the card waits for', () => {
    expect(connectorOfferWaitingLine({ addressee: zeke })).toBe('waiting for @zeke');
  });
});
