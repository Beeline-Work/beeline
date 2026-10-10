import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { SQUIRE_TASK_IDLE_LEASE_MS, SquireTaskRelay } from './squire-task-relay.js';
import { grantedHostRouteWires } from './host-mcp-route.js';
import { piMcpBridgeSource } from './pi-mcp-bridge.js';
import type { StdioSquireMcpClient } from './squire-mcp-client.js';

const relays: SquireTaskRelay[] = [];
afterEach(() => { for (const relay of relays.splice(0)) relay.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

function command(taskId: string, requestId: string): AgentCommand {
  return {
    id: requestId, roomId: 'room', agentId: 'agent', sourceMessageId: requestId,
    turnRequestId: requestId, action: 'input', reason: 'message', rootCommandId: taskId,
    rootSourceMessageId: requestId, agentDepth: 0, source: {} as AgentCommand['source'],
  };
}

function fixture(
  contextFile = '/tmp/context',
  authorize = async () => true,
  respond?: (method: string, params: { name?: string }) => Promise<unknown>,
  onApprovalDecided?: (decision: unknown) => void,
) {
  let spawns = 0;
  let exits = 0;
  let callbacks: { onSpawn: (pid: number) => void; onExit: (pid: number, code: number) => void;
    onDiagnostic: (message: string) => void; onNotification: (message: Record<string, unknown>) => void }
    | undefined;
  const relay = new SquireTaskRelay('agent', 'room', contextFile, authorize, homedir(), (hooks) => {
    spawns++;
    callbacks = hooks as typeof callbacks;
    hooks.onSpawn(2000 + spawns);
    return {
      pid: 2000 + spawns,
      requestMcp: vi.fn(async (method: string, params: { name?: string }) => {
        if (respond) return respond(method, params);
        if (method === 'tools/list') return { tools: [{ name: 'operate_start' }, { name: 'operate_observe' }] };
        if (params.name === 'operate_start') return { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] };
        return { content: [{ type: 'text', text: 'page observed' }] };
      }),
      close: () => { exits++; },
    } as unknown as StdioSquireMcpClient;
  }, onApprovalDecided);
  relays.push(relay);
  return { relay, stats: () => ({ spawns, exits }),
    die: () => callbacks?.onExit(2000 + spawns, 1),
    diagnose: (message: string) => callbacks?.onDiagnostic(message),
    notify: (message: Record<string, unknown>) => callbacks?.onNotification(message) };
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
  it('lists tools during Pi session startup before a turn, without authorizing a call', async () => {
    const { relay, stats } = fixture();
    const listed = await request(relay, 'startup', 'startup', 'tools/list');
    expect(listed.status).toBe(200);
    expect(listed.body.result).toMatchObject({ tools: expect.arrayContaining([{ name: 'operate_start' }]) });
    expect(stats().spawns).toBe(1);
    expect((await request(relay, 'startup', 'startup', 'tools/call', { name: 'operate_start' })).status)
      .toBe(400);
    relay.activate(command('root', 'turn-one'), 'generation');
    expect((await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' })).status)
      .toBe(200);
  });

  it('records a bounded Squire process reason without copying stderr into the Room', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...parts) => { logs.push(parts.join(' ')); });
    const { relay, diagnose, die } = fixture();
    await request(relay, 'startup', 'startup', 'tools/list');
    diagnose('squire mcp stderr: broker unavailable; private detail');
    die();
    expect(logs.join('\n')).toContain('"reason":"broker-unavailable"');
    expect(logs.join('\n')).toContain('"exitCode":1');
    expect(logs.join('\n')).not.toContain('private detail');
  });

  it('keeps one MCP connection through calls, a turn boundary, and a new task in the same conversation', async () => {
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
    expect(launch.env).not.toHaveProperty('TRUSTY_SQUIRE_PROFILE_DIR');
    const pi = piMcpBridgeSource([codex]);
    expect(pi).toContain('BEELINE_SQUIRE_RELAY_URL');
    relay.activate(command('root', 'turn-one'), 'generation');
    expect((await request(relay, 'root', 'turn-one', 'tools/list')).status).toBe(200);
    expect((await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' })).status).toBe(200);
    vi.useFakeTimers();
    relay.deactivate('turn-one');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS - 1);
    relay.activate(command('next-root', 'turn-two'), 'generation');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS);
    expect(stats().exits).toBe(0);
    vi.useRealTimers();
    expect((await request(relay, 'next-root', 'turn-two', 'initialize')).status).toBe(200);
    expect((await request(relay, 'next-root', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
    expect((await request(relay, 'next-root', 'turn-two', 'tools/call', {
      name: 'operate_scroll', arguments: { sessionId: 'browser-1', direction: 'down' },
    })).status).toBe(200);
    expect((await request(relay, 'next-root', 'turn-two', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
    expect(stats().spawns).toBe(1);
    expect((await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_observe' })).status).toBe(400);
    const calls = logs.filter((line) => line.includes('"event":"call-start"'))
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as {
        agentId: string; taskId: string; conversationId: string;
        mcpConnectionId: string; requestId: string; pid: number | null; ppid: number;
      });
    expect(new Set(calls.map((call) => call.mcpConnectionId)).size).toBe(1);
    expect(new Set(calls.map((call) => call.requestId))).toEqual(new Set(['turn-one', 'turn-two']));
    expect(new Set(calls.map((call) => call.taskId))).toEqual(new Set(['root', 'next-root']));
    expect(calls.every((call) => call.agentId === 'agent' && call.conversationId === 'room' &&
      typeof call.ppid === 'number')).toBe(true);
    expect(logs.join('\n')).not.toContain('browser-1');
  });

  it('keeps a connection through a long approval wait, then closes after decision and idle timeout', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...parts) => { logs.push(parts.join(' ')); });
    const { relay, stats } = fixture();
    relay.activate(command('finished', 'turn-one'), 'generation');
    await request(relay, 'finished', 'turn-one', 'tools/call', { name: 'operate_start' });
    vi.useFakeTimers();
    relay.deactivate('turn-one', 'turn-one');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS * 2);
    expect(stats().exits).toBe(0);
    relay.activate(command('approval-resume', 'turn-two'), 'generation');
    vi.useRealTimers();
    const resumed = await request(relay, 'approval-resume', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    });
    expect(resumed.status).toBe(200);
    vi.useFakeTimers();
    relay.deactivate('turn-two');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS);
    expect(stats().exits).toBe(1);
    expect(logs.join('\n')).toContain('"reason":"conversation-idle"');
    relay.activate(command('later', 'turn-three'), 'generation');
    vi.useRealTimers();
    const stale = await request(relay, 'later', 'turn-three', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    });
    expect(stale.status).toBe(400);
    expect(stale.body.error).toMatch(/no longer owned/);
  });

  it('keeps an inject_card approval session through a long idle human wait', async () => {
    let cardCalls = 0;
    const { relay, stats } = fixture('/tmp/context', async () => true, async (_method, params) => {
      if (params.name === 'operate_start')
        return { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] };
      if (params.name === 'inject_card') {
        cardCalls += 1;
        return { content: [{ type: 'text', text: JSON.stringify({
          status: cardCalls === 1 ? 'approval_pending' : 'card_injected',
          approval_id: 'buy-1', session_id: 'browser-1',
          approval_url: 'https://trustysquire.ai/vault/pay/buy-1',
        }) }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    expect((await request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
    vi.useFakeTimers();
    relay.deactivate('turn-one');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS * 2);
    expect(stats().exits).toBe(0);
    relay.activate(command('next', 'turn-two'), 'generation');
    vi.useRealTimers();
    expect((await request(relay, 'next', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
    expect((await request(relay, 'next', 'turn-two', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-1', approval_id: 'buy-1' },
    })).status).toBe(200);
    vi.useFakeTimers();
    relay.deactivate('turn-two');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS);
    expect(stats().exits).toBe(1);
  });

  it('resolves a pending approval from an unsolicited Squire notification, with what was approved', async () => {
    const decisions: unknown[] = [];
    const { relay, stats, notify } = fixture('/tmp/context', async () => true, async (_method, params) => {
      if (params.name === 'operate_start')
        return { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] };
      if (params.name === 'inject_card')
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'approval_pending', approval_id: 'buy-1', session_id: 'browser-1',
          approval_url: 'https://trustysquire.ai/vault/pay/buy-1',
        }) }] };
      return { content: [{ type: 'text', text: 'ok' }] };
    }, (decision) => decisions.push(decision));
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    await request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-1', item: 'MUJI order', merchant: 'MUJI' },
    });
    vi.useFakeTimers();
    relay.deactivate('turn-one', 'turn-one');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS * 2);
    expect(stats().exits).toBe(0); // the open approval keeps the connection alive
    notify({ jsonrpc: '2.0', method: 'notifications/approval_decided',
      params: { approval_id: 'buy-1', status: 'approved' } });
    expect(decisions).toEqual([{
      requestId: 'turn-one', approvalId: 'buy-1', status: 'approved',
      tool: 'inject_card', title: 'Purchase approval', detail: 'MUJI order · at MUJI',
    }]);
    // The resumed turn picks up the decision and ends normally, like any turn;
    // only THAT deactivate (with no approval flag) frees the connection to idle.
    vi.useRealTimers();
    relay.activate(command('resume', 'turn-two'), 'generation');
    expect((await request(relay, 'resume', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
    vi.useFakeTimers();
    relay.deactivate('turn-two');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS);
    expect(stats().exits).toBe(1);
    vi.useRealTimers();
  });

  it('wakes with the denial when Squire reports a decline, carrying the same correlation', async () => {
    const decisions: unknown[] = [];
    const { relay, notify } = fixture('/tmp/context', async () => true, async (_method, params) => {
      if (params.name === 'operate_start')
        return { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] };
      if (params.name === 'inject_card')
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'approval_pending', approval_id: 'buy-2', session_id: 'browser-1',
          approval_url: 'https://trustysquire.ai/vault/pay/buy-2', item: 'order',
        }) }] };
      return { content: [{ type: 'text', text: 'ok' }] };
    }, (decision) => decisions.push(decision));
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    await request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-1' },
    });
    relay.deactivate('turn-one', 'turn-one');
    notify({ jsonrpc: '2.0', method: 'notifications/approval_decided',
      params: { approval_id: 'buy-2', status: 'denied' } });
    expect(decisions).toEqual([expect.objectContaining({
      requestId: 'turn-one', approvalId: 'buy-2', status: 'denied',
    })]);
  });

  it.each([
    ['fetch_credential', 'Credential access approval', 'Reveal groq'],
    ['edit_credential', 'Credential edit approval', 'Edit groq'],
    ['delete_credential', 'Credential deletion approval', 'Delete groq'],
    ['edit_payment_card', 'Card edit approval', 'Edit groq'],
  ])('wakes the asking turn when a session-less %s vault approval is decided', async (tool, title, detail) => {
    const decisions: unknown[] = [];
    const { relay, stats, notify } = fixture('/tmp/context', async () => true, async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        status: 'approval_pending', approval_id: 'vault-1',
        approval_url: 'https://trustysquire.ai/vault/fetch/vault-1',
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      }) }],
    }), (decision) => decisions.push(decision));
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: tool, arguments: { service: 'groq' } });
    vi.useFakeTimers();
    relay.deactivate('turn-one');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS * 2);
    expect(stats().exits).toBe(0); // the open vault approval keeps Squire's watcher connected
    notify({ jsonrpc: '2.0', method: 'notifications/approval_decided',
      params: { approval_id: 'vault-1', status: 'approved' } });
    expect(decisions).toEqual([{ requestId: 'turn-one', approvalId: 'vault-1', status: 'approved', tool, title, detail }]);
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS);
    expect(stats().exits).toBe(1);
  });

  it('wakes the asking turn when a vault approval expires undecided, then frees the connection', async () => {
    const decisions: unknown[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { relay, stats, notify } = fixture('/tmp/context', async () => true, async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        status: 'approval_pending', approval_id: 'vault-2',
        approval_url: 'https://trustysquire.ai/vault/fetch/vault-2',
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }) }],
    }), (decision) => decisions.push(decision));
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'fetch_credential', arguments: { service: 'groq' },
    });
    relay.deactivate('turn-one');
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(decisions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(decisions).toEqual([expect.objectContaining({
      requestId: 'turn-one', approvalId: 'vault-2', status: 'expired', tool: 'fetch_credential',
    })]);
    notify({ jsonrpc: '2.0', method: 'notifications/approval_decided',
      params: { approval_id: 'vault-2', status: 'approved' } });
    expect(decisions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS);
    expect(stats().exits).toBe(1);
  });

  it('ignores a notification for an approval it never tracked, or a malformed one', async () => {
    const decisions: unknown[] = [];
    const { relay, notify } = fixture('/tmp/context', async () => true, async (_method, params) =>
      params.name === 'operate_start'
        ? { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] }
        : { content: [{ type: 'text', text: JSON.stringify({
          status: 'approval_pending', approval_id: 'buy-1', session_id: 'browser-1',
          approval_url: 'https://trustysquire.ai/vault/pay/buy-1', item: 'order',
        }) }] },
      (decision) => decisions.push(decision),
    );
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    await request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-1' },
    });
    notify({ jsonrpc: '2.0', method: 'notifications/approval_decided',
      params: { approval_id: 'unknown-approval', status: 'approved' } });
    notify({ jsonrpc: '2.0', method: 'notifications/approval_decided', params: { approval_id: 'buy-1' } });
    notify({ jsonrpc: '2.0', method: 'notifications/something_else',
      params: { approval_id: 'buy-1', status: 'approved' } });
    expect(decisions).toEqual([]);
  });

  it('releases a pending Squire approval hold when its request is cancelled', async () => {
    const { relay, stats } = fixture('/tmp/context', async () => true, async (_method, params) =>
      params.name === 'operate_start'
        ? { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] }
        : { content: [{ type: 'text', text: JSON.stringify({
          status: 'approval_pending', session_id: 'browser-1', approval_id: 'buy-1',
          approval_url: 'https://trustysquire.ai/vault/pay/buy-1',
        }) }] },
    );
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    await request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-1' },
    });
    vi.useFakeTimers();
    relay.deactivate('turn-one');
    relay.cancel('turn-one');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS);
    expect(stats().exits).toBe(1);
  });

  it('keeps an open approval through an unrelated turn and bounds it after cancellation', async () => {
    const { relay, stats } = fixture();
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    vi.useFakeTimers();
    relay.deactivate('turn-one', 'turn-one');
    relay.activate(command('other', 'turn-other'), 'generation');
    relay.deactivate('turn-other', 'turn-one');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS * 2);
    expect(stats().exits).toBe(0);
    relay.cancel('turn-one');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS);
    expect(stats().exits).toBe(1);
  });

  it('bounds an idle conversation when no continuation arrives', async () => {
    const { relay, stats } = fixture();
    relay.activate(command('paused', 'turn-one'), 'generation');
    await request(relay, 'paused', 'turn-one', 'tools/call', { name: 'operate_start' });
    vi.useFakeTimers();
    relay.deactivate('turn-one');
    await vi.advanceTimersByTimeAsync(SQUIRE_TASK_IDLE_LEASE_MS - 1);
    expect(stats().exits).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stats().exits).toBe(1);
  });

  it('cancellation rejects the old turn but preserves its session for the next turn', async () => {
    const { relay, stats } = fixture();
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    relay.cancel('turn-one');
    expect(stats().exits).toBe(0);
    relay.activate(command('second', 'turn-two'), 'generation');
    const stale = await request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    });
    expect(stale.status).toBe(400);
    expect((await request(relay, 'second', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
    expect(stats().spawns).toBe(1);
    relay.close();
    expect(stats().exits).toBe(1);
    const replacement = fixture().relay;
    replacement.activate(command('first', 'turn-three'), 'generation');
    expect((await request(replacement, 'first', 'turn-three', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);
  });

  it('retains a session when a different task becomes active and rejects the old task context', async () => {
    const { relay, stats } = fixture();
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    relay.deactivate('turn-one');
    relay.activate(command('second', 'turn-two'), 'generation');
    expect(stats().exits).toBe(0);
    expect((await request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);
    expect((await request(relay, 'second', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
  });

  it('does not give an in-flight old turn response to the next turn', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (value: unknown) => void;
    const { relay, stats } = fixture('/tmp/context', async () => true, async (_method, params) => {
      if (params.name === 'operate_start')
        return { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] };
      if (params.name === 'operate_observe') {
        entered();
        return new Promise<unknown>((resolve) => { release = resolve; });
      }
      return { content: [{ type: 'text', text: 'page observed' }] };
    });
    relay.activate(command('first', 'turn-one'), 'generation');
    await request(relay, 'first', 'turn-one', 'tools/call', { name: 'operate_start' });
    const oldCall = request(relay, 'first', 'turn-one', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    });
    await started;
    relay.deactivate('turn-one');
    relay.activate(command('second', 'turn-two'), 'generation');
    release({ content: [{ type: 'text', text: 'old page' }] });
    expect((await oldCall).status).toBe(400);
    expect((await request(relay, 'second', 'turn-two', 'tools/call', {
      name: 'operate_scroll', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
    expect(stats()).toEqual({ spawns: 1, exits: 0 });
  });

  it('requires an explicit operate_start after the Squire child dies', async () => {
    const { relay, stats, die } = fixture();
    relay.activate(command('root', 'turn-one'), 'generation');
    await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' });
    die();
    const gone = await request(relay, 'root', 'turn-one', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    });
    expect(gone.status).toBe(400);
    expect(gone.body.error).toMatch(/connection died.*session is gone/);
    expect((await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' })).status).toBe(200);
    expect(stats().spawns).toBe(2);
  });

  it('reports a stale lease as a gone session and requires a fresh start', async () => {
    const { relay, stats } = fixture('/tmp/context', async () => true, async (_method, params) =>
      params.name === 'operate_start'
        ? { content: [{ type: 'text', text: '{"sessionId":"browser-1"}' }] }
        : { isError: true, content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'stale_lease', message: 'Session is not owned by this MCP connection' },
        }) }] },
    );
    relay.activate(command('root', 'turn-one'), 'generation');
    await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' });
    const stale = await request(relay, 'root', 'turn-one', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    });
    expect(stale.status).toBe(200);
    expect(stale.body.result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('browser session is gone; call operate_start') }],
    });
    const refused = await request(relay, 'root', 'turn-one', 'tools/call', {
      name: 'operate_scroll', arguments: { sessionId: 'browser-1' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/no longer owned/);
    expect((await request(relay, 'root', 'turn-one', 'tools/call', {
      name: 'operate_start',
    })).status).toBe(200);
    expect(stats().spawns).toBe(1);
  });

  it('forgets a session after explicit operate_finish without closing the MCP connection', async () => {
    const { relay, stats } = fixture();
    relay.activate(command('root', 'turn-one'), 'generation');
    await request(relay, 'root', 'turn-one', 'tools/call', { name: 'operate_start' });
    expect((await request(relay, 'root', 'turn-one', 'tools/call', {
      name: 'operate_finish', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
    expect((await request(relay, 'root', 'turn-one', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);
    expect(stats()).toEqual({ spawns: 1, exits: 0 });
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

  it('routes separate real stdio facade processes through one conversation connection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'squire-task-proxy-'));
    const contextFile = join(dir, 'turn.json');
    const { relay, stats, die } = fixture(contextFile);
    try {
      const endpoint = await relay.listen();
      const invoke = async (
        turn: string | undefined, taskId: string, name: string, args: Record<string, unknown> = {},
      ) => {
        if (turn) await writeFile(contextFile, JSON.stringify({
          roomId: 'room', requestId: turn, taskId, generationId: 'generation',
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
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1,
            method: name === 'tools/list' ? name : 'tools/call',
            params: name === 'tools/list' ? {} : { name, arguments: args } })}\n`);
          return await reply;
        } finally {
          child.kill();
        }
      };
      expect(await invoke(undefined, 'inventory', 'tools/list')).toHaveProperty('result');
      relay.activate(command('root', 'turn-one'), 'generation');
      expect(await invoke('turn-one', 'root', 'operate_start')).toHaveProperty('result');
      die();
      const refused = await invoke('turn-one', 'root', 'operate_observe', {
        sessionId: 'browser-1',
      });
      expect(JSON.stringify(refused)).toMatch(/connection died.*operate_start/);
      expect(await invoke('turn-one', 'root', 'operate_start')).toHaveProperty('result');
      relay.deactivate('turn-one');
      relay.activate(command('next-root', 'turn-two'), 'generation');
      expect(await invoke('turn-two', 'next-root', 'operate_observe', {
        sessionId: 'browser-1',
      })).toHaveProperty('result');
      expect(await invoke('turn-two', 'next-root', 'inject_card', {
        sessionId: 'browser-1',
      })).toHaveProperty('result');
      expect(stats().spawns).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('scheduled runs inherit a live Squire session', () => {
  function scheduled(
    roomId: string,
    agentId: string,
    taskId: string,
    requestId: string,
    scheduleId?: string,
  ): AgentCommand {
    return {
      id: requestId, roomId, agentId, sourceMessageId: requestId,
      turnRequestId: requestId, action: 'input',
      reason: scheduleId ? 'schedule' : 'message',
      ...(scheduleId ? { scheduleId } : {}),
      rootCommandId: taskId, rootSourceMessageId: requestId, agentDepth: 0,
      source: {} as AgentCommand['source'],
    };
  }

  function relayFor(roomId: string, agentId: string, ...sessions: string[]) {
    let started = 0;
    const relay = new SquireTaskRelay(agentId, roomId, '/tmp/context', async () => true, homedir(),
      () => ({
        pid: 4000,
        requestMcp: vi.fn(async (method: string, params: { name?: string }) =>
          method === 'tools/list'
            ? { tools: [{ name: 'operate_start' }, { name: 'operate_observe' }] }
            : params.name === 'operate_start'
              ? { content: [{ type: 'text', text: JSON.stringify({
                sessionId: sessions[Math.min(started++, sessions.length - 1)] }) }] }
              : { content: [{ type: 'text', text: 'page observed' }] }),
        close: () => {},
      } as unknown as StdioSquireMcpClient));
    relays.push(relay);
    return relay;
  }

  async function call(
    relay: SquireTaskRelay,
    roomId: string,
    taskId: string,
    requestId: string,
    method: string,
    params: Record<string, unknown> = {},
  ) {
    const endpoint = await relay.listen();
    const response = await fetch(`${endpoint.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, taskId, requestId, generationId: 'generation', method, params }),
    });
    return { status: response.status, body: await response.json() as { result?: unknown; error?: string } };
  }

  it('Reproduction squire-sched-1: lets a later run of the same schedule use a session from its earlier run', async () => {
    const owner = relayFor('room-a', 'agent', 'browser-a1');
    owner.activate(scheduled('room-a', 'agent', 'root-a', 'turn-a', 'sched-1'), 'generation');
    expect((await call(owner, 'room-a', 'root-a', 'turn-a', 'tools/call', {
      name: 'operate_start',
    })).status).toBe(200);

    // A different conversation's relay, same agent and schedule.
    const borrower = relayFor('room-b', 'agent', 'browser-b1');
    borrower.activate(scheduled('room-b', 'agent', 'root-b', 'turn-b', 'sched-1'), 'generation');
    const inherited = await call(borrower, 'room-b', 'root-b', 'turn-b', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-a1' },
    });
    expect(inherited.status).toBe(200);
  });

  it('lets a scheduled turn inherit a session from its creating conversation', async () => {
    const owner = relayFor('room', 'agent', 'browser-1');
    owner.activate(scheduled('room', 'agent', 'root', 'turn-one'), 'generation');
    await call(owner, 'room', 'root', 'turn-one', 'tools/call', { name: 'operate_start' });

    const borrower = relayFor('room', 'agent', 'browser-2');
    borrower.activate(scheduled('room', 'agent', 'root-2', 'turn-two', 'sched-1'), 'generation');
    const inherited = await call(borrower, 'room', 'root-2', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    });
    expect(inherited.status).toBe(200);
  });

  it('still refuses an ordinary turn, another schedule, another conversation, and another agent', async () => {
    const owner = relayFor('room', 'agent', 'browser-1');
    owner.activate(scheduled('room', 'agent', 'root', 'turn-one', 'sched-1'), 'generation');
    await call(owner, 'room', 'root', 'turn-one', 'tools/call', { name: 'operate_start' });

    // An ordinary (non-scheduled) turn in a second relay for the same Room.
    const ordinary = relayFor('room', 'agent', 'browser-2');
    ordinary.activate(scheduled('room', 'agent', 'o', 't-ordinary'), 'generation');
    expect((await call(ordinary, 'room', 'o', 't-ordinary', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);

    // A different schedule with no lineage to the session.
    const otherSchedule = relayFor('room', 'agent', 'browser-3');
    otherSchedule.activate(scheduled('room', 'agent', 'o2', 't-other', 'sched-2'), 'generation');
    expect((await call(otherSchedule, 'room', 'o2', 't-other', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);

    // A different conversation's scheduled relay with no matching schedule.
    const otherRoom = relayFor('room-elsewhere', 'agent', 'browser-4');
    otherRoom.activate(scheduled('room-elsewhere', 'agent', 'o3', 't-room', 'sched-3'), 'generation');
    expect((await call(otherRoom, 'room-elsewhere', 'o3', 't-room', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);

    // A different agent, even with the schedule id.
    const otherAgent = relayFor('room', 'agent-2', 'browser-5');
    otherAgent.activate(scheduled('room', 'agent-2', 'o4', 't-agent', 'sched-1'), 'generation');
    expect((await call(otherAgent, 'room', 'o4', 't-agent', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);
  });

  it('refuses a second schedule on the owning relay a session another schedule claimed', async () => {
    const owner = relayFor('room', 'agent', 'browser-1');
    owner.activate(scheduled('room', 'agent', 'root', 'turn-one', 'sched-1'), 'generation');
    await call(owner, 'room', 'root', 'turn-one', 'tools/call', { name: 'operate_start' });

    owner.activate(scheduled('room', 'agent', 'root-2', 'turn-two', 'sched-2'), 'generation');
    expect((await call(owner, 'room', 'root-2', 'turn-two', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);

    owner.activate(scheduled('room', 'agent', 'root-3', 'turn-three', 'sched-1'), 'generation');
    expect((await call(owner, 'room', 'root-3', 'turn-three', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(200);
  });

  it('checks schedule provenance for every borrowed session that shares a client', async () => {
    const owner = relayFor('room-a', 'agent', 'browser-a1', 'browser-a2');
    owner.activate(scheduled('room-a', 'agent', 'root-a', 'turn-a', 'sched-1'), 'generation');
    await call(owner, 'room-a', 'root-a', 'turn-a', 'tools/call', { name: 'operate_start' });
    // The same owning connection also opens a session for another schedule.
    owner.activate(scheduled('room-a', 'agent', 'root-a2', 'turn-a2', 'sched-2'), 'generation');
    await call(owner, 'room-a', 'root-a2', 'turn-a2', 'tools/call', { name: 'operate_start' });

    const borrower = relayFor('room-b', 'agent', 'browser-b1');
    borrower.activate(scheduled('room-b', 'agent', 'root-b', 'turn-b', 'sched-1'), 'generation');
    expect((await call(borrower, 'room-b', 'root-b', 'turn-b', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-a1', target: { sessionId: 'browser-a2' } },
    })).status).toBe(400);
  });

  it('keeps schedule provenance when an ordinary call echoes the session id', async () => {
    const owner = relayFor('room', 'agent', 'browser-1');
    owner.activate(scheduled('room', 'agent', 'root', 'turn-one', 'sched-1'), 'generation');
    await call(owner, 'room', 'root', 'turn-one', 'tools/call', { name: 'operate_start' });

    // An ordinary turn whose response echoes the existing session id.
    owner.activate(scheduled('room', 'agent', 'root-2', 'turn-two'), 'generation');
    expect((await call(owner, 'room', 'root-2', 'turn-two', 'tools/call', {
      name: 'operate_start',
    })).status).toBe(200);

    owner.activate(scheduled('room', 'agent', 'root-3', 'turn-three', 'sched-2'), 'generation');
    expect((await call(owner, 'room', 'root-3', 'turn-three', 'tools/call', {
      name: 'operate_observe', arguments: { sessionId: 'browser-1' },
    })).status).toBe(400);
  });
});
