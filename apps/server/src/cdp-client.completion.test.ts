import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpWalletClient, WalletTransactionPending } from './cdp-client.js';

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
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('wallet completionV1 at the provider adapter', () => {
  it('parks an unconfirmed approval after one receipt and never sends the dependent call', async () => {
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
    const result = await client().contractCall(address, call).catch(error => error);
    expect(result).toBeInstanceOf(WalletTransactionPending);
    expect(result).toMatchObject({ txId: hash, approval: { asset: 'usdc', amount: '1', spender: contract } });
    expect(result.message).toContain('dependent transaction was not submitted');
    expect(methods).toEqual(['send', 'eth_getTransactionReceipt']);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(methods).toEqual(['send', 'eth_getTransactionReceipt']);
  });

  it('sends the dependent call only after the one admitted receipt confirms approval', async () => {
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
    expect(await client().contractCall(address, call)).toEqual({ txId: hash });
    expect({ sends, receipts }).toEqual({ sends: 2, receipts: 1 });
  });

  it.each([null, 'rpc-failure', '0x0', '0x1'] as const)('observes a final swap receipt once (%s)', async status => {
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
    const result = client().swap(address, { completionV1: true, chain: 'base',
      fromAsset: 'eth', toAsset: 'usdc', amount: '0.001' });
    if (status === '0x0') await expect(result).rejects.toThrow(`transaction ${hash} reverted`);
    else await expect(result).resolves.toMatchObject({ txId: hash, status: status === '0x1' ? 'confirmed' : 'pending' });
    expect({ sends, receipts }).toEqual({ sends: 1, receipts: 1 });
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect({ sends, receipts }).toEqual({ sends: 1, receipts: 1 });
  });

  it('does not re-quote, sign a permit or submit a swap while its approval is pending', async () => {
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
    await expect(client().swap(address, { completionV1: true, chain: 'base', fromAsset: 'usdc',
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
