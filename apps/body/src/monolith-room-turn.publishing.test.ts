import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import { commandFixtureApi } from './command-fixture.test-support.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

const answer = 'S1 answer begins.\n' + Array.from({ length: 30 }, (_, i) =>
  `Step ${i + 1}: Keep the full authored answer available after the turn finishes.`,
).join('\n') + '\nS1 answer ends.';
const pointer = 'The full answer is in my earlier message.';

// A real ACP stdio peer supplies deterministic model output. Only the server
// boundary is recorded; the ACP parser, Room loop and publishing lane are real.
const harnessSource = `
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line), params = message.params;
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  const update = update => send({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: params.sessionId, update } });
  if (message.method === 'initialize') reply({ protocolVersion: 1 });
  else if (message.method === 'session/new') reply({ sessionId: 's1-session' });
  else if (message.method === 'session/prompt') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(answer)} } });
    update({ sessionUpdate: 'tool_call', toolCallId: 's1-tool', title: 'read status', status: 'in_progress' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 's1-tool', status: 'completed' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(pointer)} } });
    reply({ stopReason: 'end_turn' });
  } else if (message.method === 'shutdown') process.exit(0);
  else if (message.id !== undefined) reply({});
});
`;

it('R1 stand-in S1: preserves the answer before a tool and its final pointer in one Room reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-publishing-'));
  const script = join(root, 'harness.mjs');
  await writeFile(script, harnessSource);
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
    agentBinary: process.execPath, agentCommand: process.execPath, agentArgs: [script],
    agentKind: 'codex', agentEnv: {}, workspaceRoot: join(root, 'room'),
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
          id: 's1-request', authorId: human, createdAt: 1, type: 'message',
          body: 'Give the answer, use a tool, then point to the answer.', attachments: [],
        }], cursor: 's1-request' };
        return { items: [], cursor: 'latest' };
      }
      return { id: 'write-id', createdAt: 1 };
    },
    connection: () => ({ baseUrl: 'https://server.example', daemonToken: 'test-token', agentId: agent.publicKey }),
  } as unknown as DaemonApiClient;
  const scheduler = new SessionScheduler({ maxLiveSessions: 1 });
  const abort = new AbortController();
  const loop = new MonolithRoomTurnLoop({
    roomId: 'room-id', workspaceId: 'workspace', cwd: config.workspaceRoot,
    runtime, config, api: commandFixtureApi(api, 'room-id', agent.publicKey), scheduler,
    health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
    signal: abort.signal, pollMs: 5,
    createAcpClient: options => new AcpClient({
      ...options, agentCommand: process.execPath, agentBinary: process.execPath,
      agentArgs: [script], agentLabel: 's1-scripted-acp',
      oomKills: { prime: async () => undefined, consume: async () => false },
    }),
  });
  const running = loop.run();
  try {
    await vi.waitFor(() => expect(writes).toContainEqual({
      name: 'postAgentTurnReceipt', input: expect.objectContaining({ status: 'complete' }),
    }), { timeout: 10_000 });
    const published = writes.filter(write => write.name === 'postRoomMessage');
    expect(published).toHaveLength(1);
    expect(published[0]!.input).toMatchObject({
      requestId: 's1-request', triggerMessageId: 's1-request',
      text: `${answer}\n\n${pointer}`, presentation: 'message',
    });
    const drafts = writes.filter(write => write.name === 'postAgentDraft');
    expect(drafts.some(write => String(write.input.text).includes(answer))).toBe(true);
    expect(drafts.at(-1)!.input.text).toBe(published[0]!.input.text);
    expect(writes.filter(write => ['postAgentDraft', 'postRoomMessage', 'retractAgentLiveOutput'].includes(write.name)).at(-1)!.name)
      .toBe('retractAgentLiveOutput');
  } finally {
    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
