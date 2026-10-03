import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import {
  PI_MCP_BRIDGE_FILENAME,
  harnessMountsSessionMcpServers,
  installPiMcpBridge,
  piMcpBridgeSource,
} from './pi-mcp-bridge.js';
import { SquireTaskRelay } from './squire-task-relay.js';
import { squireFacadeLaunch } from './squire-host.js';
import type { StdioSquireMcpClient } from './squire-mcp-client.js';

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
  it('claims session MCP only for harnesses that actually deliver it', () => {
    expect(harnessMountsSessionMcpServers('/usr/bin/pi-acp')).toBe(false);
    expect(harnessMountsSessionMcpServers('pi-acp')).toBe(false);
    expect(harnessMountsSessionMcpServers('cursor-agent-acp')).toBe(false);
    expect(harnessMountsSessionMcpServers('/usr/bin/cursor-agent-acp')).toBe(false);
    expect(harnessMountsSessionMcpServers('cursor-acp-bridge')).toBe(true);
    expect(harnessMountsSessionMcpServers('/usr/bin/cursor-acp-bridge')).toBe(true);
    expect(harnessMountsSessionMcpServers('claude-agent-acp')).toBe(true);
    expect(harnessMountsSessionMcpServers('codex-acp')).toBe(true);
    expect(harnessMountsSessionMcpServers('grok')).toBe(true);
    expect(harnessMountsSessionMcpServers('some-unknown-acp')).toBe(false);
    expect(harnessMountsSessionMcpServers(undefined)).toBe(false);
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

  it('carries CodeGraph into pi while Codex, Claude, and Grok mount it from session/new', () => {
    for (const harness of ['codex-acp', 'claude-agent-acp', 'grok']) {
      expect(harnessMountsSessionMcpServers(harness)).toBe(true);
    }
    expect(harnessMountsSessionMcpServers('pi-acp')).toBe(false);
    const source = piMcpBridgeSource([
      {
        name: 'codegraph',
        command: '/opt/beeline/codegraph',
        args: ['serve', '--mcp', '--path', '/repo'],
        env: [{ name: 'CODEGRAPH_NO_DAEMON', value: '1' }],
      },
    ]);
    expect(source).toContain('"name": "codegraph"');
    expect(source).toContain('"command": "/opt/beeline/codegraph"');
    expect(source).toContain('"CODEGRAPH_NO_DAEMON": "1"');
    expect(source).toContain("method: 'tools/list'");
    expect(source).toContain("method: 'tools/call'");
  });

  it('writes the bridge into pi’s own extensions directory, privately', async () => {
    const piHome = await home();
    const path = await installPiMcpBridge({
      agentCommand: '/usr/bin/pi-acp',
      piHome,
      nativeMcp: false,
      servers: [SERVER],
    });
    expect(path).toBe(resolve(piHome, 'extensions', PI_MCP_BRIDGE_FILENAME));
    const stats = await stat(path as string);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await readFile(path as string, 'utf8')).toContain('beeline-agent');
  });

  it('puts copied local stdio servers on the legacy bridge once', async () => {
    const piHome = await home();
    await writeFile(
      resolve(piHome, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          local: {
            command: '/usr/bin/local-mcp',
            args: ['serve'],
            cwd: '/repo',
            env: { MODE: 'room' },
          },
          'beeline-agent': { command: '/wrong/duplicate' },
        },
      }),
    );
    const path = await installPiMcpBridge({
      agentCommand: 'pi-acp',
      piHome,
      nativeMcp: false,
      servers: [SERVER],
    });
    const source = await readFile(path!, 'utf8');
    expect(source).toContain('"command": "/usr/bin/local-mcp"');
    expect(source).toContain('"MODE": "room"');
    expect(source).toContain('"cwd": "/repo"');
    expect(source).not.toContain('/wrong/duplicate');
    expect(source.match(/"name": "beeline-agent"/g)).toHaveLength(1);
    const config = JSON.parse(await readFile(resolve(piHome, 'mcp.json'), 'utf8'));
    expect(config.mcpServers.local.enabled).toBe(false);
    expect(config.mcpServers['beeline-agent'].enabled).toBe(false);
  });

  it('lets native Pi own its isolated config and removes a stale generated bridge', async () => {
    const piHome = await home();
    const bridge = resolve(piHome, 'extensions', PI_MCP_BRIDGE_FILENAME);
    await mkdir(resolve(piHome, 'extensions'), { recursive: true });
    await writeFile(bridge, 'stale');
    await writeFile(
      resolve(piHome, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          local: { command: '/usr/bin/local-mcp', exposure: 'codemode' },
        },
      }),
    );
    const path = await installPiMcpBridge({
      agentCommand: 'pi-acp',
      piHome,
      nativeMcp: true,
      servers: [SERVER],
    });
    expect(path).toBe(resolve(piHome, 'mcp.json'));
    const config = JSON.parse(await readFile(path!, 'utf8'));
    expect(config.mcpServers.local).toEqual({
      command: '/usr/bin/local-mcp',
      exposure: 'codemode',
    });
    expect(config.mcpServers['beeline-agent']).toMatchObject({
      command: SERVER.command,
      exposure: 'direct',
      env: {
        BEELINE_DAEMON_TOKEN: 'token-abc',
      },
    });
    await expect(readFile(bridge, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes nothing for a harness that mounts its own servers, or with no home', async () => {
    const piHome = await home();
    expect(
      await installPiMcpBridge({ agentCommand: 'claude-agent-acp', piHome, servers: [SERVER] }),
    ).toBeUndefined();
    expect(
      await installPiMcpBridge({ agentCommand: 'cursor-acp-bridge', piHome, servers: [SERVER] }),
    ).toBeUndefined();
    expect(
      await installPiMcpBridge({ agentCommand: 'cursor-agent-acp', piHome, servers: [SERVER] }),
    ).toBeUndefined();
    expect(
      await installPiMcpBridge({ agentCommand: '/usr/bin/pi-acp', servers: [SERVER] }),
    ).toBeUndefined();
    expect(
      await installPiMcpBridge({
        agentCommand: '/usr/bin/pi-acp',
        piHome,
        nativeMcp: false,
        servers: [],
      }),
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
    await installPiMcpBridge({
      agentCommand: 'pi-acp',
      piHome,
      nativeMcp: false,
      servers: [SERVER],
    });
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
  async function bridgeFor(
    name = 'beeline-agent',
    authorizationEnv: Record<string, string> = {},
    failOnce = false,
  ): Promise<{
    tools: Map<string, BridgedTool>;
    readCalls: () => Promise<{ params: { name: string; arguments: unknown }; surface: string }[]>;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'pi-bridge-live-'));
    const serverPath = resolve(root, 'server.mjs');
    const logPath = resolve(root, 'calls.jsonl');
    await writeFile(
      serverPath,
      `import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
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
    if (process.env.MCP_FAIL_ONCE_FILE && !existsSync(process.env.MCP_FAIL_ONCE_FILE)) {
      writeFileSync(process.env.MCP_FAIL_ONCE_FILE, 'failed');
      process.stderr.write('index worker closed the connection\\n');
      process.exit(17);
    }
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
          name,
          command: process.execPath,
          args: [serverPath],
          env: [
            { name: 'BEELINE_MCP_SURFACE', value: 'agent' },
            ...(failOnce
              ? [{ name: 'MCP_FAIL_ONCE_FILE', value: resolve(root, 'failed-once') }]
              : []),
            ...(name === 'vault'
              ? [{ name: 'TRUSTY_SQUIRE_BROKER_SOCKET', value: '/host/broker.sock' }]
              : []),
          ],
        },
        ...(name === 'beeline-agent'
          ? []
          : [
              {
                name: 'beeline-agent',
                command: process.execPath,
                args: [serverPath],
                env: Object.entries(authorizationEnv).map(([name, value]) => ({ name, value })),
              },
            ]),
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

  it.each(['squire', 'vault'])(
    'gates every Pi %s call against the current turn before contacting Squire',
    async (name) => {
      const root = await home();
      const contextPath = resolve(root, 'turn.json');
      const context = { roomId: 'room', requestId: 'request-1', generationId: 'generation' };
      await writeFile(contextPath, JSON.stringify(context));
      let verdict: unknown = { allowed: false };
      let status = 200;
      const requests: unknown[] = [];
      const server = createServer(async (request, response) => {
        expect(request.url).toBe('/v1/daemon/operations/authorizeSquireCall');
        expect(request.headers.authorization).toBe('Bearer daemon-token');
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(verdict));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address() as { port: number };
        const { tools, readCalls } = await bridgeFor(name, {
          BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${address.port}`,
          BEELINE_DAEMON_TOKEN: 'daemon-token',
          BEELINE_TURN_CONTEXT_FILE: contextPath,
        });
        const tool = tools.get(`${name}__subscribe_events`)!;
        await expect(tool.execute('denied', {})).rejects.toThrow();
        expect(await readCalls()).toEqual([]);
        expect(requests).toEqual([context]);
        verdict = { allowed: true };
        await tool.execute('approved', {});
        expect(await readCalls()).toHaveLength(1);
        await writeFile(contextPath, JSON.stringify({ ...context, requestId: 'request-2' }));
        verdict = { allowed: false };
        await expect(tool.execute('different-requester', {})).rejects.toThrow();
        expect(requests.at(-1)).toEqual({ ...context, requestId: 'request-2' });
        verdict = { allowed: 'true' };
        await expect(tool.execute('malformed', {})).rejects.toThrow();
        status = 503;
        verdict = { allowed: true };
        await expect(tool.execute('unavailable', {})).rejects.toThrow();
        await writeFile(contextPath, '{}');
        await expect(tool.execute('missing-context', {})).rejects.toThrow();
        expect(await readCalls()).toHaveLength(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const { tools, readCalls } = await bridgeFor(name);
      await expect(
        tools.get(`${name}__subscribe_events`)!.execute('no-auth', {}),
      ).rejects.toThrow();
      expect(await readCalls()).toEqual([]);
    },
  );

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
        params: {
          name: 'subscribe_events',
          arguments: { kinds: ['joined'] },
          _meta: { beelineToolCallId: 'call-1' },
        },
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

  it('reports CodeGraph process stderr, then calls again through a fresh process while read tools remain', async () => {
    const { tools } = await bridgeFor('codegraph', {}, true);
    const explore = tools.get('codegraph__subscribe_events')!;
    await expect(explore.execute('first', {})).rejects.toThrow(
      /codegraph exited before answering \(code 17, signal null\): index worker closed the connection/,
    );
    expect(await explore.execute('retry', {})).toMatchObject({
      content: [{ text: 'You now react to joined in this Room.' }],
    });
    expect(
      await tools.get('beeline-agent__subscribe_events')!.execute('fallback', {}),
    ).toMatchObject({ content: [{ text: 'You now react to joined in this Room.' }] });
  });
});

describe('pi MCP bridge, through a real Squire task relay (the live Pi route)', () => {
  /**
   * Proves the property live Pi actually depends on: `callServer()` above
   * spawns a brand-new facade PROCESS for every single `execute()` call —
   * that part of the bug report is true and intentional (a cheap stdio↔HTTP
   * proxy). What must NOT happen per call is a new SQUIRE CONNECTION, because
   * Trusty Squire 1.1.25 ties a browser session to the agent connection that
   * opened it and closes it a few seconds after that connection ends. This
   * drives the REAL generated bridge module (via `piMcpBridgeSource`,
   * imported and executed exactly like Pi would) through a REAL
   * `SquireTaskRelay`, across three separate turns of one task, and asserts
   * the relay's own backing connection (`spawns`) never grows past the one
   * opened for the initial tools/list inventory call — no matter how many
   * facade processes `execute()` spawns — and that no call ever sees
   * `stale_lease`.
   */
  it('reuses exactly one Squire connection across many per-call facade spawns, over several turns of one task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bridge-squire-relay-'));
    const contextFile = resolve(root, 'turn.json');
    let spawns = 0;
    const relay = new SquireTaskRelay(
      'agent',
      'room',
      contextFile,
      async () => true,
      root,
      (hooks) => {
        spawns++;
        hooks.onSpawn(9000 + spawns);
        return {
          pid: 9000 + spawns,
          requestMcp: async (
            method: string,
            params: { name?: string; arguments?: Record<string, unknown> },
          ) => {
            if (method === 'tools/list')
              return {
                tools: ['operate_start', 'operate_observe', 'operate_scroll', 'operate_finish'].map(
                  (name) => ({ name }),
                ),
              };
            if (params.name === 'operate_start')
              return { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] };
            return { content: [{ type: 'text', text: `${params.name} ok` }] };
          },
          close: () => {},
        } as unknown as StdioSquireMcpClient;
      },
    );
    const endpoint = await relay.listen();
    const daemon = createServer(async (request, response) => {
      for await (const _chunk of request) void _chunk;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ allowed: true }));
    });
    await new Promise<void>((resolveListen) => daemon.listen(0, '127.0.0.1', resolveListen));
    try {
      const launch = squireFacadeLaunch(root, { agentId: 'agent', roomId: 'room', relay: endpoint });
      const squireServer = {
        name: 'squire',
        command: launch.command,
        args: launch.args,
        env: Object.entries(launch.env).map(([name, value]) => ({ name, value })),
      };
      const daemonAddress = daemon.address() as { port: number };
      const beelineAgentServer = {
        name: 'beeline-agent',
        command: process.execPath,
        args: ['-e', ''],
        env: [
          { name: 'BEELINE_DAEMON_BASE_URL', value: `http://127.0.0.1:${daemonAddress.port}` },
          { name: 'BEELINE_DAEMON_TOKEN', value: 'daemon-token' },
          { name: 'BEELINE_TURN_CONTEXT_FILE', value: contextFile },
        ],
      };
      const bridgePath = resolve(root, 'bridge.mjs');
      await writeFile(bridgePath, piMcpBridgeSource([squireServer, beelineAgentServer]), 'utf8');
      const module = (await import(`file://${bridgePath}`)) as {
        default: (pi: { registerTool: (tool: Record<string, unknown>) => void }) => Promise<void>;
      };
      const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
      await module.default({
        registerTool: (tool) => tools.set(tool.name as string, tool as never),
      });
      expect([...tools.keys()]).toEqual(
        expect.arrayContaining([
          'squire__operate_start',
          'squire__operate_observe',
          'squire__operate_scroll',
          'squire__operate_finish',
        ]),
      );
      // The inventory tools/list probe above already opened the one Squire
      // connection this whole test keeps proving stays singular.
      expect(spawns).toBe(1);

      const runTurn = async (
        requestId: string,
        calls: Array<{ tool: string; args?: Record<string, unknown> }>,
      ) => {
        await writeFile(
          contextFile,
          JSON.stringify({ roomId: 'room', requestId, taskId: 'task-1', generationId: 'gen-1' }),
        );
        relay.activate(
          {
            id: requestId,
            roomId: 'room',
            agentId: 'agent',
            sourceMessageId: requestId,
            turnRequestId: requestId,
            action: 'input',
            reason: 'message',
            rootCommandId: 'task-1',
            rootSourceMessageId: requestId,
            agentDepth: 0,
            source: {} as AgentCommand['source'],
          } as AgentCommand,
          'gen-1',
        );
        const results: unknown[] = [];
        for (const call of calls) {
          const tool = tools.get(`squire__${call.tool}`)!;
          results.push(await tool.execute(`${requestId}-${call.tool}`, call.args ?? {}));
        }
        relay.deactivate(requestId);
        return results;
      };

      await runTurn('turn-1', [{ tool: 'operate_start' }]);
      await runTurn('turn-2', [
        { tool: 'operate_observe', args: { sessionId: 'browser-1' } },
        { tool: 'operate_scroll', args: { sessionId: 'browser-1', direction: 'down' } },
      ]);
      const finished = await runTurn('turn-3', [
        { tool: 'operate_finish', args: { sessionId: 'browser-1' } },
      ]);

      for (const result of finished) expect(JSON.stringify(result)).not.toContain('stale_lease');
      // Four more facade processes spawned across three turns — and the
      // underlying Squire connection is still the single one from inventory.
      expect(spawns).toBe(1);
    } finally {
      daemon.closeAllConnections();
      await new Promise<void>((resolveClose) => daemon.close(() => resolveClose()));
      relay.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
