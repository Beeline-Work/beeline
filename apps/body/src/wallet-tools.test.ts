import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentToolsFor, callAgentTool, daemonOperationIsSafeToRepeat } from './read-only-mcp.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const payload = {
  domain: {
    name: 'Exchange',
    version: '1',
    chainId: 1337,
    verifyingContract: '0x' + '0'.repeat(40),
  },
  types: { BeelineTest: [{ name: 'notice', type: 'string' }] },
  primaryType: 'BeelineTest',
  message: { notice: 'Harmless signing test; no order or transfer' },
};

describe('wallet MCP identity and signing', () => {
  it('routes every wallet tool as the actual agent in its active corner', async () => {
    vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent-room');
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-1');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost:1234');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      calls.push({ name: url.pathname.split('/').at(-1)!, body });
      // Mirror the server ownership invariant: the old literal self fails.
      if (body.agentId !== 'agent-1')
        return Response.json(
          { error: 'daemon token does not own requested agent' },
          { status: 503 },
        );
      return Response.json({ ok: true });
    });
    for (const [tool, args] of [
      ['wallet_address', {}],
      ['wallet_balance', {}],
      ['wallet_chains', {}],
      ['wallet_history', { limit: 5 }],
      ['wallet_quote', { asset: 'usdc', amount: '1' }],
      ['wallet_pay', { asset: 'usdc', amount: '1', to: '0xabc' }],
      ['wallet_swap', { fromAsset: 'usdc', toAsset: 'eth', amount: '1' }],
      [
        'wallet_contract_call',
        {
          chain: 'arbitrum',
          contract: '0x' + '1'.repeat(40),
          data: '0xd0e30db0',
          approve: { asset: 'usdc', amount: '5' },
        },
      ],
      ['wallet_sign_typed_data', payload],
    ] as const)
      await expect(callAgentTool('app_tool', { app:'beeline:wallet', tool:tool.replace('wallet_', ''), args }, 'wallet-call')).resolves.toBe('{"ok":true}');
    expect(calls).toHaveLength(9);
    expect(calls.find((call) => call.name === 'walletContractCall')?.body).toEqual({
      completionV1: true,
      agentId: 'agent-1',
      roomId: 'corner-1',
      chain: 'arbitrum',
      contract: '0x' + '1'.repeat(40),
      data: '0xd0e30db0',
      approve: { asset: 'usdc', amount: '5' },
    });
    for (const call of calls)
      expect(call.body).toMatchObject({ agentId: 'agent-1', roomId: 'corner-1' });
    for (const call of calls.filter(call => ['walletPay', 'walletSwap', 'walletContractCall'].includes(call.name)))
      expect(call.body.completionV1).toBe(true);
    expect(calls.at(-1)).toEqual({
      name: 'walletSignTypedData',
      body: { ...payload, agentId: 'agent-1', roomId: 'corner-1' },
    });
    expect(daemonOperationIsSafeToRepeat('walletSignTypedData', {})).toBe(false);
    expect(daemonOperationIsSafeToRepeat('walletContractCall', {})).toBe(false);
  });

  it('discovers wallet operations without mounting wallet schemas on ordinary turns', async () => {
    const names = agentToolsFor(true, false).map(tool => tool.name);
    expect(names).toContain('app_tool');
    expect(names).not.toContain('wallet_contract_call');
    const catalog = JSON.parse(await callAgentTool('app_tool', { app: 'beeline:wallet' }, 'discover'));
    const typed = catalog.tools.find((tool: { name: string }) => tool.name === 'sign_typed_data');
    expect(typed.inputSchema.required).toEqual(['domain', 'types', 'primaryType', 'message']);
    expect(typed.description).toContain('authorize transfers');
    expect(catalog.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['contract_call', 'link_request', 'link_wait']));
  });

  it('returns an uncertain payment as pending and never redispatches it on elapsed time', async () => {
    vi.useFakeTimers();
    vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-1');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost:1234');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const result = { outcome: 'pending', reason: 'Transaction submission is UNKNOWN. Do not resubmit this intent.' };
    const fetched = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ completionV1: true, agentId: 'agent-1' });
      return Response.json(result);
    });
    vi.stubGlobal('fetch', fetched);
    expect(JSON.parse(await callAgentTool('app_tool', { app: 'beeline:wallet', tool: 'pay',
      args: { chain: 'base', asset: 'usdc', amount: '1', to: `0x${'1'.repeat(40)}` } }, 'uncertain-payment'))).toEqual(result);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(daemonOperationIsSafeToRepeat('walletPay', {})).toBe(false);
  });

});
