/**
 * Per-chain facts and the small amount of raw EVM plumbing the CDP client
 * needs: public JSON-RPC reads, EIP-1559 RLP serialization, ERC-20 calldata
 * and decimal/atomic unit conversion. No third-party dependency.
 *
 * CDP v2 coverage (coinbase/cdp-sdk openapi.yaml, checked 2026-10-07):
 *   token-balances      base, ethereum
 *   send/transaction    base, ethereum, avalanche, polygon, optimism, arbitrum
 *   swaps               base, ethereum, arbitrum, optimism, polygon
 * Everything else is read from, or broadcast to, the chain's public RPC.
 */
import type { WalletChainId } from '@beeline/api-contract/wallet';

export type EvmChain = {
  readonly chainId: number;
  readonly rpcUrl: string;
  /** Lowercase symbol of the native gas token. */
  readonly nativeSymbol: string;
  readonly usdc: { readonly address: string; readonly decimals: number };
  readonly cdpBalances: boolean;
  readonly cdpSend: boolean;
  readonly cdpSwap: boolean;
};

export const EVM_CHAINS: Record<WalletChainId, EvmChain> = {
  base: {
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    nativeSymbol: 'eth',
    usdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    cdpBalances: true,
    cdpSend: true,
    cdpSwap: true,
  },
  arbitrum: {
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    nativeSymbol: 'eth',
    usdc: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    cdpBalances: false,
    cdpSend: true,
    cdpSwap: true,
  },
  optimism: {
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    nativeSymbol: 'eth',
    usdc: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    cdpBalances: false,
    cdpSend: true,
    cdpSwap: true,
  },
  polygon: {
    chainId: 137,
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    nativeSymbol: 'pol',
    usdc: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    cdpBalances: false,
    cdpSend: true,
    cdpSwap: true,
  },
  zora: {
    chainId: 7777777,
    rpcUrl: 'https://rpc.zora.energy',
    nativeSymbol: 'eth',
    // Zora has no native USDC; USDzC is the bridged USDC the chain uses.
    usdc: { address: '0xCccCCccc7021b32EBb4e8C08314bD62F7c653EC4', decimals: 6 },
    cdpBalances: false,
    cdpSend: false,
    cdpSwap: false,
  },
  bnb: {
    chainId: 56,
    rpcUrl: 'https://bsc-rpc.publicnode.com',
    nativeSymbol: 'bnb',
    usdc: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    cdpBalances: false,
    cdpSend: false,
    cdpSwap: false,
  },
  avalanche: {
    chainId: 43114,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    nativeSymbol: 'avax',
    usdc: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
    cdpBalances: false,
    cdpSend: true,
    cdpSwap: false,
  },
  ethereum: {
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    nativeSymbol: 'eth',
    usdc: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    cdpBalances: true,
    cdpSend: true,
    cdpSwap: true,
  },
};

/** EIP-7528 native-token placeholder, as CDP balances and swaps use it. */
export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export type EvmAsset = { symbol: string; decimals: number; token: string | null };

/** Resolve an asset symbol on a chain: the native token or USDC. */
export function evmAsset(chain: WalletChainId, symbol: string): EvmAsset {
  const config = EVM_CHAINS[chain];
  const wanted = symbol.trim().toLowerCase();
  if (wanted === config.nativeSymbol || wanted === 'native')
    return { symbol: config.nativeSymbol, decimals: 18, token: null };
  if (wanted === 'usdc') return { symbol: 'usdc', decimals: config.usdc.decimals, token: config.usdc.address };
  throw new Error(`asset ${symbol} unsupported on ${chain}: use ${config.nativeSymbol} or usdc`);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** "1.5" with 6 decimals -> 1500000n. Rejects more precision than the token has. */
export function parseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new Error(`invalid amount: ${amount}`);
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > decimals) throw new Error(`amount ${amount} has more than ${decimals} decimals`);
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** 1500000n with 6 decimals -> "1.5". */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

type RpcCall = { method: string; params: unknown[] };

/** One batched JSON-RPC request; any per-call error rejects the batch. */
export async function rpcBatch(chain: WalletChainId, calls: RpcCall[], signal?: AbortSignal): Promise<unknown[]> {
  const response = await fetch(EVM_CHAINS[chain].rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calls.map((call, id) => ({ jsonrpc: '2.0', id, ...call }))),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`${chain} RPC failed (${response.status})`);
  const rows = (await response.json()) as Array<{
    id: number;
    result?: unknown;
    error?: { message?: string };
  }>;
  if (!Array.isArray(rows)) throw new Error(`${chain} RPC returned no batch`);
  return calls.map((call, id) => {
    const row = rows.find((entry) => entry.id === id);
    if (!row || row.error || row.result === undefined)
      throw new Error(`${chain} RPC ${call.method} failed: ${row?.error?.message ?? 'no result'}`);
    return row.result;
  });
}

export async function rpc(chain: WalletChainId, method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
  return (await rpcBatch(chain, [{ method, params }], signal))[0];
}

/** Native and USDC balance of `address`, in atomic units, from the public RPC. */
export async function rpcNativeAndUsdc(
  chain: WalletChainId,
  address: string,
): Promise<{ native: bigint; usdc: bigint }> {
  const [native, usdc] = await rpcBatch(chain, [
    { method: 'eth_getBalance', params: [address, 'latest'] },
    {
      method: 'eth_call',
      params: [{ to: EVM_CHAINS[chain].usdc.address, data: `0x70a08231${word(address)}` }, 'latest'],
    },
  ]);
  return { native: hexToBigInt(native), usdc: hexToBigInt(usdc) };
}

export function hexToBigInt(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error('RPC returned a non-hex value');
  return value === '0x' ? 0n : BigInt(value);
}

// ---------------------------------------------------------------------------
// Calldata
// ---------------------------------------------------------------------------

function word(value: string | bigint): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.toLowerCase().replace(/^0x/, '');
  return hex.padStart(64, '0');
}

export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** ERC-20 `transfer(to, amount)`. */
export function erc20TransferData(to: string, amount: bigint): string {
  return `0xa9059cbb${word(to)}${word(amount)}`;
}

/** ERC-20 `approve(spender, amount)`. */
export function erc20ApproveData(spender: string, amount: bigint): string {
  return `0x095ea7b3${word(spender)}${word(amount)}`;
}

/** Swap calldata followed by the Permit2 signature length and signature, as CDP expects. */
export function appendPermit2Signature(data: string, signature: string): string {
  const sig = signature.replace(/^0x/, '');
  return `${data}${word(BigInt(sig.length / 2))}${sig}`;
}

// ---------------------------------------------------------------------------
// RLP / EIP-1559
// ---------------------------------------------------------------------------

type RlpInput = Uint8Array | RlpInput[];

function bytesFromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  return Uint8Array.from(Buffer.from(clean.length % 2 ? `0${clean}` : clean, 'hex'));
}

function bytesFromBigInt(value: bigint): Uint8Array {
  return value === 0n ? new Uint8Array() : bytesFromHex(value.toString(16));
}

function rlpLength(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const encoded = bytesFromBigInt(BigInt(length));
  return Uint8Array.of(offset + 55 + encoded.length, ...encoded);
}

export function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0]! < 0x80) return input;
    return Uint8Array.from([...rlpLength(input.length, 0x80), ...input]);
  }
  const body = Buffer.concat(input.map((item) => rlpEncode(item)));
  return Uint8Array.from([...rlpLength(body.length, 0xc0), ...body]);
}

export type Eip1559Transaction = {
  chainId: number;
  to: string;
  value?: bigint;
  data?: string;
  nonce?: bigint;
  maxPriorityFeePerGas?: bigint;
  maxFeePerGas?: bigint;
  gas?: bigint;
};

/** Unsigned EIP-1559 (type 2) serialization; omitted fields encode empty, as CDP fills them. */
export function serializeEip1559(tx: Eip1559Transaction): string {
  const payload = rlpEncode([
    bytesFromBigInt(BigInt(tx.chainId)),
    bytesFromBigInt(tx.nonce ?? 0n),
    bytesFromBigInt(tx.maxPriorityFeePerGas ?? 0n),
    bytesFromBigInt(tx.maxFeePerGas ?? 0n),
    bytesFromBigInt(tx.gas ?? 0n),
    bytesFromHex(tx.to),
    bytesFromBigInt(tx.value ?? 0n),
    bytesFromHex(tx.data ?? '0x'),
    [],
  ]);
  return `0x02${Buffer.from(payload).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const PRICED = new Set(['eth', 'usdc', 'cbbtc', 'pol', 'bnb', 'avax', 'weth']);
const priceCache = new Map<string, { usd: number; at: number }>();

/** USD spot price from Coinbase's public price API, cached for a minute; 0 when unknown. */
export async function usdPrice(symbol: string): Promise<number> {
  const key = symbol.toLowerCase();
  if (key === 'usdc') return 1;
  if (!PRICED.has(key)) return 0;
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.usd;
  const pair = key === 'weth' ? 'ETH' : key === 'cbbtc' ? 'BTC' : key.toUpperCase();
  try {
    const response = await fetch(`https://api.coinbase.com/v2/prices/${pair}-USD/spot`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    const usd = Number(((await response.json()) as { data?: { amount?: string } }).data?.amount);
    if (!Number.isFinite(usd)) throw new Error('no amount');
    priceCache.set(key, { usd, at: Date.now() });
    return usd;
  } catch (error) {
    console.error(`[wallet] ${pair}-USD price read failed:`, error instanceof Error ? error.message : error);
    return cached?.usd ?? 0;
  }
}
