import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { commandFixtureApi } from './command-fixture.test-support.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

type Loop = { activate(): Promise<string>; discardSession(preserve?: boolean): Promise<void>; run(): Promise<void>; configurationChanged(): void; client?: AcpClient };

it.each([['room', 'activation'], ['corner', 'activation'], ['room', 'intake'], ['corner', 'intake']] as const)('Reproduction ACP-LEAK: %s %s authentication refusal leaves no live subprocess', async (surface, path) => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-activation-failure-'));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex') }, rooms: [],
    communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test' },
  } as AgentRuntimeRecord;
  const harness = 'codex';
  const command = process.execPath;
  const config = { agentCommand: command, agentBinary: command, agentKind: harness, agentArgs: [join(root, 'fake-codex-acp.cjs')],
    readonlyMcpCommand: '/fake/mcp', mcpBinary: '/fake/mcp', agentEnv: {},
    workspaceRoot: root, agentHomeRoot: join(root, 'agent-home'), operatorHome: join(root, 'operator'),
  } as BodyConfig;
  await writeFile(join(root, 'fake-codex-acp.cjs'), `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const response = request.method === 'session/new'
    ? { error: { code: -32000, message: 'Authentication required' } }
    : { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');
});
`);
  const name = 'Bee';
  const abort = new AbortController();
  const receipts: Array<Record<string, unknown>> = [];
  let delivered = 0;
  const api = {
    execute: vi.fn(async (operation: string, input: Record<string, unknown>) => {
      if (operation === 'postAgentTurnReceipt' && input.status === 'failed') receipts.push(input);
      if (operation === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (operation === 'getRoomInbox') {
        if (input.startAtLatest || delivered >= 4) return { items: [], cursor: 'latest' };
        return { items: [{ id: `turn-${++delivered}`, authorId: '22'.repeat(32), createdAt: delivered,
          type: 'message', body: 'Please handle this request', attachments: [] }], cursor: 'latest' };
      }
      if (operation === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (operation === 'getWorkspaceRoster') return { members: [{ identityId: identity.publicKey, name, kind: 'agent' }] };
      if (operation === 'getRoomRepositoryState') return { resolution: 'none' };
      if (operation === 'listAgentGrants') return { grants: [] };
      if (operation === 'getCornerRestoreState') return { cornerId: 'surface', lifecycle: { lifecycle: 'working', checks: 'unknown' } };
      return { id: 'ok' };
    }),
    connection: () => ({ baseUrl: 'https://server.example', daemonToken: 'test', agentId: identity.publicKey }),
  };
  const scheduler = new SessionScheduler({ maxLiveSessions: 1 });
  const clients: AcpClient[] = [];
  const options = { runtime, config,
    api: path === 'intake' ? commandFixtureApi(api as unknown as DaemonApiClient, 'surface', identity.publicKey) : api as never,
    signal: abort.signal, pollMs: 5, scheduler, createAcpClient: (options: ConstructorParameters<typeof AcpClient>[0]) => {
      expect(clients.filter(client => client.isAlive)).toHaveLength(0);
      const client = new AcpClient(options);
      clients.push(client);
      vi.spyOn(client, 'stop');
      return client;
    } };
  const loop = (surface === 'room'
      ? new MonolithRoomTurnLoop({ ...options, roomId: 'surface', workspaceId: 'workspace', cwd: root,
          health: { poll: () => undefined } })
      : new MonolithCornerTurnLoop({ ...options, cornerId: 'surface', parentRoomId: 'parent',
          workspaceId: 'workspace', objective: 'Answer the message', worktreePath: root,
          onPoll: () => undefined, onCloseRequested: async () => undefined })) as unknown as Loop;
  let running: Promise<void> | undefined;
  try {
    if (path === 'activation') {
      // Simulate a retained client with no session; replacement must stop it first.
      const orphan = options.createAcpClient({ agentCommand: command, agentArgs: config.agentArgs, agentEnv: {} });
      await orphan.start();
      loop.client = orphan;
    }
    if (path === 'intake') {
      running = loop.run();
      if (surface === 'corner') {
        for (let attempt = 1; attempt <= 4; attempt++) {
          await vi.waitFor(() => expect(receipts).toHaveLength(attempt), { timeout: 10_000 });
          await vi.waitFor(() => expect(clients.filter(client => client.isAlive)).toHaveLength(0));
          // A rejected corner intake stays parked despite later requests.
          // Exercise four distinct recovery attempts, with cleanup between them.
          await new Promise(resolve => setTimeout(resolve, 30));
          expect(receipts).toHaveLength(attempt);
          if (attempt < 4) loop.configurationChanged();
        }
      } else await vi.waitFor(() => expect(receipts).toHaveLength(4), { timeout: 10_000 });
      expect(receipts.every(receipt => receipt.reasonKind === 'not-signed-in')).toBe(true);
      expect(receipts.every(receipt => String(receipt.reason).includes('sign in again'))).toBe(true);
      expect(clients.filter(client => client.isAlive)).toHaveLength(0);
      expect(clients.every(client => vi.mocked(client.stop).mock.calls.length === 1)).toBe(true);
    } else for (let turn = 0; turn < 4; turn++) {
      let failure: unknown;
      try { await loop.activate(); } catch (error) { failure = error; }
      expect(String(failure)).toContain('ACP error -32000: Authentication required');
      expect(clients.filter(client => client.isAlive)).toHaveLength(0);
      expect(clients.every(client => vi.mocked(client.stop).mock.calls.length === 1)).toBe(true);
      expect(distillTurnFailureReason(failure).kind).toBe('not-signed-in');
    }
    expect(clients).toHaveLength(path === 'activation' ? 5 : 4);
  } finally {
    abort.abort();
    await running;
    await loop.discardSession();
    await Promise.all(clients.map(client => client.stop()));
    await scheduler.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
