import { phoneFetch, describe, expect, it, vi, walletSource, walletExplorerTxUrl, postWalletNotice, HUMAN, HELPER, WORKSPACE, BRIDGE2, fixtureScope1 } from './wallet.integration.test-support.js';

describe('wallet over the fake CDP seam', () => {
const scope1 = fixtureScope1();


  it.each([true, false])('provider-first settlement indexes token receipts once (swap=%s), then joins execution attribution', async (includeIncoming) => {
    const wallet = await scope1.createdWallet();
    const hash = `0x${'5'.repeat(64)}`;
    const venue = `0x${'6'.repeat(40)}`;
    const token = `0x${'9'.repeat(40)}`;
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
    const word = (amount: number) => `0x${amount.toString(16).padStart(64, '0')}`;
    const originalFetch = globalThis.fetch;
    const rpcCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).startsWith(scope1.origin)) return originalFetch(url, init);
      const batch = JSON.parse(String(init?.body)) as Array<{ id: number; method: string }>;
      return Response.json(batch.map(call => {
        rpcCalls.push(call.method);
        return { id: call.id, jsonrpc: '2.0', result: call.method === 'eth_getTransactionByHash'
          ? { from: wallet.address, to: venue, value: '0x0', input: '0x12345678' }
          : { logs: [
            { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', logIndex: '0x1',
              topics: [transferTopic, topic(wallet.address), topic(venue)], data: word(5_000_000) },
            ...(includeIncoming ? [{ address: token, logIndex: '0x2', topics: [transferTopic, topic(venue), topic(wallet.address)], data: word(7) }] : []),
          ] } };
      }));
    });
    const data = { address: wallet.address, transaction_hash: hash, network: 'base' };
    expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', data)).status).toBe(200);
    expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', data, 'retry')).status).toBe(200);
    expect(rpcCalls).toEqual(['eth_getTransactionByHash', 'eth_getTransactionReceipt']);
    let rows = await scope1.notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain(includeIncoming ? 'confirmed swap' : 'confirmed contract');
    expect(rows[0]!.text).toContain('−5 USDC');
    if (includeIncoming) expect(rows[0]!.text).toContain('+7 raw units');
    expect(rows[0]!.text).not.toContain('−−');
    expect(rows[0]!.text).toContain(venue);
    await postWalletNotice(scope1.database, WORKSPACE, HUMAN, {
      walletNotice: true, status: 'pending', operation: 'swap', execution: true,
      amountText: '5 USDC→ETH', counterparty: 'Coinbase CDP', chain: 'base', agentId: HELPER,
      agentName: '@bee', txUrl: walletExplorerTxUrl('base', hash),
    });
    rows = await scope1.notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.card).toMatchObject({ status: 'confirmed', agentId: HELPER });
    expect(rows[0]!.text).toContain('@bee');
  });


  it('ignores unknown accounts and testnets and records each insufficient attempt separately', async () => {
    const wallet = await scope1.createdWallet();
    const data = { address: `0x${'6'.repeat(40)}`, transaction_hash: `0x${'5'.repeat(64)}`, network: 'base-mainnet' };
    expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', data)).status).toBe(200);
    expect((await scope1.deliverWalletEvent('wallet.transaction.confirmed', { ...data, address: wallet.address, network: 'base-sepolia' })).status).toBe(200);
    expect(await scope1.notices()).toHaveLength(0);
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const pay = { chain: 'base', asset: 'usdc', amount: '999999', to: `0x${'7'.repeat(40)}`, agentId: HELPER };
    expect((await scope1.daemonOperation('walletPay', pay)).body.outcome).toBe('insufficient');
    expect((await scope1.daemonOperation('walletPay', pay)).body.outcome).toBe('insufficient');
    const rows = await scope1.notices();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.card.status === 'refused' && row.text.includes(pay.to) && row.text.includes('@bee'))).toBe(true);
  });


  it('rejects forged provider events and phone sends into inaccessible Workspaces before sending', async () => {
    await scope1.createdWallet();
    const send = vi.spyOn(walletSource(), 'sendTransaction');
    const response = await phoneFetch(`${scope1.origin}/v1/phone/operations/sendFromWallet`, {
      method: 'POST', headers: { authorization: `Bearer ${scope1.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: '99999999-9999-4999-8999-999999999999',
        chain: 'base', asset: 'usdc', amount: '1', to: `0x${'7'.repeat(40)}` }),
    });
    expect(response.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
    const forged = await phoneFetch(`${scope1.origin}/v1/wallet/events/cdp/test`, {
      method: 'POST', body: '{}', headers: { 'x-hook0-signature': 'forged' },
    });
    expect(forged.status).toBe(401);
    expect(await scope1.notices()).toHaveLength(0);
  });


  it('an Arbitrum-only wallet reads its real balance, chains, quote and inbound history', async () => {
    // The fake outlives a test; start from an empty wallet on every chain.
    scope1.fakeState().holdings.clear();
    const wallet = await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    scope1.fundChain(wallet.address, 'arbitrum', 'eth', 0.5);

    const balance = (await scope1.daemonOperation('getWalletToolBalance', { agentId: HELPER })).body;
    expect(balance).toEqual({
      totalUsd: '$1,600.00',
      coins: [{ symbol: 'eth', name: 'ETH', chain: 'arbitrum', amount: '0.50', usd: '$1,600.00' }],
    });
    const chains = (await scope1.daemonOperation('getWalletToolChains', { agentId: HELPER })).body
      .chains as Array<{ id: string; hasBalance: boolean }>;
    expect(chains.filter((chain) => chain.hasBalance).map((chain) => chain.id)).toEqual(['arbitrum']);
    expect(
      (await scope1.daemonOperation('getWalletToolQuote', { agentId: HELPER, chain: 'arbitrum', asset: 'eth', amount: '0.001' })).body,
    ).toMatchObject({ available: '0.50', sufficient: true, chain: 'arbitrum' });
    expect(
      (await scope1.daemonOperation('getWalletToolQuote', { agentId: HELPER, chain: 'base', asset: 'eth', amount: '0.001' })).body,
    ).toMatchObject({ available: '0', sufficient: false, chain: 'base' });

    const history = async () =>
      (await scope1.daemonOperation('getWalletToolHistory', { agentId: HELPER })).body.entries as Array<{
        direction: string;
        amountText: string;
        chain: string;
        txUrl: string | null;
      }>;
    const arbitrumInbound = async () =>
      (await history()).filter((entry) => entry.direction === 'in' && entry.chain === 'arbitrum');
    const inbound = await arbitrumInbound();
    expect(inbound).toEqual([
      expect.objectContaining({ amountText: '+0.5 ETH', chain: 'arbitrum', txUrl: null }),
    ]);
    // A repeated read records the same deposit once.
    expect(await arbitrumInbound()).toHaveLength(1);
    scope1.fundChain(wallet.address, 'arbitrum', 'eth', 0.75);
    expect((await arbitrumInbound()).map((entry) => entry.amountText)).toEqual([
      '+0.5 ETH',
      '+0.25 ETH',
    ]);
  });


  it('pays and swaps on Arbitrum without reading the swap output as a deposit', async () => {
    // The fake outlives a test; start from an empty wallet on every chain.
    scope1.fakeState().holdings.clear();
    const wallet = await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    scope1.fundChain(wallet.address, 'arbitrum', 'eth', 1);
    scope1.fundChain(wallet.address, 'arbitrum', 'usdc', 50);

    const paid = await scope1.daemonOperation('walletPay', {
      agentId: HELPER, chain: 'arbitrum', asset: 'usdc', amount: '20', to: '0xabc',
    });
    expect(paid.body).toMatchObject({ outcome: 'sent', txUrl: expect.stringMatching(/^https:\/\/arbiscan\.io\/tx\//) });
    expect(scope1.fakeState().holdings.get(`arbitrum:${wallet.address}`)!.get('usdc')).toBe(30);

    const swapped = await scope1.daemonOperation('walletSwap', {
      agentId: HELPER, chain: 'arbitrum', fromAsset: 'eth', toAsset: 'usdc', amount: '0.5',
    });
    expect(swapped.body).toMatchObject({ outcome: 'sent', txUrl: expect.stringMatching(/^https:\/\/arbiscan\.io\/tx\//) });
    const entries = (await scope1.daemonOperation('getWalletToolHistory', { agentId: HELPER })).body.entries as Array<{
      direction: string; amountText: string; chain: string;
    }>;
    expect(
      entries
        .filter((entry) => entry.direction === 'in' && entry.chain === 'arbitrum')
        .map((entry) => entry.amountText)
        .sort(),
    ).toEqual([
      '+1 ETH',
      '+50 USDC',
    ]);
    expect(entries.filter((entry) => entry.direction === 'out').every((entry) => entry.chain === 'arbitrum')).toBe(true);
  });


  it('reports an unsupported swap chain as a named failure', async () => {
    await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    vi.spyOn(walletSource(), 'swap').mockRejectedValue(new Error('swap unsupported on zora'));
    expect(
      (await scope1.daemonOperation('walletSwap', { agentId: HELPER, chain: 'zora', fromAsset: 'usdc', toAsset: 'eth', amount: '1' })).body,
    ).toEqual({ outcome: 'failed', reason: 'swap unsupported on zora' });
  });


  it('refuses a wallet_pay to Hyperliquid Bridge2 that the venue rule says is lost', async () => {
    // The fake outlives a test; start from an empty wallet on every chain.
    scope1.fakeState().holdings.clear();
    const wallet = await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    scope1.fundChain(wallet.address, 'arbitrum', 'usdc', 10);
    scope1.fundChain(wallet.address, 'arbitrum', 'eth', 1);
    const send = vi.spyOn(walletSource(), 'sendTransaction');
    const pay = (asset: string, amount: string) =>
      scope1.daemonOperation('walletPay', { agentId: HELPER, chain: 'arbitrum', asset, amount, to: BRIDGE2 });

    expect((await pay('usdc', '4.99')).body).toEqual({
      outcome: 'failed',
      reason:
        'Hyperliquid Bridge2 deposits must be at least 5 USDC; a smaller deposit is never credited and is lost',
    });
    expect((await pay('eth', '0.1')).body).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('credits only USDC'),
    });
    expect(send).not.toHaveBeenCalled();
    expect((await pay('usdc', '5')).body).toMatchObject({ outcome: 'sent' });
    expect(send).toHaveBeenCalledWith(wallet.address, {
      chain: 'arbitrum',
      asset: 'usdc',
      amount: '5',
      to: BRIDGE2,
    });
  });


  it('approves an exact amount and calls a contract, under the same funds and ledger rules', async () => {
    scope1.fakeState().holdings.clear();
    const wallet = await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    const call = vi.spyOn(walletSource(), 'contractCall');
    const vault = '0x' + '7'.repeat(40);
    const deposit = { agentId: HELPER, chain: 'arbitrum', contract: vault, data: '0xb6b55f25' + '0'.repeat(64) };

    expect(
      (await scope1.daemonOperation('walletContractCall', { ...deposit, approve: { asset: 'usdc', amount: '20' } })).body,
    ).toMatchObject({ outcome: 'insufficient', asset: 'usdc', needed: '20', available: '0' });
    expect(call).not.toHaveBeenCalled();

    scope1.fundChain(wallet.address, 'arbitrum', 'usdc', 50);
    const sent = await scope1.daemonOperation('walletContractCall', {
      ...deposit,
      approve: { asset: 'usdc', amount: '20' },
    });
    expect(sent.body).toMatchObject({
      outcome: 'sent',
      amountText: '−20 USDC',
      txUrl: expect.stringMatching(/^https:\/\/arbiscan\.io\/tx\//),
    });
    expect(call).toHaveBeenCalledWith(wallet.address, {
      chain: 'arbitrum',
      contract: vault,
      data: deposit.data,
      approve: { asset: 'usdc', amount: '20' },
    });
    const entries = (await scope1.daemonOperation('getWalletToolHistory', { agentId: HELPER })).body.entries as Array<{
      direction: string; amountText: string; counterparty: string;
    }>;
    expect(entries.filter((entry) => entry.direction === 'out')).toEqual([
      expect.objectContaining({ amountText: '−20 USDC', counterparty: vault }),
    ]);
  });


  it('refuses contract calls that grant an allowance or break a venue rule', async () => {
    scope1.fakeState().holdings.clear();
    const wallet = await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE });
    scope1.fundChain(wallet.address, 'arbitrum', 'usdc', 50);
    scope1.fundChain(wallet.address, 'arbitrum', 'eth', 1);
    const call = vi.spyOn(walletSource(), 'contractCall');
    const usdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const contractCall = (input: Record<string, unknown>) =>
      scope1.daemonOperation('walletContractCall', { agentId: HELPER, chain: 'arbitrum', ...input });

    // An unlimited approve hidden in call data.
    expect(
      (await contractCall({ contract: usdc, data: `0x095ea7b3${word('0x' + '7'.repeat(40))}${'f'.repeat(64)}` })).body,
    ).toEqual({
      outcome: 'failed',
      reason: 'call data grants a token allowance; use approve, which approves an exact amount',
    });
    // A USDC transfer to Bridge2 below the minimum, encoded as call data.
    expect(
      (await contractCall({ contract: usdc, data: `0xa9059cbb${word(BRIDGE2)}${word((4_000_000).toString(16))}` })).body,
    ).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('at least 5 USDC') });
    // Native value sent to Bridge2.
    expect((await contractCall({ contract: BRIDGE2, data: '0x', value: '0.1' })).body).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('credits only USDC'),
    });
    expect((await contractCall({ contract: '0x1234', data: '0x' })).body).toMatchObject({ outcome: 'failed' });
    expect(call).not.toHaveBeenCalled();
  });


  it('the only spending refusal is insufficient funds', async () => {
    await scope1.createdWallet();
    await scope1.phoneOperation('grantWalletDelegation', { workspaceId: WORKSPACE, ttlHours: 24 });
    const sent = (await scope1.daemonOperation('walletPay', {
      agentId: HELPER,
      chain: 'base',
      asset: 'usdc',
      amount: '999999',
      to: '0xabc',
    })) as { body: { outcome: string; asset: string; available: string } };
    expect(sent.body.outcome).toBe('insufficient');
    expect(sent.body.asset).toBe('usdc');
  });
});
