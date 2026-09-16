import type {
  WalletChainId,
  WalletHistoryResult,
  WalletLedgerEntry,
  WalletSendOutcome,
  WalletView,
} from '@beeline/api-contract/wallet';
import type { WalletSource } from './wallet-source';

/**
 * The mock wallet: a fixed paint-ready projection, the twin of the server's
 * own shapes (never a fake protocol). Tests mutate only through the same
 * operations the screens call.
 */
const MOCK_WALLET: WalletView = {
  address: '0x8f2c41B9Ea52d3aB7f0cCd4911E6D6b7B0a19d77',
  solanaAddress: null,
  totalUsd: '$412.60',
  coins: [
    { symbol: 'USDC', name: 'USD Coin', amount: '392.60', usd: '$392.60', chain: 'base' },
    { symbol: 'ETH', name: 'Ethereum', amount: '0.0061', usd: '$18.00', chain: 'base' },
    { symbol: 'cbBTC', name: 'Coinbase BTC', amount: '0.00002', usd: '$2.00', chain: 'base' },
  ],
  chains: [
    { id: 'base', name: 'Base', feeUsd: null, sponsored: true, hasBalance: true },
    { id: 'arbitrum', name: 'Arbitrum', feeUsd: '$0.01', sponsored: false, hasBalance: true },
    { id: 'optimism', name: 'Optimism', feeUsd: '$0.01', sponsored: false, hasBalance: true },
    { id: 'polygon', name: 'Polygon', feeUsd: '$0.02', sponsored: false, hasBalance: true },
    { id: 'ethereum', name: 'Ethereum', feeUsd: '$1.40', sponsored: false, hasBalance: true },
    { id: 'avalanche', name: 'Avalanche', feeUsd: '$0.03', sponsored: false, hasBalance: false },
  ],
  sponsorship: { usedUsd: '$0.42', limitUsd: '$5.00' },
  delegation: { active: true, expiresAt: Date.now() + 24 * 3_600_000 },
};

export class MockWalletSource implements WalletSource {
  private wallet: WalletView = {
    ...MOCK_WALLET,
    chains: [...MOCK_WALLET.chains],
    coins: [...MOCK_WALLET.coins],
  };

  async createWallet(): Promise<WalletView> {
    this.wallet = { ...this.wallet };
    return this.wallet;
  }

  async readWallet(): Promise<WalletView> {
    return this.wallet;
  }

  async sendFromWallet(input: {
    chain: WalletChainId;
    asset: string;
    amount: string;
    to: string;
  }): Promise<WalletSendOutcome> {
    const coin = this.wallet.coins.find(
      (candidate) => candidate.symbol.toLowerCase() === input.asset.toLowerCase(),
    );
    const amount = Number(input.amount);
    if (!coin || Number(coin.amount) < amount) {
      return {
        outcome: 'insufficient',
        needed: input.amount,
        available: coin?.amount ?? '0',
        asset: input.asset,
      };
    }
    this.wallet = {
      ...this.wallet,
      coins: this.wallet.coins.map((candidate) =>
        candidate === coin
          ? { ...candidate, amount: String(Number(candidate.amount) - amount) }
          : candidate,
      ),
    };
    return {
      outcome: 'sent',
      txUrl: 'https://basescan.org/tx/0xmock',
      amountText: `-${input.amount} ${input.asset.toUpperCase()}`,
      balanceAfterUsd: this.wallet.totalUsd,
    };
  }

  async grantDelegation(): Promise<{ expiresAt: number }> {
    const expiresAt = Date.now() + 24 * 3_600_000;
    this.wallet = { ...this.wallet, delegation: { active: true, expiresAt } };
    return { expiresAt };
  }

  async readHistory(): Promise<WalletHistoryResult> {
    return { entries: this.history };
  }

  /** The mock ledger: a settled, paint-ready feed the mock send appends to. */
  private history: WalletLedgerEntry[] = [
    {
      direction: 'in',
      agentName: null,
      amountText: '+392.60 USDC',
      counterparty: '0x4d17…9c02',
      chain: 'base',
      balanceAfterUsd: '$412.60',
      txUrl: 'https://basescan.org/tx/0xmock-in',
      createdAt: Date.now() - 3 * 3_600_000,
    },
    {
      direction: 'out',
      agentName: '@hoots',
      amountText: '−12.00 USDC',
      counterparty: '0x8f2c…9d77',
      chain: 'base',
      balanceAfterUsd: '$400.60',
      txUrl: 'https://basescan.org/tx/0xmock-out',
      createdAt: Date.now() - 26 * 3_600_000,
    },
  ];
}
