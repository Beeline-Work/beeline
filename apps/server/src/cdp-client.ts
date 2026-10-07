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
 * SERVER WALLET model (rewritten 2026-11): no "end-user" entity. A wallet IS
 * a CDP Server-Wallet EVM account identified by its address. The account name
 * is deterministic per identity (stable so the same wallet is returned). The
 * one app-wide Wallet Secret signs all wallet-scoped calls.
 *
 * Auth:
 *   1. Developer auth: an EdDSA (Ed25519) JWT per request, header `kid` = API
 *      key id, `nonce` = random uuid, claims {sub, iss, aud, nbf, exp, uris}.
 *   2. Wallet-secret auth: an ES256 (ECDSA P-256) JWT in the `X-Wallet-Auth`
 *      header on wallet-scoped calls (account creation, sends), with a sorted-
 *      body SHA-256 `reqHash`.
 *
 * Confirmed working endpoints (probed production 2026-11):
 *   POST /platform/v2/evm/accounts          -> 201 { address, name, ... }
 *   POST /platform/v2/solana/accounts       -> 201 { address, name, ... }
 *   GET  /platform/v2/evm/token-balances/{network}/{address}
 *
 * Sends, swaps and typed-data signing follow the CDP v2 OpenAPI spec
 * (coinbase/cdp-sdk openapi.yaml): send/transaction, sign/transaction,
 * /evm/swaps and sign/typed-data. Per-chain coverage lives in evm-chain.ts.
 */
import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject, createSign, createHash } from 'node:crypto';
import {
  walletAssetName,
  type WalletChainId,
  type WalletCoinView,
  type WalletContractCall,
  type WalletLedgerEntry,
  type WalletSendInput,
  type WalletTypedData,
} from '@beeline/api-contract/wallet';
import {
  EVM_CHAINS,
  NATIVE_TOKEN,
  appendPermit2Signature,
  erc20ApproveData,
  erc20TransferData,
  evmAsset,
  formatUnits,
  hexToBigInt,
  isEvmAddress,
  parseUnits,
  rpc,
  rpcBatch,
  rpcNativeAndUsdc,
  serializeEip1559,
  usdPrice,
} from './evm-chain.js';

// ---------------------------------------------------------------------------
// Credential parsing
// ---------------------------------------------------------------------------

export type CdpCredentials = {
  keyId: string;
  keySecret: string;
  /** The ONE project-wide P-256 wallet secret, PEM or base64 PKCS8 DER. */
  walletSecret?: string;
};

// ---------------------------------------------------------------------------
// CdpWalletSource interface
// ---------------------------------------------------------------------------

/** Everything the wallet module needs from Coinbase, and nothing else. */
export interface CdpWalletSource {
  /** Create an EVM account with the given deterministic name. */
  createEvmAccount(name: string): Promise<{ address: string }>;
  /** Create a SEPARATE Solana account with the given deterministic name. */
  createSolanaAccount(name: string): Promise<{ address: string }>;
  /** Holdings for an EVM address on one chain, each tagged with that chain. */
  balances(network: WalletChainId, address: string): Promise<WalletCoinView[]>;
  /** Estimated send fee; `sponsored` chains (Base, via the paymaster) carry null. */
  feeEstimate(chain: WalletChainId): Promise<{ feeUsd: number | null; sponsored: boolean }>;
  /** The paymaster's free monthly gas allowance, or null when unconfigured. */
  sponsorshipAllowance(): Promise<{ usedUsd: number; limitUsd: number } | null>;
  /** Move `input.amount` of `input.asset` to `input.to`. Throws on failure. */
  sendTransaction(address: string, input: WalletSendInput): Promise<{ txId: string }>;
  /**
   * Call `call.contract` with `call.data` and `call.value`. With `call.approve`,
   * first approve exactly that token amount for the contract and wait for it.
   */
  contractCall(address: string, call: WalletContractCall): Promise<{ txId: string }>;
  /** Convert `fromAsset` to `toAsset` in-wallet on one chain (same account, no transfer). */
  swap(
    address: string,
    input: { chain: WalletChainId; fromAsset: string; toAsset: string; amount: string },
  ): Promise<{ txId: string; toAmount: string; status: 'confirmed' | 'pending' }>;
  /** Sign an EIP-712 message without broadcasting or selecting a network. */
  signTypedData(address: string, input: WalletTypedData): Promise<{ signature: string }>;
  /** Recent transaction history (both directions) for deposit reconciliation; the real client has none. */
  history(address: string, limit: number): Promise<WalletLedgerEntry[]>;
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
// CdpWalletClient — the real implementation (server-wallet API)
// ---------------------------------------------------------------------------

const API_BASE = '/platform/v2';

export class CdpWalletClient implements CdpWalletSource {
  private readonly walletKey: KeyObject | null;

  constructor(private readonly credentials: CdpCredentials) {
    this.walletKey = credentials.walletSecret
      ? walletSecretKey(credentials.walletSecret)
      : null;
  }

  /**
   * Fire a developer-authenticated request (Ed25519 dev JWT only).
   * Used for read operations that don't need wallet secret auth.
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
   * Used for account creation and state-changing operations.
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
   * Create an EVM account with the given deterministic name.
   * POST /platform/v2/evm/accounts  -> 201 { address, name, createdAt, updatedAt }
   * Requires both the developer JWT and the wallet-secret JWT.
   */
  async createEvmAccount(name: string): Promise<{ address: string }> {
    const result = await this.walletRequest<{ address: string }>(
      'POST',
      '/evm/accounts',
      { name },
    );
    return { address: result.address };
  }

  /**
   * Create a SEPARATE Solana account with the given deterministic name.
   * POST /platform/v2/solana/accounts  -> 201 { address, name, createdAt, updatedAt }
   * Requires both the developer JWT and the wallet-secret JWT.
   */
  async createSolanaAccount(name: string): Promise<{ address: string }> {
    const result = await this.walletRequest<{ address: string }>(
      'POST',
      '/solana/accounts',
      { name },
    );
    return { address: result.address };
  }

  /**
   * Native and USDC holdings (plus any other CDP-indexed token) for an EVM
   * address on one chain. CDP's token-balances endpoint covers only Base and
   * Ethereum; every other chain, and any CDP failure, reads the public RPC.
   */
  async balances(network: WalletChainId, address: string): Promise<WalletCoinView[]> {
    const chain = EVM_CHAINS[network];
    let rows: Array<{ symbol: string; amount: bigint; decimals: number }> | null = null;
    if (chain.cdpBalances) {
      try {
        rows = await this.cdpTokenBalances(network, address);
      } catch (error) {
        console.error(
          `[cdp] token-balances failed for ${network}; reading the public RPC:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (!rows) {
      const { native, usdc } = await rpcNativeAndUsdc(network, address);
      rows = [
        { symbol: chain.nativeSymbol, amount: native, decimals: 18 },
        { symbol: 'usdc', amount: usdc, decimals: chain.usdc.decimals },
      ];
    }
    const coins: WalletCoinView[] = [];
    for (const row of rows) {
      if (row.amount <= 0n) continue;
      const amount = formatUnits(row.amount, row.decimals);
      coins.push({
        symbol: row.symbol,
        name: walletAssetName(row.symbol),
        chain: network,
        amount,
        usd: formatUsd(Number(amount) * (await usdPrice(row.symbol))),
      });
    }
    return coins;
  }

  /** GET /platform/v2/evm/token-balances/{network}/{address}, every page. */
  private async cdpTokenBalances(
    network: WalletChainId,
    address: string,
  ): Promise<Array<{ symbol: string; amount: bigint; decimals: number }>> {
    const chain = EVM_CHAINS[network];
    const rows: Array<{ symbol: string; amount: bigint; decimals: number }> = [];
    let pageToken: string | undefined;
    do {
      const result = await this.devRequest<{
        balances?: Array<{
          amount?: { amount?: string; decimals?: number };
          token?: { symbol?: string; contractAddress?: string };
        }>;
        nextPageToken?: string;
      }>('GET', `/evm/token-balances/${network}/${address}${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      for (const row of result.balances ?? []) {
        const contract = row.token?.contractAddress?.toLowerCase() ?? '';
        const decimals = row.amount?.decimals;
        if (!row.amount?.amount || typeof decimals !== 'number') continue;
        const symbol =
          contract === NATIVE_TOKEN.toLowerCase()
            ? chain.nativeSymbol
            : contract === chain.usdc.address.toLowerCase()
              ? 'usdc'
              : (row.token?.symbol ?? contract).toLowerCase();
        rows.push({ symbol, amount: BigInt(row.amount.amount), decimals });
      }
      pageToken = result.nextPageToken || undefined;
    } while (pageToken);
    return rows;
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
    // TODO: wire to real CDP paymaster endpoint when available in server-wallet API
    return null;
  }

  /** Send the native token or USDC as one EIP-1559 transaction. */
  async sendTransaction(address: string, input: WalletSendInput): Promise<{ txId: string }> {
    if (!isEvmAddress(input.to)) throw new Error(`invalid recipient address: ${input.to}`);
    const asset = evmAsset(input.chain, input.asset);
    const amount = parseUnits(input.amount, asset.decimals);
    if (amount <= 0n) throw new Error('amount must be positive');
    return {
      txId: await this.sendEvmTransaction(
        address,
        input.chain,
        asset.token
          ? { to: asset.token, data: erc20TransferData(input.to, amount) }
          : { to: input.to, value: amount },
      ),
    };
  }

  /** An exact ERC-20 approval for the contract, mined first, then the call itself. */
  async contractCall(address: string, call: WalletContractCall): Promise<{ txId: string }> {
    if (!isEvmAddress(call.contract)) throw new Error(`invalid contract address: ${call.contract}`);
    const value = call.value ? parseUnits(call.value, evmAsset(call.chain, 'native').decimals) : 0n;
    if (call.approve) {
      const asset = evmAsset(call.chain, call.approve.asset);
      if (!asset.token) throw new Error('approve needs a token, not the native asset');
      const approval = await this.sendEvmTransaction(address, call.chain, {
        to: asset.token,
        data: erc20ApproveData(call.contract, parseUnits(call.approve.amount, asset.decimals)),
      });
      await waitForReceipt(call.chain, approval);
    }
    return {
      txId: await this.sendEvmTransaction(address, call.chain, {
        to: call.contract,
        data: call.data,
        ...(value ? { value } : {}),
      }),
    };
  }

  /**
   * POST /platform/v2/evm/accounts/{address}/send/transaction where CDP
   * supports the network (it fills nonce, gas and fees). Elsewhere the
   * transaction is completed from the public RPC, signed by CDP
   * (/sign/transaction) and broadcast with eth_sendRawTransaction.
   */
  private async sendEvmTransaction(
    address: string,
    network: WalletChainId,
    tx: { to: string; value?: bigint; data?: string; gas?: bigint },
  ): Promise<string> {
    if (!this.walletKey) throw new Error('Wallet secret required for sends');
    const chain = EVM_CHAINS[network];
    if (chain.cdpSend) {
      const result = await this.walletRequest<{ transactionHash: string }>(
        'POST',
        `/evm/accounts/${address}/send/transaction`,
        { network, transaction: serializeEip1559({ chainId: chain.chainId, ...tx }) },
      );
      return result.transactionHash;
    }
    const call = {
      from: address,
      to: tx.to,
      ...(tx.value ? { value: `0x${tx.value.toString(16)}` } : {}),
      ...(tx.data ? { data: tx.data } : {}),
    };
    const [nonce, priority, block, estimate] = await rpcBatch(network, [
      { method: 'eth_getTransactionCount', params: [address, 'pending'] },
      { method: 'eth_maxPriorityFeePerGas', params: [] },
      { method: 'eth_getBlockByNumber', params: ['latest', false] },
      { method: 'eth_estimateGas', params: [call] },
    ]);
    const maxPriorityFeePerGas = hexToBigInt(priority);
    const baseFee = hexToBigInt((block as { baseFeePerGas?: string }).baseFeePerGas ?? '0x0');
    const signed = await this.walletRequest<{ signedTransaction: string }>(
      'POST',
      `/evm/accounts/${address}/sign/transaction`,
      {
        transaction: serializeEip1559({
          chainId: chain.chainId,
          ...tx,
          nonce: hexToBigInt(nonce),
          maxPriorityFeePerGas,
          maxFeePerGas: baseFee * 2n + maxPriorityFeePerGas,
          gas: tx.gas ?? (hexToBigInt(estimate) * 12n) / 10n,
        }),
      },
    );
    return String(await rpc(network, 'eth_sendRawTransaction', [signed.signedTransaction]));
  }

  /**
   * Swap in-wallet through CDP's swap API (POST /platform/v2/evm/swaps), on
   * the networks it supports. An ERC-20 sell first approves Permit2 when the
   * quote reports a missing allowance, then signs the Permit2 message and
   * appends it to the swap calldata.
   */
  async swap(
    address: string,
    input: { chain: WalletChainId; fromAsset: string; toAsset: string; amount: string },
  ): Promise<{ txId: string; toAmount: string; status: 'confirmed' | 'pending' }> {
    const chain = EVM_CHAINS[input.chain];
    if (!chain.cdpSwap) throw new Error(`swap unsupported on ${input.chain}`);
    if (!this.walletKey) throw new Error('Wallet secret required for swaps');
    const from = evmAsset(input.chain, input.fromAsset);
    const to = evmAsset(input.chain, input.toAsset);
    if (from.symbol === to.symbol) throw new Error('swap needs two different assets');
    const fromAmount = parseUnits(input.amount, from.decimals);
    if (fromAmount <= 0n) throw new Error('amount must be positive');
    type SwapQuote = {
      liquidityAvailable?: boolean;
      toAmount?: string;
      issues?: { allowance?: { spender?: string } | null };
      permit2?: { eip712?: WalletTypedData } | null;
      transaction?: { to: string; data: string; value?: string; gas?: string };
    };
    const quote = async (): Promise<SwapQuote> =>
      this.devRequest<SwapQuote>('POST', '/evm/swaps', {
        network: input.chain,
        fromToken: from.token ?? NATIVE_TOKEN,
        toToken: to.token ?? NATIVE_TOKEN,
        fromAmount: fromAmount.toString(),
        taker: address,
      });
    let swap = await quote();
    if (swap.liquidityAvailable === false) throw new Error(`no swap liquidity on ${input.chain}`);
    const spender = swap.issues?.allowance?.spender;
    if (spender && from.token) {
      const approval = await this.sendEvmTransaction(address, input.chain, {
        to: from.token,
        data: erc20ApproveData(spender, fromAmount),
      });
      await waitForReceipt(input.chain, approval);
      swap = await quote();
    }
    if (!swap.transaction) throw new Error('CDP swap quote returned no transaction');
    let data = swap.transaction.data;
    if (swap.permit2?.eip712) {
      const { signature } = await this.signTypedData(address, swap.permit2.eip712);
      data = appendPermit2Signature(data, signature);
    }
    const txId = await this.sendEvmTransaction(address, input.chain, {
      to: swap.transaction.to,
      data,
      ...(swap.transaction.value ? { value: BigInt(swap.transaction.value) } : {}),
      ...(swap.transaction.gas ? { gas: BigInt(swap.transaction.gas) } : {}),
    });
    const confirmed = await waitForReceipt(input.chain, txId, true);
    return {
      txId,
      toAmount: formatUnits(BigInt(swap.toAmount ?? '0'), to.decimals),
      status: confirmed ? 'confirmed' : 'pending',
    };
  }

  async signTypedData(address: string, input: WalletTypedData): Promise<{ signature: string }> {
    const result = await this.walletRequest<{ signature: string }>(
      'POST', `/evm/accounts/${address}/sign/typed-data`, {
        domain: input.domain, types: withEip712Domain(input), primaryType: input.primaryType, message: input.message,
      },
    );
    if (typeof result.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(result.signature))
      throw new Error('CDP returned an invalid typed-data signature');
    return { signature: result.signature };
  }

  /**
   * CDP v2 has no address-history endpoint for server-wallet accounts, so
   * the source reports none. Inbound transfers are found from per-chain
   * balance increases (`reconcileBalances` in wallet.ts).
   */
  async history(_address: string, _limit: number): Promise<WalletLedgerEntry[]> {
    return [];
  }
}

/** Wait (up to a minute) for a transaction to be mined successfully. */
async function waitForReceipt(chain: WalletChainId, txHash: string, allowPending = false): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; attempt < 30 && Date.now() < deadline; attempt += 1) {
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const receipt = (await rpc(chain, 'eth_getTransactionReceipt', [txHash], signal).catch(() => null)) as
      | { status?: string }
      | null;
    if (receipt?.status === '0x1') return true;
    if (receipt?.status === '0x0') throw new Error(`transaction ${txHash} reverted`);
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, remaining)));
  }
  if (allowPending) return false;
  throw new Error(`transaction ${txHash} was not mined within a minute`);
}

/**
 * CDP requires `EIP712Domain` in `types`. When the caller omits it, derive it
 * from the domain fields present, in the canonical EIP-712 order.
 */
export function withEip712Domain(input: WalletTypedData): WalletTypedData['types'] {
  if (Object.hasOwn(input.types, 'EIP712Domain')) return input.types;
  const fields = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ].filter((field) => input.domain[field.name] !== undefined && input.domain[field.name] !== null);
  return { EIP712Domain: fields, ...input.types };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}