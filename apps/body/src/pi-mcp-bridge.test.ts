import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PI_MCP_BRIDGE_FILENAME,
  harnessMountsSessionMcpServers,
  installPiMcpBridge,
  piMcpBridgeSource,
} from './pi-mcp-bridge.js';

const SERVER = {
  name: 'beeline-agent',
  command: '/usr/bin/beeline-readonly-mcp',
  args: ['--stdio'],
  env: [
    { name: 'BEELINE_MCP_SURFACE', value: 'agent' },
    { name: 'BEELINE_DAEMON_TOKEN', value: 'token-abc' },
  ],
};

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bridge-'));
  await mkdir(resolve(root, 'pi'), { recursive: true });
  return resolve(root, 'pi');
}

describe('pi MCP bridge', () => {
  it('names pi as the one harness that drops session/new mcpServers', () => {
    expect(harnessMountsSessionMcpServers('/usr/bin/pi-acp')).toBe(false);
    expect(harnessMountsSessionMcpServers('pi-acp')).toBe(false);
    expect(harnessMountsSessionMcpServers('claude-agent-acp')).toBe(true);
    expect(harnessMountsSessionMcpServers('codex-acp')).toBe(true);
    expect(harnessMountsSessionMcpServers('grok')).toBe(true);
    expect(harnessMountsSessionMcpServers(undefined)).toBe(true);
  });

  it('carries the session’s exact server command, args and environment', () => {
    const source = piMcpBridgeSource([SERVER]);
    expect(source).toContain('"command": "/usr/bin/beeline-readonly-mcp"');
    expect(source).toContain('"--stdio"');
    expect(source).toContain('"BEELINE_DAEMON_TOKEN": "token-abc"');
    // The bridge speaks the same stdio MCP every other harness speaks, so the
    // MCP server stays the one authority for what an agent may do.
    expect(source).toContain("method: 'tools/list'");
    expect(source).toContain("method: 'tools/call'");
    expect(source).toContain('pi.registerTool');
  });

  it('writes the bridge into pi’s own extensions directory, privately', async () => {
    const piHome = await home();
    const path = await installPiMcpBridge({
      agentCommand: '/usr/bin/pi-acp',
      piHome,
      servers: [SERVER],
    });
    expect(path).toBe(resolve(piHome, 'extensions', PI_MCP_BRIDGE_FILENAME));
    const stats = await stat(path as string);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await readFile(path as string, 'utf8')).toContain('beeline-agent');
  });

  it('writes nothing for a harness that mounts its own servers, or with no home', async () => {
    const piHome = await home();
    expect(
      await installPiMcpBridge({ agentCommand: 'claude-agent-acp', piHome, servers: [SERVER] }),
    ).toBeUndefined();
    expect(
      await installPiMcpBridge({ agentCommand: '/usr/bin/pi-acp', servers: [SERVER] }),
    ).toBeUndefined();
    expect(
      await installPiMcpBridge({ agentCommand: '/usr/bin/pi-acp', piHome, servers: [] }),
    ).toBeUndefined();
  });

  it('replaces an existing bridge rather than following a symlink planted at its path', async () => {
    const piHome = await home();
    const directory = resolve(piHome, 'extensions');
    await mkdir(directory, { recursive: true });
    const outside = resolve(piHome, 'outside.js');
    await writeFile(outside, 'untouched', 'utf8');
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, resolve(directory, PI_MCP_BRIDGE_FILENAME));
    await installPiMcpBridge({ agentCommand: 'pi-acp', piHome, servers: [SERVER] });
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect(await readFile(resolve(directory, PI_MCP_BRIDGE_FILENAME), 'utf8')).toContain(
      'pi.registerTool',
    );
  });
});

/**
 * The bridge against a REAL stdio MCP server process.
 *
 * The generated file is plain ESM over node builtins, so a test can import it
 * and hand it a stub `pi` — which is exactly what pi's loader does. That makes
 * this a proof of the wire protocol (initialize, tools/list, tools/call, the
 * isError result) rather than a shape assertion: the failure it exists to catch
 * is a bridge that registers tools nobody can call.
 */
describe('pi MCP bridge, against a live stdio MCP server', () => {
  type BridgedTool = {
    description: string;
    parameters: unknown;
    execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  };
  async function bridgeFor(): Promise<{
    tools: Map<string, BridgedTool>;
    readCalls: () => Promise<{ params: { name: string; arguments: unknown }; surface: string }[]>;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'pi-bridge-live-'));
    const serverPath = resolve(root, 'server.mjs');
    const logPath = resolve(root, 'calls.jsonl');
    await writeFile(
      serverPath,
      `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } });
  if (request.method === 'tools/list')
    return send({ jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'subscribe_events', description: 'Choose what wakes you.', inputSchema: { type: 'object', required: ['kinds'], properties: { kinds: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
      { name: 'always_refuses', description: 'Refuses.', inputSchema: { type: 'object', properties: {} } },
    ] } });
  if (request.method === 'tools/call') {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ params: request.params, surface: process.env.BEELINE_MCP_SURFACE }) + '\\n');
    if (request.params.name === 'always_refuses')
      return send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'not an event kind you can subscribe to' }], isError: true } });
    return send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'You now react to joined in this Room.' }] } });
  }
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'no' } });
});
`,
      'utf8',
    );
    const bridgePath = resolve(root, 'bridge.mjs');
    await writeFile(
      bridgePath,
      piMcpBridgeSource([
        {
          name: 'beeline-agent',
          command: process.execPath,
          args: [serverPath],
          env: [{ name: 'BEELINE_MCP_SURFACE', value: 'agent' }],
        },
      ]),
      'utf8',
    );
    const module = (await import(`file://${bridgePath}`)) as {
      default: (pi: { registerTool: (tool: Record<string, unknown>) => void }) => Promise<void>;
    };
    const tools = new Map<string, BridgedTool>();
    await module.default({
      registerTool: (tool) => tools.set(tool.name as string, tool as unknown as BridgedTool),
    });
    return {
      tools,
      readCalls: async () =>
        (await readFile(logPath, 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
    };
  }

  it('republishes every tool the server lists, with its own schema', async () => {
    const { tools } = await bridgeFor();
    expect([...tools.keys()]).toEqual([
      'beeline-agent__subscribe_events',
      'beeline-agent__always_refuses',
    ]);
    const subscribe = tools.get('beeline-agent__subscribe_events');
    expect(subscribe?.description).toBe('Choose what wakes you.');
    // The MCP schema is passed through unchanged: typebox v1 schemas ARE plain
    // JSON Schema, so pi needs no translation layer here.
    expect(subscribe?.parameters).toEqual({
      type: 'object',
      required: ['kinds'],
      properties: { kinds: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    });
  });

  it('calls the tool with the model’s arguments in the server’s own environment', async () => {
    const { tools, readCalls } = await bridgeFor();
    const subscribe = tools.get('beeline-agent__subscribe_events');
    const result = (await subscribe?.execute('call-1', { kinds: ['joined'] })) as {
      content: { text: string }[];
    };
    expect(result.content[0]?.text).toBe('You now react to joined in this Room.');
    expect(await readCalls()).toEqual([
      {
        params: { name: 'subscribe_events', arguments: { kinds: ['joined'] } },
        surface: 'agent',
      },
    ]);
  });

  it('turns an MCP refusal into a thrown tool error, so the model reads why', async () => {
    const { tools } = await bridgeFor();
    const refusing = tools.get('beeline-agent__always_refuses');
    await expect(refusing?.execute('call-2', {})).rejects.toThrow(
      /not an event kind you can subscribe to/,
    );
  });
});
