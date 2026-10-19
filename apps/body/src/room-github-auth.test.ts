import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { installRoomGitHubLauncher } from './room-github-auth.js';

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(personal: boolean) {
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
        transport: 'squire-api', status: 'connected', connectionReference: 'vault://personal' }] }));
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
  await writeFile(resourceAuthFile, JSON.stringify({ baseUrl: url, daemonToken: 'daemon-fixture', turnContextPath }));
  return { root, calls, resourceAuthFile, relay: { url, token: 'relay-fixture', contextFile: turnContextPath } };
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
