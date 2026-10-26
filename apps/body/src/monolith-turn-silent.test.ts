import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import { commandFixtureApi } from './command-fixture.test-support.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

vi.mock('./corner-branch-sync.js', () => ({ syncCornerBranch: vi.fn(async () => 'unchanged') }));
type Update = Record<string, unknown>;
const text = (value: string): Update => ({
  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value },
});
const tool = (id: string, title: string): Update[] => [
  { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'other', status: 'pending' },
  { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' },
];

// A real ACP stdio peer replays a fixed update stream. Only the server
// boundary is recorded; the ACP parser, Room loop and publishing lane are real.
const harnessSource = (updates: readonly Update[]) => `
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const updates = ${JSON.stringify(updates)};
let toolEnv = {};
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line), params = message.params;
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  const update = update => send({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: params.sessionId, update } });
  if (message.method === 'initialize') reply({ protocolVersion: 1 });
  else if (message.method === 'session/new') {
    const servers = params.mcpServers.map(server => server.args?.[0]?.endsWith('/launch.cjs')
      ? JSON.parse(readFileSync(server.args[1], 'utf8')) : server);
    const server = servers.find(server => server.env?.some(value => value.name === 'BEELINE_TURN_CONTEXT_FILE'));
    toolEnv = Object.fromEntries(server.env.map(({ name, value }) => [name, value]));
    reply({ sessionId: 'r1-session' });
  }
  else if (message.method === 'session/prompt') {
    for (const item of updates) {
      if (item.silence) {
        try { execFileSync(process.execPath, ['--import', ${JSON.stringify(createRequire(import.meta.url).resolve('tsx'))}, '--input-type=module', '-e', ${JSON.stringify(`
          import { callAgentTool } from '${pathToFileURL(join(process.cwd(), 'src/read-only-mcp.ts')).href}';
          process.env.BEELINE_DAEMON_BASE_URL = 'http://fixture';
          process.env.BEELINE_DAEMON_TOKEN = 'fixture';
          // The replayed tool is explicitly advertised even when the fixture binary is Node.
          process.env.BEELINE_EXPLICIT_SILENT_RECEIPT = '1';
          globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
          if (await callAgentTool('no_reply_needed', {}, 'silent') !== JSON.stringify({ acknowledged: true })) throw new Error('Silence was not acknowledged');
        `)}], { env: { ...process.env, ...toolEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { process.stderr.write(error.stderr); process.exit(1); }
      } else update(item);
    }
    reply({ stopReason: 'end_turn' });
  } else if (message.method === 'shutdown') process.exit(0);
  else if (message.id !== undefined) reply({});
});
`;

/** Run production session setup and publishing against a scripted ACP peer. */
async function turnWrites(scope: 'room' | 'corner', agentKind: BodyConfig['agentKind']) {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-publishing-'));
  const script = join(root, 'harness.mjs');
  await writeFile(script, harnessSource([...tool('silent', 'no_reply_needed'), { silence: true }, text('This closing text must disappear.')]));
  const identity = identityFromKey('11'.repeat(32), 'Bee');
  const human = '22'.repeat(32);
  const agent = {
    name: 'Bee', publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
  };
  const runtime = {
    agent, rooms: [], supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'test-token' },
  } as unknown as AgentRuntimeRecord;
  const config = {
    agentBinary: process.execPath, agentCommand: process.execPath, agentArgs: ['--import', createRequire(import.meta.url).resolve('tsx'), script],
    agentKind, agentEnv: {}, workspaceRoot: join(root, 'room'),
    agentHomeRoot: join(root, 'agent-home'), operatorHome: join(root, 'operator-home'),
    mcpBinary: '/fake-dev-mcp', readonlyMcpCommand: '/fake-beeline-mcp',
    autoApprovePermissions: true, accessPolicy: 'everyone',
  } as BodyConfig;
  const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
  let inboxReads = 0;
  const api = {
    execute: async (name: string, input: Record<string, unknown>) => {
      writes.push({ name, input });
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getRoomRepositoryState') return { resolution: 'none' };
      if (name === 'getWorkspaceRoster') return { members: [
        { identityId: agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
        { identityId: human, kind: 'human', name: 'Captain', role: 'owner' },
      ] };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomInbox') {
        if (++inboxReads === 2) return { items: [{
          id: 'r1-request', authorId: human, createdAt: 1, type: 'message',
          body: 'Report received.', attachments: [], fixtureCommandReason: 'report',
        }], cursor: 'r1-request' };
        return { items: [], cursor: 'latest' };
      }
      return { id: 'write-id', createdAt: 1 };
    },
    connection: () => ({ baseUrl: 'https://server.example', daemonToken: 'test-token', agentId: agent.publicKey }),
  } as unknown as DaemonApiClient;
  const scheduler = new SessionScheduler({ maxLiveSessions: 1 });
  const abort = new AbortController();
  const common = {
    roomId: 'room-id', workspaceId: 'workspace', cwd: config.workspaceRoot,
    runtime, config, api: commandFixtureApi(api, 'room-id', agent.publicKey), scheduler,
    health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
    signal: abort.signal, pollMs: 5,
    createAcpClient: (options: ConstructorParameters<typeof AcpClient>[0]) => new AcpClient({
      ...options, agentCommand: process.execPath, agentBinary: process.execPath,
      agentArgs: ['--import', createRequire(import.meta.url).resolve('tsx'), script], agentLabel: 'r1-scripted-acp',
      oomKills: { prime: async () => undefined, consume: async () => false },
    }),
  };
  const loop = scope === 'room' ? new MonolithRoomTurnLoop(common) : new MonolithCornerTurnLoop({
    ...common, cornerId: 'room-id', parentRoomId: 'parent-room', objective: 'Handle report',
    worktreePath: root, repository: { featureBranch: 'feature/fixture', targetBranch: 'main', gitCommonDir: join(root, '.git') },
    onPoll: vi.fn(), onFailure: vi.fn(), onCloseRequested: vi.fn(async () => undefined),
  });
  const running = loop.run();
  try {
    await vi.waitFor(() => expect(writes).toContainEqual({
      name: 'postAgentTurnReceipt', input: expect.objectContaining({ status: 'complete' }),
    }), { timeout: 10_000 });
    return writes;
  } finally {
    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();
    await rm(root, { recursive: true, force: true });
  }
}


it.each(['room', 'corner'] as const)('Reproduction R1: production %s ACP environment carries successful no_reply_needed to stop', async scope => {
  for (const kind of ['claude', 'codex', 'pi'] as const) {
    const writes = await turnWrites(scope, kind);
    expect(writes.filter(write => write.name === 'postRoomMessage')).toEqual([]);
    expect(writes).toContainEqual({ name: 'postAgentTurnReceipt', input: expect.objectContaining({ status: 'complete', completionKind: 'no-reply' }) });
  }
}, 60_000);
