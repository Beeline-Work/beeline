import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { installRoomGitHubLauncher } from './room-github-auth.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const calls: { tool: string; arguments: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    let data: unknown;
    if (req.url?.endsWith('readAgentWorkbench')) data = { apps: [{ appKey: 'github', selectedByOwner: true, transport: 'composio', appId: 'fixture' }] };
    else if (req.url?.endsWith('listAppTools')) data = { tools: ['GITHUB_CREATE_AN_ISSUE_COMMENT', 'BEELINE_GITHUB_REST_READ', 'BEELINE_GITHUB_GRAPHQL_READ', 'BEELINE_GITHUB_CONTENTS_PUT'].map(slug => ({ slug })) };
    else {
      calls.push(input);
      const result = input.arguments?.query?.includes('PullRequestByNumber') ? { data: { repository: { pullRequest: { title: 'Fixture PR' } } } } : input.arguments?.query?.includes('__type') ? { data: { Release: { fields: [{ name: 'isLatest' }] } } } : input.tool === 'BEELINE_GITHUB_GRAPHQL_READ'
        ? { data: { repository: { releases: { nodes: [{ name: 'Fixture release', tagName: 'v1', isDraft: false, isPrerelease: false, publishedAt: '2026-11-07T00:00:00Z' }], pageInfo: { hasNextPage: false, endCursor: '' } } } } }
        : { content: { path: 'proof.txt' } };
      data = { status: 'executed', data: { status: 200, headers: {}, body: JSON.stringify(result) } };
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const root = await mkdtemp(join(tmpdir(), 'gh-personal-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'context.json'), JSON.stringify({ roomId: 'fixture' }));
  await writeFile(join(root, 'fixture.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, daemonToken: 'fixture', turnContextPath: join(root, 'context.json') }));
  const path = await installRoomGitHubLauncher({ root, ghBinary: '/usr/bin/gh', inheritedPath: process.env.PATH!, resourceAuthFile: join(root, 'fixture.json') });
  const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(join(path.split(':')[0], 'gh'), args, { env: { ...process.env, GH_TOKEN: 'fixture', GH_CACHE_DIR: join(root, 'cache'), XDG_CACHE_HOME: join(root, 'cache') } });
    let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
  return { run, calls };
}
it('Reproduction gh-personal-502: native gh release list reads through Composio', async () => {
  const { run, calls } = await fixture();
  const result = await run(['release', 'list', '-R', 'Beeline-Work/beeline', '-L', '1']);
  expect(result.code, result.output + JSON.stringify(calls)).toBe(0);
  expect(result.output).toContain('Fixture release');
  expect(calls[0].tool).toBe('BEELINE_GITHUB_GRAPHQL_READ');
});
it('returns an unsupported request and its client error instead of a blanket 502', async () => {
  const { run, calls } = await fixture();
  const result = await run(['api', '-X', 'DELETE', 'repos/a/b/releases/1']);
  expect(result.output).toContain('HTTP 400');
  expect(result.output).toContain('Unsupported GitHub request: DELETE /repos/a/b/releases/1');
  expect(calls).toHaveLength(0);
});
it('refuses GraphQL mutations without calling the provider', async () => {
  const { run, calls } = await fixture();
  const result = await run(['api', 'graphql', '-f', 'query=mutation { deleteIssue(input:{id:"x"}) { clientMutationId } }']);
  expect(result.output).toContain('HTTP 400');
  expect(calls).toHaveLength(0);
});
it('routes repository contents PUT through the server tool', async () => {
  const { run, calls } = await fixture();
  const result = await run(['api', '-X', 'PUT', 'repos/a/b/contents/proof.txt', '-f', 'message=proof', '-f', 'content=eA==']);
  expect(result.code, result.output + JSON.stringify(calls)).toBe(0);
  expect(calls[0]).toMatchObject({ tool: 'BEELINE_GITHUB_CONTENTS_PUT', arguments: { path: '/repos/a/b/contents/proof.txt', body: { message: 'proof', content: 'eA==' } } });
});

it('reads pull request details with native gh', async () => {
  const { run } = await fixture();
  const result = await run(['pr', 'view', '1', '-R', 'a/b', '--json', 'title']);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('Fixture PR');
});
