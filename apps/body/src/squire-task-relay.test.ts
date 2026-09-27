import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { SquireTaskRelay } from './squire-task-relay.js';
import { grantedHostRouteWires } from './host-mcp-route.js';
import { piMcpBridgeSource } from './pi-mcp-bridge.js';
import type { StdioSquireMcpClient } from './squire-mcp-client.js';

const relays: SquireTaskRelay[] = [];
afterEach(() => { for (const relay of relays.splice(0)) relay.close(); vi.restoreAllMocks(); });

function command(taskId: string, requestId: string): AgentCommand {
  return {
    id: requestId, roomId: 'room', agentId: 'agent', sourceMessageId: requestId,
    turnRequestId: requestId, action: 'input', reason: 'message', rootCommandId: taskId,
    rootSourceMessageId: requestId, agentDepth: 0, source: {} as AgentCommand['source'],
  };
}

function fixture(contextFile = '/tmp/context', authorize = async () => true) {
  let spawns = 0;
  let exits = 0;
  let callbacks: { onSpawn: (pid: number) => void; onExit: (pid: number, code: number) => void } | undefined;
  const relay = new SquireTaskRelay('agent', 'room', contextFile, authorize, homedir(), (hooks) => {
    spawns++;
    callbacks = hooks as typeof callbacks;
    hooks.onSpawn(2000 + spawns);
    return {
      pid: 2000 + spawns,
      requestMcp: vi.fn(async (method: string, params: { name?: string }) => {
        if (method === 'tools/list') return { tools: [{ name: 'operate_start' }, { name: 'operate_observe' }] };
        if (params.name === 'operate_start') return { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] };
        return { content: [{ type: 'text', text: 'page observed' }] };
      }),
      close: () => { exits++; },
    } as unknown as StdioSquireMcpClient;
  });
  relays.push(relay);
  return { relay, stats: () => ({ spawns, exits }), die: () => callbacks?.onExit(2000 + spawns, 1) };
}

async function request(
  relay: SquireTaskRelay,
  taskId: string,
  requestId: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const endpoint = await relay.listen();
  const response = await fetch(`${endpoint.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: 'room', taskId, requestId, generationId: 'generation', method, params }),
  });
  return { status: response.status, body: await response.json() as { result?: unknown; error?: string } };
}

describe('helper-owned Squire task relay', () => {
  it('keeps one MCP connection through two calls and two turns across Pi and Codex routes', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...parts) => { logs.push(parts.join(' ')); });
    const { relay, stats } = fixture();
    const endpoint = await relay.listen();
    const scope = { agentId: 'agent', roomId: 'room', relay: endpoint };
    const codex = grantedHostRouteWires(['squire'], '/home/op', {}, '/tmp/resource-auth', scope)[0]!;
    expect(codex.env).toContainEqual({ name: 'BEELINE_RESOURCE_GATE', value: 'transport' });
    const launch = JSON.parse(codex.env?.find((entry) => entry.name === 'BEELINE_RESOURCE_LAUNCH')?.value ?? '{}');
    expect(launch.env.BEELINE_SQUIRE_RELAY_URL).toBe(endpoint.url);
    expect(launch.env.BEELINE_TURN_CONTEXT_FILE).toBe('/tmp/context');
    expect(launch.env).not.toHaveProperty('TRUSTY_SQUIRE_BROKER_SOCKET');
    const pi = piMcpBridgeSource([codex]);
    expect(pi).toContain('BEELINE_SQUIRE_RELAY_URL');
    relay.activate(command('root', 'turn-one'), 'generation');
    expect((await request(relay, 'root', 'turn-one', 'tools/list')).status).toBe(200);
    expect((await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' })).status).toBe(200);
    relay.deactivate('turn-one');
    relay.activate(command('root', 'turn-two'), 'generation');
    expect((await request(relay, 'root', 'turn-two', 'initialize')).status).toBe(200);
    expect((await request(relay, 'root', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
    expect(stats().spawns).toBe(1);
    expect((await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_observe' })).status).toBe(400);
    const calls = logs.filter((line) => line.includes('"event":"call-start"'))
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as { mcpConnectionId: string; requestId: string });
    expect(new Set(calls.map((call) => call.mcpConnectionId)).size).toBe(1);
    expect(new Set(calls.map((call) => call.requestId))).toEqual(new Set(['turn-one', 'turn-two']));
    expect(logs.join('\n')).not.toContain('browser-1');
  });

  it('cancellation closes the connection; the next task and helper cannot reuse its session', async () => {
    const { relay, stats } = fixture();
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    relay.cancel('turn-one');
    expect(stats().exits).toBe(1);
    relay.activate(command('second', 'turn-two'), 'generation');
    const stale = await request(relay, 'second', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    });
    expect(stale.status).toBe(400);
    expect(stale.body.error).toMatch(/no longer owned/);
    const replacement = fixture().relay;
    replacement.activate(command('first', 'turn-three'), 'generation');
    expect((await request(replacement, 'first', 'turn-three', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);
  });

  it('closes the old root before a different task becomes active', async () => {
    const { relay, stats } = fixture();
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    relay.deactivate('turn-one');
    relay.activate(command('second', 'turn-two'), 'generation');
    expect(stats().exits).toBe(1);
    expect((await request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);
  });

  it('requires an explicit operate_start after the Squire child dies', async () => {
    const { relay, stats, die } = fixture();
    relay.activate(command('root', 'turn-one'), 'generation');
    await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' });
    die();
    expect((await request(relay, 'root', 'turn-one', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);
    expect((await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' })).status).toBe(200);
    expect(stats().spawns).toBe(2);
  });

  it('enforces the grant at the relay even when the caller bypasses the stdio facade', async () => {
    const authorize = vi.fn(async () => false);
    const { relay } = fixture('/tmp/context', authorize);
    relay.activate(command('root', 'turn-one'), 'generation');
    const result = await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/not authorized/);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'root', requestId: 'turn-one', tool: 'operate_start',
    }));
  });

  it('rejects another task and a caller without the relay token', async () => {
    const { relay } = fixture();
    relay.activate(command('root', 'turn-one'), 'generation');
    expect((await request(relay, 'other-root', 'turn-one', 'tools/list')).status).toBe(400);
    const endpoint = await relay.listen();
    const withoutToken = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST', body: JSON.stringify({ method: 'tools/list' }),
    });
    expect(withoutToken.status).toBe(403);
    expect(() => relay.activate({ ...command('root', 'turn-one'), agentId: 'other-agent' }, 'generation'))
      .toThrow(/scope/);
  });

  it('routes separate real stdio facade processes through the same task connection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'squire-task-proxy-'));
    const contextFile = join(dir, 'turn.json');
    const { relay, stats } = fixture(contextFile);
    try {
      const endpoint = await relay.listen();
      const invoke = async (turn: string, name: string, args: Record<string, unknown> = {}) => {
        await writeFile(contextFile, JSON.stringify({
          roomId: 'room', requestId: turn, taskId: 'root', generationId: 'generation',
        }));
        const child = spawn(process.execPath, [
          '--import', 'tsx', fileURLToPath(new URL('./squire-facade.ts', import.meta.url)),
        ], {
          env: { ...process.env, BEELINE_SQUIRE_RELAY_URL: endpoint.url,
            BEELINE_SQUIRE_RELAY_TOKEN: endpoint.token, BEELINE_TURN_CONTEXT_FILE: contextFile },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        try {
          const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
            let output = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
              output += chunk;
              const newline = output.indexOf('\n');
              if (newline >= 0) resolve(JSON.parse(output.slice(0, newline)));
            });
            child.once('error', reject);
            child.once('exit', () => reject(new Error('stdio facade exited before responding')));
          });
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name, arguments: args } })}\n`);
          return await reply;
        } finally {
          child.kill();
        }
      };
      relay.activate(command('root', 'turn-one'), 'generation');
      expect(await invoke('turn-one', 'operate_start')).toHaveProperty('result');
      relay.deactivate('turn-one');
      relay.activate(command('root', 'turn-two'), 'generation');
      expect(await invoke('turn-two', 'operate_observe', { sessionId: 'browser-1' })).toHaveProperty('result');
      expect(stats().spawns).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
