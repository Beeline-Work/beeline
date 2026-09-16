/**
 * The fake wallet source: every test and every unconfigured server runs on
 * this. Isolated per instance (call `fakeCdpWalletSource()` fresh per test),
 * never touches the network, and invents NO credential — a test that wants
 * "the real Coinbase" must inject a stub, not read a key.
 *
 * Updated for server-wallet API (no end-user model): accounts are keyed by
 * their deterministic name, and wallets are identified by address.
 */
import { randomUUID } from 'node:crypto';
import {
  walletExplorerTxUrl,
  type WalletChainId,
  type WalletCoinView,
  type WalletLedgerEntry,
  type WalletSendInput,
} from '@beeline/api-contract/wallet';
import type { CdpWalletSource } from './cdp-client.js';

type FakeAccount = {
  name: string;
  eoaAddress: string | null;
  solanaAddress: string | null;
};
type FakeTx = {
  txId: string;
  direction: 'in' | 'out';
  asset: string;
  amount: string;
  counterparty: string;
  chain: WalletChainId;
  usd: number;
  createdAt: number;
};

export type FakeWalletState = {
  /** Accounts keyed by deterministic name. */
  accounts: Map<string, FakeAccount>;
  /** Holdings keyed by EOA address -> symbol -> units. */
  holdings: Map<string, Map<string, number>>;
  prices: Map<string, number>;
  transactions: Map<string, FakeTx[]>;
};

export function fakeCdpWalletSource(): CdpWalletSource & { readonly state: FakeWalletState } {
  const state: FakeWalletState = {
    accounts: new Map(),
    holdings: new Map(),
    prices: new Map([
      ['usdc', 1],
      ['eth', 3200],
      ['cbbtc', 64000],
      ['sol', 180],
    ]),
    transactions: new Map(),
  };

  const holdingsFor = (address: string): Map<string, number> => {
    let h = state.holdings.get(address);
    if (!h) {
      h = new Map([['usdc', 0], ['eth', 0]]);
      state.holdings.set(address, h);
    }
    return h;
  };

  const unitPrice = (symbol: string): number =>
    state.prices.get(symbol.toLowerCase()) ?? 1;

  const record = (address: string, tx: FakeTx): void => {
    let list = state.transactions.get(address);
    if (!list) {
      list = [];
      state.transactions.set(address, list);
    }
    list.push(tx);
  };

  return {
    state,
    async createEvmAccount(name: string) {
      let account = state.accounts.get(name);
      if (!account) {
        account = {
          name,
          eoaAddress: `0x${randomUUID().replaceAll('-', '').slice(0, 40)}`,
          solanaAddress: null,
        };
        state.accounts.set(name, account);
      }
      if (!account.eoaAddress) {
        account.eoaAddress = `0x${randomUUID().replaceAll('-', '').slice(0, 40)}`;
      }
      return { address: account.eoaAddress };
    },
    async createSolanaAccount(name: string) {
      let account = state.accounts.get(name);
      if (!account) {
        account = {
          name,
          eoaAddress: null,
          solanaAddress: `Sol${randomUUID().replaceAll('-', '').slice(0, 40)}`,
        };
        state.accounts.set(name, account);
      }
      if (!account.solanaAddress) {
        account.solanaAddress = `Sol${randomUUID().replaceAll('-', '').slice(0, 40)}`;
      }
      return { address: account.solanaAddress };
    },
    async balances(network: string, address: string): Promise<WalletCoinView[]> {
      return [...holdingsFor(address).entries()]
        .filter(([, units]) => units > 0)
        .map(([symbol, units]) => ({
          symbol,
          name: symbol === 'usdc' ? 'USD Coin' : symbol.toUpperCase(),
          amount: units.toFixed(2),
          usd: `$${(units * unitPrice(symbol)).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`,
        }));
    },
    async feeEstimate(chain: WalletChainId) {
      if (chain === 'base') return { feeUsd: null, sponsored: true };
      return { feeUsd: 0.42, sponsored: false };
    },
    async sponsorshipAllowance() {
      return { usedUsd: 1.24, limitUsd: 25 };
    },
    async sendTransaction(address: string, input: WalletSendInput) {
      const holdings = holdingsFor(address);
      const symbol = input.asset.toLowerCase();
      const available = holdings.get(symbol) ?? 0;
      const needed = Number(input.amount);
      if (Number.isNaN(needed) || needed <= 0 || needed > available) {
        throw new FakeInsufficientFundsError(needed, available, symbol);
      }
      holdings.set(symbol, available - needed);
      const txId = `fake-tx-${randomUUID()}`;
      record(address, {
        txId,
        direction: 'out',
        asset: symbol,
        amount: input.amount,
        counterparty: input.to,
        chain: input.chain,
        usd: needed * unitPrice(symbol),
        createdAt: Date.now(),
      });
      return { txId };
    },
    async swap(address: string, input: { fromAsset: string; toAsset: string; amount: string }) {
      const holdings = holdingsFor(address);
      const from = input.fromAsset.toLowerCase();
      const to = input.toAsset.toLowerCase();
      const available = holdings.get(from) ?? 0;
      const needed = Number(input.amount);
      if (Number.isNaN(needed) || needed <= 0 || needed > available) {
        throw new FakeInsufficientFundsError(needed, available, from);
      }
      const toAmount = ((needed * unitPrice(from)) / unitPrice(to)) * 0.995;
      holdings.set(from, available - needed);
      holdings.set(to, (holdings.get(to) ?? 0) + toAmount);
      const txId = `fake-swap-${randomUUID()}`;
      record(address, {
        txId,
        direction: 'out',
        asset: from,
        amount: input.amount,
        counterparty: `swap→${to.toUpperCase()}`,
        chain: 'base',
        usd: needed * unitPrice(from),
        createdAt: Date.now(),
      });
      return { txId, toAmount: toAmount.toFixed(6) };
    },
    async history(address: string, limit: number): Promise<WalletLedgerEntry[]> {
      return (state.transactions.get(address) ?? [])
        .slice(-limit)
        .reverse()
        .map((tx) => ({
          direction: tx.direction,
          agentName: null,
          amountText: `${tx.direction === 'in' ? '+' : '−'}${tx.amount} ${tx.asset.toUpperCase()}`,
          counterparty: tx.counterparty,
          chain: tx.chain,
          balanceAfterUsd: `$${tx.usd.toFixed(2)}`,
          txUrl: walletExplorerTxUrl(tx.chain, tx.txId),
          createdAt: tx.createdAt,
        }));
    },
  };
}

export class FakeInsufficientFundsError extends Error {
  constructor(
    readonly needed: number,
    readonly available: number,
    readonly symbol: string,
  ) {
    super(`insufficient funds: requested ${needed} ${symbol.toUpperCase()}, wallet holds ${available}`);
    this.name = 'FakeInsufficientFundsError';
  }
}