import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import { commandFixtureApi } from './command-fixture.test-support.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { createRequire } from 'node:module';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

vi.mock('./corner-branch-sync.js', () => ({ syncCornerBranch: vi.fn(async () => 'unchanged') }));
vi.mock('../dist/corner-branch-sync.js', () => ({ syncCornerBranch: vi.fn(async () => 'unchanged') }));
const RoomLoop = process.env.BEELINE_PROOF_BUILT ? (await import('../dist/monolith-room-turn.js')).MonolithRoomTurnLoop : MonolithRoomTurnLoop;
const CornerLoop = process.env.BEELINE_PROOF_BUILT ? (await import('../dist/monolith-corner-turn.js')).MonolithCornerTurnLoop : MonolithCornerTurnLoop;
const Client = process.env.BEELINE_PROOF_BUILT ? (await import('../dist/acp.js')).AcpClient : AcpClient;
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
const harnessSource = (updates: readonly Update[], root: string) => `
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const updates = ${JSON.stringify(updates)};
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line), params = message.params;
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  const update = update => send({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: params.sessionId, update } });
  if (message.method === 'initialize') reply({ protocolVersion: 1 });
  else if (message.method === 'session/new') {
    reply({ sessionId: 'r1-session' });
  }
  else if (message.method === 'session/prompt') {
    for (const item of updates) update(item);
    const capture = ${JSON.stringify(join(root, 'prompts.jsonl'))};
    appendFileSync(capture, JSON.stringify(params.prompt) + '\\n');
    if (readFileSync(capture, 'utf8').trim().split('\\n').length >= 3) reply({ stopReason: 'end_turn' });
  } else if (message.method === 'shutdown') process.exit(0);
  else if (message.id !== undefined) reply({});
});
`;

/** Run production session setup and publishing against a scripted ACP peer. */
async function turnWrites(scope: 'room' | 'corner', agentKind: BodyConfig['agentKind']) {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-publishing-'));
  const script = join(root, 'harness.mjs');
  await writeFile(script, harnessSource([text('The blue avatar draft is saved as draft.svg.'), ...tool('draw', 'draw_avatar')], root));
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
    agentKind, agentEnv: { BEELINE_FREE_AGENT_ID: 'fixture', BEELINE_FREE_AGENT_MAX_TURN_SECONDS: '2' }, workspaceRoot: join(root, 'room'),
    agentHomeRoot: join(root, 'agent-home'), operatorHome: join(root, 'operator-home'),
    mcpBinary: '/fake-dev-mcp', readonlyMcpCommand: '/fake-beeline-mcp',
    autoApprovePermissions: true, accessPolicy: 'everyone',
  } as BodyConfig;
  const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
  let inboxReads = 0;
  const delivered = new Set<number>();
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
        const terminal = writes.filter(write => write.name === 'postAgentTurnReceipt' && ['failed', 'complete'].includes(String(write.input.status))).length;
        const turn = terminal + 1;
        if (++inboxReads > 1 && turn <= 3 && !delivered.has(turn)) {
          delivered.add(turn);
          return { items: [{ id: `request-${turn}`, authorId: human, createdAt: turn, type: 'message',
            body: turn === 1 ? 'Make my avatar blue.' : 'continue', attachments: [] }], cursor: `request-${turn}` };
        }
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
    createAcpClient: (options: ConstructorParameters<typeof AcpClient>[0]) => new Client({
      ...options, agentCommand: process.execPath, agentBinary: process.execPath,
      agentArgs: ['--import', createRequire(import.meta.url).resolve('tsx'), script], agentLabel: 'r1-scripted-acp',
      oomKills: { prime: async () => undefined, consume: async () => false },
    }),
  };
  const loop = scope === 'room' ? new RoomLoop(common) : new CornerLoop({
    ...common, cornerId: 'room-id', parentRoomId: 'parent-room', objective: 'Handle report',
    worktreePath: root, repository: { featureBranch: 'feature/fixture', targetBranch: 'main', gitCommonDir: join(root, '.git') },
    onPoll: vi.fn(), onFailure: vi.fn(), onCloseRequested: vi.fn(async () => undefined),
  });
  const running = loop.run();
  try {
    await vi.waitFor(() => expect(writes.filter(write => write.name === 'postAgentTurnReceipt' && ['failed', 'complete'].includes(String(write.input.status)))).toHaveLength(3), { timeout: 15_000 });
    const prompts = (await readFile(join(root, 'prompts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.stringify(JSON.parse(line)));
    expect(prompts[1]).toContain('Make my avatar blue.');
    expect(prompts[1]).toContain('The blue avatar draft is saved as draft.svg.');
    expect(prompts[1]).toContain('draw_avatar: completed');
    expect(prompts[2]).toContain('hit the limit twice');
    await expect(readFile(join(config.agentHomeRoot!, 'free-agent-continuation.json'))).rejects.toThrow();
    return writes;
  } finally {
    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();
    await rm(root, { recursive: true, force: true });
  }
}


it.each(['room', 'corner'] as const)('Reproduction FREE-CONTINUE-1: %s hard stop saves partial reply and fails the turn', async scope => {
  const writes = await turnWrites(scope, 'pi');
  const replies = writes.filter(write => write.name === 'postRoomMessage');
  expect(replies).toHaveLength(3);
  expect(replies[0]!.input.text).toContain('send continue');
  expect(replies[1]!.input.text).toContain('too large for one turn');
  expect(replies[1]!.input.text).toContain('First, I can');
  expect(replies[1]!.input.text).not.toContain('send continue');
  expect(replies[0]!.input.text).toContain('The blue avatar draft is saved as draft.svg.');
  expect(writes).toContainEqual({ name: 'postAgentTurnReceipt', input: expect.objectContaining({ status: 'failed', reason: 'free-agent-time-limit' }) });
}, 30_000);
