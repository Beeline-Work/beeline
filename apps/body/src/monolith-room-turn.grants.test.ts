import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { GrantCommandRunner } from './grant-runner.js';
import {
  inboxItemTriggersTurn,
  isGrantDecisionLine,
  MonolithRoomTurnLoop,
  pendingGrantToolCall,
} from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

describe('grant decision recognition', () => {
  const agent = 'a'.repeat(64);
  const decision = formatGrantDecisionLine({
    deciderName: 'Charles',
    decision: 'always',
    kind: 'command',
    target: 'fly deploy -a preview --with FLY_TOKEN',
  });

  it('wakes on a server decision line mentioning the agent and on nothing else system-shaped', () => {
    const base = { id: 'x', authorId: HUMAN, createdAt: 1, attachments: [], mentionIds: [agent] };
    expect(isGrantDecisionLine({ type: 'system', body: decision, mentionIds: [agent] }, agent)).toBe(true);
    expect(inboxItemTriggersTurn({ ...base, type: 'system', body: decision }, agent)).toBe(true);
    // Not addressed to this agent, or a plain system line, or a human message shaped like one.
    expect(inboxItemTriggersTurn({ ...base, type: 'system', body: decision, mentionIds: [] }, agent)).toBe(false);
    expect(inboxItemTriggersTurn({ ...base, type: 'system', body: 'member joined' }, agent)).toBe(false);
    expect(
      inboxItemTriggersTurn(
        { ...base, type: 'system', body: 'Owner turned yolo on for Bee · grant requests are now approved automatically' },
        agent,
      ),
    ).toBe(false);
    // The agent's own rows never trigger, even in decision shape.
    expect(inboxItemTriggersTurn({ ...base, authorId: agent, type: 'system', body: decision }, agent)).toBe(false);
  });

  it('spots the request_grant call that paused the turn from its reply text', () => {
    expect(
      pendingGrantToolCall({
        title: 'mcp__beeline-agent__request_grant',
        content: [{ type: 'text', text: 'pending, card posted: run fly deploy [grant g-1]. …' }],
      }),
    ).toBe(true);
    expect(
      pendingGrantToolCall({ title: 'beeline-agent.request_grant', content: 'approved (yolo): run npm test' }),
    ).toBe(false);
    expect(pendingGrantToolCall({ title: 'mcp__beeline-agent__open_corner', content: 'pending, card posted' })).toBe(
      false,
    );
  });
});

describe('Room turn paused on a grant card', () => {
  it('marks the turn paused after a pending request_grant and resumes it when the decision line arrives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-room-grants-'));
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
      agentHomeRoot: join(root, 'agent-home'),
      operatorHome: join(root, 'operator-home'),
    } as BodyConfig;
    const decision = formatGrantDecisionLine({
      deciderName: 'Captain',
      decision: 'once',
      kind: 'command',
      target: 'fly deploy -a preview --with FLY_TOKEN',
    });
    let inboxReads = 0;
    let decisionDelivered = false;
    let loop: MonolithRoomTurnLoop | undefined;
    const activity: Array<Record<string, unknown>> = [];
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
      if (name === 'postAgentActivity') activity.push(input);
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
                body: 'Deploy the preview please',
                mentionIds: [agent.publicKey],
                attachments: [],
              },
            ],
            cursor: 'ask-1',
          };
        }
        // The owner answers only after the daemon has paused the turn on the card.
        if (!decisionDelivered && loop?.pausedGrantRequestId() === 'ask-1') {
          decisionDelivered = true;
          return {
            items: [
              // A plain system line never wakes the agent…
              {
                id: 'join-1',
                authorId: HUMAN,
                createdAt: 2,
                type: 'system',
                body: 'member joined',
                mentionIds: [agent.publicKey],
                attachments: [],
              },
              // …the owner's decision does, without an authority read.
              {
                id: 'decision-1',
                authorId: HUMAN,
                createdAt: 3,
                type: 'system',
                body: decision,
                mentionIds: [agent.publicKey],
                attachments: [],
              },
            ],
            cursor: 'decision-1',
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
    const sessionNew = vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    const sessionPrompt = vi
      .spyOn(acp, 'sessionPrompt')
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'I asked Captain for permission to run the deploy; waiting on the card.',
        toolCalls: [
          {
            id: 'call-1',
            title: 'mcp__beeline-agent__request_grant',
            status: 'completed',
            content: [{ type: 'text', text: 'pending, card posted: run fly deploy -a preview [grant g-1].' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Deployed the preview.',
        toolCalls: [],
      });
    const grantRunner = new GrantCommandRunner({ api, agentId: agent.publicKey, resolveSecret: async () => undefined });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const abort = new AbortController();
    loop = new MonolithRoomTurnLoop({
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
      grantRunner,
      grantRunnerEndpoint: { url: 'http://127.0.0.1:1', token: 'runner-token' },
    });
    const running = loop.run();
    await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(decisionDelivered).toBe(true);
    await vi.waitFor(() => expect(loop!.pausedGrantRequestId()).toBeUndefined(), { timeout: 5_000 });
    abort.abort();
    await running;
    await scheduler.dispose();

    // The resumed prompt carries the decision and the resume instruction.
    const resumed = sessionPrompt.mock.calls[1]![1] as string;
    expect(resumed).toContain(decision);
    expect(resumed).toContain('answer to your grant request');
    expect(resumed).toContain('run_granted_command');
    // The decision skipped the per-author authority read (the server gated it).
    const authorityReads = execute.mock.calls.filter(([name]) => name === 'getRoomAuthority');
    expect(authorityReads).toHaveLength(1);
    expect(authorityReads[0]![1]).toEqual({ roomId: 'room-id', principalId: HUMAN });
    // The plain join line never became a turn.
    expect(sessionPrompt).toHaveBeenCalledTimes(2);
    // Both turns' ledger rows carry the requester by name.
    expect(activity.map((row) => (row.activity as Array<{ requestedBy: unknown }>)[0]!.requestedBy)).toEqual([
      { pubkey: HUMAN, name: 'Captain' },
      { pubkey: HUMAN, name: 'Captain' },
    ]);
    // The beeline-agent MCP mount carries the runner door.
    const servers = (sessionNew.mock.calls[0]![0] as { mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }> })
      .mcpServers;
    const agentServer = servers.find((server) => server.name === 'beeline-agent')!;
    expect(agentServer.env).toEqual(
      expect.arrayContaining([
        { name: 'BEELINE_GRANT_RUNNER_URL', value: 'http://127.0.0.1:1' },
        { name: 'BEELINE_GRANT_RUNNER_TOKEN', value: 'runner-token' },
      ]),
    );
  });
});
