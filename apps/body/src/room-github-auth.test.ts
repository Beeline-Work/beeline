import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { installRoomGitHubLauncher } from './room-github-auth.js';
import { RegistryMcpHostBroker, registryMcpStatePath, registryMcpStateRoot } from './registry-mcp.js';

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Server[] = [];
const brokers: RegistryMcpHostBroker[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map(broker => broker.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(personal: boolean, transport = 'squire-api', outcome = 'executed') {
  const root = await mkdtemp(join(tmpdir(), 'room-gh-test-'));
  roots.push(root);
  const context = { roomId: 'parent', requestId: 'request', taskId: 'task', generationId: 'generation' };
  const calls: Array<{ name: string; arguments: Record<string, any> }> = [];
  const server = createServer(async (request, reply) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    if (request.url === '/v1/daemon/operations/readAgentWorkbench') {
      expect(request.headers.authorization).toBe('Bearer daemon-fixture');
      expect(input.roomId).toBe('parent');
      reply.end(JSON.stringify({ apps: [{ appKey: 'github', selectedByOwner: personal,
        appId: 'personal-app', connectorId: '11111111-2222-4333-8444-555555555555',
        transport, status: 'connected', connectionReference: 'vault://personal' }] }));
      return;
    }
    if (request.url?.startsWith('/v1/daemon/operations/')) {
      expect(request.headers.authorization).toBe('Bearer daemon-fixture');
      expect(input).toMatchObject({ ...context, agentId: 'helper-fixture', appId: 'personal-app' });
      const name = request.url.split('/').at(-1)!;
      calls.push({ name, arguments: input });
      reply.end(JSON.stringify(name === 'listAppTools' ? { tools: outcome === 'missing' ? [] : [
        { slug: 'GITHUB_CREATE_AN_ISSUE_COMMENT' },
      ] } : { status: outcome, data: { id: 42 } }));
      return;
    }
    expect(request.headers.authorization).toBe('Bearer relay-fixture');
    expect(input).toMatchObject(context);
    calls.push(input.params);
    const data = input.params.name === 'list_credentials'
      ? { credentials: [{ reference: 'vault://personal', field_names: ['access_token'] }] }
      : { response: { status: 201, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 42, html_url: 'https://github.com/owner/widgets/issues/1#issuecomment-42' }) } };
    reply.end(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(data) }] } }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const turnContextPath = join(root, 'turn.json');
  const resourceAuthFile = join(root, 'resource.json');
  await writeFile(turnContextPath, JSON.stringify(context));
  await writeFile(resourceAuthFile, JSON.stringify({ baseUrl: url, daemonToken: 'daemon-fixture', agentId: 'helper-fixture', turnContextPath }));
  const registryBrokerSocket = join(root, 'broker.sock');
  await mkdir(registryMcpStateRoot(root), { recursive: true });
  await writeFile(registryMcpStatePath('11111111-2222-4333-8444-555555555555', root), JSON.stringify({
    status: 'connected', connectorId: '11111111-2222-4333-8444-555555555555', serverName: 'github/github',
    version: '1', remoteUrl: 'https://github-provider.invalid/mcp', accessToken: 'sealed-provider-fixture',
  }));
  const authorizations: Array<Record<string, unknown>> = [];
  const broker = new RegistryMcpHostBroker(root, (async (_url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sealed-provider-fixture');
    const message = JSON.parse(init!.body as string);
    calls.push({ name: message.method, arguments: message.params });
    let result: unknown = {};
    if (message.method === 'tools/list') result = { tools: outcome === 'missing' ? [] : [{ name: 'add_issue_comment' }] };
    if (message.method === 'tools/call') result = { isError: outcome === 'provider_error',
      content: [{ type: 'text', text: JSON.stringify({ id: 42 }) }] };
    return message.id === undefined ? new Response(null, { status: 202 })
      : Response.json({ jsonrpc: '2.0', id: message.id, result });
  }) as typeof fetch, async input => {
    expect(input).toMatchObject({ roomId: context.roomId, requestId: context.requestId,
      generationId: context.generationId, target: 'registry-mcp:github/github' });
    authorizations.push(input);
    return !(input.consume && outcome === 'needs_permission');
  }, registryBrokerSocket);
  brokers.push(broker);
  await broker.start();
  return { root, calls, authorizations, resourceAuthFile, registryBrokerSocket, relay: { url, token: 'relay-fixture', contextFile: turnContextPath } };
}

it('runs real gh issue-comment API requests through the explicitly connected personal key', async () => {
  const f = await fixture(true);
  const ghBinary = (await exec('which', ['gh'], { env: { PATH: '/usr/bin:/bin' } })).stdout.trim();
  const path = await installRoomGitHubLauncher({ ...f, ghBinary, inheritedPath: '/usr/bin:/bin' });
  const result = await exec('gh', ['api', '--method', 'POST', 'repos/owner/widgets/issues/1/comments',
    '-f', 'body=Room authentication verification', '--jq', '.id'], {
    cwd: f.root, env: { ...process.env, PATH: path, GH_TOKEN: 'app-fixture', GITHUB_TOKEN: 'app-fixture',
      GH_HOST: 'github.com', GH_REPO: 'owner/widgets', GH_DEBUG: '' },
  });
  expect(result.stdout.trim()).toBe('42');
  const call = f.calls.find(call => call.name === 'use_credential')!;
  expect(call.arguments).toEqual({ reference: 'vault://personal', http: {
    method: 'POST', url: 'https://api.github.com/repos/owner/widgets/issues/1/comments',
    headers: expect.objectContaining({ authorization: 'Bearer ${SECRET.access_token}' }),
    body: JSON.stringify({ body: 'Room authentication verification' }),
  } });
});

it('keeps repository App authentication when GitHub was only discovered from the vault', async () => {
  const f = await fixture(false);
  const binary = join(f.root, 'native-gh');
  await writeFile(binary, `#!${process.execPath}\nprocess.stdout.write(process.env.GH_TOKEN);`, { mode: 0o700 });
  const path = await installRoomGitHubLauncher({ ...f, ghBinary: binary, inheritedPath: '/usr/bin:/bin' });
  const result = await exec('gh', ['api', 'repos/owner/widgets/issues/1'], {
    cwd: f.root, env: { ...process.env, PATH: path, GH_TOKEN: 'repository-app-fixture' },
  });
  expect(result.stdout).toBe('repository-app-fixture');
  expect(f.calls).toEqual([]);
});

for (const transport of ['composio', 'registry-mcp']) {
  async function comment(f: Awaited<ReturnType<typeof fixture>>, endpoint = 'repos/owner/widgets/issues/1/comments') {
    const ghBinary = (await exec('which', ['gh'], { env: { PATH: '/usr/bin:/bin' } })).stdout.trim();
    const path = await installRoomGitHubLauncher({ ...f, ghBinary, inheritedPath: '/usr/bin:/bin' });
    return exec('gh', ['api', '--method', 'POST', endpoint,
      '-f', 'body=Room authentication verification', '--jq', '.id'], {
      cwd: f.root, env: { ...process.env, PATH: path, GH_TOKEN: 'app-fixture',
        GITHUB_TOKEN: 'app-fixture', GH_HOST: 'github.com', GH_REPO: 'owner/widgets', GH_DEBUG: '' },
    });
  }

  it(`runs native gh issue comments through the selected ${transport} account`, async () => {
    const f = await fixture(true, transport);
    expect((await comment(f)).stdout.trim()).toBe('42');
    const call = f.calls.find(call => call.name === (transport === 'composio' ? 'executeAppTool' : 'tools/call'))!;
    expect(call.arguments).toMatchObject({
      [transport === 'composio' ? 'tool' : 'name']: transport === 'composio'
        ? 'GITHUB_CREATE_AN_ISSUE_COMMENT' : 'add_issue_comment',
      arguments: { owner: 'owner', repo: 'widgets', issue_number: 1, body: 'Room authentication verification' },
    });
    expect(f.calls.some(call => call.name === 'use_credential')).toBe(false);
    if (transport === 'registry-mcp') {
      expect(f.calls.map(call => call.name)).toEqual([
        'initialize', 'notifications/initialized', 'tools/list', 'tools/call',
      ]);
      expect(f.authorizations.filter(call => call.consume)).toEqual([
        expect.objectContaining({ operation: 'add_issue_comment', consume: true }),
      ]);
    }
  });

  it(`preserves ${transport} refusal without falling back to the App`, async () => {
    const f = await fixture(true, transport, 'needs_permission');
    await expect(comment(f)).rejects.toMatchObject({ code: 1 });
    if (transport === 'composio') {
      expect(f.calls.filter(call => call.name === 'executeAppTool')).toHaveLength(1);
    } else {
      expect(f.authorizations.filter(call => call.consume)).toHaveLength(1);
      expect(f.calls.some(call => call.name === 'tools/call')).toBe(false);
    }
  });

  it(`does not invent an unavailable ${transport} comment tool`, async () => {
    const f = await fixture(true, transport, 'missing');
    await expect(comment(f)).rejects.toMatchObject({ code: 1 });
    expect(f.calls.some(call => ['executeAppTool', 'tools/call'].includes(call.name))).toBe(false);
  });

  it(`keeps ${transport} translation limited to issue-comment creation`, async () => {
    const f = await fixture(true, transport);
    await expect(comment(f, 'repos/owner/widgets/issues')).rejects.toMatchObject({ code: 1 });
    expect(f.calls.some(call => ['executeAppTool', 'tools/call'].includes(call.name))).toBe(false);
  });
}
