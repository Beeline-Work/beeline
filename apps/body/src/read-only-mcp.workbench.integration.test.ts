import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { SquireTaskRelay } from './squire-task-relay.js';
import type { StdioSquireMcpClient } from './squire-mcp-client.js';
import { beelineAgentMcpServer } from './room-session.js';
import { DaemonApiClient } from './daemon-api-client.js';

let directory: string;
let outfile: string;
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
const relays: SquireTaskRelay[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workbench-mcp-'));
  outfile = join(directory, 'beeline-readonly-mcp.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent',
  });
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const relay of relays.splice(0)) relay.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function fixture(options: { stale?: boolean; failure?: string; toolFailure?: string; syncFails?: boolean } = {}) {
  const context = { roomId: 'corner', requestId: 'turn', taskId: 'root', generationId: 'generation' };
  const contextFile = join(directory, 'turn.json');
  await writeFile(contextFile, JSON.stringify(context));
  const calls: string[] = [];
  let connections = [{ reference: 'github', service: 'github', label: 'Existing key', state: 'active' }];
  let status = options.stale ? 'error' : 'connected';
  let cause = options.stale ? 'Earlier install failed' : undefined;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (request.url?.endsWith('/postConnectorVault')) {
      if (options.syncFails) { response.writeHead(503).end('{}'); return; }
      status = input.errorMessage ? 'error' : 'connected';
      cause = input.errorMessage;
      if (!input.errorMessage) connections = input.connections;
      response.end('{}');
    } else if (request.url?.endsWith('/readAgentWorkbench')) {
      response.end(JSON.stringify({ owner: { name: 'Owner' }, machine: { name: 'squire' },
        catalog: [{ connectorType: 'trusty-squire', name: 'Trusty Squire', purpose: 'A vault.',
          paired: { status, errorMessage: cause, helperName: 'squire', onThisMachine: true } }],
        connections, apps: [],
      }));
    } else { response.writeHead(404).end('{}'); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const relay = new SquireTaskRelay('agent', 'corner', contextFile, async () => true, directory,
    () => ({
      requestMcp: async (_method: string, params: { name?: string }) => {
        calls.push(params.name!);
        if (options.failure) throw new Error(options.failure);
        if (options.toolFailure) return { isError: true, content: [{ type: 'text', text: options.toolFailure }] };
        return { content: [{ type: 'text', text: JSON.stringify({ credentials: connections }) }] };
      }, close: () => {},
    } as unknown as StdioSquireMcpClient));
  relays.push(relay);
  relay.activate({ agentId: 'agent', roomId: 'corner', turnRequestId: 'turn', rootCommandId: 'root' } as AgentCommand, 'generation');
  const endpoint = await relay.listen();
  const config = {
    agentBinary: 'agent', mcpBinary: 'unused', readonlyMcpCommand: process.execPath,
    readonlyMcpArgs: [outfile], operatorHome: directory, agentEnv: {}, workspaceRoot: directory,
    autoApprovePermissions: false,
  };
  const wire = beelineAgentMcpServer(config, new DaemonApiClient(origin, 'daemon-token', 'agent'), {
    roomId: 'parent', cornerId: 'corner', workspaceId: 'workspace', turnContextPath: contextFile,
    // Same mount used by Room and corner sessions.
    squireRelay: endpoint,
  });
  const child = spawn(wire.command, wire.args, {
    env: { ...process.env, PATH: directory,
      ...Object.fromEntries(wire.env.map(({ name, value }) => [name, value])) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  const statusText = () => new Promise<string>((resolve, reject) => {
    lines.once('line', (line) => {
      const response = JSON.parse(line);
      if (response.result?.isError) reject(new Error(response.result.content[0].text));
      else resolve(response.result.content[0].text);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'workbench_status', arguments: {} } }) + '\n');
  });
  return { statusText, calls, closeRelay: () => relay.close(), appView: () => ({ status, cause, connections }),
    mountedTool: () => fetch(`${endpoint.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({ ...context, method: 'tools/call', params: { name: 'list_credentials' } }),
    }),
  };
}

describe('Reproduction squire-status-1 through the released Workbench MCP', () => {
  it.each([false, true])('reports connected through the working task relay (stale=%s)', async (stale) => {
    const f = await fixture({ stale });
    expect((await f.mountedTool()).status).toBe(200);
    const text = await f.statusText();
    expect(text).toContain('Trusty Squire): connected on squire (your machine)');
    expect(f.calls).toEqual(['list_credentials', 'list_credentials']);
    expect(f.appView().status).toBe('connected');
    console.log('Reproduction squire-status-1: list_credentials succeeded → Workbench connected on squire');
  });

  it('reports a redacted transport cause and preserves keys when Squire is unreachable', async () => {
    const f = await fixture({ failure: 'broker unavailable: /private/account/credentials.json token=secret-value' });
    const text = await f.statusText();
    expect(text).toContain('Trusty Squire): error on squire');
    expect(text).toContain('Squire broker unavailable');
    expect(text).not.toContain('/private');
    expect(text).not.toContain('secret-value');
    expect(f.appView()).toMatchObject({ status: 'error', cause: 'Squire broker unavailable' });
    expect(f.appView().connections).toHaveLength(1);
  });

  it('keeps the successful reachability verdict when metadata sync fails', async () => {
    const f = await fixture({ syncFails: true });
    expect(await f.statusText()).toContain('Trusty Squire): connected on squire');
  });

  it('reports a refused connection when the actual task relay is down', async () => {
    const f = await fixture();
    f.closeRelay();
    expect(await f.statusText()).toContain('Squire relay connection refused');
    expect(f.appView()).toMatchObject({ status: 'error', cause: 'Squire relay connection refused' });
  });

  it('does not mistake an MCP tool error for an empty successful vault read', async () => {
    const f = await fixture({ toolFailure: 'vault locked: /private/credentials.json key=secret-value' });
    const text = await f.statusText();
    expect(text).toContain('Squire vault locked');
    expect(text).not.toContain('secret-value');
    expect(f.appView()).toMatchObject({ status: 'error', cause: 'Squire vault locked' });
    expect(f.appView().connections).toHaveLength(1);
  });

  it('does not turn a task authorization refusal into a machine failure', async () => {
    const f = await fixture({ failure: 'Squire call is not authorized for this task' });
    expect(await f.statusText()).toContain('Trusty Squire): connected on squire');
    expect(f.appView().status).toBe('connected');
  });
});
