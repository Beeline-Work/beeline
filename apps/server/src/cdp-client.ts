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
 *   COINBASE_CDP_WALLET_SECRET    the P-256 Wallet Secret for signing user ops
 *
 * NON-CUSTODIAL embedded user wallets ONLY: custodial and agentic wallet
 * products are locked behind US/Singapore business verification this UAE
 * entity cannot obtain, so nothing here may depend on them. End users are
 * created under the app credential; their EVM account IS the EOA (identical
 * on every EVM chain), and their Solana account is a separate account on the
 * same end-user.
 *
 * CDP auth: TWO layers.
 *   1. Developer auth: an EdDSA (Ed25519) JWT per request, header `kid` = API
 *      key id, `nonce` = random uuid, claims {sub, iss, aud, nbf, exp, uris}.
 *      Signed with the Ed25519 private key.
 *   2. Wallet-secret auth: an ES256 (ECDSA P-256) JWT in the `X-Wallet-Auth`
 *      header on wallet-scoped calls, with a sorted-body SHA-256 `reqHash`.
 *      The project's ONE Wallet Secret (COINBASE_CDP_WALLET_SECRET) signs
 *      every user operation — never a per-person secret.
 *
 * Endpoint paths follow the probe-proven structure:
 *   POST /platform/v2/embedded-wallet-api/projects/{projectId}/end-users
 *   PUT  /platform/v2/embedded-wallet-api/end-users/{userId}/wallet-secrets
 *   POST /platform/v2/embedded-wallet-api/end-users/{userId}/evm
 *   GET  /platform/v2/embedded-wallet-api/end-users/{userId}?projectId=...
 */
import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject, createSign, createHash } from 'node:crypto';
import {
  walletAssetName,
  walletExplorerTxUrl,
  type WalletChainId,
  type WalletCoinView,
  type WalletLedgerEntry,
  type WalletSendInput,
} from '@beeline/api-contract/wallet';

// ---------------------------------------------------------------------------
// Credential parsing
// ---------------------------------------------------------------------------

export type CdpCredentials = {
  keyId: string;
  keySecret: string;
  /** The ONE project-wide P-256 wallet secret, PEM or base64 PKCS8 DER. */
  walletSecret?: string;
  /** The CDP project id. Defaults to the Beeline project. */
  projectId?: string;
};

/** The Beeline CDP project id. */
const BEELINE_PROJECT_ID = '6fdaf9eb-9935-49fc-be84-047a324bf275';

// ---------------------------------------------------------------------------
// CdpWalletSource interface
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const CDP_HOST = 'api.cdp.coinbase.com';

export function realCdpWalletSource(): CdpWalletSource | null {
  const keyId = process.env.COINBASE_CDP_API_KEY_ID?.trim();
  const keySecret = process.env.COINBASE_CDP_API_KEY_SECRET?.trim();
  const walletSecret = process.env.COINBASE_CDP_WALLET_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  return new CdpWalletClient({
    keyId,
    keySecret,
    ...(walletSecret ? { walletSecret } : {}),
  });
}

// ---------------------------------------------------------------------------
// Developer Ed25519 JWT
// ---------------------------------------------------------------------------

/** Build the EdDSA JWT CDP expects on every developer-authenticated request. */
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

/** Accept the PEM form CDP shows, or the raw base64 Ed25519 seed. */
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

// ---------------------------------------------------------------------------
// Wallet-secret ES256 auth (X-Wallet-Auth header)
// ---------------------------------------------------------------------------

/**
 * Parse the app-wide P-256 wallet secret into a `KeyObject`.
 *
 * Accepts PEM or DER PKCS8 format. CDP provides the Wallet Secret as a P-256
 * key (not a raw seed); the vault is configured as PEM or base64 DER.
 */
function walletSecretKey(secret: string): KeyObject {
  const trimmed = secret.trim();
  if (trimmed.includes('-----BEGIN')) return createPrivateKey(trimmed);
  const raw = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64');
  return createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' });
}

/**
 * Convert a DER-encoded ECDSA signature (ASN.1 SEQUENCE of two INTEGERs)
 * to the raw r||s format JWT ES256 expects (64 bytes: two 32-byte big-endian
 * values concatenated).
 */
function derToRawSignature(der: Buffer): Buffer {
  // DER: 30 <len> 02 <rlen> <r> 02 <slen> <s>
  let offset = 0;
  if (der[offset] !== 0x30) throw new Error('not a DER SEQUENCE');
  const firstLen: number = der[offset + 1]!;
  if (firstLen & 0x80) {
    const nBytes = firstLen & 0x7f;
    offset = 2;
    for (let i = 0; i < nBytes; i++) offset += der[offset]!;
    offset = 2 + nBytes;
  } else {
    offset = 2;
  }
  const readInteger = (): Buffer => {
    if (der[offset] !== 0x02) throw new Error('expected INTEGER');
    const len: number = der[offset + 1]!;
    offset += 2;
    const value = der.subarray(offset, offset + len);
    offset += len;
    // Strip leading 0x00 padding byte (added for positive sign) but keep the
    // rest. Pad left to 32 bytes if shorter.
    let start = 0;
    if (value.length > 32 && value[0] === 0x00) start = 1;
    const trimmed = value.subarray(start);
    if (trimmed.length > 32) throw new Error(`INTEGER too long: ${trimmed.length}`);
    return trimmed.length < 32
      ? Buffer.concat([Buffer.alloc(32 - trimmed.length), trimmed])
      : trimmed;
  };
  const r = readInteger();
  const s = readInteger();
  return Buffer.concat([r, s]);
}

/**
 * Build the ES256 JWT for the X-Wallet-Auth header.
 *
 * Structure (from the live probe):
 *   Header:  {"alg":"ES256","typ":"JWT"}
 *   Payload: {
 *     uris: ["POST api.cdp.coinbase.com/platform/v2/..."],
 *     reqHash: hex(sha256(sortKeys(body)))  // absent when body is empty
 *   }
 *   Signed with the app's P-256 Wallet Secret.
 *
 * `sortKeys` recursively sorts object keys for a deterministic hash, matching
 * the CDP server's own canonical form.
 */
function sortKeys(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  return sorted;
}

function walletAuthJwt(
  walletKey: KeyObject,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): string {
  const header = { alg: 'ES256' as const, typ: 'JWT' as const };
  const payload: Record<string, unknown> = {
    uris: [`${method} ${CDP_HOST}${path}`],
  };
  if (body && Object.keys(body).length > 0) {
    payload.reqHash = createHash('sha256')
      .update(JSON.stringify(sortKeys(body)))
      .digest('hex');
  }
  const now = Math.floor(Date.now() / 1000);
  payload.iat = now;
  payload.nbf = now;
  payload.jti = randomUUID();

  const enc = (input: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(input)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const derSig = createSign('sha256').update(signingInput).sign(walletKey);
  const rawSig = derToRawSignature(derSig);
  return `${signingInput}.${rawSig.toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// CdpWalletClient — the real implementation
// ---------------------------------------------------------------------------

const API_BASE = '/platform/v2/embedded-wallet-api';

export class CdpWalletClient implements CdpWalletSource {
  private readonly projectId: string;
  private readonly walletKey: KeyObject | null;

  constructor(private readonly credentials: CdpCredentials) {
    this.projectId = credentials.projectId ?? BEELINE_PROJECT_ID;
    this.walletKey = credentials.walletSecret
      ? walletSecretKey(credentials.walletSecret)
      : null;
  }

  /**
   * Fire a developer-authenticated request (Ed25519 dev JWT only).
   * Used for end-user management and read operations that don't need wallet
   * secret auth (X-Wallet-Auth).
   */
  private async devRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fullPath = `${API_BASE}${path}`;
    const jwt = cdpJwt(this.credentials, method, fullPath);
    const response = await fetch(`https://${CDP_HOST}${fullPath}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CDP ${method} ${fullPath} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Fire a wallet-authenticated request (dev JWT + X-Wallet-Auth ES256 JWT).
   * Used for user-specific operations like creating accounts, sending, etc.
   * Requires the wallet secret to be configured.
   */
  private async walletRequest<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const fullPath = `${API_BASE}${path}`;
    const jwt = cdpJwt(this.credentials, method, fullPath);
    if (!this.walletKey) {
      throw new Error('CDP wallet secret not configured: COINBASE_CDP_WALLET_SECRET is required for user operations');
    }
    const walletJwt = walletAuthJwt(this.walletKey, method, fullPath, body);
    const response = await fetch(`https://${CDP_HOST}${fullPath}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        'x-wallet-auth': walletJwt,
        'content-type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CDP ${method} ${fullPath} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  // -----------------------------------------------------------------------
  // CdpWalletSource implementation
  // -----------------------------------------------------------------------

  /**
   * Create an end-user under the app credential. No email OTP needed for the
   * server-side Embedded Wallets API — the developer JWT authorizes end-user
   * creation directly (captain verified: "CDP accepts a JWT from our own
   * auth"). The wallet secret is then registered on this end-user so wallet
   * operations are authenticated through the project's P-256 keypair.
   */
  async createUser(): Promise<{ userId: string }> {
    const result = await this.devRequest<{ userId: string }>(
      'POST',
      `/projects/${this.projectId}/end-users`,
      {},
    );
    const userId = result.userId;
    // Register the app's wallet secret on this end-user so we can sign
    // subsequent wallet operations.
    if (this.walletKey) {
      const pubKey = this.walletKeyToSpki();
      const walletSecretId = createHash('sha256')
        .update(pubKey + userId)
        .digest('hex')
        .slice(0, 36); // UUID-like format, unique per user
      const validUntil = new Date(Date.now() + 365 * 24 * 3600_000).toISOString(); // 1 year
      await this.walletRequest(
        'PUT',
        `/end-users/${userId}/wallet-secrets`,
        { walletSecretId, publicKey: pubKey, validUntil },
      );
    }
    return { userId };
  }

  /** Get the SPKI (SubjectPublicKeyInfo) of the wallet secret, base64-encoded. */
  private walletKeyToSpki(): string {
    if (!this.walletKey) throw new Error('no wallet secret configured');
    // Node v24 does not allow export({type:'spki'}) directly from a private
    // KeyObject. Wrap the key as a public key first.
    return createPublicKey(this.walletKey).export({ type: 'spki', format: 'der' }).toString('base64');
  }

  async getOrCreateEvmAccount(userId: string): Promise<{ address: string }> {
    if (!this.walletKey) {
      throw new Error('Wallet secret required for EVM account creation');
    }
    const pubKey = this.walletKeyToSpki();
    const walletSecretId = createHash('sha256')
      .update(pubKey + userId)
      .digest('hex')
      .slice(0, 36);
    const result = await this.walletRequest<{ address: string }>(
      'POST',
      `/end-users/${userId}/evm`,
      { walletSecretId },
    );
    return { address: result.address };
  }

  async getOrCreateSolanaAccount(userId: string): Promise<{ address: string }> {
    if (!this.walletKey) {
      throw new Error('Wallet secret required for Solana account creation');
    }
    const pubKey = this.walletKeyToSpki();
    const walletSecretId = createHash('sha256')
      .update(pubKey + userId)
      .digest('hex')
      .slice(0, 36);
    const result = await this.walletRequest<{ address: string }>(
      'POST',
      `/end-users/${userId}/solana`,
      { walletSecretId },
    );
    return { address: result.address };
  }

  async balances(userId: string): Promise<WalletCoinView[]> {
    // The end-user resource carries holdings when queried with the project id.
    const result = await this.devRequest<{
      userId: string;
      accounts?: Array<{ type: string; address: string; balances: Array<{ asset: string; amount: string }> }>;
      holdings?: Array<{ asset: string; amount: string; usd_value: string }>;
    }>('GET', `/end-users/${userId}?projectId=${this.projectId}`);
    // CDP may return holdings as a flat list or nested under accounts.
    const holdings = result.holdings ?? [];
    if (holdings.length) {
      return holdings.map((row) => ({
        symbol: assetSymbol(row.asset),
        name: walletAssetName(assetSymbol(row.asset)),
        amount: row.amount,
        usd: formatUsd(Number(row.usd_value)),
      }));
    }
    // Fallback: extract from accounts if holdings not present.
    const accounts = result.accounts ?? [];
    const coins: WalletCoinView[] = [];
    for (const account of accounts) {
      for (const bal of account.balances ?? []) {
        const symbol = assetSymbol(bal.asset);
        coins.push({
          symbol,
          name: walletAssetName(symbol),
          amount: bal.amount,
          usd: formatUsd(0),
        });
      }
    }
    return coins;
  }

  async feeEstimate(chain: WalletChainId): Promise<{ feeUsd: number | null; sponsored: boolean }> {
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
      const result = await this.devRequest<{ used_usd: number; limit_usd: number }>(
        'GET',
        `/projects/${this.projectId}/paymaster/allowance`,
      );
      return { usedUsd: result.used_usd, limitUsd: result.limit_usd };
    } catch {
      return null;
    }
  }

  async sendTransaction(userId: string, input: WalletSendInput): Promise<{ txId: string }> {
    if (!this.walletKey) throw new Error('Wallet secret required for sends');
    const result = await this.walletRequest<{ transaction_id?: string; txId?: string }>(
      'POST',
      `/end-users/${userId}/send`,
      {
        chain: input.chain,
        asset: input.asset.toLowerCase(),
        amount: input.amount,
        destination: input.to,
      },
    );
    return { txId: result.transaction_id ?? result.txId ?? 'unknown' };
  }

  async swap(
    userId: string,
    input: { fromAsset: string; toAsset: string; amount: string },
  ): Promise<{ txId: string; toAmount: string }> {
    if (!this.walletKey) throw new Error('Wallet secret required for swaps');
    const result = await this.walletRequest<{
      transaction_id?: string;
      to_amount?: string;
      txId?: string;
      toAmount?: string;
    }>(
      'POST',
      `/end-users/${userId}/swap`,
      {
        from_asset: input.fromAsset.toLowerCase(),
        to_asset: input.toAsset.toLowerCase(),
        amount: input.amount,
      },
    );
    return {
      txId: result.transaction_id ?? result.txId ?? 'unknown',
      toAmount: result.to_amount ?? result.toAmount ?? '0',
    };
  }

  async history(userId: string, limit: number): Promise<WalletLedgerEntry[]> {
    const n = Math.min(Math.max(limit, 1), 100);
    const result = await this.devRequest<{
      transactions?: Array<{
        transaction_id: string;
        direction: string;
        asset: string;
        amount: string;
        counterparty: string;
        chain: string;
        usd_value: string;
        block_time: string;
      }>;
      events?: Array<{
        id: string;
        direction: string;
        asset: string;
        amount: string;
        counterparty: string;
        chain: string;
        usdValue: string;
        createdAt: string;
      }>;
    }>('GET', `/end-users/${userId}/transactions?limit=${n}&projectId=${this.projectId}`);
    const txs = result.transactions ?? result.events ?? [];
    return txs.slice(0, n).map((row: Record<string, unknown>) => {
      const chain = guessChain(String(row.chain ?? 'base'));
      return {
        direction: String(row.direction ?? 'in') === 'in' ? ('in' as const) : ('out' as const),
        agentName: null,
        amountText: formatAmountText(String(row.direction ?? 'in'), String(row.amount ?? '0'), String(row.asset ?? 'usdc')),
        counterparty: String(row.counterparty ?? ''),
        chain,
        balanceAfterUsd: formatUsd(Number(row.usd_value ?? row.usdValue ?? 0)),
        txUrl: walletExplorerTxUrl(chain, String(row.transaction_id ?? row.id ?? '')),
        createdAt: new Date(String(row.block_time ?? row.createdAt ?? Date.now())).getTime(),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a CDP asset id to a standard symbol. */
function assetSymbol(asset: string): string {
  const symbols: Record<string, string> = {
    'usdc': 'usdc',
    'eth': 'eth',
    'cbbtc': 'cbbtc',
    'sol': 'sol',
    'usd-coin': 'usdc',
    'ethereum': 'eth',
    'coinbase-wrapped-btc': 'cbbtc',
  };
  return symbols[asset.toLowerCase()] ?? asset.toLowerCase();
}

function formatAmountText(direction: string, amount: string, asset: string): string {
  const prefix = direction === 'in' ? '+' : '−';
  return `${prefix}${amount} ${asset.toUpperCase()}`;
}

function guessChain(value: string): WalletChainId {
  const map: Record<string, WalletChainId> = {
    base: 'base',
    arbitrum: 'arbitrum',
    optimism: 'optimism',
    polygon: 'polygon',
    zora: 'zora',
    bnb: 'bnb',
    avalanche: 'avalanche',
    ethereum: 'ethereum',
  };
  return map[value.toLowerCase()] ?? 'base';
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}