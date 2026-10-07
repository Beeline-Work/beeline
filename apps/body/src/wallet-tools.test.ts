import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentToolsFor, callAgentTool, daemonOperationIsSafeToRepeat } from './read-only-mcp.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
      ['wallet_hyperliquid_deposit', { amount: '5' }],
      ['wallet_sign_typed_data', payload],
    ] as const)
      await expect(callAgentTool(tool, args, 'wallet-call')).resolves.toBe('{"ok":true}');
    expect(calls).toHaveLength(9);
    expect(calls.find((call) => call.name === 'walletHyperliquidDeposit')?.body).toMatchObject({
      agentId: 'agent-1',
      amount: '5',
    });
    for (const call of calls)
      expect(call.body).toMatchObject({ agentId: 'agent-1', roomId: 'corner-1' });
    expect(calls.at(-1)).toEqual({
      name: 'walletSignTypedData',
      body: { ...payload, agentId: 'agent-1', roomId: 'corner-1' },
    });
    expect(daemonOperationIsSafeToRepeat('walletSignTypedData', {})).toBe(false);
    expect(daemonOperationIsSafeToRepeat('walletHyperliquidDeposit', {})).toBe(false);
  });

  it('exposes typed data in Room and corner tools with all four required fields', () => {
    for (const corner of [false, true]) {
      const tool = agentToolsFor(true, false, corner).find(
        (entry) => entry.name === 'wallet_sign_typed_data',
      )!;
      expect(tool.inputSchema.required).toEqual(['domain', 'types', 'primaryType', 'message']);
      expect(tool.description).toContain('authorize transfers');
    }
  });
});
