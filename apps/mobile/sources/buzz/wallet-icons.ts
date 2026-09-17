import type { WalletChainId } from '@beeline/api-contract/wallet';
import chainArbitrum from '@/assets/images/wallet/chain-arbitrum.png';
import chainAvalanche from '@/assets/images/wallet/chain-avalanche.png';
import chainBase from '@/assets/images/wallet/chain-base.png';
import chainBinance from '@/assets/images/wallet/chain-binance.png';
import chainEthereum from '@/assets/images/wallet/chain-ethereum.png';
import chainOptimism from '@/assets/images/wallet/chain-optimism.png';
import chainPolygon from '@/assets/images/wallet/chain-polygon.png';
import chainZora from '@/assets/images/wallet/chain-zora.png';
import tokenBtc from '@/assets/images/wallet/token-cbbtc.png';
import tokenEth from '@/assets/images/wallet/token-eth.png';
import tokenSol from '@/assets/images/wallet/token-sol.png';
import tokenUsdc from '@/assets/images/wallet/token-usdc.png';

/**
 * Real brand marks for the wallet surfaces, one static import per asset so
 * Metro bundles them. Sources (public icon sets, committed under
 * `assets/images/wallet/`):
 *
 *  - Chain logos: Trustwallet `assets` blockchains logos (base, arbitrum,
 *    optimism, polygon, binance, ethereum, solana), DefiLlama chain icons
 *    (zora), cryptocurrency-icons (avalanche).
 *  - Token icons: spothq `cryptocurrency-icons` (usdc, eth, btc — the cbBTC
 *    mark rides the Bitcoin glyph, as Coinbase Wallet itself does — and sol).
 *
 * An unknown symbol or chain id resolves to `undefined` and the caller
 * renders a monogram tile — never a broken image.
 */
const CHAIN_ICONS: Record<WalletChainId, number> = {
  base: chainBase,
  arbitrum: chainArbitrum,
  optimism: chainOptimism,
  polygon: chainPolygon,
  zora: chainZora,
  bnb: chainBinance,
  avalanche: chainAvalanche,
  ethereum: chainEthereum,
};

const TOKEN_ICONS: Record<string, number> = {
  usdc: tokenUsdc,
  eth: tokenEth,
  cbbtc: tokenBtc,
  btc: tokenBtc,
  sol: tokenSol,
};

/** Bundled asset for a chain id, or undefined when we carry no mark for it. */
export function chainIcon(chain: WalletChainId): number | undefined {
  return CHAIN_ICONS[chain];
}

/** Bundled asset for a token symbol (case-insensitive), or undefined. */
export function tokenIcon(symbol: string): number | undefined {
  return TOKEN_ICONS[symbol.toLowerCase()];
}
