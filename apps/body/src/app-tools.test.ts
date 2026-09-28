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
});
