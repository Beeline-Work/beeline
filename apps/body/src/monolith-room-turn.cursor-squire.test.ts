import { commandFixtureApi } from './command-fixture.test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, type McpServerWire } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

async function roomSessionServers(agentKind: 'cursor' | 'claude'): Promise<McpServerWire[]> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-cursor-squire-'));
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
    agentKind,
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
  } as unknown as AgentRuntimeRecord;
  const config = {
    agentBinary: '/fake-agent',
    agentKind,
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    workspaceRoot: join(root, 'room'),
    autoApprovePermissions: true,
    accessPolicy: 'everyone',
    agentHomeRoot: join(root, 'agent-home'),
    operatorHome: join(root, 'operator-home'),
  } as BodyConfig;
  let inboxReads = 0;
  const execute = vi.fn(async (name: string) => {
    if (name === 'getAgentConfiguration') return { commands: [], yoloMode: true };
    if (name === 'getRoomRepositoryState') return { resolution: 'none' };
    if (name === 'getWorkspaceRoster') {
      return {
        members: [
          { identityId: agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
          { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'owner' },
        ],
      };
    }
    if (name === 'listAgentGrants') {
      return { grants: [{ grantId: 'g-1', kind: 'mcp', target: 'squire', status: 'approved' }] };
    }
    if (name === 'getRoomInbox') {
      inboxReads += 1;
      if (inboxReads === 2) {
        return {
          items: [{
            id: 'ask-1',
            authorId: HUMAN,
            createdAt: 1,
            type: 'message',
            body: 'Call OpenRouter with the vaulted key',
            attachments: [],
          }],
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
  vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
  const sessionNew = vi
    .spyOn(acp, 'sessionNew')
    .mockResolvedValue({ sessionId: 'session-1', raw: {} });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
    stopReason: 'end_turn',
    updates: [],
    agentText: 'Done.',
    toolCalls: [],
  });
  const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
  const abort = new AbortController();
  const loop = new MonolithRoomTurnLoop({
    roomId: 'room-id',
    workspaceId: 'workspace',
    cwd: config.workspaceRoot,
    runtime,
    config,
    api: commandFixtureApi(api, 'room-id', runtime.agent.publicKey),
    scheduler,
    health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
    signal: abort.signal,
    pollMs: 10,
    createAcpClient: () => acp,
  });
  const running = loop.run();
  await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  abort.abort();
  await running;
  await scheduler.dispose();
  return (sessionNew.mock.calls[0]![0] as { mcpServers: McpServerWire[] }).mcpServers;
}

describe('Room session/new servers with an approved squire grant', () => {
  it('hands Cursor the granted squire route, since session/new is its only MCP source', async () => {
    const names = (await roomSessionServers('cursor')).map((server) => server.name);
    expect(names).toContain('beeline-agent');
    expect(names.filter((name) => name === 'squire')).toHaveLength(1);
  });

  it('leaves Claude on its home config route, so squire is not mounted twice', async () => {
    const names = (await roomSessionServers('claude')).map((server) => server.name);
    expect(names).toContain('beeline-agent');
    expect(names).not.toContain('squire');
  });
});
