import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/** Keep native gh while letting Squire spend a selected personal key sealed. */
export async function installRoomGitHubLauncher(input: {
  root: string;
  ghBinary: string;
  inheritedPath: string;
  resourceAuthFile: string;
  registryBrokerSocket?: string;
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
const { createConnection } = require('node:net');
const { randomUUID } = require('node:crypto');
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
async function daemon(auth, context, name, args) {
  const response = await fetch(new URL('/v1/daemon/operations/' + name, auth.baseUrl), {
    method: 'POST', headers: { authorization: 'Bearer ' + auth.daemonToken,
      'content-type': 'application/json', 'x-beeline-helper-version': auth.helperVersion ?? 'v0.0.0' },
    body: JSON.stringify({ ...context, agentId: auth.agentId, ...args }),
    signal: AbortSignal.timeout(210000),
  });
  if (!response.ok) throw new Error('GitHub app tool request failed');
  return await response.json();
}
function registry(connectorId, context, connectionId, method, params, id) {
  if (!config.registryBrokerSocket || !connectorId) throw new Error('GitHub MCP connection unavailable');
  return new Promise((resolve, reject) => {
    const socket = createConnection(config.registryBrokerSocket);
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(125000, () => socket.destroy(new Error('GitHub MCP request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(JSON.stringify({ connectorId, turn: context, connectionId,
      line: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) })));
    socket.on('data', chunk => { output += chunk; });
    socket.on('close', () => {
      try {
        const response = JSON.parse(output);
        if (response.error) throw new Error('GitHub MCP request failed');
        const message = response.messages.map(line => JSON.parse(line)).find(item => item.id === id);
        if (id !== undefined && (!message || message.error)) throw new Error('GitHub MCP request failed');
        resolve(message?.result);
      } catch (error) { reject(error); }
    });
  });
}
async function issueCommentRoute(personal, auth, context) {
  const managed = personal.transport === 'composio';
  if (!managed && personal.transport !== 'registry-mcp') throw new Error('GitHub transport unavailable');
  const connectionId = randomUUID();
  let id = 0;
  const mcp = (method, params, notification = false) => registry(personal.connectorId, context,
    connectionId, method, params, notification ? undefined : ++id);
  let tools;
  if (managed) {
    tools = (await daemon(auth, context, 'listAppTools', { appId: personal.appId, query: 'issue comment' })).tools;
  } else {
    await mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'beeline-room-github', version: '1' } });
    await mcp('notifications/initialized', {}, true);
    tools = [];
    let cursor;
    do {
      const page = await mcp('tools/list', cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
  }
  const name = managed ? 'GITHUB_CREATE_AN_ISSUE_COMMENT' : 'add_issue_comment';
  const tool = tools?.find(tool => (managed ? tool.slug : tool.name) === name);
  if (!tool) throw new Error('The connected GitHub provider has no issue-comment tool');
  return async (request, body) => {
    const match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/comments$/.exec(request.url);
    if (request.method !== 'POST' || request.headers.host !== 'api.github.com' || !match)
      throw new Error('This GitHub provider supports issue-comment requests only');
    const input = JSON.parse(body);
    if (typeof input.body !== 'string' || Object.keys(input).some(key => key !== 'body'))
      throw new Error('Invalid issue-comment request');
    const args = { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]),
      issue_number: Number(match[3]), body: input.body };
    let data;
    if (managed) {
      const result = await daemon(auth, context, 'executeAppTool', { appId: personal.appId,
        tool: name, arguments: args });
      if (result.status !== 'executed') throw new Error('GitHub app request was not executed');
      data = result.data;
    } else {
      data = unpack(await mcp('tools/call', { name, arguments: args }));
    }
    return { status: 201, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) };
  };
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
  let providerRequest;
  if (personal.transport === 'squire-api') {
    const inventory = await squire(context, 'list_credentials', { service: 'github', fields: 'summary' });
    const credential = inventory.credentials?.find(item => item.reference === personal.connectionReference);
    if (!credential) throw new Error('The connected personal GitHub key is unavailable');
    const field = ['access_token', 'token', 'value'].find(name => credential.field_names?.includes(name));
    if (!field) throw new Error('The connected personal GitHub key has no supported token field');
    providerRequest = async (request, body) => {
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
      return result.response;
    };
  } else {
    providerRequest = await issueCommentRoute(personal, auth, context);
  }
  const root = await mkdtemp(join(tmpdir(), 'bl-gh-'));
  const socket = join(root, 'api.sock');
  const server = createServer(async (request, reply) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const upstream = await providerRequest(request, body);
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
