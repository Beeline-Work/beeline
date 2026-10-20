import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingGrantToolCall } from './monolith-room-turn.js';
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
  vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room-1');
  vi.stubEnv('BEELINE_SQUIRE_RELAY_URL', '');
  vi.stubEnv('BEELINE_SQUIRE_RELAY_TOKEN', '');
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
  it('reports that Squire is not mounted while keeping connect available', async () => {
    for (const corner of [false, true]) {
      expect(agentToolsFor(true, false, corner, corner).some(tool => tool.name === 'connect')).toBe(true);
    }
    await callAgentTool('connect', { mode:'ensure', continuation:'Finish the requested task.', service: 'Example', reason: 'Finish' }, 'call-1');
    expect(calls).toEqual([{ name: 'connect', input: expect.objectContaining({ squireAvailable: false }) }]);
  });

  it('refreshes the vault through the mounted agent relay before connect checks readiness', async () => {
    vi.stubEnv('BEELINE_SQUIRE_RELAY_URL', 'http://squire.test');
    vi.stubEnv('BEELINE_SQUIRE_RELAY_TOKEN', 'relay-only');
    const sequence: string[] = [];
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const name = String(url).split('/').at(-1)!;
      const input = JSON.parse(String(init.body));
      sequence.push(name);
      if (name === 'mcp') {
        expect(input.params.name).toBe('list_credentials');
        return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify({
          credentials: [] }) }] } });
      }
      if (name === 'connect') expect(input.squireAvailable).toBe(true);
      return Response.json(name === 'connect' ? { status: 'needs_squire', app: 'Example',
        squire: { url: 'https://example.com', goal: 'Save the login in the vault.' }, next: 'Use your own operate_drive.' } : {});
    });
    const reply = await callAgentTool('connect', { mode:'ensure', continuation:'Finish the requested task.', service: 'Example', reason: 'Finish' }, 'call-1');
    expect(JSON.parse(reply))
      .toMatchObject({ status: 'needs_squire', squire: { url: 'https://example.com' } });
    expect(pendingGrantToolCall({ title: 'connect', content: reply })).toBe(false);
    expect(sequence).toEqual(['mcp', 'postConnectorVault', 'connect']);
  });

  it('reports unavailable when mounted Squire cannot be reached without attempting a browser drive', async () => {
    vi.stubEnv('BEELINE_SQUIRE_RELAY_URL', 'http://squire.test');
    vi.stubEnv('BEELINE_SQUIRE_RELAY_TOKEN', 'relay-only');
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const name = String(url).split('/').at(-1)!;
      const input = JSON.parse(String(init.body));
      if (name === 'mcp') {
        expect(input.params.name).toBe('list_credentials');
        return Response.json({ error: 'unavailable' }, { status: 503 });
      }
      if (name === 'connect') expect(input.squireAvailable).toBe(false);
      return Response.json(name === 'connect' ? { status: 'unavailable', app: 'Example',
        next: 'Trusty Squire is unavailable in this agent session.' } : {});
    });
    expect(JSON.parse(await callAgentTool('connect', { mode:'ensure', continuation:'Finish the requested task.', service: 'Example', reason: 'Finish' }, 'call-1')))
      .toMatchObject({ status: 'unavailable' });
  });

  describe('Reproduction squire-session-1: a browser app with a signed-in Squire session', () => {
    const asset = 'https://dreamina.capcut.com/ai-tool/asset';
    const page = (url: string, rows: unknown[][], stage = 'browse') => ({ url, stage, session_id: 'check-1', safe_table: rows });
    const run = async (signedInUrl: string | undefined, pages: Record<string, unknown>) => {
      vi.stubEnv('BEELINE_SQUIRE_RELAY_URL', 'http://squire.test');
      vi.stubEnv('BEELINE_SQUIRE_RELAY_TOKEN', 'relay-only');
      const sequence: string[] = [];
      const connects: Record<string, unknown>[] = [];
      vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
        const name = String(url).split('/').at(-1)!;
        const input = JSON.parse(String(init.body));
        if (name === 'mcp') {
          const tool = input.params.name as string;
          const query = input.params.arguments.query as string | undefined;
          sequence.push(query ? `${tool}:${query}` : tool);
          const body = tool === 'list_credentials' ? { credentials: [] }
            : tool === 'operate_finish' ? { closed: true }
            : tool === 'operate_start' ? pages.start : pages[query!] ?? { ...(pages.start as object), safe_table: [] };
          return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
        }
        sequence.push(name);
        if (name !== 'connect') return Response.json({});
        connects.push(input);
        return Response.json(input.squireSignedIn
          ? { status: 'ready', app: 'Dreamina', appKey: 'dreamina', transport: 'squire-browser', next: 'ready' }
          : { status: 'needs_squire', app: 'Dreamina', appKey: 'dreamina', transport: 'squire-browser',
            squire: { url: 'https://www.google.com/search?q=Dreamina', goal: 'Sign in.' }, next: 'Use your own operate_drive.' });
      });
      const reply = JSON.parse(await callAgentTool('connect', { mode:'ensure', continuation:'Finish the requested task.', service: 'Dreamina', reason: 'Make a video',
        noApi: true, ...(signedInUrl ? { signedInUrl } : {}) }, 'call-1'));
      return { reply, sequence, connects };
    };

    it('is ready after a read-only check of a signed-in-only page', async () => {
      const { reply, sequence, connects } = await run(asset, {
        start: page(asset, [['@e:1', 'b', '@credits'], ['@e:2', 'b', '@create']]) });
      expect(reply).toMatchObject({ status: 'ready' });
      expect(sequence).toEqual(['list_credentials', 'postConnectorVault', 'connect', 'operate_start',
        'operate_observe:sign in', 'operate_observe:log in', 'operate_observe:sign up', 'operate_finish', 'connect']);
      expect(connects[0]).toMatchObject({ signedInUrl: asset });
      expect(connects[0]).not.toHaveProperty('squireSignedIn');
      expect(connects[1]).toMatchObject({ signedInUrl: asset, squireSignedIn: true, squireAvailable: true });
      expect(sequence).not.toContain('operate_drive');
    });

    it.each([
      ['a redirect to the public home page', page('https://dreamina.capcut.com/ai-tool/home', [['@e:1', 'b', '@create']])],
      ['sign-in controls', page(asset, [['@e:1', 'b', '@sign-in|a=login']])],
      ['a sign-up control', page(asset, [['@e:1', 'l', '@sign-up-now|a=signup']])],
      ['a login page', page(asset, [], 'auth')],
      ['a redirect to another site', page('https://accounts.google.com/signin', [])],
    ])('keeps the needs_squire handback for %s', async (_case, start) => {
      const { reply, sequence, connects } = await run(asset, { start });
      expect(reply).toMatchObject({ status: 'needs_squire', squire: { url: 'https://www.google.com/search?q=Dreamina' } });
      expect(sequence).toEqual(['list_credentials', 'postConnectorVault', 'connect', 'operate_start', 'operate_finish']);
      expect(connects).toHaveLength(1);
    });

    it('keeps the handback when only a later query finds sign-in controls', async () => {
      const { reply, sequence } = await run(asset, { start: page(asset, []),
        'log in': page(asset, [['@e:9', 'b', '@log-in|a=login|m=t']]) });
      expect(reply).toMatchObject({ status: 'needs_squire' });
      expect(sequence.at(-1)).toBe('operate_finish');
    });

    it.each([undefined, 'https://dreamina.capcut.com/', 'https://github.com/settings/profile'])(
      'opens no Squire page without a signed-in-only page of the app (%s)', async (signedInUrl) => {
        const { reply, sequence } = await run(signedInUrl, {});
        expect(reply).toMatchObject({ status: 'needs_squire' });
        expect(sequence).not.toContain('operate_start');
      });
  });

  it('passes one bounded request-specific promise into connectApp', async () => {
    const continuation = 'I will finish the requested draft after sign-in.';
    await callAgentTool('connect', { mode:'ensure',  service: 'Example', reason: 'Finish the draft',
      continuation }, 'call-1');
    expect(calls).toEqual([{ name: 'connect', input: expect.objectContaining({
      service: 'Example', reason: 'Finish the draft', continuation,
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
      await expect(callAgentTool('connect', { mode:'ensure',  service: 'Example', reason: 'Finish',
        continuation }, 'call-1'))
        .rejects.toThrow(/continuation|invalid arguments/);
    }
    expect(calls).toEqual([]);
  });

  it('discovers and executes a connected app with turn authority and no provider secret', async () => {
    expect(agentToolsFor(true, false).map((tool) => tool.name))
      .toEqual(expect.arrayContaining(['app_tool']));
    answer = (name) => Response.json(name === 'listAppTools'
      ? { tools: [{ slug: 'SLACK_POST_MESSAGE', name: 'Post message',
          description: 'Post a message', inputParameters: { type: 'object' } }] }
      : { status: 'executed', data: { ok: true } });
    expect(JSON.parse(await callAgentTool('app_tool', { app: appId }, 'call-1')).tools)
      .toHaveLength(1);
    expect(JSON.parse(await callAgentTool('app_tool', {
      app: appId, tool: 'SLACK_POST_MESSAGE', args: { text: 'hello' },
    }, 'call-2'))).toEqual({ status: 'executed', data: { ok: true } });
    expect(calls.map((call) => call.name)).toEqual(['listAppTools', 'executeAppTool']);
    for (const call of calls) expect(call.input).toMatchObject({ appId, agentId: 'agent-1',
      roomId: 'room-1', requestId: 'request-1', generationId: 'generation-1' });
    expect(JSON.stringify(calls)).not.toMatch(/accessToken|refreshToken|composio|apiKey/i);
  });

  it('returns Squire API discovery guidance without executing a provider tool', async () => {
    const route = { tools: [], transport: 'squire-api', service: 'github',
      next: 'Call GitHub API with Trusty Squire use_credential.',
      credentials: [{ reference: 'vault:github', allowedHosts: ['api.github.com'] }] };
    answer = () => Response.json(route);
    expect(JSON.parse(await callAgentTool('app_tool', { app: appId }, 'call-1')))
      .toEqual(route);
    expect(calls.map(call => call.name)).toEqual(['listAppTools']);
  });

  it('reports a missing app without trying another provider path', async () => {
    answer = () => Response.json({ error: 'app_unavailable' }, { status: 404 });
    await expect(callAgentTool('app_tool', { app: appId }, 'call-1'))
      .rejects.toThrow('listAppTools failed (404: app_unavailable)');
    expect(calls.map((call) => call.name)).toEqual(['listAppTools']);
  });

  it('preserves the server permission decision for a foreign agent', async () => {
    answer = () => Response.json({ status: 'needs_permission', grantId: 'grant-1' });
    expect(JSON.parse(await callAgentTool('app_tool', {
      app: appId, tool: 'SLACK_POST_MESSAGE', args: { text: 'hello' },
    }, 'call-1'))).toEqual({ status: 'needs_permission', grantId: 'grant-1' });
    expect(calls.map((call) => call.name)).toEqual(['executeAppTool']);
  });

  it('keeps a disconnected account unusable', async () => {
    answer = (name) => Response.json(name === 'listAppTools' ? { tools: [] }
      : { status: 'needs_connection' });
    expect(JSON.parse(await callAgentTool('app_tool', { app: appId }, 'call-1')))
      .toEqual({ tools: [] });
    expect(JSON.parse(await callAgentTool('app_tool', {
      app:appId, tool: 'SLACK_POST_MESSAGE', args: {},
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

  it.each(['connected', 'error'].flatMap(status => ['squire-api', 'composio'].map(transport => ({ status, transport }))))('R2594: gives the personal GitHub API route priority with App checkout available ($status, $transport)', async ({ status, transport }) => {
    const text = await workbenchStatus({ roomId: 'room-1', execute: async () => ({
      apps: [{ appId, appKey: 'github', name: 'GitHub', transport,
        status, ...(status === 'error' ? { errorMessage: 'Permission denied' } : {}) }],
    }) });
    expect(text).toContain(`personal GitHub connection (app ${appId}, ${transport})`);
    expect(text).toContain('including Git Data API pushes');
    expect(text).toContain('never switching to the App identity');
    expect(text).toContain(transport === 'squire-api'
      ? 'call Squire use_credential (service "github")' : `use app_tool(app:"${appId}")`);
    if (status === 'error') expect(text).toContain('Permission denied');
  });

  it('Reproduction CRED-1: status names the connected vault reference for API calls', async () => {
    const text = await workbenchStatus({ roomId: 'room-1', execute: async () => ({
      apps: [{ appId, appKey: 'github', name: 'GitHub', transport: 'squire-api',
        status: 'connected', connectionReference: 'vault://github/work' }],
    }) });
    expect(text).toContain('use_credential(reference:"vault://github/work")');
    expect(text).toContain('call Squire use_credential (reference "vault://github/work")');
    expect(text).not.toContain('service "github"');
  });

  it('R2594: does not invent a personal credential when only repository App access is available', async () => {
    const text = await workbenchStatus({ roomId: 'room-1', execute: async () => ({ apps: [] }) });
    expect(text).not.toContain('GitHub operation identity:');
    expect(calls).toEqual([]);
  });

  it('R2594: preserves a personal GitHub push denial without requesting an App credential', async () => {
    answer = () => Response.json({ status: 'needs_permission', grantId: 'github-push' });
    const result = JSON.parse(await callAgentTool('app_tool', { app: appId,
      tool: 'GITHUB_UPDATE_A_REFERENCE', args: { owner: 'owner', repo: 'widgets',
        ref: 'heads/proof/github-personal', sha: '1'.repeat(40), force: false } }, 'push'));
    expect(result).toEqual({ status: 'needs_permission', grantId: 'github-push' });
    expect(calls.map(call => call.name)).toEqual(['executeAppTool']);
    expect(calls[0]!.input).toMatchObject({ appId, roomId: 'room-1',
      arguments: { ref: 'heads/proof/github-personal', force: false } });
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
      'connect', 'app_tool',
    ]));
    expect(await callAgentTool('connect', {mode:'status'}, 'call-1'))
      .toContain(`X (app:x, id ${appId}) via composio: connecting`);
    expect(JSON.parse(await callAgentTool('connect', { mode:'ensure',  service: 'X',
      reason: 'Check X posts', continuation: 'I will check the requested posts after sign-in.'
    }, 'call-2'))).toMatchObject({ status: 'needs_sign_in', appId });
    expect(calls.map((call) => [call.name, call.input.roomId]))
      .toEqual([['readAgentWorkbench', 'corner-1'], ['connect', 'corner-1']]);
    expect(calls[1]?.input).toMatchObject({ requestId: 'request-1',
      generationId: 'generation-1' });
  });
});
