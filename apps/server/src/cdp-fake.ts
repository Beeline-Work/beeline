/**
 * The fake wallet source: every test and every unconfigured server runs on
 * this. Isolated per instance (call `fakeCdpWalletSource()` fresh per test),
 * never touches the network, and invents NO credential — a test that wants
 * "the real Coinbase" must inject a stub, not read a key.
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

type FakeAccount = { userId: string; eoa: string; solana: string | null };
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
  accounts: Map<string, FakeAccount>;
  holdings: Map<string, Map<string, number>>; // userId -> symbol -> units
  prices: Map<string, number>; // symbol -> USD per unit
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

  const holdingsFor = (userId: string): Map<string, number> => {
    let holdings = state.holdings.get(userId);
    if (!holdings) {
      holdings = new Map([['usdc', 0], ['eth', 0]]);
      state.holdings.set(userId, holdings);
    }
    return holdings;
  };

  const unitPrice = (symbol: string): number =>
    state.prices.get(symbol.toLowerCase()) ?? 1;

  const record = (userId: string, tx: FakeTx): void => {
    let list = state.transactions.get(userId);
    if (!list) {
      list = [];
      state.transactions.set(userId, list);
    }
    list.push(tx);
  };

  return {
    state,
    async createUser() {
      return { userId: `fake-user-${randomUUID()}` };
    },
    async getOrCreateEvmAccount(userId: string) {
      let account = state.accounts.get(userId);
      if (!account) {
        account = {
          userId,
          eoa: `0x${randomUUID().replaceAll('-', '').slice(0, 40)}`,
          solana: null,
        };
        state.accounts.set(userId, account);
      }
      return { address: account.eoa };
    },
    async getOrCreateSolanaAccount(userId: string) {
      let account = state.accounts.get(userId);
      if (!account) {
        account = {
          userId,
          eoa: `0x${randomUUID().replaceAll('-', '').slice(0, 40)}`,
          solana: null,
        };
        state.accounts.set(userId, account);
      }
      if (!account.solana) account.solana = `Sol${randomUUID().replaceAll('-', '').slice(0, 40)}`;
      return { address: account.solana };
    },
    async balances(userId: string): Promise<WalletCoinView[]> {
      return [...holdingsFor(userId).entries()]
        .filter(([, units]) => units > 0 || ['usdc', 'eth'].includes(userId === '' ? '' : holdingsFor(userId).size ? '' : 'usdc'))
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
    async sendTransaction(userId: string, input: WalletSendInput) {
      const holdings = holdingsFor(userId);
      const symbol = input.asset.toLowerCase();
      const available = holdings.get(symbol) ?? 0;
      const needed = Number(input.amount);
      if (Number.isNaN(needed) || needed <= 0 || needed > available) {
        throw new FakeInsufficientFundsError(needed, available, symbol);
      }
      holdings.set(symbol, available - needed);
      const txId = `fake-tx-${randomUUID()}`;
      record(userId, {
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
    async swap(userId: string, input: { fromAsset: string; toAsset: string; amount: string }) {
      const holdings = holdingsFor(userId);
      const from = input.fromAsset.toLowerCase();
      const to = input.toAsset.toLowerCase();
      const available = holdings.get(from) ?? 0;
      const needed = Number(input.amount);
      if (Number.isNaN(needed) || needed <= 0 || needed > available) {
        throw new FakeInsufficientFundsError(needed, available, from);
      }
      const toAmount = ((needed * unitPrice(from)) / unitPrice(to)) * 0.995; // 0.5% fee
      holdings.set(from, available - needed);
      holdings.set(to, (holdings.get(to) ?? 0) + toAmount);
      const txId = `fake-swap-${randomUUID()}`;
      record(userId, {
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
    async history(userId: string, limit: number): Promise<WalletLedgerEntry[]> {
      return (state.transactions.get(userId) ?? [])
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
