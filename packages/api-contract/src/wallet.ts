/**
 * Wallet connector — the Coinbase CDP Embedded Wallet vocabulary.
 *
 * ONE app-wide Coinbase credential lives in the Beeline server's own secrets;
 * no end user ever provisions a key and nothing here ever touches a Trusty
 * Squire vault (captain invariant, 2026-09). A wallet belongs to the HUMAN who
 * created it (one binding per identity); agents spend it through the seven
 * session tools, scoped to their owner's wallet. The balance IS the limit:
 * the only refusal is insufficient funds. No caps, no policy engine, no
 * signature ceremony.
 *
 * Chains are a PER-TRANSACTION argument, never a wallet property. Base gas is
 * sponsored by CDP's paymaster under a free monthly allowance; every other
 * chain costs the wallet its own gas, which is why every chain view carries a
 * fee.
 */

export const WALLET_CHAIN_IDS = [
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'zora',
  'bnb',
  'avalanche',
  'ethereum',
] as const;
export type WalletChainId = (typeof WALLET_CHAIN_IDS)[number];

export function isWalletChainId(value: unknown): value is WalletChainId {
  return typeof value === 'string' && (WALLET_CHAIN_IDS as readonly string[]).includes(value);
}

export const WALLET_CHAIN_NAMES: Record<WalletChainId, string> = {
  base: 'Base',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  polygon: 'Polygon',
  zora: 'Zora',
  bnb: 'BNB Chain',
  avalanche: 'Avalanche',
  ethereum: 'Ethereum',
};

/** Human name for an asset symbol; unknown symbols pass through verbatim. */
export function walletAssetName(symbol: string): string {
  const names: Record<string, string> = {
    usdc: 'USD Coin',
    eth: 'Ethereum',
    cbbtc: 'Coinbase BTC',
    btc: 'Bitcoin',
    sol: 'Solana',
  };
  return names[symbol.toLowerCase()] ?? symbol.toUpperCase();
}

/** The chain receipt link shown on ledger lines and returned by wallet_pay. */
export function walletExplorerTxUrl(chain: WalletChainId, txId: string): string {
  const hosts: Record<WalletChainId, string> = {
    base: 'https://basescan.org/tx/',
    arbitrum: 'https://arbiscan.io/tx/',
    optimism: 'https://optimistic.etherscan.io/tx/',
    polygon: 'https://polygonscan.com/tx/',
    zora: 'https://explorer.zora.energy/tx/',
    bnb: 'https://bscscan.com/tx/',
    avalanche: 'https://snowtrace.io/tx/',
    ethereum: 'https://etherscan.io/tx/',
  };
  return `${hosts[chain]}${txId}`;
}

export type WalletCoinView = {
  readonly symbol: string;
  readonly name: string;
  /** The chain this holding lives on. Optional: the server's balance read
   *  does not yet attribute holdings to chains, so the wallet dashboard
   *  renders the chain badge only when the source supplies it. */
  readonly chain?: WalletChainId;
  /** Human-readable decimal amount, e.g. "392.60". */
  readonly amount: string;
  /** Human-readable USD value of the holding, e.g. "$392.60". */
  readonly usd: string;
};

export type WalletChainView = {
  readonly id: WalletChainId;
  readonly name: string;
  /** Estimated send fee, human-readable; `null` when the chain sponsors it. */
  readonly feeUsd: string | null;
  readonly sponsored: boolean;
  /** True when the wallet holds anything on this chain (picker grays it off). */
  readonly hasBalance: boolean;
};

/** CDP paymaster gas sponsorship: a free monthly allowance, then Beeline pays. */
export type WalletSponsorshipView = {
  readonly usedUsd: string;
  readonly limitUsd: string;
};

export type WalletView = {
  /** The EOA — identical on every EVM chain by definition, so the receive
   *  screen can promise one address across chains. */
  readonly address: string;
  /** Solana is a SEPARATE account attached to the same CDP user, never
   *  another chain on the same address. Created on demand. */
  readonly solanaAddress: string | null;
  readonly totalUsd: string;
  readonly coins: readonly WalletCoinView[];
  readonly chains: readonly WalletChainView[];
  readonly sponsorship: WalletSponsorshipView | null;
  /** DELEGATED SIGNING grant (docs.cdp.coinbase.com/wallets/using-wallets/
   *  delegated-signing): the user grants it while present; the backend then
   *  signs with the CDP key pair without a user session. One user-scoped
   *  delegation is active at a time and it expires (24h default) — an
   *  expired one is a clear "your agents need permission again" state on
   *  the wallet screen, never a silent agent failure. */
  readonly delegation: WalletDelegationView;
};

export type WalletDelegationView = {
  readonly active: boolean;
  /** Absolute Unix ms; meaningful only when `active`. */
  readonly expiresAt: number | null;
};

export type GrantWalletDelegationInput = { readonly workspaceId: string };
export type GrantWalletDelegationResult = {
  readonly expiresAt: number;
};

export type WalletSendInput = {
  readonly chain: WalletChainId;
  /** Asset symbol, e.g. "usdc". */
  readonly asset: string;
  /** Human-readable decimal amount, e.g. "120.00". */
  readonly amount: string;
  readonly to: string;
};

export type WalletSendResult = {
  readonly outcome: 'sent';
  readonly txUrl: string;
  /** "−120.00 USDC" style amount text as written to the ledger. */
  readonly amountText: string;
  /** Balance remaining after the send, human-readable USD. */
  readonly balanceAfterUsd: string;
};

export type WalletInsufficient = {
  readonly outcome: 'insufficient';
  readonly asset: string;
  readonly needed: string;
  readonly available: string;
};


/** The named non-silent refusal when the signing grant has lapsed. */
export type WalletDelegationExpired = {
  readonly outcome: 'delegation-expired';
};

/** A source-level refusal (e.g. the chain rejected the send) is a named failure. */
export type WalletFailed = {
  readonly outcome: 'failed';
  readonly reason: string;
};

export type WalletSendOutcome =
  | WalletSendResult
  | WalletInsufficient
  | WalletDelegationExpired
  | WalletFailed;

/** One ledger line: every transaction, in AND out, with what it left behind. */
export type WalletLedgerEntry = {
  readonly direction: 'in' | 'out';
  /** Outbound lines name the agent that spent; inbound is "Received". */
  readonly agentName: string | null;
  readonly amountText: string;
  readonly counterparty: string;
  readonly chain: WalletChainId;
  readonly balanceAfterUsd: string;
  readonly txUrl: string | null;
  readonly createdAt: number;
};

// --- Phone operations (the human's screens) -------------------------------------

export type WalletWorkspaceInput = { readonly workspaceId: string };
export type ReadWalletInput = WalletWorkspaceInput;
export type CreateWalletInput = WalletWorkspaceInput;
export type SendFromWalletInput = WalletWorkspaceInput & WalletSendInput;

export type ReadWalletHistoryInput = WalletWorkspaceInput & {
  /** Max entries returned, 1–100, default 20. */
  readonly limit?: number;
};
export type WalletHistoryResult = {
  readonly entries: readonly WalletLedgerEntry[];
};

// --- Daemon operations (the agent's tools) ---------------------------------------

export type WalletToolState = {
  /** The agent's connected owner's identity id; null for ownerless agents. */
  readonly ownerIdentityId: string | null;
  readonly wallet: { readonly address: string; readonly solanaAddress: string | null } | null;
};
export type WalletToolStateInput = { readonly agentId: string };

export type WalletToolBalanceInput = { readonly agentId: string; readonly chain?: WalletChainId };
export type WalletToolBalanceResult = {
  readonly totalUsd: string;
  readonly coins: readonly WalletCoinView[];
};

export type WalletToolChainsInput = { readonly agentId: string };
export type WalletToolChainsResult = { readonly chains: readonly WalletChainView[] };

export type WalletToolHistoryInput = { readonly agentId: string; readonly limit?: number };
export type WalletToolHistoryResult = { readonly entries: readonly WalletLedgerEntry[] };

export type WalletToolQuoteInput = {
  readonly agentId: string;
  readonly chain: WalletChainId;
  readonly asset: string;
  readonly amount: string;
};
export type WalletToolQuoteResult = {
  readonly feeUsd: string | null;
  readonly sponsored: boolean;
  readonly sufficient: boolean;
  readonly available: string;
  readonly asset: string;
};

export type WalletPayInput = WalletSendInput & { readonly agentId: string };
export type WalletSwapInput = {
  readonly agentId: string;
  readonly fromAsset: string;
  readonly toAsset: string;
  readonly amount: string;
  readonly chain?: WalletChainId;
};

export type WalletSwapResult = {
  readonly outcome: 'sent';
  readonly txUrl: string;
  readonly fromAmountText: string;
  readonly toAmountText: string;
  readonly balanceAfterUsd: string;
} | WalletInsufficient | WalletDelegationExpired;
