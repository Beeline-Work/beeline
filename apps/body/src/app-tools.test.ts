import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentToolsFor, callAgentTool, workbenchStatus } from './read-only-mcp.js';

const appId = '11111111-1111-4111-8111-111111111111';
let home: string;
let calls: Array<{ name: string; input: Record<string, unknown> }>;
let answer: (name: string) => Response;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'beeline-app-tools-'));
  const context = join(home, 'turn.json');
  writeFileSync(context, JSON.stringify({ roomId: 'room-1', requestId: 'request-1',
    generationId: 'generation-1' }));
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
  vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
  vi.stubEnv('BEELINE_DAEMON_TOKEN', 'daemon-only');
  vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
  calls = [];
  answer = () => Response.json({});
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const name = String(url).split('/').at(-1)!;
    calls.push({ name, input: JSON.parse(String(init.body)) });
    return answer(name);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('server-mediated connected app tools', () => {
  it('passes one bounded request-specific promise into connectApp', async () => {
    const continuation = 'I will finish the requested draft after sign-in.';
    await callAgentTool('connect_app', { app: 'Example', reason: 'Finish the draft',
      continuation }, 'call-1');
    expect(calls).toEqual([{ name: 'connectApp', input: expect.objectContaining({
      app: 'Example', reason: 'Finish the draft', continuation,
      roomId: 'room-1', requestId: 'request-1', generationId: 'generation-1',
    }) }]);
  });

  it('rejects multiline, oversized, and secret-shaped card promises before the server call', async () => {
    const invalid = [
      'I will finish this. Then I will send that.',
      'I will finish this.\nPlease sign in.',
      `${'x'.repeat(161)}.`,
      'I will use token: ya29-secret to finish this.',
      'I will open https://example.com to finish this.',
    ];
    for (const continuation of invalid) {
      await expect(callAgentTool('connect_app', { app: 'Example', reason: 'Finish',
        continuation }, 'call-1'))
        .rejects.toThrow(/app continuation/);
    }
    expect(calls).toEqual([]);
  });

  it('discovers and executes a connected app with turn authority and no provider secret', async () => {
    expect(agentToolsFor(true, false).map((tool) => tool.name))
      .toEqual(expect.arrayContaining(['list_app_tools', 'execute_app_tool']));
    answer = (name) => Response.json(name === 'listAppTools'
      ? { tools: [{ slug: 'SLACK_POST_MESSAGE', name: 'Post message',
          description: 'Post a message', inputParameters: { type: 'object' } }] }
      : { status: 'executed', data: { ok: true } });
    expect(JSON.parse(await callAgentTool('list_app_tools', { appId }, 'call-1')).tools)
      .toHaveLength(1);
    expect(JSON.parse(await callAgentTool('execute_app_tool', {
      appId, tool: 'SLACK_POST_MESSAGE', arguments: { text: 'hello' },
    }, 'call-2'))).toEqual({ status: 'executed', data: { ok: true } });
    expect(calls.map((call) => call.name)).toEqual(['listAppTools', 'executeAppTool']);
    for (const call of calls) expect(call.input).toMatchObject({ appId, agentId: 'agent-1',
      roomId: 'room-1', requestId: 'request-1', generationId: 'generation-1' });
    expect(JSON.stringify(calls)).not.toMatch(/accessToken|refreshToken|composio|apiKey/i);
  });

  it('reports a missing app without trying another provider path', async () => {
    answer = () => Response.json({ error: 'app_unavailable' }, { status: 404 });
    await expect(callAgentTool('list_app_tools', { appId }, 'call-1'))
      .rejects.toThrow('listAppTools failed (404: app_unavailable)');
    expect(calls.map((call) => call.name)).toEqual(['listAppTools']);
  });

  it('preserves the server permission decision for a foreign agent', async () => {
    answer = () => Response.json({ status: 'needs_permission', grantId: 'grant-1' });
    expect(JSON.parse(await callAgentTool('execute_app_tool', {
      appId, tool: 'SLACK_POST_MESSAGE', arguments: { text: 'hello' },
    }, 'call-1'))).toEqual({ status: 'needs_permission', grantId: 'grant-1' });
    expect(calls.map((call) => call.name)).toEqual(['executeAppTool']);
  });

  it('keeps a disconnected account unusable', async () => {
    answer = (name) => Response.json(name === 'listAppTools' ? { tools: [] }
      : { status: 'needs_connection' });
    expect(JSON.parse(await callAgentTool('list_app_tools', { appId }, 'call-1')))
      .toEqual({ tools: [] });
    expect(JSON.parse(await callAgentTool('execute_app_tool', {
      appId, tool: 'SLACK_POST_MESSAGE', arguments: {},
    }, 'call-2'))).toEqual({ status: 'needs_connection' });
    expect(calls.map((call) => call.name)).toEqual(['listAppTools', 'executeAppTool']);
  });

  it('shows one stable app ID in the Workbench for later turns', async () => {
    const text = await workbenchStatus({ roomId: 'room-1', execute: async () => ({
      apps: [{ appId, appKey: 'slack', name: 'Slack', transport: 'composio',
        status: 'connected' }],
    }) });
    expect(text).toContain(`Slack (app:slack, id ${appId})`);
    expect(text.match(/app:slack/g)).toHaveLength(1);
  });

  it('lets a corner turn discover X and start its connection with the same turn authority', async () => {
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-1');
    writeFileSync(join(home, 'turn.json'), JSON.stringify({ roomId: 'corner-1',
      requestId: 'request-1', generationId: 'generation-1' }));
    answer = (name) => Response.json(name === 'readAgentWorkbench'
      ? { apps: [{ appId, appKey: 'x', name: 'X', transport: 'composio',
          status: 'connecting' }] }
      : { status: 'needs_sign_in', appId, app: 'X', next: 'Sign in from the card.' });
    const names = agentToolsFor(true, false, true, true).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'workbench_status', 'connect_app', 'list_app_tools', 'execute_app_tool',
    ]));
    expect(await callAgentTool('workbench_status', {}, 'call-1'))
      .toContain(`X (app:x, id ${appId}) via composio: connecting`);
    expect(JSON.parse(await callAgentTool('connect_app', { app: 'X',
      reason: 'Check X posts', continuation: 'I will check the requested posts after sign-in.'
    }, 'call-2'))).toMatchObject({ status: 'needs_sign_in', appId });
    expect(calls.map((call) => [call.name, call.input.roomId]))
      .toEqual([['readAgentWorkbench', 'corner-1'], ['connectApp', 'corner-1']]);
    expect(calls[1]?.input).toMatchObject({ requestId: 'request-1',
      generationId: 'generation-1' });
  });
});
