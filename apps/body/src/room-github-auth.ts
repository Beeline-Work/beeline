import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/** Keep native gh while letting Squire spend a selected personal key sealed. */
export async function installRoomGitHubLauncher(input: {
  root: string;
  ghBinary: string;
  inheritedPath: string;
  resourceAuthFile: string;
  relay?: { url: string; token: string; contextFile: string };
}): Promise<string> {
  const bin = join(input.root, 'room-github-bin');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const path = join(bin, 'gh');
  await writeFile(path, `#!${process.execPath}
const config = ${JSON.stringify(input)};
${launcherSource}
`, { mode: 0o700 });
  await chmod(path, 0o700);
  return [bin, input.inheritedPath].filter(Boolean).join(delimiter);
}

// Native gh owns argument parsing, pagination, jq and GraphQL. Its supported
// HTTP socket transport forwards personal-account requests to Squire rather
// than retrieving a provider token into the helper or the harness.
const launcherSource = String.raw`
const { readFile, mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
function unpack(result) {
  if (result.isError) throw new Error('Squire could not execute the GitHub request');
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text')?.text;
  return text ? JSON.parse(text) : result;
}
async function squire(context, name, args) {
  if (!config.relay) throw new Error('The personal GitHub connection requires Trusty Squire in this session');
  const response = await fetch(config.relay.url + '/mcp', {
    method: 'POST', headers: { authorization: 'Bearer ' + config.relay.token, 'content-type': 'application/json' },
    body: JSON.stringify({ ...context, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(210000),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error('GitHub connection could not be used');
  return unpack(payload.result);
}
async function run(env) {
  const child = spawn(config.ghBinary, process.argv.slice(2), { env, stdio: 'inherit' });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
async function main() {
  const auth = JSON.parse(await readFile(config.resourceAuthFile, 'utf8'));
  const context = JSON.parse(await readFile(auth.turnContextPath, 'utf8'));
  const response = await fetch(new URL('/v1/daemon/operations/readAgentWorkbench', auth.baseUrl), {
    method: 'POST',
    headers: { authorization: 'Bearer ' + auth.daemonToken, 'content-type': 'application/json',
      'x-beeline-helper-version': auth.helperVersion ?? 'v0.0.0' },
    body: JSON.stringify({ roomId: context.roomId }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('GitHub connection could not be checked');
  const workbench = await response.json();
  // Use the server's connection provenance, never a key label or a guess
  // about its permission level, to distinguish selection from discovery.
  const personal = workbench.apps?.find(app => app.appKey === 'github' && app.selectedByOwner);
  if (!personal) return await run(process.env);
  if (personal.transport !== 'squire-api') throw new Error('Use the connected personal GitHub tools for this account');
  const inventory = await squire(context, 'list_credentials', { service: 'github', fields: 'summary' });
  const credential = inventory.credentials?.find(item => item.reference === personal.connectionReference);
  if (!credential) throw new Error('The connected personal GitHub key is unavailable');
  const field = ['access_token', 'token', 'value'].find(name => credential.field_names?.includes(name));
  if (!field) throw new Error('The connected personal GitHub key has no supported token field');
  const root = await mkdtemp(join(tmpdir(), 'bl-gh-'));
  const socket = join(root, 'api.sock');
  const server = createServer(async (request, reply) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const headers = {};
      for (const name of ['accept', 'content-type', 'x-github-api-version']) {
        if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
      }
      headers.authorization = 'Bearer ' + '$' + '{SECRET.' + field + '}';
      const result = await squire(context, 'use_credential', {
        reference: credential.reference,
        http: { method: request.method, url: 'https://' + request.headers.host + request.url,
          headers, ...(body ? { body } : {}) },
      });
      const upstream = result.response;
      if (!upstream || !Number.isInteger(upstream.status)) throw new Error('GitHub response unavailable');
      const outgoing = {};
      for (const [name, value] of Object.entries(upstream.headers ?? {})) {
        if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase()))
          outgoing[name] = value;
      }
      reply.writeHead(upstream.status, outgoing).end(upstream.body ?? '');
    } catch {
      reply.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'The personal GitHub request could not be completed' }));
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    await writeFile(join(root, 'config.yml'), 'http_unix_socket: ' + JSON.stringify(socket) + '\n');
    return await run({ ...process.env, GH_CONFIG_DIR: root, GH_TOKEN: 'beeline-personal-route', GITHUB_TOKEN: 'beeline-personal-route' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
main().then(code => { process.exitCode = code; }, error => {
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
});
`;
