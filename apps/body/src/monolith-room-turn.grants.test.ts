import { commandFixtureApi } from './command-fixture.test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import { AcpClient } from './acp.js';
import { credentialMaskPaths } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { GrantCommandRunner, type GrantRunnerRoom } from './grant-runner.js';
import {
  MonolithRoomTurnLoop,
  approvedDeviceGrant,
  deviceGrantResumePrompt,
  pendingGrantToolCall,
  resumePrompt,
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

  it('spots the request_grant call that paused the turn from its reply text', () => {
    expect(
      pendingGrantToolCall({
        title: 'mcp__beeline-agent__request_grant',
        content: [{ type: 'text', text: 'pending, card posted: run fly deploy [grant g-1]. …' }],
      }),
    ).toBe(true);
    expect(
      pendingGrantToolCall({
        title: 'beeline-agent.request_grant',
        content: 'approved (yolo): run npm test',
      }),
    ).toBe(false);
    expect(
      pendingGrantToolCall({
        title: 'mcp__beeline-agent__open_corner',
        content: 'pending, card posted',
      }),
    ).toBe(false);
  });

  it('tells an approved MCP grant resume that the route is mounted now', () => {
    const answer = formatGrantDecisionLine({
      deciderName: 'Captain',
      decision: 'always',
      kind: 'mcp',
      target: 'squire',
    });

    expect(resumePrompt({ body: answer, systemEvent: { kind: 'grant-decided' } })).toContain(
      'The approved squire route is mounted in this session',
    );
    expect(resumePrompt({ body: answer, systemEvent: { kind: 'grant-decided' } })).toContain(
      'do not restart, schedule another turn, or request the route again',
    );
  });
});

describe('device grant continuation', () => {
  const approved =
    'approved: use /dev/kvm [grant g-9]. A running session cannot add a device, so end your turn now with one short line; this same turn continues straight away in a session that has /dev/kvm. Do not ask anyone to restart.';

  it('spots an instantly approved device grant from its reply text', () => {
    expect(
      approvedDeviceGrant([
        { title: 'mcp__beeline-agent__request_grant', content: [{ type: 'text', text: approved }] },
      ]),
    ).toBe('/dev/kvm');
    expect(
      approvedDeviceGrant([
        {
          title: 'mcp__beeline-agent__request_grant',
          content: 'pending, card posted: use /dev/kvm [grant g-9].',
        },
        {
          title: 'mcp__beeline-agent__request_grant',
          content:
            'approved: use kvm [grant g-8], but only device nodes under /dev/ are added to your session, so nothing was added.',
        },
        { title: 'mcp__beeline-agent__open_corner', content: approved },
      ]),
    ).toBeUndefined();
  });

  it('tells the continued turn the device is present and not to restart', () => {
    const prompt = deviceGrantResumePrompt('/dev/kvm', 'Got /dev/kvm; continuing.');
    expect(prompt).toContain('/dev/kvm is in this session now');
    expect(prompt).toContain('Your reply just before this was: Got /dev/kvm; continuing.');
    expect(prompt).toContain('Do not request it again or ask anyone to restart');
  });

  it('tells a card-approved device resume that the device is in this session', () => {
    const answer = formatGrantDecisionLine({
      deciderName: 'Captain',
      decision: 'once',
      kind: 'device',
      target: '/dev/kvm',
    });
    const prompt = resumePrompt({ body: answer, systemEvent: { kind: 'grant-decided' } });
    expect(prompt).toContain('The approved device /dev/kvm is in this session');
    expect(prompt).toContain('do not restart, schedule another turn, or request the device again');
  });

  it('continues the same Room turn in a new session that mounts the granted device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-room-device-'));
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
      bwrapPath: '/usr/bin/bwrap',
    } as BodyConfig;
    let inboxReads = 0;
    let granted = false;
    const execute = vi.fn(async (name: string, _input: Record<string, unknown>) => {
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
        return {
          grants: granted
            ? [{ grantId: 'g-9', kind: 'device', target: '/dev/ttyUSB0', status: 'approved' }]
            : [],
        };
      }
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
                body: 'Flash the board on the serial port',
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
    const spawns: Array<ConstructorParameters<typeof AcpClient>[0]> = [];
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
    const sessionNew = vi
      .spyOn(acp, 'sessionNew')
      .mockResolvedValueOnce({ sessionId: 'session-1', raw: {} })
      .mockResolvedValueOnce({ sessionId: 'session-2', raw: {} });
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    const sessionPrompt = vi
      .spyOn(acp, 'sessionPrompt')
      .mockImplementationOnce(async () => {
        granted = true;
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'Got the serial port; continuing.',
          toolCalls: [
            {
              id: 'call-1',
              title: 'mcp__beeline-agent__request_grant',
              status: 'completed',
              content: [
                {
                  type: 'text',
                  text: approved.replaceAll('/dev/kvm', '/dev/ttyUSB0'),
                },
              ],
            },
          ],
        };
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Flashed the board.',
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
      createAcpClient: (options) => {
        spawns.push(options);
        return acp;
      },
    });
    const running = loop.run();
    await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    await vi.waitFor(
      () =>
        expect(
          execute.mock.calls.some(
            ([name, input]) =>
              name === 'postRoomMessage' && JSON.stringify(input).includes('Flashed the board.'),
          ),
        ).toBe(true),
      { timeout: 5_000 },
    );
    abort.abort();
    await running;
    await scheduler.dispose();

    // One inbox item, two prompts: the same turn ran again in a fresh session.
    expect(sessionNew).toHaveBeenCalledTimes(2);
    expect(sessionPrompt.mock.calls[1]![0]).toBe('session-2');
    const continued = sessionPrompt.mock.calls[1]![1] as string;
    expect(continued).toContain('/dev/ttyUSB0 is in this session now');
    expect(continued).toContain('Flash the board on the serial port');
    // Only the second session's sandbox binds the granted device.
    expect(spawns).toHaveLength(2);
    const argv = (spawn: ConstructorParameters<typeof AcpClient>[0]) =>
      [spawn.agentCommand ?? spawn.agentBinary, ...(spawn.agentArgs ?? [])].join(' ');
    expect(argv(spawns[0]!)).not.toContain('/dev/ttyUSB0');
    expect(argv(spawns[1]!)).toContain('--dev-bind-try /dev/ttyUSB0 /dev/ttyUSB0');
  });
});

describe('Room turn paused on a grant card', () => {
  it.each(['once', 'deny'] as const)('clears the pending approval after a %s decision resumes the turn', async (grantDecision) => {
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
      bwrapPath: '/usr/bin/bwrap',
    } as BodyConfig;
    const decision = formatGrantDecisionLine({
      deciderName: 'Captain',
      decision: grantDecision,
      kind: 'command',
      target: 'fly deploy -a preview --with FLY_TOKEN',
    });
    let inboxReads = 0;
    let connectorDelivered = false;
    let pendingAfterConnector = false;
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
                attachments: [],
              },
            ],
            cursor: 'ask-1',
          };
        }
        if (!connectorDelivered && loop?.pausedGrantRequestId() === 'ask-1') {
          connectorDelivered = true;
          return {
            items: [{
              id: 'unrelated-connector',
              fixtureCommandAction: 'resume',
              fixtureTurnRequestId: 'ask-1',
              authorId: HUMAN,
              createdAt: 2,
              type: 'system',
              body: 'Captain added an unrelated connector',
              systemEvent: { kind: 'connector-offer-decided' },
              attachments: [],
            }],
            cursor: 'unrelated-connector',
          };
        }
        // An unrelated connector answer must not release this grant's pending hold.
        if (connectorDelivered && !decisionDelivered && sessionPrompt.mock.calls.length >= 2) {
          pendingAfterConnector = loop?.pausedGrantRequestId() === 'ask-1';
          decisionDelivered = true;
          return {
            items: [
              // A plain system line never wakes the agent…
              {
                id: 'join-1',
                fixtureCommand: false,
                authorId: HUMAN,
                createdAt: 3,
                type: 'system',
                body: 'member joined',
                attachments: [],
              },
              // …the owner's decision does, without an authority read.
              {
                id: 'decision-1',
                fixtureCommandAction: 'resume',
                fixtureTurnRequestId: 'ask-1',
                authorId: HUMAN,
                createdAt: 4,
                type: 'system',
                body: decision,
                systemEvent: { kind: 'grant-decided' },
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
    const sessionNew = vi
      .spyOn(acp, 'sessionNew')
      .mockResolvedValue({ sessionId: 'room-session', raw: {} });
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
            content: [
              {
                type: 'text',
                text: 'pending, card posted: run fly deploy -a preview [grant g-1].',
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'The other connector was added.',
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: grantDecision === 'deny' ? 'Permission declined; no command was run.' : 'Deployed the preview.',
        toolCalls: [],
      });
    // C94: what the Room registers is what the runner enforces, so record it.
    const registered: GrantRunnerRoom[] = [];
    class RecordingRunner extends GrantCommandRunner {
      override register(roomId: string, room: GrantRunnerRoom): void {
        registered.push(room);
        super.register(roomId, room);
      }
    }
    const grantRunner = new RecordingRunner({
      api,
      agentId: agent.publicKey,
      resolveSecret: async () => undefined,
    });
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const abort = new AbortController();
    loop = new MonolithRoomTurnLoop({
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
      grantRunner,
      grantRunnerEndpoint: { url: 'http://127.0.0.1:1', token: 'runner-token' },
    });
    const running = loop.run();
    await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalledTimes(3), { timeout: 5_000 });
    expect(pendingAfterConnector).toBe(true);
    expect(decisionDelivered).toBe(true);
    await vi.waitFor(() => expect(loop!.pausedGrantRequestId()).toBeUndefined(), {
      timeout: 5_000,
    });
    abort.abort();
    await running;
    await scheduler.dispose();

    // The resumed prompt carries the decision and the resume instruction.
    const resumed = sessionPrompt.mock.calls[2]![1] as string;
    expect(resumed).toContain(decision);
    expect(resumed).toContain('Resume the paused turn');

    // The decision skipped the per-author authority read (the server gated it).
    const authorityReads = execute.mock.calls.filter(([name]) => name === 'getRoomAuthority');
    expect(authorityReads).toHaveLength(0);
    // The plain join line never became a turn.
    expect(sessionPrompt).toHaveBeenCalledTimes(3);
    // Both turns' ledger rows carry the requester by name.
    expect(
      activity.map((row) => (row.activity as Array<{ requestedBy: unknown }>)[0]!.requestedBy),
    ).toEqual([
      { pubkey: HUMAN, name: 'Captain' },
      { pubkey: HUMAN, name: 'Captain' },
      { pubkey: HUMAN, name: 'Captain' },
    ]);
    // A Room registers itself as the surface with no host-command capability,
    // and hands over the bwrap that keeps its read-only promise for grants.
    expect(registered).toHaveLength(1);
    const policy = registered[0]!.writePolicy();
    expect(policy.surface).toBe('room');
    expect(policy.bwrapPath).toBe(config.bwrapPath);
    expect(policy.maskPaths).toEqual(
      credentialMaskPaths(config.sandboxMaskPaths, config.operatorHome ?? homedir()),
    );
    // The beeline-agent MCP mount carries the runner door.
    const servers = (
      sessionNew.mock.calls[0]![0] as {
        mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }>;
      }
    ).mcpServers;
    const agentServer = servers.find((server) => server.name === 'beeline-agent')!;
    expect(agentServer.env).toEqual(
      expect.arrayContaining([
        { name: 'BEELINE_GRANT_RUNNER_URL', value: 'http://127.0.0.1:1' },
        { name: 'BEELINE_GRANT_RUNNER_TOKEN', value: 'runner-token' },
      ]),
    );
  });
});
