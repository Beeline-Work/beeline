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
const updates = ${JSON.stringify(updates)};
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line), params = message.params;
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  const update = update => send({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: params.sessionId, update } });
  if (message.method === 'initialize') reply({ protocolVersion: 1 });
  else if (message.method === 'session/new') reply({ sessionId: 'r1-session' });
  else if (message.method === 'session/prompt') {
    for (const item of updates) update(item);
    reply({ stopReason: 'end_turn' });
  } else if (message.method === 'shutdown') process.exit(0);
  else if (message.id !== undefined) reply({});
});
`;

/** Run one Room turn against the scripted harness; return every server write. */
async function roomTurnWrites(updates: readonly Update[], agentKind: BodyConfig['agentKind'] = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-publishing-'));
  const script = join(root, 'harness.mjs');
  await writeFile(script, harnessSource(updates));
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
          body: 'Do the work and tell me.', attachments: [],
        }], cursor: 'r1-request' };
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
      agentArgs: [script], agentLabel: 'r1-scripted-acp',
      oomKills: { prime: async () => undefined, consume: async () => false },
    }),
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

const posted = (writes: Awaited<ReturnType<typeof roomTurnWrites>>) => {
  const replies = writes.filter(write => write.name === 'postRoomMessage');
  expect(replies).toHaveLength(1);
  // The draft is retracted after the reply, never left under it.
  expect(writes.filter(write => ['postAgentDraft', 'postRoomMessage', 'retractAgentLiveOutput'].includes(write.name)).at(-1)!.name)
    .toBe('retractAgentLiveOutput');
  return replies[0]!.input as { text: string; steps?: Array<Record<string, unknown>> };
};
const shape = (steps: Array<Record<string, unknown>> | undefined) =>
  (steps ?? []).map(step => (step.kind === 'note' ? `note: ${step.text}` : `tool: ${step.title}`));

// Message 65b1d846 (Room bb91a1c7): Ruby wrote one sentence, loaded a tool
// with ToolSearch, called close_corner, then wrote the answer. The posted
// message began with the sentence. Both shapes of the answer's first delta
// are replayed: with and without the paragraph break Claude can open with.
const ruby = {
  narration: 'Now close the Play declaration corner.',
  answer: "@lunchboxfortwo I've updated the conversation-keep-awake corner to do all three changes in one PR. Its session hasn't started yet.\n\nI closed the Play declaration corner. Nothing went to Google.",
};
// Message 51751cde (Room bb91a1c7): Jellybean's sentence ended in a line
// break, a Skill call followed, then the answer. The posted message carried
// the sentence and three line breaks before the answer.
const jellybean = {
  narration: 'I’ll check the corner’s blocker before deciding whether it needs to resume or stay parked. I’m using the using-beeline skill for that check.',
  answer: 'Queued the corner to check for completed sign-in and handback, then finish verification if ready. Execution hasn’t started yet.',
};

it.each([
  ['65b1d846', [
    text(ruby.narration), ...tool('t1', 'ToolSearch'), ...tool('t2', 'close_corner'), text(ruby.answer),
  ], ruby],
  ['65b1d846, answer opening on a paragraph break', [
    text(ruby.narration), ...tool('t1', 'ToolSearch'), ...tool('t2', 'close_corner'), text(`\n\n${ruby.answer}`),
  ], ruby],
  ['51751cde', [
    text(`${jellybean.narration}\n`), ...tool('t1', 'Load skill: using-beeline'), text(jellybean.answer),
  ], jellybean],
  ['51751cde, answer opening on a paragraph break', [
    text(jellybean.narration), ...tool('t1', 'Load skill: using-beeline'), text(`\n\n\n${jellybean.answer}`),
  ], jellybean],
] as const)('R1 %s: posts only the final answer and keeps the earlier sentence as a note', async (_name, updates, message) => {
  const reply = posted(await roomTurnWrites(updates));
  expect(reply.text).toBe(message.answer);
  expect(shape(reply.steps).filter(step => step.startsWith('note: '))).toEqual([`note: ${message.narration}`]);
  // The note keeps its place: before the tool calls that followed it.
  expect(shape(reply.steps)[0]).toBe(`note: ${message.narration}`);
  expect(shape(reply.steps).filter(step => step.startsWith('tool: '))).toHaveLength(updates.filter(update => update.sessionUpdate === 'tool_call').length);
});

const answer = 'S1 answer begins.\n' + Array.from({ length: 30 }, (_, i) =>
  `Step ${i + 1}: Keep the full authored answer available after the turn finishes.`,
).join('\n') + '\nS1 answer ends.';

it('#2495: an answer written before the last tool call is still the reply', async () => {
  const reply = posted(await roomTurnWrites([
    text(answer), ...tool('s1-tool', 'react_to_message'), text('\n\n'),
  ]));
  expect(reply.text).toBe(answer);
  expect(shape(reply.steps)).toEqual(['tool: react_to_message']);
});

it('#2495: an answer followed by a tool and a short pointer stays whole, as a note', async () => {
  const pointer = 'The full answer is in my earlier message.';
  const reply = posted(await roomTurnWrites([text(answer), ...tool('s1-tool', 'read status'), text(pointer)]));
  expect(reply.text).toBe(pointer);
  expect(shape(reply.steps)).toEqual([`note: ${answer}`, 'tool: read status']);
});

const noteText = (steps: Array<Record<string, unknown>> | undefined) =>
  (steps ?? []).filter(step => step.kind === 'note').map(step => step.text).join('');

it('keeps a long earlier run whole in the steps and the reply clean', async () => {
  const long = `Start. ${'x'.repeat(16_000)} End.`;
  const reply = posted(await roomTurnWrites([text(long), ...tool('t1', 'read status'), text('Done.')]));
  expect(reply.text).toBe('Done.');
  expect(noteText(reply.steps)).toBe(long);
  expect(reply.steps!.map(step => step.kind)).toEqual(['note', 'note', 'tool']);
  expect(reply.steps![1]).toMatchObject({ continues: true });
});

it('keeps more than 200 earlier runs as notes and the reply clean', async () => {
  const updates = Array.from({ length: 201 }, (_, index) => [
    text(`Note ${index}.`), ...tool(`t${index}`, `step ${index}`),
  ]).flat();
  const reply = posted(await roomTurnWrites([...updates, text('Done.')]));
  expect(reply.text).toBe('Done.');
  const notes = shape(reply.steps).filter(step => step.startsWith('note: '));
  expect(notes).toEqual(Array.from({ length: 201 }, (_, index) => `note: Note ${index}.`));
  expect(shape(reply.steps)).toHaveLength(402);
});

it('Reproduction 572a0de1: streamed intermediate prose then matching final has one visible reply', async () => {
  const prose = 'Google sign-in (#2676) is merged. The checks passed.';
  const writes = await roomTurnWrites([text(prose), ...tool('post', 'read status'), text(prose)], 'claude');
  const reply = posted(writes);
  expect(reply.text).toBe(prose);
  expect(shape(reply.steps)).toEqual(['tool: read status']);
});
