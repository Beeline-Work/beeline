/**
 * Per-venue deposit rules, checked on every wallet send and contract call
 * (`wallet_pay` and `wallet_contract_call`). A venue that credits deposits
 * sent to a fixed address can lose funds it does not accept; a rule here
 * refuses such a transfer before it is made. Adding a venue is one entry.
 */
import type { WalletChainId } from '@beeline/api-contract/wallet';

export type WalletVenueRule = {
  readonly venue: string;
  readonly chain: WalletChainId;
  /** The address that receives deposits on `chain`. */
  readonly address: string;
  /** The only asset the venue credits; any other asset sent there is lost. */
  readonly asset: string;
  /** The smallest amount credited, in `asset`; a smaller deposit is lost. */
  readonly minimum: string;
  /** Where the facts come from. */
  readonly source: string;
};

export const WALLET_VENUE_RULES: readonly WalletVenueRule[] = [
  {
    venue: 'Hyperliquid Bridge2',
    chain: 'arbitrum',
    address: '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7',
    asset: 'usdc',
    minimum: '5',
    source: 'Hyperliquid docs, USDC > Legacy Bridge',
  },
];

export type WalletTransfer = {
  readonly chain: WalletChainId;
  readonly asset: string;
  readonly amount: string;
  readonly to: string;
};

/** Why a venue would never credit this transfer, or null when no rule refuses it. */
export function venueRefusal(
  transfer: WalletTransfer,
  rules: readonly WalletVenueRule[] = WALLET_VENUE_RULES,
): string | null {
  const rule = rules.find(
    (entry) =>
      entry.chain === transfer.chain && entry.address.toLowerCase() === transfer.to.toLowerCase(),
  );
  if (!rule) return null;
  const asset = rule.asset.toUpperCase();
  if (transfer.asset.toLowerCase() !== rule.asset)
    return `${rule.venue} credits only ${asset}; ${transfer.asset.toUpperCase()} sent there is lost`;
  if (!(Number(transfer.amount) >= Number(rule.minimum)))
    return `${rule.venue} deposits must be at least ${rule.minimum} ${asset}; a smaller deposit is never credited and is lost`;
  return null;
}
