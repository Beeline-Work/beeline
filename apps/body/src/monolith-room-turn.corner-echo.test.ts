import { mkdtemp, rm } from 'node:fs/promises';
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

async function runTurn(
  agentText: string,
  toolCalls: Array<{ id: string; title: string; status: string }>,
): Promise<{ receipts: Array<Record<string, unknown>>; posted: Array<Record<string, unknown>> }> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-corner-echo-'));
  roots.push(root);
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
    agentBinary: '/fake-agent',
    agentKind: 'codex',
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
  } as unknown as AgentRuntimeRecord;
  const config: BodyConfig = {
    agentBinary: '/fake-agent',
    agentKind: 'codex',
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    workspaceRoot: join(root, 'room'),
    autoApprovePermissions: true,
    accessPolicy: 'everyone',
  } as BodyConfig;
  let inboxReads = 0;
  const receipts: Array<Record<string, unknown>> = [];
  const posted: Array<Record<string, unknown>> = [];
  const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
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
    if (name === 'postRoomMessage') posted.push(input);
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
              body: 'fix the widget',
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
  });
  const api = {
    execute,
    connection: () => ({
      baseUrl: 'https://server.example',
      daemonToken: 'daemon-token',
      agentId: agent.publicKey,
    }),
  } as unknown as DaemonApiClient;
  const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
  vi.spyOn(acp, 'start').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
    stopReason: 'end_turn',
    updates: [],
    agentText,
    toolCalls,
  });
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

const OPEN_CORNER = { id: 'call-1', title: 'mcp__beeline-agent__open_corner', status: 'completed' };

describe('Room turn after open_corner', () => {
  it('drops the "Opened corner …" echo: the server card already announces it', async () => {
    const { receipts, posted } = await runTurn(
      'Opened corner 3f2a9c1e-77d2-4b0e-9d1a-0c5b2e8f4a11 with the objective "Fix the widget".',
      [OPEN_CORNER],
    );
    expect(posted).toEqual([]);
    expect(receipts).toContainEqual(
      expect.objectContaining({ requestId: 'ask-1', status: 'complete' }),
    );
  });

  it('keeps what the model adds beyond the announcement', async () => {
    const { posted } = await runTurn(
      'Opened corner 3f2a9c1e for the widget fix.\n\n@Captain the repo has no CI; want one in the same PR?',
      [OPEN_CORNER],
    );
    expect(posted.map((message) => message.text)).toEqual([
      '@Captain the repo has no CI; want one in the same PR?',
    ]);
  });

  it('keeps the announcement wording when no corner call happened in the turn', async () => {
    const { posted } = await runTurn('Opened corner earlier today; it is still working.', []);
    expect(posted.map((message) => message.text)).toEqual([
      'Opened corner earlier today; it is still working.',
    ]);
  });
});
