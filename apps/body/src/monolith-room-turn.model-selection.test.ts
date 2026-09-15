import { commandFixtureApi } from './command-fixture.test-support.js';
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

/**
 * Drive one real turn through `MonolithRoomTurnLoop.activate()` with a
 * per-agent `getAgentConfiguration` override on only one axis, a persisted
 * `modelSelection` default on both, and a fake harness that advertises a
 * settable `model` and `effort` axis. Returns exactly what got applied to
 * the session via `setConfigOption`.
 */
async function activateWith(
  configuration: { model?: string; effort?: string },
  modelSelection: { model?: string; effort?: string },
): Promise<Array<[string, string]>> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-model-selection-'));
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
    modelSelection,
  } as BodyConfig;

  let bootstrapped = false;
  let delivered = false;
  const receipts: Array<Record<string, unknown>> = [];
  const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false, ...configuration };
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
      if (!bootstrapped) {
        bootstrapped = true;
        return { items: [], cursor: 'latest' };
      }
      if (!delivered) {
        delivered = true;
        return {
          items: [
            {
              id: 'ask-1',
              authorId: HUMAN,
              createdAt: 1,
              type: 'message',
              body: 'hello',
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

  const acp = new AcpClient({ agentBinary: config.agentBinary, agentEnv: {} });
  vi.spyOn(acp, 'start').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionNew').mockResolvedValue({
    sessionId: 'room-session',
    raw: {
      configOptions: [
        {
          id: 'model-axis',
          category: 'model',
          currentValue: 'default-model',
          options: [{ id: 'default-model' }, { id: 'override-model' }],
        },
        {
          id: 'effort-axis',
          category: 'effort',
          currentValue: 'medium',
          options: [{ id: 'high' }, { id: 'medium' }, { id: 'low' }],
        },
      ],
    },
  });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp, 'setModel').mockResolvedValue(undefined);
  const setConfigCalls: Array<[string, string]> = [];
  vi.spyOn(acp, 'setConfigOption').mockImplementation(async (_sid, configId, value) => {
    setConfigCalls.push([configId, value]);
  });
  vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
    stopReason: 'end_turn',
    updates: [],
    agentText: 'hi',
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
    pollMs: 5,
    createAcpClient: () => acp,
  });
  const running = loop.run();
  await vi.waitFor(() => expect(receipts.length).toBeGreaterThan(0), { timeout: 10_000 });
  abort.abort();
  await running.catch(() => undefined);
  await scheduler.dispose();
  return setConfigCalls;
}

describe('Room session activation model/effort selection', () => {
  it('falls back to the persisted effort when only the model is overridden', async () => {
    const calls = await activateWith(
      { model: 'override-model' },
      { model: 'default-model', effort: 'high' },
    );

    // Overriding one axis used to drop the other entirely instead of
    // falling back to the persisted default for it: the harness would
    // launch with no effort selection at all rather than "high".
    expect(calls).toContainEqual(['model-axis', 'override-model']);
    expect(calls).toContainEqual(['effort-axis', 'high']);
  });

  it('falls back to the persisted model when only the effort is overridden', async () => {
    const calls = await activateWith(
      { effort: 'low' },
      { model: 'default-model', effort: 'high' },
    );

    expect(calls).toContainEqual(['model-axis', 'default-model']);
    expect(calls).toContainEqual(['effort-axis', 'low']);
  });
});
