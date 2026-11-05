/**
 * Unit-test the CDP request construction: endpoint paths, the X-Wallet-Auth
 * ES256 signature over the sorted-body hash, and the developer JWT.
 *
 * These tests pin exactly what wire format we send to Coinbase, so a broken
 * endpoint path (like the old `/platform/v2/embedded-wallet-api/...` that
 * returned 404) or a malformed auth header is caught before the code reaches
 * production.
 *
 * Server-wallet model (rewritten 2026-11): no "end-user" entity. A wallet IS
 * an EVM account identified by its address. All paths are under
 * `/platform/v2/evm/...` and `/platform/v2/solana/...`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { cdpJwt, CdpWalletClient, WalletTransactionPending, withEip712Domain } from './cdp-client.js';

/** A real Ed25519 keypair for dev auth in tests. */
function testEd25519Creds(): { keyId: string; keySecret: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  return { keyId: 'test-kid', keySecret: seed.toString('base64') };
}

/** A useable P-256 keypair for test wallet-secret signing. */
function testP256Key(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

describe('cdp request construction', () => {
  describe('developer JWT (Ed25519)', () => {
    it.each([
      { method: 'GET', path: '/platform/v2/evm/token-balances/base/0xabc',
        uri: 'GET api.cdp.coinbase.com/platform/v2/evm/token-balances/base/0xabc' },
      { method: 'POST', path: '/platform/v2/evm/accounts',
        uri: 'POST api.cdp.coinbase.com/platform/v2/evm/accounts' },
    ])('builds a JWT with the correct claims for $method', ({method, path, uri}) => {
      const jwt = cdpJwt(testEd25519Creds(), method, path);
      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      expect(header).toMatchObject({ alg: 'EdDSA', kid: 'test-kid', typ: 'JWT' });
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      expect(payload).toMatchObject({ sub: 'test-kid', iss: 'cdp', uris: [uri] });
      expect(payload.exp - payload.nbf).toBe(120);
    });
  });

  it('forwards EIP-712 to the account signing endpoint with both JWTs and no network allowlist', async () => {
    const client = new CdpWalletClient({ ...testEd25519Creds(), walletSecret: testP256Key().privateKey });
    const originalFetch = globalThis.fetch;
    const signature = `0x${'ab'.repeat(65)}`;
    const payload = {
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'0'.repeat(40)}` },
      types: { BeelineTest: [{ name: 'notice', type: 'string' }] },
      primaryType: 'BeelineTest', message: { notice: 'Harmless test; not an order' },
    };
    try {
      globalThis.fetch = async (url, options) => {
        expect(String(url)).toBe('https://api.cdp.coinbase.com/platform/v2/evm/accounts/0xabc/sign/typed-data');
        expect(options?.method).toBe('POST');
        // CDP requires EIP712Domain; it is derived from the domain fields present.
        expect(JSON.parse(options?.body as string)).toEqual({
          ...payload,
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
            ...payload.types,
          },
        });
        const headers = options?.headers as Record<string, string>;
        expect(headers.authorization).toMatch(/^Bearer /);
        expect(headers['x-wallet-auth']).toBeTruthy();
        const auth = JSON.parse(Buffer.from(headers['x-wallet-auth']!.split('.')[1]!, 'base64url').toString());
        expect(auth.uris).toEqual(['POST api.cdp.coinbase.com/platform/v2/evm/accounts/0xabc/sign/typed-data']);
        expect(auth.reqHash).toMatch(/^[a-f0-9]{64}$/);
        return Response.json({ signature });
      };
      await expect(client.signTypedData('0xabc', payload)).resolves.toEqual({ signature });
      globalThis.fetch = async () => Response.json({ signature: 'missing' });
      await expect(client.signTypedData('0xabc', payload)).rejects.toThrow('invalid typed-data signature');
      globalThis.fetch = async () => new Response('policy refused', { status: 403 });
      await expect(client.signTypedData('0xabc', payload)).rejects.toThrow('403');
    } finally { globalThis.fetch = originalFetch; }
  });

  describe('endpoint paths (server-wallet API)', () => {
    it('creates EVM accounts under /platform/v2/evm/accounts (NOT /platform/v2/embedded-wallet-api)', async () => {
      const creds = { ...testEd25519Creds(), walletSecret: testP256Key().privateKey };
      const client = new CdpWalletClient(creds);
      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ address: '0xabc', name: 'test-wallet', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }));
        };
        await client.createEvmAccount('test-wallet');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/evm/accounts');
      expect(capturedUrl).not.toContain('/embedded-wallet-api');
      expect(capturedUrl).not.toContain('/platform/v2/users');
    });

    it('creates Solana accounts under /platform/v2/solana/accounts', async () => {
      const creds = { ...testEd25519Creds(), walletSecret: testP256Key().privateKey };
      const client = new CdpWalletClient(creds);
      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ address: 'SolTest', name: 'test-sol', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }));
        };
        await client.createSolanaAccount('test-sol');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/solana/accounts');
      expect(capturedUrl).not.toContain('/embedded-wallet-api');
    });

    it('reads balances from /platform/v2/evm/token-balances/{network}/{address}', async () => {
      const creds = testEd25519Creds();
      const client = new CdpWalletClient(creds);
      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ balances: [] }));
        };
        await client.balances('base', '0xabc');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/evm/token-balances/base/0xabc');
      expect(capturedUrl).not.toContain('/embedded-wallet-api');
      expect(capturedUrl).not.toContain('projectId=');
    });
  });

  describe('X-Wallet-Auth (ES256)', () => {
    it('includes x-wallet-auth header on wallet-authenticated requests (account creation)', async () => {
      const key = testP256Key();
      const creds = { ...testEd25519Creds(), walletSecret: key.privateKey };
      const client = new CdpWalletClient(creds);

      let capturedHeaders: Record<string, string> = {};
      let capturedBody = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
          capturedHeaders = (opts?.headers as Record<string, string>) ?? {};
          capturedBody = (opts?.body as string) ?? '';
          return new Response(JSON.stringify({ address: '0xabc', name: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
        };
        await client.createEvmAccount('test-wallet-1');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedHeaders['authorization']).toMatch(/^Bearer /);
      expect(capturedHeaders['x-wallet-auth']).toBeTruthy();
      expect(capturedHeaders['x-wallet-auth'].split('.')).toHaveLength(3);
      const walletPart = JSON.parse(
        Buffer.from(capturedHeaders['x-wallet-auth'].split('.')[1]!, 'base64url').toString(),
      );
      expect(walletPart.uris).toBeDefined();
      expect(walletPart.reqHash).toBe('794dd1f73c999ca5c30d5166a4c5b031f950f026cf879bdb162eecc63a219410');
      expect(walletPart.jti).toBeDefined();
      // Body should be { name: "test-wallet-1" } sorted (only one key)
      const parsed = JSON.parse(capturedBody);
      expect(parsed.name).toBe('test-wallet-1');
    });

    it('does not send x-wallet-auth on dev-authenticated requests (balances, no wallet secret needed)', async () => {
      const creds = testEd25519Creds(); // no wallet secret
      const client = new CdpWalletClient(creds);

      let capturedHeaders: Record<string, string> = {};
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
          capturedHeaders = (opts?.headers as Record<string, string>) ?? {};
          return new Response(JSON.stringify({ balances: [] }));
        };
        await client.balances('base', '0xabc');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedHeaders['authorization']).toBeDefined();
      expect(capturedHeaders['x-wallet-auth']).toBeUndefined();
    });
  });
});
describe('cdp Ed25519 key parsing', () => {
  it('signs with a raw 64-byte Ed25519 secret (the shape CDP hands out)', () => {
    // A CDP API key secret is the base64 of the raw 64-byte Ed25519 key
    // (32-byte seed + 32-byte public). Node's PKCS8 export starts with a
    // 16-byte prefix, so slice it back to the seed and append the public half
    // to reproduce CDP's exact 64-byte shape.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const seed = pkcs8.subarray(pkcs8.length - 32);
    const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
    const rawSecret = Buffer.concat([seed, pub]).toString('base64');
    // Before the fix this threw DECODER routines::unsupported.
    const jwt = cdpJwt({ keyId: 'test-kid', keySecret: rawSecret }, 'GET', '/v2/x');
    expect(jwt.split('.')).toHaveLength(3);
  });
});

/**
 * The real CDP client on every listed chain, with `fetch` mocked: balances
 * read CDP only where it has coverage and the public RPC elsewhere, sends and
 * swaps use the CDP v2 endpoints (never `/transfers`), and typed data gains a
 * derived EIP712Domain. RLP fixtures were cross-checked against viem's
 * serializeTransaction.
 */

// Public Bridge2 address used by the request fixture.
const HYPERLIQUID_BRIDGE2 = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';

const OWNER = '0xE196B6eD2f276A5c33a122562F13d9a199d89a23';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

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

  it('approves exactly the given amount for the contract, waits, then sends the call', async () => {
    const vault = '0x7777777777777777777777777777777777777777';
    let sends = 0;
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/send/transaction'))
        return Response.json({ transactionHash: sends++ ? '0xcallhash' : '0xapprovehash' });
      if (call.url === 'https://arb1.arbitrum.io/rpc')
        return rpcReply(call, { eth_getTransactionReceipt: { status: '0x1' } });
      return new Response('unexpected', { status: 500 });
    });
    const result = await client().contractCall(OWNER, {
      chain: 'arbitrum',
      contract: vault,
      data: '0xd0e30db0',
      value: '0.001',
      approve: { asset: 'usdc', amount: '5' },
    });
    expect(result).toEqual({ txId: '0xcallhash' });
    expect(calls.map((call) => call.url.split('/').at(-1))).toEqual(['transaction', 'rpc', 'transaction']);
    // approve(vault, 5 USDC) on the Arbitrum USDC contract.
    expect(calls[0]!.body.transaction).toContain(
      `af88d065e77c8cc2239327c5edb3a432268e5831` +
        `80b844095ea7b3${'0'.repeat(24)}${'7'.repeat(40)}${(5_000_000).toString(16).padStart(64, '0')}`,
    );
    expect(calls[1]!.body[0]).toMatchObject({ method: 'eth_getTransactionReceipt', params: ['0xapprovehash'] });
    // The call itself: to the vault, 0.001 ETH, the given call data.
    expect(calls[2]!.body.transaction).toContain(`${'7'.repeat(40)}87038d7ea4c6800084d0e30db0`);
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
  it('bounds a stalled receipt RPC and returns pending without another submission', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    let submissions = 0;
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
      if (String(url).endsWith('/evm/swaps')) return Response.json({
        toAmount: '43210000', transaction: { to: RECIPIENT, data: '0xabcd' },
      });
      if (String(url).endsWith('/send/transaction')) {
        submissions += 1;
        return Response.json({ transactionHash: '0xstalled' });
      }
      return new Promise<Response>((_, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
    });
    const result = client().swap(OWNER, { chain: 'arbitrum', fromAsset: 'eth', toAsset: 'usdc', amount: '0.017' });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ txId: '0xstalled', status: 'pending' });
    expect(submissions).toBe(1);
  });

  it.each([false, true])('keeps an unconfirmed swap pending without resubmitting (RPC error: %s)', async (rpcError) => {
    vi.useFakeTimers();
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/evm/swaps')) return Response.json({
        toAmount: '43210000', transaction: { to: RECIPIENT, data: '0xabcd' },
      });
      if (call.url === 'https://arb1.arbitrum.io/rpc') {
        if (rpcError) throw new Error('RPC unavailable');
        return rpcReply(call, { eth_getTransactionReceipt: null });
      }
      return Response.json({ transactionHash: '0xpending' });
    });
    const result = client().swap(OWNER, { chain: 'arbitrum', fromAsset: 'eth', toAsset: 'usdc', amount: '0.017' });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ txId: '0xpending', status: 'pending' });
    expect(calls.filter((call) => call.url.endsWith('/send/transaction'))).toHaveLength(1);
  });

  it('Reproduction swap-receipt-1: rejects an on-chain failed swap receipt', async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/evm/swaps')) return Response.json({
        toAmount: '43210000', transaction: { to: RECIPIENT, data: '0xabcd', gas: '420491' },
      });
      if (call.url === 'https://arb1.arbitrum.io/rpc')
        return rpcReply(call, { eth_getTransactionReceipt: { status: '0x0', gasUsed: '0x66a8b' } });
      return Response.json({ transactionHash: '0xfailed' });
    });
    await expect(client().swap(OWNER, {
      chain: 'arbitrum', fromAsset: 'eth', toAsset: 'usdc', amount: '0.017',
    })).rejects.toThrow('transaction 0xfailed reverted');
    expect(calls.filter((call) => call.url.endsWith('/send/transaction'))).toHaveLength(1);
  });

  it('swaps ETH to USDC on Arbitrum through CDP /evm/swaps and send/transaction', async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith('/evm/swaps'))
        return Response.json({
          liquidityAvailable: true,
          toAmount: '43210000',
          transaction: { to: '0x2222222222222222222222222222222222222222', data: '0xabcd', value: '17000000000000000', gas: '300000' },
        });
      if (call.url === 'https://arb1.arbitrum.io/rpc')
        return rpcReply(call, { eth_getTransactionReceipt: { status: '0x1' } });
      return Response.json({ transactionHash: '0xswap' });
    });
    await expect(
      client().swap(OWNER, { chain: 'arbitrum', fromAsset: 'eth', toAsset: 'usdc', amount: '0.017' }),
    ).resolves.toEqual({ txId: '0xswap', toAmount: '43.21', status: 'confirmed' });
    expect(calls.map((call) => call.url.replace('https://api.cdp.coinbase.com/platform/v2', ''))).toEqual([
      '/evm/swaps',
      `/evm/accounts/${OWNER}/send/transaction`,
      'https://arb1.arbitrum.io/rpc',
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



// Ephemeral fixture keys only. All provider and chain requests are intercepted.
function client(wallet = true): CdpWalletClient {
  return new CdpWalletClient({
    keyId: 'completion-fixture',
    keySecret: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ...(wallet ? { walletSecret: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } : {}),
  });
}
const address = `0x${'1'.repeat(40)}`;
const contract = `0x${'2'.repeat(40)}`;
const hash = `0x${'a'.repeat(64)}`;
const pay = { completionV1: true, chain: 'base', asset: 'usdc', amount: '1', to: contract } as const;
const call = { completionV1: true, chain: 'base', contract, data: '0x12345678',
  approve: { asset: 'usdc', amount: '1' } } as const;

describe('wallet completionV1 at the provider adapter', () => {
  it.each([true, undefined] as const)('parks an unconfirmed approval after one receipt without a dependent call (completionV1=%s)', async completionV1 => {
    vi.useFakeTimers();
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      if (String(url).endsWith('/send/transaction')) {
        methods.push('send');
        return Response.json({ transactionHash: hash });
      }
      const rows = JSON.parse(String(init.body)) as { id: number; method: string }[];
      methods.push(...rows.map(row => row.method));
      return Response.json(rows.map(({ id }) => ({ id, result: null })));
    });
    const result = await client().contractCall(address, { ...call, completionV1 }).catch(error => error);
    expect(result).toBeInstanceOf(WalletTransactionPending);
    expect(result).toMatchObject({ txId: hash, approval: { asset: 'usdc', amount: '1', spender: contract } });
    expect(result.message).toContain('dependent transaction was not submitted');
    expect(methods).toEqual(['send', 'eth_getTransactionReceipt']);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(methods).toEqual(['send', 'eth_getTransactionReceipt']);
  });

  it.each([true, undefined] as const)('sends the dependent call only after one confirmed receipt (completionV1=%s)', async completionV1 => {
    let sends = 0;
    let receipts = 0;
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      if (String(url).endsWith('/send/transaction')) {
        sends += 1;
        return Response.json({ transactionHash: hash });
      }
      const rows = JSON.parse(String(init.body)) as { id: number; method: string }[];
      expect(rows.map(row => row.method)).toEqual(['eth_getTransactionReceipt']);
      receipts += 1;
      expect(sends).toBe(1);
      return Response.json(rows.map(({ id }) => ({ id, result: { status: '0x1' } })));
    });
    expect(await client().contractCall(address, { ...call, completionV1 })).toEqual({ txId: hash });
    expect({ sends, receipts }).toEqual({ sends: 2, receipts: 1 });
  });

  it.each(([null, 'rpc-failure', '0x0', '0x1'] as const).flatMap(status =>
    [true, undefined].map(completionV1 => ({ status, completionV1: completionV1 as true | undefined }))))
    ('observes a final swap receipt once ($status, completionV1=$completionV1)', async ({status, completionV1}) => {
    vi.useFakeTimers();
    let sends = 0;
    let receipts = 0;
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      if (String(url).endsWith('/evm/swaps')) return Response.json({ toAmount: '1000000',
        transaction: { to: contract, data: '0x12345678' } });
      if (String(url).endsWith('/send/transaction')) {
        sends += 1;
        return Response.json({ transactionHash: hash });
      }
      receipts += 1;
      if (status === 'rpc-failure') throw new Error('synthetic unavailable');
      const rows = JSON.parse(String(init.body)) as { id: number }[];
      return Response.json(rows.map(({ id }) => ({ id, result: status === null ? null : { status } })));
    });
    const result = client().swap(address, { completionV1, chain: 'base',
      fromAsset: 'eth', toAsset: 'usdc', amount: '0.001' });
    if (status === '0x0') await expect(result).rejects.toThrow(`transaction ${hash} reverted`);
    else await expect(result).resolves.toMatchObject({ txId: hash, status: status === '0x1' ? 'confirmed' : 'pending' });
    expect({ sends, receipts }).toEqual({ sends: 1, receipts: 1 });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect({ sends, receipts }).toEqual({ sends: 1, receipts: 1 });
  });

  it.each([true, undefined] as const)('does not re-quote, sign or submit while approval is pending (completionV1=%s)', async completionV1 => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      if (path.endsWith('/evm/swaps')) return Response.json({ issues: { allowance: { spender: contract } },
        transaction: { to: contract, data: '0x12345678' } });
      if (path.endsWith('/send/transaction')) return Response.json({ transactionHash: hash });
      const rows = JSON.parse(String(init.body)) as { id: number }[];
      return Response.json(rows.map(({ id }) => ({ id, result: null })));
    });
    await expect(client().swap(address, { completionV1, chain: 'base', fromAsset: 'usdc',
      toAsset: 'eth', amount: '1' })).rejects.toMatchObject({ txId: hash, approval: { spender: contract } });
    expect(requests).toHaveLength(3);
    expect(requests.filter(path => path.endsWith('/evm/swaps'))).toHaveLength(1);
    expect(requests.filter(path => path.endsWith('/send/transaction'))).toHaveLength(1);
    expect(requests.some(path => path.includes('/sign/'))).toBe(false);
  });

  it.each(['spender', 'recipient'] as const)('rejects an invalid provider %s before any approval, signing or broadcast', async field => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      requests.push(String(url));
      if (!String(url).endsWith('/evm/swaps')) throw new Error('financial effect must not be admitted');
      return Response.json({ issues: { allowance: { spender: field === 'spender' ? 'invalid-provider-text' : contract } },
        transaction: { to: field === 'recipient' ? 'invalid-provider-text' : contract, data: '0x12345678' } });
    });
    const error = await client().swap(address, { completionV1: true, chain: 'base', fromAsset: 'usdc',
      toAsset: 'eth', amount: '1' }).catch(value => value);
    expect(error).not.toBeInstanceOf(WalletTransactionPending);
    expect(error.message).toContain(field === 'spender' ? 'invalid approval spender' : 'invalid transaction recipient');
    expect(error.message).not.toContain('invalid-provider-text');
    expect(requests).toHaveLength(1);
  });

  it.each(['lost', 'bad-json', 'invalid-hash', 'null', 408, 409, 429, 500] as const)(
    'preserves UNKNOWN after an admitted CDP broadcast (%s), without a resend', async failure => {
      vi.useFakeTimers();
      let sends = 0;
      vi.stubGlobal('fetch', async () => {
        sends += 1;
        if (failure === 'lost') throw new Error('fixture response was lost');
        if (failure === 'bad-json') return new Response('not json');
        if (failure === 'invalid-hash') return Response.json({ transactionHash: 'not-a-hash' });
        if (failure === 'null') return Response.json(null);
        return new Response('fixture unavailable', { status: failure });
      });
      const error = await client().sendTransaction(address, pay).catch(value => value);
      expect(error).toBeInstanceOf(WalletTransactionPending);
      expect(error.message).toContain('UNKNOWN');
      expect(error.txId).toBeUndefined();
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(sends).toBe(1);
    },
  );

  it('keeps a definitive provider refusal and preflight validation separate from uncertainty', async () => {
    const fetch = vi.fn(async () => new Response('fixture invalid input', { status: 422 }));
    vi.stubGlobal('fetch', fetch);
    const configured = client();
    const refusal = await configured.sendTransaction(address, pay).catch(value => value);
    expect(refusal).not.toBeInstanceOf(WalletTransactionPending);
    expect(refusal.message).toBe('CDP refused transaction (422)');
    fetch.mockClear();
    await expect(configured.sendTransaction(address, { ...pay, to: 'invalid' })).rejects.toThrow('invalid recipient');
    await expect(client(false).sendTransaction(address, pay)).rejects.toThrow('Wallet secret required');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a lost public-RPC broadcast UNKNOWN after signing, with no automatic redispatch', async () => {
    vi.useFakeTimers();
    const methods: string[] = [];
    let signatures = 0;
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      if (String(url).endsWith('/sign/transaction')) {
        signatures += 1;
        return Response.json({ signedTransaction: '0x02aabb' });
      }
      const rows = JSON.parse(String(init.body)) as { id: number; method: string }[];
      methods.push(...rows.map(row => row.method));
      if (rows.some(row => row.method === 'eth_sendRawTransaction'))
        throw new Error('fixture lost broadcast response');
      return Response.json(rows.map(({ id, method }) => ({ id, result:
        method === 'eth_getBlockByNumber' ? { baseFeePerGas: '0x1' } : '0x100' })));
    });
    const error = await client().sendTransaction(address, { ...pay, chain: 'zora' }).catch(value => value);
    expect(error).toBeInstanceOf(WalletTransactionPending);
    expect(error.message).toContain('UNKNOWN');
    expect(error.txId).toBeUndefined();
    expect(signatures).toBe(1);
    expect(methods.filter(method => method === 'eth_sendRawTransaction')).toHaveLength(1);
    const before = [...methods];
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(methods).toEqual(before);
  });

  it('retains UNKNOWN approval identity if its broadcast response is lost, and sends no call', async () => {
    const fetch = vi.fn(async () => { throw new Error('fixture lost approval response'); });
    vi.stubGlobal('fetch', fetch);
    const error = await client().contractCall(address, call).catch(value => value);
    expect(error).toBeInstanceOf(WalletTransactionPending);
    expect(error.txId).toBeUndefined();
    expect(error.approval).toEqual({ asset: 'usdc', amount: '1', spender: contract });
    expect(error.message).toContain('Approval submission is UNKNOWN');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not reclassify the old non-opt-in provider adapter', async () => {
    vi.stubGlobal('fetch', async () => new Response('legacy refusal', { status: 500 }));
    const { completionV1: _, ...legacy } = pay;
    const error = await client().sendTransaction(address, legacy).catch(value => value);
    expect(error).not.toBeInstanceOf(WalletTransactionPending);
    expect(error.message).toContain('failed (500): legacy refusal');
  });
});
