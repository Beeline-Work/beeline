import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';

beforeEach(() => {
  vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
  vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// The always-on prompt owns "end the turn after ordering"; the tool text only describes the order.
it('returns the delivery receipt without restating the end-the-turn rule', async () => {
  const fetch = vi.fn(async (_url: URL, _init: RequestInit) => Response.json({ commandIds: ['order-1'] }));
  vi.stubGlobal('fetch', fetch);
  const result = await callAgentTool('order', { address: '11111111-1111-4111-8111-111111111111', text: 'Compute 17 + 25' }, 'call-1');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ address: '11111111-1111-4111-8111-111111111111', text: 'Compute 17 + 25' });
  expect(JSON.parse(result as string)).toEqual({ commandIds: ['order-1'] });
  expect(agentToolsFor(true, true).find(t => t.name === 'order')!.description).not.toMatch(/end this turn|never poll/i);
});

it('preserves an order refusal without claiming delivery or telling the commander to wait', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ error: 'forbidden' }, { status: 403 }));
  await expect(callAgentTool('order', { address: '11111111-1111-4111-8111-111111111111', text: 'Compute 17 + 25' }, 'call-2'))
    .rejects.toThrow('403');
});

it('forwards the one named agent and never describes a Room broadcast', async () => {
  const fetch = vi.fn(async (_url: URL, _init: RequestInit) => Response.json({ commandIds: ['order-2'] }));
  vi.stubGlobal('fetch', fetch);
  await callAgentTool('order', { address: '11111111-1111-4111-8111-111111111111', agent: '@candy', text: 'Check the build' }, 'call-3');
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ address: '11111111-1111-4111-8111-111111111111', agent: '@candy', text: 'Check the build' });
  const tool = agentToolsFor(true, true).find(t => t.name === 'order')!;
  expect(tool.description).not.toMatch(/broadcast/i);
  expect(tool.description).toContain('one agent');
  expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain('agent');
});
