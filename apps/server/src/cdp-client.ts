/**
 * The Coinbase CDP seam: ONE interface every wallet call goes through, plus
 * the real client over `api.cdp.coinbase.com`.
 *
 * Credential shape (captain, 2026-09-15): ONE app-wide Ed25519 API key named
 * `beeline-server` (project 6fdaf9eb-9935-49fc-be84-047a324bf275, entity
 * entity_27c4ef32-75d2-5d0d-9f49-6dc532aa964c), vaulted in Trusty Squire and
 * configured as SERVER env — never in code, tests, or a user vault:
 *   COINBASE_CDP_API_KEY_ID       the key id (uuid form from the portal)
 *   COINBASE_CDP_API_KEY_SECRET   the Ed25519 PRIVATE KEY (PEM or base64)
 *   COINBASE_CDP_WALLET_SECRET    the Wallet Secret for signing user ops
 *
 * NON-CUSTODIAL embedded user wallets ONLY: custodial and agentic wallet
 * products are locked behind US/Singapore business verification this UAE
 * entity cannot obtain, so nothing here may depend on them. End users are
 * CDP "users" minted under the app credential; their EVM account IS the EOA
 * the receive screen shows, and their Solana account is a separate account
 * on the same user.
 *
 * CDP auth: an EdDSA (Ed25519) JWT per request, header `kid` = API key id,
 * `nonce` = random uuid, claims {sub, iss, aud, nbf, exp, uris}. Signed with
 * the private key. The Wallet Secret rides the `X-Wallet-Auth` header on
 * wallet-scoped calls.
 */
import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import {
  walletAssetName,
  walletExplorerTxUrl,
  type WalletChainId,
  type WalletCoinView,
  type WalletLedgerEntry,
  type WalletSendInput,
} from '@beeline/api-contract/wallet';

/** Everything the wallet module needs from Coinbase, and nothing else. */
export interface CdpWalletSource {
  /** Mint one end user under the app credential. */
  createUser(): Promise<{ userId: string }>;
  /** The user's EVM account — the EOA, identical on every EVM chain. */
  getOrCreateEvmAccount(userId: string): Promise<{ address: string }>;
  /** The user's SEPARATE Solana account, created on demand. */
  getOrCreateSolanaAccount(userId: string): Promise<{ address: string }>;
  /** Holdings as human-readable coin views, USD-valued. */
  balances(userId: string): Promise<WalletCoinView[]>;
  /** Estimated send fee; `sponsored` chains (Base, via the paymaster) carry null. */
  feeEstimate(chain: WalletChainId): Promise<{ feeUsd: number | null; sponsored: boolean }>;
  /** The paymaster's free monthly gas allowance, or null when unconfigured. */
  sponsorshipAllowance(): Promise<{ usedUsd: number; limitUsd: number } | null>;
  /** Move `input.amount` of `input.asset` to `input.to`. Throws on failure. */
  sendTransaction(userId: string, input: WalletSendInput): Promise<{ txId: string }>;
  /** Convert `fromAsset` to `toAsset` in-wallet (same account, no transfer). */
  swap(
    userId: string,
    input: { fromAsset: string; toAsset: string; amount: string },
  ): Promise<{ txId: string; toAmount: string }>;
  /** Recent transaction history (both directions) for deposit reconciliation. */
  history(userId: string, limit: number): Promise<WalletLedgerEntry[]>;
}

const CDP_HOST = 'api.cdp.coinbase.com';
const CDP_BASE = `https://${CDP_HOST}`;

export function realCdpWalletSource(): CdpWalletSource | null {
  const keyId = process.env.COINBASE_CDP_API_KEY_ID?.trim();
  const keySecret = process.env.COINBASE_CDP_API_KEY_SECRET?.trim();
  const walletSecret = process.env.COINBASE_CDP_WALLET_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  return new CdpWalletClient({ keyId, keySecret, ...(walletSecret ? { walletSecret } : {}) });
}

export type CdpCredentials = {
  keyId: string;
  keySecret: string;
  walletSecret?: string;
};

/** Build the EdDSA JWT CDP expects on every request. */
export function cdpJwt(credentials: CdpCredentials, method: string, pathname: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', kid: credentials.keyId, nonce: randomUUID(), typ: 'JWT' }),
  ).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: credentials.keyId,
      iss: 'cdp',
      aud: ['request'],
      nbf: now,
      exp: now + 120,
      uris: [`${method} ${CDP_HOST}${pathname}`],
    }),
  ).toString('base64url');
  const signature = sign(
    null,
    Buffer.from(`${header}.${payload}`),
    cdpPrivateKey(credentials.keySecret),
  );
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

export class CdpWalletClient implements CdpWalletSource {
  constructor(private readonly credentials: CdpCredentials) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const jwt = cdpJwt(this.credentials, method, new URL(path, CDP_BASE).pathname);
    const response = await fetch(`${CDP_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        ...(this.credentials.walletSecret
          ? { 'X-Wallet-Auth': `Bearer ${this.credentials.walletSecret}` }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CDP ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  async createUser(): Promise<{ userId: string }> {
    const result = await this.request<{ id: string }>('POST', '/platform/v2/users', {
      name: `beeline-${randomUUID().slice(0, 8)}`,
    });
    return { userId: result.id };
  }

  async getOrCreateEvmAccount(userId: string): Promise<{ address: string }> {
    const existing = await this.findAccount(userId, 'evm');
    if (existing) return existing;
    const created = await this.request<{ address: string }>(
      'POST',
      `/platform/v2/users/${encodeURIComponent(userId)}/accounts`,
      { type: 'evm' },
    );
    return { address: created.address };
  }

  async getOrCreateSolanaAccount(userId: string): Promise<{ address: string }> {
    const existing = await this.findAccount(userId, 'solana');
    if (existing) return existing;
    const created = await this.request<{ address: string }>(
      'POST',
      `/platform/v2/users/${encodeURIComponent(userId)}/accounts`,
      { type: 'solana' },
    );
    return { address: created.address };
  }

  private async findAccount(
    userId: string,
    type: 'evm' | 'solana',
  ): Promise<{ address: string } | null> {
    const accounts = await this.request<{
      accounts: Array<{ address: string; type: string }>;
    }>('GET', `/platform/v2/users/${encodeURIComponent(userId)}/accounts?type=${type}`);
    const match = accounts.accounts.find((account) => account.type === type);
    return match ? { address: match.address } : null;
  }

  async balances(userId: string): Promise<WalletCoinView[]> {
    const result = await this.request<{
      balances: Array<{ asset: string; amount: string; usd_value: string }>;
    }>('GET', `/platform/v2/users/${encodeURIComponent(userId)}/balances`);
    return result.balances.map((row) => ({
      symbol: row.asset.toLowerCase(),
      name: walletAssetName(row.asset),
      amount: row.amount,
      usd: formatUsd(Number(row.usd_value)),
    }));
  }

  async feeEstimate(chain: WalletChainId): Promise<{ feeUsd: number | null; sponsored: boolean }> {
    // Base gas is covered by the paymaster's free monthly allowance, so the
    // send screen shows SPONSORED there. Other chains cost the wallet gas;
    // the estimate is a conservative static table, not a per-send round trip.
    if (chain === 'base') return { feeUsd: null, sponsored: true };
    const table: Partial<Record<WalletChainId, number>> = {
      arbitrum: 0.04,
      optimism: 0.05,
      polygon: 0.02,
      zora: 0.03,
      bnb: 0.08,
      avalanche: 0.06,
      ethereum: 1.8,
    };
    return { feeUsd: table[chain] ?? 0.1, sponsored: false };
  }

  async sponsorshipAllowance(): Promise<{ usedUsd: number; limitUsd: number } | null> {
    try {
      const result = await this.request<{ used_usd: number; limit_usd: number }>(
        'GET',
        '/platform/v2/paymaster/allowance',
      );
      return { usedUsd: result.used_usd, limitUsd: result.limit_usd };
    } catch {
      return null;
    }
  }

  async sendTransaction(userId: string, input: WalletSendInput): Promise<{ txId: string }> {
    const result = await this.request<{ transaction_id: string }>(
      'POST',
      `/platform/v2/users/${encodeURIComponent(userId)}/transactions`,
      {
        chain: input.chain,
        asset: input.asset.toLowerCase(),
        amount: input.amount,
        destination: input.to,
      },
    );
    return { txId: result.transaction_id };
  }

  async swap(userId: string, input: { fromAsset: string; toAsset: string; amount: string }) {
    const result = await this.request<{ transaction_id: string; to_amount: string }>(
      'POST',
      `/platform/v2/users/${encodeURIComponent(userId)}/trades`,
      {
        from_asset: input.fromAsset.toLowerCase(),
        to_asset: input.toAsset.toLowerCase(),
        amount: input.amount,
      },
    );
    return { txId: result.transaction_id, toAmount: result.to_amount };
  }

  async history(userId: string, limit: number): Promise<WalletLedgerEntry[]> {
    const result = await this.request<{
      transactions: Array<{
        transaction_id: string;
        direction: 'in' | 'out';
        asset: string;
        amount: string;
        counterparty: string;
        chain: string;
        usd_value: string;
        block_time: string;
      }>;
    }>('GET', `/platform/v2/users/${encodeURIComponent(userId)}/transactions?limit=${limit}`);
    return result.transactions.map((row) => {
      const chain = (isChainId(row.chain) ? row.chain : 'base') as WalletChainId;
      return {
        direction: row.direction,
        agentName: null,
        amountText: `${row.direction === 'in' ? '+' : '−'}${row.amount} ${row.asset.toUpperCase()}`,
        counterparty: row.counterparty,
        chain,
        balanceAfterUsd: formatUsd(Number(row.usd_value)),
        txUrl: walletExplorerTxUrl(chain, row.transaction_id),
        createdAt: new Date(row.block_time).getTime(),
      };
    });
  }
}

function isChainId(value: string): boolean {
  return ['base', 'arbitrum', 'optimism', 'polygon', 'zora', 'bnb', 'avalanche', 'ethereum'].includes(
    value,
  );
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Accept the PEM form CDP shows, or the raw base64 Ed25519 seed. */
/**
 * Coinbase CDP's Ed25519 API key secret is the RAW key bytes (a 32-byte seed,
 * or a 64-byte seed+public value), base64-encoded. Node's createPrivateKey
 * cannot ingest those raw bytes: it needs a PKCS8 wrapper around the 32-byte
 * seed. Wrapping the raw bytes in a generic PEM (the previous behaviour) made
 * createPrivateKey throw `DECODER routines::unsupported`, so every signed CDP
 * request 503'd and the wallet could never create or read. Build the PKCS8 the
 * seed needs; also accept a PEM the caller pasted, or an already-DER PKCS8.
 */
function cdpPrivateKey(secret: string): KeyObject {
  const trimmed = secret.trim();
  if (trimmed.includes('-----BEGIN')) return createPrivateKey(trimmed);
  const raw = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64');
  if (raw.length === 32 || raw.length === 64) {
    const pkcs8 = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      raw.subarray(0, 32),
    ]);
    return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  }
  return createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' });
}
