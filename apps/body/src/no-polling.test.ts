import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
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
    const connector = new ConnectorAssignmentLoop({ api: client, agentId: staged.runtime.agent.publicKey });
    const abort = new AbortController();
    const running = core.run({ signal: abort.signal, onEstablished: () => {
      client.setConnectorAssignmentListener(() => connector.wake());
      connector.start();
    } });
    socket.readyState = 1;
    socket.onopen?.();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
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

  it('adds no interval timer beyond the existing local ones', async () => {
    const dir = new URL('.', import.meta.url);
    const names = (await readdir(dir)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const intervals: string[] = [];
    for (const name of names) {
      const source = ts.createSourceFile(name, await readFile(new URL(name, dir), 'utf8'),
        ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'setInterval')
          intervals.push(name);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    // Recovery is the reconnect backoff and the bounded retries, both
    // setTimeout; none of these intervals reads from the server.
    expect(intervals.sort()).toEqual([
      'agent-runtime.ts', // scratch sweep (local disk)
      'session-scheduler.ts', // idle session sweep (local)
      'systemd.ts', // local watchdog feed
      'turn-receipt-heartbeat.ts', // receipt heartbeat while a turn runs
    ]);
  });

  it('has no interval or timeout callback that can reach a daemon read', async () => {
    const dir = new URL('.', import.meta.url);
    const names = (await readdir(dir)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const violations: string[] = [];
    for (const name of names) {
      const source = ts.createSourceFile(name, await readFile(new URL(name, dir), 'utf8'),
        ts.ScriptTarget.Latest, true);
      const functions = new Map<string, ts.Node>();
      const index = (node: ts.Node): void => {
        if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name)
          functions.set(node.name.getText(source), node);
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
          functions.set(node.name.text, node.initializer);
        ts.forEachChild(node, index);
      };
      index(source);
      const reachesRead = (node: ts.Node, seen = new Set<string>()): boolean => {
        let found = false;
        const walk = (child: ts.Node): void => {
          if (found) return;
          if (ts.isCallExpression(child)) {
            const expression = child.expression;
            if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'execute' &&
              child.arguments[0] && /^(get|list|claim|read|search)[A-Z]/.test(
                child.arguments[0].getText(source).replace(/^['"]|['"]$/g, '')))
              found = true;
            const called = ts.isPropertyAccessExpression(expression) ? expression.name.text :
              ts.isIdentifier(expression) ? expression.text : undefined;
            if (called && !seen.has(called) && functions.has(called)) {
              seen.add(called);
              if (reachesRead(functions.get(called)!, seen)) found = true;
            }
          }
          ts.forEachChild(child, walk);
        };
        walk(node);
        return found;
      };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.getText(source).match(/^(setInterval|setTimeout)$/)) {
          const callback = node.arguments[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            if (reachesRead(callback))
              violations.push(`${name}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });
});
