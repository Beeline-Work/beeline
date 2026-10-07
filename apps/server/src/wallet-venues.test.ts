import { describe, expect, it } from 'vitest';
import { venueRefusal, type WalletVenueRule } from './wallet-venues.js';

const BRIDGE2 = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';

describe('venue rules', () => {
  it('refuses Hyperliquid Bridge2 deposits under 5 USDC or in another asset', () => {
    const to = BRIDGE2.toLowerCase();
    expect(venueRefusal({ chain: 'arbitrum', asset: 'usdc', amount: '4.99', to })).toBe(
      'Hyperliquid Bridge2 deposits must be at least 5 USDC; a smaller deposit is never credited and is lost',
    );
    expect(venueRefusal({ chain: 'arbitrum', asset: 'ETH', amount: '1', to })).toBe(
      'Hyperliquid Bridge2 credits only USDC; ETH sent there is lost',
    );
    expect(venueRefusal({ chain: 'arbitrum', asset: 'usdc', amount: '5', to })).toBeNull();
    // The same address on another chain is not the venue.
    expect(venueRefusal({ chain: 'base', asset: 'usdc', amount: '1', to })).toBeNull();
  });

  it('applies a new venue from one table entry', () => {
    const rules: WalletVenueRule[] = [
      { venue: 'Example', chain: 'base', address: '0x' + '9'.repeat(40), asset: 'usdc', minimum: '10', source: 'test' },
    ];
    expect(venueRefusal({ chain: 'base', asset: 'usdc', amount: '9', to: '0x' + '9'.repeat(40) }, rules)).toContain(
      'Example deposits must be at least 10 USDC',
    );
  });
});
