import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

async function runTurn(options: {
  agentCommand: string;
  agentKind: string;
  prompt: (input: {
    agentHomeRoot: string;
  }) => Promise<Awaited<ReturnType<AcpClient['sessionPrompt']>>>;
}): Promise<{ receipts: Array<Record<string, unknown>>; posted: Array<Record<string, unknown>> }> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-failure-'));
  roots.push(root);
  const agentHomeRoot = join(root, 'agent-home');
  const identity = identityFromKey(AGENT_HEX, 'Bee');
  const agent = {
    name: 'Bee',
    publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
  };
  const runtime = {
    agent,
    rooms: [],
    supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
    agentBinary: options.agentCommand,
    agentKind: options.agentKind,
    agentCommand: options.agentCommand,
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
  } as unknown as AgentRuntimeRecord;
  const config: BodyConfig = {
    agentBinary: options.agentCommand,
    agentKind: options.agentKind,
    agentCommand: options.agentCommand,
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    workspaceRoot: join(root, 'room'),
    autoApprovePermissions: true,
    accessPolicy: 'everyone',
    agentHomeRoot,
    operatorHome: join(root, 'operator-home'),
  } as BodyConfig;
  let inboxReads = 0;
  const receipts: Array<Record<string, unknown>> = [];
  const respond = async (name: string, input: Record<string, unknown>) => {
    if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
    if (name === 'getRoomRepositoryState') return { resolution: 'none' };
    if (name === 'getWorkspaceRoster') {
      return {
        members: [
          { identityId: agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
          { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'owner' },
        ],
      };
    }
    if (name === 'postAgentTurnReceipt') receipts.push(input);
    if (name === 'getRoomInbox') {
      inboxReads += 1;
      if (inboxReads === 2) {
        return {
          items: [
            {
              id: 'ask-1',
              authorId: HUMAN,
              createdAt: 1,
              type: 'message',
              body: "what's up",
              mentionIds: [agent.publicKey],
              attachments: [],
            },
          ],
          cursor: 'ask-1',
        };
      }
      return { items: [], cursor: 'latest' };
    }
    if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
    if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
    return { id: 'write-id', createdAt: 1 };
  };
  const execute = vi.fn(respond);
  const api = {
    execute,
    connection: () => ({
      baseUrl: 'https://server.example',
      daemonToken: 'daemon-token',
      agentId: agent.publicKey,
    }),
  } as unknown as DaemonApiClient;
  const posted: Array<Record<string, unknown>> = [];
  execute.mockImplementation(async (name: string, input: Record<string, unknown>) => {
    if (name === 'postRoomMessage') posted.push(input);
    return respond(name, input);
  });
  const acp = new AcpClient({ agentBinary: options.agentCommand, agentEnv: {} });
  vi.spyOn(acp, 'start').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp, 'sessionPrompt').mockImplementation(() => options.prompt({ agentHomeRoot }));
  const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
  const abort = new AbortController();
  const loop = new MonolithRoomTurnLoop({
    roomId: 'room-id',
    workspaceId: 'workspace',
    cwd: config.workspaceRoot,
    runtime,
    config,
    api,
    scheduler,
    health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
    signal: abort.signal,
    pollMs: 10,
    createAcpClient: () => acp,
  });
  const running = loop.run();
  await vi.waitFor(
    () =>
      expect(
        receipts.some((receipt) => receipt.status === 'failed' || receipt.status === 'complete'),
      ).toBe(true),
    { timeout: 5_000 },
  );
  abort.abort();
  await running.catch(() => undefined);
  await scheduler.dispose();
  return { receipts, posted };
}

describe('Room turn failure receipt', () => {
  it('reports failed with a distilled, secret-free reason and never a stack trace', async () => {
    const failure = new Error(
      'ACP error -32000: provider error 429 concurrency_limit (Authorization: Bearer sk-or-v1-abcdefghijklmnop)',
    );
    failure.stack = `${failure.message}\n    at AcpClient.request (/opt/beeline/acp.js:984:20)`;
    const { receipts } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: () => Promise.reject(failure),
    });

    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed).toEqual(
      expect.objectContaining({ roomId: 'room-id', requestId: 'ask-1', status: 'failed' }),
    );
    const reason = failed.reason as string;
    expect(reason).toContain('provider error 429 concurrency_limit');
    expect(reason).toContain('[REDACTED]');
    expect(reason).not.toMatch(/sk-or-v1|\n|\bat AcpClient/);
    expect(reason.length).toBeLessThanOrEqual(200);
  });

  it("names pi's recorded provider refusal when pi-acp ends a turn with no content", async () => {
    const { receipts, posted } = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      prompt: async ({ agentHomeRoot }) => {
        // pi's own session record (layout: $PI_CODING_AGENT_DIR/sessions/<cwd>/<ts>_<id>.jsonl),
        // exactly what pi wrote for Candy's turns on 2026-09-03 while pi-acp streamed nothing.
        const dir = join(agentHomeRoot, 'pi', 'sessions', '--room--');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, '2026-09-03T17-55-38-000Z_room-session.jsonl'),
          [
            JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [],
                stopReason: 'error',
                errorMessage:
                  '402: {"message":"This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 10381. To increase, visit https://openrouter.ai/settings/credits and add more credits","code":402}',
              },
            }),
          ].join('\n'),
        );
        return { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] };
      },
    });
    expect(posted).toEqual([]);
    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    const reason = failed.reason as string;
    expect(reason).toMatch(/^provider error 402: This request requires more credits/);
    expect(reason).not.toContain('no durable Room reply');
    expect(reason.length).toBeLessThanOrEqual(200);
  });

  it('describes the stream when a non-pi harness ends a turn with reasoning only', async () => {
    const { receipts } = await runTurn({
      agentCommand: '/fake-agent',
      agentKind: 'codex',
      prompt: async () => ({
        stopReason: 'end_turn',
        agentText: '',
        toolCalls: [],
        updates: [
          {
            sessionId: 'room-session',
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'hmm' },
            },
          },
        ],
      }),
    });
    const failed = receipts.find((receipt) => receipt.status === 'failed')!;
    expect(failed.reason).toBe(
      'harness ended the turn (end_turn) with no answer text; the stream carried only agent_thought_chunk×1',
    );
  });

  it('posts answer text pi recorded when the ACP stream delivered none', async () => {
    const { receipts, posted } = await runTurn({
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      prompt: async ({ agentHomeRoot }) => {
        const dir = join(agentHomeRoot, 'pi', 'sessions', '--room--');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, '2026_room-session.jsonl'),
          [
            JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'All good.' }],
                stopReason: 'stop',
              },
            }),
          ].join('\n'),
        );
        return { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] };
      },
    });
    expect(posted.map((message) => message.text)).toEqual(['All good.']);
    expect(receipts.some((receipt) => receipt.status === 'complete')).toBe(true);
  });
});
