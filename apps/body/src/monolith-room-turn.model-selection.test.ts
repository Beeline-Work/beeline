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
          { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'master' },
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

/**
 * Drive one real turn through `activate()` for a grok-style harness whose
 * launch-time model/effort are baked into `agentArgs` as `--model`/
 * `--reasoning-effort` flags, with no per-agent override and no persisted
 * `modelSelection` at all. Returns the exact argv handed to the harness
 * process, so a regression that clears both flags (rather than merely
 * failing to override them) is caught directly.
 */
async function activateGrokLaunchArgv(): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-grok-launch-'));
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
    agentBinary: '/opt/grok/grok',
    agentKind: 'custom',
    agentCommand: '/opt/grok/grok',
    agentArgs: ['agent', '--model', 'grok-4.5', '--reasoning-effort', 'high', 'stdio'],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    workspaceRoot: join(root, 'room'),
    autoApprovePermissions: true,
    accessPolicy: 'everyone',
    agentHomeRoot: join(root, 'agent-home'),
    operatorHome: join(root, 'operator-home'),
  } as BodyConfig;

  let bootstrapped = false;
  let delivered = false;
  const receipts: Array<Record<string, unknown>> = [];
  const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
    if (name === 'getRoomRepositoryState') return { resolution: 'none' };
    if (name === 'getWorkspaceRoster') {
      return {
        members: [
          { identityId: agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
          { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'master' },
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
  vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp, 'setModel').mockResolvedValue(undefined);
  vi.spyOn(acp, 'setConfigOption').mockResolvedValue(undefined);
  vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
    stopReason: 'end_turn',
    updates: [],
    agentText: 'hi',
    toolCalls: [],
  });

  let capturedArgs: string[] | undefined;
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
    createAcpClient: (options) => {
      capturedArgs = options.agentArgs;
      return acp;
    },
  });
  const running = loop.run();
  await vi.waitFor(() => expect(receipts.length).toBeGreaterThan(0), { timeout: 10_000 });
  abort.abort();
  await running.catch(() => undefined);
  await scheduler.dispose();
  return capturedArgs ?? [];
}

/**
 * Drive TWO real turns with a phone-side model/effort selection between them,
 * optionally delivering the wake the server's `config-changed` push produces
 * (`scheduler.suspendIdle()`, exactly what `RoomRuntimeCoordinator` runs when
 * `DaemonApiClient` reports the push). Returns how many sessions were opened
 * and what each turn applied via `setConfigOption`, so both directions of the
 * hot restart are observable: a change must retire the retained session (the
 * next turn cold-activates and re-reads the saved selection), and no wake
 * must not restart anything.
 */
async function activateAcrossSelectionChange(
  suspendBetween: boolean,
): Promise<{ sessionNewCalls: number; turns: Array<Array<[string, string]>> }> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-model-hot-restart-'));
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
  // The same object `config` holds, so the phone-side change is a mutation of
  // what the next activation reads — exactly what the server write does.
  const modelSelection: { model?: string; effort?: string } = {
    model: 'default-model',
    effort: 'medium',
  };
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
  let turn = 0;
  // Holds the second message until the wake has been delivered, so the race
  // between "turn 2 reused the warm session" and "the wake retired it" is
  // decided by the test, not the poll interval.
  let releaseSecond = () => {};
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const receipts: Array<Record<string, unknown>> = [];
  const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
    if (name === 'getRoomRepositoryState') return { resolution: 'none' };
    if (name === 'getWorkspaceRoster') {
      return {
        members: [
          { identityId: agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
          { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'master' },
        ],
      };
    }
    if (name === 'postAgentTurnReceipt') receipts.push(input);
    if (name === 'getRoomInbox') {
      if (!bootstrapped) {
        bootstrapped = true;
        return { items: [], cursor: 'latest' };
      }
      turn += 1;
      if (turn <= 2) {
        if (turn === 2) await secondGate;
        return {
          items: [
            {
              id: `ask-${turn}`,
              authorId: HUMAN,
              createdAt: turn,
              type: 'message',
              body: `hello ${turn}`,
              attachments: [],
            },
          ],
          cursor: `ask-${turn}`,
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
  const sessionNew = vi.spyOn(acp, 'sessionNew').mockResolvedValue({
    sessionId: 'room-session',
    raw: {
      configOptions: [
        {
          id: 'model-axis',
          category: 'model',
          currentValue: 'default-model',
          options: [{ id: 'default-model' }, { id: 'changed-model' }],
        },
        {
          id: 'effort-axis',
          category: 'effort',
          currentValue: 'medium',
          options: [{ id: 'medium' }, { id: 'high' }],
        },
      ],
    },
  });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp, 'setModel').mockResolvedValue(undefined);
  const configCalls: Array<[string, string]> = [];
  vi.spyOn(acp, 'setConfigOption').mockImplementation(async (_sid, configId, value) => {
    configCalls.push([configId, value]);
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
  try {
    await vi.waitFor(
      () => expect(receipts.length).toBeGreaterThanOrEqual(1),
      { timeout: 10_000 },
    );
    if (suspendBetween) {
      // Let the first turn fully settle (its run must leave the scheduler's
      // busy set) before the phone writes a new selection and the
      // `config-changed` wake retires every retained session.
      await vi.waitFor(() => expect(scheduler.snapshot().busy).toBe(0), { timeout: 10_000 });
      modelSelection.model = 'changed-model';
      modelSelection.effort = 'high';
      await scheduler.suspendIdle();
    }
    releaseSecond();
    await vi.waitFor(
      () => expect(receipts.length).toBeGreaterThanOrEqual(2),
      { timeout: 10_000 },
    );
  } finally {
    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();
  }
  return { sessionNewCalls: sessionNew.mock.calls.length, configCalls };
}

describe('Room session activation model/effort selection', () => {  it('falls back to the persisted effort when only the model is overridden', async () => {
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

  it('keeps a grok harness launch-time model and effort flags when nothing overrides them', async () => {
    // The per-axis merge must fall back to `undefined` (not `{model: undefined,
    // effort: undefined}`) when neither the per-agent config nor the persisted
    // modelSelection selects anything: an always-truthy selection object made
    // `agentArgsWithModelSelection` strip grok's baked-in --model/--reasoning-effort
    // launch flags without anything to splice back in, silently clearing both.
    const argv = await activateGrokLaunchArgv();

    expect(argv).toEqual([
      'agent',
      '--model',
      'grok-4.5',
      '--reasoning-effort',
      'high',
      'stdio',
    ]);
  });

  it('hot-restarts: the config-change wake retires the session and the next turn re-reads the selection', async () => {
    const { sessionNewCalls, configCalls } = await activateAcrossSelectionChange(true);

    expect(sessionNewCalls).toBe(2);
    // The first activation applied the selection as it was, and the second —
    // after the wake retired the warm session — applied the SAVED new one,
    // the same way session start reads it.
    expect(configCalls.slice(0, 2)).toEqual([
      ['model-axis', 'default-model'],
      ['effort-axis', 'medium'],
    ]);
    expect(configCalls.slice(2)).toEqual([
      ['model-axis', 'changed-model'],
      ['effort-axis', 'high'],
    ]);
  });

  it('keeps one session across two turns when no selection change arrives', async () => {
    const { sessionNewCalls, configCalls } = await activateAcrossSelectionChange(false);

    expect(sessionNewCalls).toBe(1);
    expect(configCalls).toEqual([
      ['model-axis', 'default-model'],
      ['effort-axis', 'medium'],
    ]);
  });
});
