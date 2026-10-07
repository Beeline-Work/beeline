/**
 * The real CDP client on every listed chain, with `fetch` mocked: balances
 * read CDP only where it has coverage and the public RPC elsewhere, sends and
 * swaps use the CDP v2 endpoints (never `/transfers`), and typed data gains a
 * derived EIP712Domain. RLP fixtures were cross-checked against viem's
 * serializeTransaction.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpWalletClient, withEip712Domain } from './cdp-client.js';
import { HYPERLIQUID_BRIDGE2, formatUnits, parseUnits } from './evm-chain.js';

const OWNER = '0xE196B6eD2f276A5c33a122562F13d9a199d89a23';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

function client(): CdpWalletClient {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const wallet = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  return new CdpWalletClient({
    keyId: 'test-kid',
    keySecret: pkcs8.subarray(pkcs8.length - 32).toString('base64'),
    walletSecret: (wallet.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
  });
}

type Call = { url: string; method: string; body: any };

/** Route mocked responses by URL; every request is recorded. */
function mockFetch(route: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    const call = {
      url: String(url),
      method: options?.method ?? 'GET',
      body: options?.body ? JSON.parse(options.body as string) : undefined,
    };
    calls.push(call);
    return route(call);
  });
  return calls;
}

/** Answer a JSON-RPC batch from a method -> result table. */
function rpcReply(call: Call, results: Record<string, unknown>): Response {
  return Response.json(
    (call.body as Array<{ id: number; method: string }>).map((entry) => ({
      jsonrpc: '2.0',
      id: entry.id,
      result: results[entry.method],
    })),
  );
}

const price = (usd: string) => Response.json({ data: { amount: usd, base: 'ETH', currency: 'USD' } });

afterEach(() => vi.unstubAllGlobals());

describe('balances on every chain', () => {
  it('reads an Arbitrum-only balance from the public RPC, never CDP token-balances', async () => {
    const calls = mockFetch((call) => {
      if (call.url === 'https://arb1.arbitrum.io/rpc')
        return rpcReply(call, { eth_getBalance: '0x40a2d061edd7e8', eth_call: `0x${'0'.repeat(64)}` });
      if (call.url.startsWith('https://api.coinbase.com/v2/prices/ETH-USD')) return price('2500');
      return new Response('unexpected', { status: 500 });
    });
    const coins = await client().balances('arbitrum', OWNER);
    expect(coins).toEqual([
      { symbol: 'eth', name: 'Ethereum', chain: 'arbitrum', amount: '0.01819341438935652', usd: '$45.48' },
    ]);
    expect(calls.some((call) => call.url.includes('api.cdp.coinbase.com'))).toBe(false);
    const batch = calls.find((call) => call.url.includes('arbitrum'))!.body;
    expect(batch[0]).toMatchObject({ method: 'eth_getBalance', params: [OWNER, 'latest'] });
    expect(batch[1].params[0]).toEqual({
      to: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      data: `0x70a08231${'0'.repeat(24)}${OWNER.slice(2).toLowerCase()}`,
    });
  });

  it('reads USDC with the chain decimals, including 18-decimal USDC on BNB', async () => {
    mockFetch((call) =>
      rpcReply(call, { eth_getBalance: '0x0', eth_call: `0x${(12n * 10n ** 18n).toString(16).padStart(64, '0')}` }),
    );
    expect(await client().balances('bnb', OWNER)).toEqual([
      { symbol: 'usdc', name: 'USD Coin', chain: 'bnb', amount: '12', usd: '$12.00' },
    ]);
  });

  it('parses CDP token-balances amounts {amount, decimals} on Base', async () => {
    mockFetch((call) => {
      if (call.url.includes('/evm/token-balances/base/'))
        return Response.json({
          balances: [
            {
              amount: { amount: '2500000', decimals: 6 },
              token: { network: 'base', symbol: 'USDC', contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
            },
            {
              amount: { amount: '1000000000000000000', decimals: 18 },
              token: { network: 'base', symbol: 'ETH', contractAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' },
            },
          ],
        });
      return price('2500');
    });
    expect(await client().balances('base', OWNER)).toEqual([
      { symbol: 'usdc', name: 'USD Coin', chain: 'base', amount: '2.5', usd: '$2.50' },
      { symbol: 'eth', name: 'Ethereum', chain: 'base', amount: '1', usd: '$2,500.00' },
    ]);
  });

  it('falls back to the public RPC when CDP token-balances fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch((call) => {
      if (call.url.includes('api.cdp.coinbase.com')) return new Response('nope', { status: 404 });
      return rpcReply(call, { eth_getBalance: '0x0', eth_call: `0x${(7_000_000n).toString(16).padStart(64, '0')}` });
    });
    expect(await client().balances('ethereum', OWNER)).toEqual([
      { symbol: 'usdc', name: 'USD Coin', chain: 'ethereum', amount: '7', usd: '$7.00' },
    ]);
  });
});

describe('sends', () => {
  it('sends native ETH on Arbitrum through send/transaction, never /transfers', async () => {
    const calls = mockFetch(() => Response.json({ transactionHash: '0xhash' }));
    await expect(
      client().sendTransaction(OWNER, { chain: 'arbitrum', asset: 'eth', amount: '0.001', to: RECIPIENT }),
    ).resolves.toEqual({ txId: '0xhash' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.cdp.coinbase.com/platform/v2/evm/accounts/${OWNER}/send/transaction`);
    expect(calls[0]!.body).toEqual({
      network: 'arbitrum',
      transaction: '0x02e682a4b18080808094111111111111111111111111111111111111111187038d7ea4c6800080c0',
    });
  });

  it('sends USDC on Arbitrum as an ERC-20 transfer to the USDC contract', async () => {
    const calls = mockFetch(() => Response.json({ transactionHash: '0xhash' }));
    await client().sendTransaction(OWNER, { chain: 'arbitrum', asset: 'usdc', amount: '5', to: HYPERLIQUID_BRIDGE2 });
    expect(calls[0]!.body.transaction).toBe(
      '0x02f86482a4b18080808094af88d065e77c8cc2239327c5edb3a432268e583180b844a9059cbb0000000000000000000000002df1c51e09aecf9cacb7bc98cb1742757f163df700000000000000000000000000000000000000000000000000000000004c4b40c0',
    );
  });

  it('signs with CDP and broadcasts through the RPC where CDP cannot send (Zora)', async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/sign/transaction')) return Response.json({ signedTransaction: '0xsigned' });
      if (Array.isArray(call.body) && call.body[0].method === 'eth_sendRawTransaction')
        return rpcReply(call, { eth_sendRawTransaction: '0xzorahash' });
      return rpcReply(call, {
        eth_getTransactionCount: '0x7',
        eth_maxPriorityFeePerGas: '0x3e8',
        eth_getBlockByNumber: { baseFeePerGas: '0x16e16c' },
        eth_estimateGas: '0x445c',
      });
    });
    await expect(
      client().sendTransaction(OWNER, { chain: 'zora', asset: 'eth', amount: '0.000000000000000001', to: RECIPIENT }),
    ).resolves.toEqual({ txId: '0xzorahash' });
    const signed = calls.find((call) => call.url.endsWith('/sign/transaction'))!;
    expect(signed.body).toEqual({
      transaction: '0x02e78376adf1078203e8832dc6c08252089411111111111111111111111111111111111111110180c0',
    });
    expect(calls.at(-1)!.body[0]).toMatchObject({ method: 'eth_sendRawTransaction', params: ['0xsigned'] });
  });

  it('refuses a malformed recipient or an asset the chain does not have before calling CDP', async () => {
    const calls = mockFetch(() => Response.json({}));
    await expect(
      client().sendTransaction(OWNER, { chain: 'arbitrum', asset: 'eth', amount: '1', to: '0xabc' }),
    ).rejects.toThrow('invalid recipient address');
    await expect(
      client().sendTransaction(OWNER, { chain: 'polygon', asset: 'eth', amount: '1', to: RECIPIENT }),
    ).rejects.toThrow('asset eth unsupported on polygon');
    expect(calls).toHaveLength(0);
  });
});

describe('swaps', () => {
  it('swaps ETH to USDC on Arbitrum through CDP /evm/swaps and send/transaction', async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/evm/swaps'))
        return Response.json({
          liquidityAvailable: true,
          toAmount: '43210000',
          transaction: { to: '0x2222222222222222222222222222222222222222', data: '0xabcd', value: '17000000000000000', gas: '300000' },
        });
      return Response.json({ transactionHash: '0xswap' });
    });
    await expect(
      client().swap(OWNER, { chain: 'arbitrum', fromAsset: 'eth', toAsset: 'usdc', amount: '0.017' }),
    ).resolves.toEqual({ txId: '0xswap', toAmount: '43.21' });
    expect(calls.map((call) => call.url.replace('https://api.cdp.coinbase.com/platform/v2', ''))).toEqual([
      '/evm/swaps',
      `/evm/accounts/${OWNER}/send/transaction`,
    ]);
    expect(calls[0]!.body).toEqual({
      network: 'arbitrum',
      fromToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      toToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      fromAmount: '17000000000000000',
      taker: OWNER,
    });
    expect(calls[1]!.body.network).toBe('arbitrum');
    expect(calls.some((call) => call.url.includes('/transfers'))).toBe(false);
  });

  it('approves Permit2 when needed and appends the Permit2 signature for a USDC sell', async () => {
    const permit = {
      domain: { name: 'Permit2', chainId: 42161, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      types: { PermitTransferFrom: [{ name: 'nonce', type: 'uint256' }] },
      primaryType: 'PermitTransferFrom',
      message: { nonce: '1' },
    };
    let quotes = 0;
    const signature = `0x${'ab'.repeat(65)}`;
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/evm/swaps')) {
        quotes += 1;
        return Response.json({
          liquidityAvailable: true,
          toAmount: '1000000000000000',
          issues: quotes === 1 ? { allowance: { spender: '0x000000000022D473030F116dDEE9F6B43aC78BA3' } } : {},
          permit2: { eip712: permit },
          transaction: { to: '0x2222222222222222222222222222222222222222', data: '0xabcd' },
        });
      }
      if (call.url.endsWith('/sign/typed-data')) return Response.json({ signature });
      if (call.url === 'https://arb1.arbitrum.io/rpc')
        return rpcReply(call, { eth_getTransactionReceipt: { status: '0x1' } });
      return Response.json({ transactionHash: `0xtx${calls.length}` });
    });
    const result = await client().swap(OWNER, { chain: 'arbitrum', fromAsset: 'usdc', toAsset: 'eth', amount: '3' });
    expect(result.toAmount).toBe('0.001');
    const sends = calls.filter((call) => call.url.endsWith('/send/transaction'));
    expect(sends).toHaveLength(2);
    // The approval: approve(Permit2, 3 USDC) on the USDC contract.
    expect(sends[0]!.body.transaction).toContain('095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3');
    // The swap: calldata + uint256(65) + signature.
    expect(sends[1]!.body.transaction).toContain(`abcd${(65).toString(16).padStart(64, '0')}${'ab'.repeat(65)}`);
    const signed = calls.find((call) => call.url.endsWith('/sign/typed-data'))!;
    expect(signed.body.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
  });

  it('returns "swap unsupported on <chain>" without calling CDP where its swap API has no coverage', async () => {
    const calls = mockFetch(() => Response.json({}));
    for (const chain of ['zora', 'bnb', 'avalanche'] as const)
      await expect(
        client().swap(OWNER, { chain, fromAsset: 'usdc', toAsset: 'eth', amount: '1' }),
      ).rejects.toThrow(`swap unsupported on ${chain}`);
    expect(calls).toHaveLength(0);
  });
});

describe('typed data', () => {
  const hyperliquid = {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'0'.repeat(40)}` },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: 'a', connectionId: `0x${'0'.repeat(64)}` },
  };

  it('derives EIP712Domain from the present domain fields and keeps chainId 1337', async () => {
    const calls = mockFetch(() => Response.json({ signature: `0x${'cd'.repeat(65)}` }));
    await client().signTypedData(OWNER, hyperliquid);
    expect(calls[0]!.body).toEqual({
      ...hyperliquid,
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        ...hyperliquid.types,
      },
    });
    expect(calls[0]!.body.domain.chainId).toBe(1337);
  });

  it('derives EIP712Domain for any protocol, not only Hyperliquid', () => {
    const field = (name: string, type: string) => ({ name, type });
    const cases = [
      // EIP-2612 USDC permit on Arbitrum.
      [
        { name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
        [field('name', 'string'), field('version', 'string'), field('chainId', 'uint256'), field('verifyingContract', 'address')],
      ],
      // Permit2 has no version.
      [
        { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
        [field('name', 'string'), field('chainId', 'uint256'), field('verifyingContract', 'address')],
      ],
      // A salted domain on Polygon; unknown fields are not domain fields.
      [
        { chainId: 137, salt: `0x${'11'.repeat(32)}`, extra: 'ignored' },
        [field('chainId', 'uint256'), field('salt', 'bytes32')],
      ],
    ] as const;
    for (const [domain, expected] of cases)
      expect(withEip712Domain({ ...hyperliquid, domain }).EIP712Domain).toEqual(expected);
  });

  it('leaves a caller-supplied EIP712Domain untouched', () => {
    const types = { EIP712Domain: [{ name: 'name', type: 'string' }], ...hyperliquid.types };
    expect(withEip712Domain({ ...hyperliquid, types })).toBe(types);
  });
});

describe('history', () => {
  it('makes no call to the nonexistent CDP history endpoint', async () => {
    const calls = mockFetch(() => Response.json({}));
    await expect(client().history(OWNER, 10)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('units', () => {
  it('converts decimals exactly and rejects excess precision', () => {
    expect(parseUnits('0.017', 18)).toBe(17_000_000_000_000_000n);
    expect(parseUnits('5', 6)).toBe(5_000_000n);
    expect(formatUnits(18193414389356520n, 18)).toBe('0.01819341438935652');
    expect(() => parseUnits('1.0000001', 6)).toThrow('more than 6 decimals');
    expect(() => parseUnits('-1', 6)).toThrow('invalid amount');
  });
});
