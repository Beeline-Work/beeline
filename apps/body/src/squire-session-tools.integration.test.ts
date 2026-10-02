/**
 * End-to-end proof for the host-shared Squire session registry: two real
 * `SquireTaskRelay` HTTP servers (one per agent) on one registry directory, and
 * the real `list_squire_sessions` / `close_squire_session` tool functions
 * talking to them. Only Squire itself is faked; the relay transport, the
 * registry files, and the close request all really run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { SquireSessionRegistry } from './squire-session-registry.js';
import { SquireTaskRelay, type SquireTaskRelayOptions } from './squire-task-relay.js';
import { closeSquireSession, listSquireSessions, type SquireSessionDeps } from './read-only-mcp.js';
import type { StdioSquireMcpClient } from './squire-mcp-client.js';

const relays: SquireTaskRelay[] = [];
const dirs: string[] = [];
/** Arguments of every operate_finish call, so a reap is proven to use Squire's own key. */
const finishCalls: Array<Record<string, unknown>> = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  finishCalls.length = 0;
  vi.restoreAllMocks();
});

function command(agentId: string, roomId: string, taskId: string, requestId: string): AgentCommand {
  return {
    id: requestId, roomId, agentId, sourceMessageId: requestId,
    turnRequestId: requestId, action: 'input', reason: 'message', rootCommandId: taskId,
    rootSourceMessageId: requestId, agentDepth: 0, source: {} as AgentCommand['source'],
  };
}

async function registryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'squire-session-registry-'));
  dirs.push(dir);
  return dir;
}

type Respond = (method: string, params: { name?: string; arguments?: Record<string, unknown> }) => Promise<unknown>;

async function relayFor(
  dir: string,
  agentId: string,
  roomId: string,
  respond: Respond,
  options: SquireTaskRelayOptions = {},
): Promise<SquireTaskRelay> {
  const relay = new SquireTaskRelay(
    agentId,
    roomId,
    '/tmp/context',
    async () => true,
    '/tmp/squire-home',
    (hooks) => {
      hooks.onSpawn(4242);
      return {
        pid: 4242,
        requestMcp: vi.fn(respond),
        close: () => {},
      } as unknown as StdioSquireMcpClient;
    },
    { registry: new SquireSessionRegistry(dir), ownerId: 'owner-1', ...options },
  );
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
): Promise<{ status: number; body: { result?: unknown; error?: string } }> {
  const endpoint = await relay.listen();
  const response = await fetch(`${endpoint.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, taskId, requestId, generationId: 'generation', method, params }),
  });
  return { status: response.status, body: await response.json() as { result?: unknown; error?: string } };
}

function startResponder(sessionId: string, extra?: Respond): Respond {
  return async (method, params) => {
    if (params.name === 'operate_start')
      return { content: [{ type: 'text', text: JSON.stringify({ sessionId }) }] };
    if (params.name === 'operate_finish') finishCalls.push(params.arguments ?? {});
    if (extra) return await extra(method, params);
    return { content: [{ type: 'text', text: 'ok' }] };
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the registry to converge');
}

const deps = (dir: string, agentId = 'agent-b'): SquireSessionDeps => ({
  dir, ownerId: 'owner-1', agentId,
});

describe('shared Squire session registry', () => {
  it('lists a stale session with its owner, start time and liveness, and lets another agent of the same owner close it', async () => {
    const dir = await registryDir();
    const a = await relayFor(dir, 'agent-a', 'room-a', startResponder('browser-A'));
    await relayFor(dir, 'agent-b', 'room-b', startResponder('browser-B'));

    a.activate(command('agent-a', 'room-a', 'task-a', 'turn-a'), 'generation');
    await call(a, 'room-a', 'task-a', 'turn-a', 'tools/call', { name: 'operate_start' });
    a.deactivate('turn-a');

    const listed = JSON.parse(await listSquireSessions(deps(dir))) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      sessionId: 'browser-A',
      ownerAgentId: 'agent-a',
      conversationId: 'room-a',
      turnLive: false,
      stale: true,
      canClose: true,
    });
    expect(Number.isNaN(Date.parse(String(listed.sessions[0]!.startedAt)))).toBe(false);

    const closed = JSON.parse(
      await closeSquireSession({ sessionId: 'browser-A' }, deps(dir)),
    ) as { closed: boolean };
    expect(closed.closed).toBe(true);
    expect(finishCalls).toEqual([{ session_id: 'browser-A' }]);
    expect(
      (JSON.parse(await listSquireSessions(deps(dir))) as { sessions: unknown[] }).sessions,
    ).toHaveLength(0);
  });

  it('refuses to close a session whose turn is still live', async () => {
    const dir = await registryDir();
    const a = await relayFor(dir, 'agent-a', 'room-a', startResponder('browser-A'));
    a.activate(command('agent-a', 'room-a', 'task-a', 'turn-a'), 'generation');
    await call(a, 'room-a', 'task-a', 'turn-a', 'tools/call', { name: 'operate_start' });

    const listed = JSON.parse(await listSquireSessions(deps(dir))) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(listed.sessions[0]).toMatchObject({ turnLive: true, stale: false, canClose: false });

    await expect(closeSquireSession({ sessionId: 'browser-A' }, deps(dir)))
      .rejects.toThrow(/live turn/);
    expect(
      (JSON.parse(await listSquireSessions(deps(dir))) as { sessions: unknown[] }).sessions,
    ).toHaveLength(1);
  });

  it('keeps a session listed when the broker refuses to close it', async () => {
    const dir = await registryDir();
    const a = await relayFor(dir, 'agent-a', 'room-a', startResponder('browser-A', async (_method, params) => {
      if (params.name === 'operate_finish')
        return { isError: true, content: [{ type: 'text', text: 'session is busy' }] };
      return { content: [{ type: 'text', text: 'ok' }] };
    }));
    a.activate(command('agent-a', 'room-a', 'task-a', 'turn-a'), 'generation');
    await call(a, 'room-a', 'task-a', 'turn-a', 'tools/call', { name: 'operate_start' });
    a.deactivate('turn-a');

    await expect(closeSquireSession({ sessionId: 'browser-A' }, deps(dir)))
      .rejects.toThrow(/refused to close/);
    expect(new SquireSessionRegistry(dir).listSessions()).toHaveLength(1);
  });

  it('refuses a session belonging to another owner', async () => {
    const dir = await registryDir();
    const a = await relayFor(dir, 'agent-a', 'room-a', startResponder('browser-A'));
    a.activate(command('agent-a', 'room-a', 'task-a', 'turn-a'), 'generation');
    await call(a, 'room-a', 'task-a', 'turn-a', 'tools/call', { name: 'operate_start' });
    a.deactivate('turn-a');

    await expect(
      closeSquireSession({ sessionId: 'browser-A' }, { dir, ownerId: 'owner-2', agentId: 'agent-b' }),
    ).rejects.toThrow(/another owner/);
  });

  it('reaps a session whose turn ended after the stale timeout', async () => {
    const dir = await registryDir();
    const a = await relayFor(dir, 'agent-a', 'room-a', startResponder('browser-A'), {
      sessionStaleMs: 25,
    });
    a.activate(command('agent-a', 'room-a', 'task-a', 'turn-a'), 'generation');
    await call(a, 'room-a', 'task-a', 'turn-a', 'tools/call', { name: 'operate_start' });
    a.deactivate('turn-a');

    expect(new SquireSessionRegistry(dir).listSessions()).toHaveLength(1);
    await waitFor(() => new SquireSessionRegistry(dir).listSessions().length === 0);
    expect(finishCalls).toEqual([{ session_id: 'browser-A' }]);
  });

  it('lets only one agent stage the same order, then releases the lock when the card is released', async () => {
    const dir = await registryDir();
    let releases = 0;
    const cardResponder = (sessionId: string, approvalId: string): Respond => async (_method, params) => {
      if (params.name === 'operate_start')
        return { content: [{ type: 'text', text: JSON.stringify({ sessionId }) }] };
      if (params.name === 'inject_card') {
        const injected = params.arguments?.approval_id !== undefined;
        if (!injected) releases += 1;
        return { content: [{ type: 'text', text: JSON.stringify({
          status: injected ? 'card_injected' : 'approval_pending',
          session_id: sessionId,
          approval_id: approvalId,
          approval_url: `https://trustysquire.ai/vault/pay/${approvalId}`,
        }) }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    const a = await relayFor(dir, 'agent-a', 'room-a', cardResponder('browser-A', 'buy-1'));
    const b = await relayFor(dir, 'agent-b', 'room-b', cardResponder('browser-B', 'buy-2'));

    const order = { merchant: 'Acme', amount_cents: 1299, currency: 'USD', item: 'Widget' };
    a.activate(command('agent-a', 'room-a', 'task-a', 'turn-a'), 'generation');
    await call(a, 'room-a', 'task-a', 'turn-a', 'tools/call', { name: 'operate_start' });
    const first = await call(a, 'room-a', 'task-a', 'turn-a', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-A', ...order },
    });
    expect(first.status).toBe(200);

    const locks = new SquireSessionRegistry(dir).listOrderLocks();
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ holderAgentId: 'agent-a', approvalPending: true });
    expect(releases).toBe(1);

    b.activate(command('agent-b', 'room-b', 'task-b', 'turn-b'), 'generation');
    await call(b, 'room-b', 'task-b', 'turn-b', 'tools/call', { name: 'operate_start' });
    const second = await call(b, 'room-b', 'task-b', 'turn-b', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-B', ...order },
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already staging this order/);
    // Only the first agent's card-release link was ever created.
    expect(releases).toBe(1);

    // The human card release consumes the approval; the lock is then free.
    const resolved = await call(a, 'room-a', 'task-a', 'turn-a', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-A', approval_id: 'buy-1' },
    });
    expect(resolved.status).toBe(200);
    expect(new SquireSessionRegistry(dir).listOrderLocks()).toHaveLength(0);

    const third = await call(b, 'room-b', 'task-b', 'turn-b', 'tools/call', {
      name: 'inject_card', arguments: { sessionId: 'browser-B', ...order },
    });
    expect(third.status).toBe(200);
    expect(releases).toBe(2);
  });
});
