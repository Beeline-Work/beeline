import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { DaemonApiClient } from './daemon-api-client.js';
import { ConnectorAssignmentLoop } from './connector-assignments.js';
import { identityFromKey, stageMonolithAgentRuntime } from './runtime.js';
import { ThinDaemonCore } from './thin-core.js';
import type { BodyConfig } from './config.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// NEVER DELETE, SKIP, OR WEAKEN THIS TEST. Timer-based polling saturated the production
// database on 2026-09-27; recurring helper server reads are banned.
describe('no timer-driven helper server reads', () => {
  it('makes zero daemon API calls across hours of connected idle time', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-no-polling-'));
    roots.push(root);
    const staged = await stageMonolithAgentRuntime({
      workspaceId: 'workspace', pairedBy: 'human', daemonExchangeToken: `bde_${'a'.repeat(43)}`,
      agentBinary: '/nonexistent', agentKind: 'codex', agentCommand: '/nonexistent',
      agentArgs: [], mcpBinary: 'unused',
      agentIdentity: identityFromKey('33'.repeat(32), 'Bee'),
      bodyIdentity: identityFromKey('44'.repeat(32), 'Body'), supervisorRoot: root,
    });
    const operations: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const name = url.split('/').at(-1)!;
      operations.push(name);
      if (name === 'getDaemonBootstrap')
        return Response.json({ workspaceIds: ['workspace'], rooms: [] });
      if (name === 'getConnectorAssignments') return Response.json({ assignments: [] });
      if (name === 'postConnectorVault') return Response.json({});
      throw new Error(`unexpected daemon operation ${name}`);
    });
    const agentId = staged.runtime.agent.publicKey;
    type FakeSocket = { readyState: number; onopen?: () => void; onclose?: () => void;
      onmessage?: (event: { data: string }) => void; listeners: Map<string, () => void>;
      on: (event: string, listener: () => void) => void;
      send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
    const opened: FakeSocket[] = [];
    let socket!: FakeSocket;
    const client = new DaemonApiClient('http://localhost:3000', 'token', agentId,
      fetchImpl as typeof fetch, () => {
        const created: FakeSocket = {
          readyState: 0, listeners: new Map(), close: vi.fn(), terminate: vi.fn(),
          on: (event, listener) => created.listeners.set(event, listener),
          // The server takes the agent's registration on the machine socket.
          send: vi.fn((raw: string) => {
            if (JSON.parse(raw).type === 'register')
              created.onmessage?.({ data: JSON.stringify({ type: 'registered', agentId }) });
          }),
        };
        socket = created;
        opened.push(created);
        return created as unknown as WebSocket;
      });
    const config: BodyConfig = { agentBinary: '/nonexistent', agentKind: 'codex',
      agentCommand: '/nonexistent', agentArgs: [], mcpBinary: 'unused', readonlyMcpCommand: '/nonexistent',
      agentEnv: {}, workspaceRoot: root, autoApprovePermissions: false };
    const core = new ThinDaemonCore(staged.runtime, staged.configPath, config, { daemonApi: client });
    const connector = new ConnectorAssignmentLoop({ api: client, agentId: staged.runtime.agent.publicKey, brokerInstalled: () => false });
    const abort = new AbortController();
    const running = core.run({ signal: abort.signal, onEstablished: () => {
      client.setConnectorAssignmentListener(() => connector.wake());
      connector.start();
    } });
    socket.readyState = 1;
    socket.onopen?.();
    await vi.waitFor(() => expect(operations).toContain('getConnectorAssignments'));
    expect(operations).toContain('getDaemonBootstrap');
    const baseline = [...operations];
    // Four idle hours on a healthy socket: the server's heartbeat pings it
    // every 30 seconds. A ping is answered by the socket itself and causes no
    // read, no reconnect and no reconciliation.
    for (let elapsed = 0; elapsed < 4 * 60 * 60_000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
      socket.listeners.get('ping')?.();
    }
    expect(operations).toEqual(baseline);
    expect(opened).toHaveLength(1);
    expect(socket.terminate).not.toHaveBeenCalled();
    // No background memory review exists: an old server's memory-job frame
    // claims nothing and opens no hidden session.
    socket.onmessage?.({ data: JSON.stringify({ type: 'memory-job', roomId: 'room-1', agentId }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(operations).toEqual(baseline);
    socket.onmessage?.({ data: JSON.stringify({ type: 'connector-assignment', agentId }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(operations.filter((name) => name === 'getConnectorAssignments').length)
      .toBeGreaterThan(baseline.filter((name) => name === 'getConnectorAssignments').length);
    abort.abort(); connector.stop();
    await running;
  });

});
