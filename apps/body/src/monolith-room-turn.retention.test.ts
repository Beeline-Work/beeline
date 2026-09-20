import { commandFixtureApi } from './command-fixture.test-support.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';
import { parse as parseToml } from 'smol-toml';
import { turnTraceDirectory, type TurnTraceRecord } from './turn-trace.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

type AgentConfiguration = {
  commands: never[];
  yoloMode: boolean;
  model?: string;
  effort?: string;
  soul?: { name: string; instructions: string };
};

/**
 * Drive the real `MonolithRoomTurnLoop` over two asks, with the server's answer
 * to `getAgentConfiguration` under the test's control between them. Retention
 * is only a saving while what it retains is still current, so what this rig
 * reports is the one fact that settles it: how many harness processes were
 * spawned, and what each turn's own trace called its activation.
 */
async function twoTurns(
  configurations: readonly [AgentConfiguration, AgentConfiguration],
  systemPrompts: string[] = [],
  hooks?: {
    thirdTurn?: boolean;
    agentKind?: BodyConfig['agentKind'];
    beforeTurns?: (paths: { operatorHome: string; agentHomeRoot: string }) => Promise<void>;
    betweenTurns?: (paths: { operatorHome: string; agentHomeRoot: string }) => Promise<void>;
  },
): Promise<{
  activations: number;
  traces: TurnTraceRecord[];
  sessionPrompts: string[];
  mountedInventories: string[][];
}> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-retention-'));
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
  const traceDir = turnTraceDirectory(root);
  const config: BodyConfig = {
    agentBinary: '/fake-agent',
    agentKind: hooks?.agentKind ?? 'codex',
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
    turnTraceDir: traceDir,
  } as BodyConfig;
  const paths = {
    operatorHome: join(root, 'operator-home'),
    agentHomeRoot: join(root, 'agent-home'),
  };

  await hooks?.beforeTurns?.(paths);

  const asks = [
    { id: 'ask-1', body: 'first' },
    { id: 'ask-2', body: 'second' },
    ...(hooks?.thirdTurn ? [{ id: 'ask-3', body: 'third' }] : []),
  ];
  const receipts: Array<Record<string, unknown>> = [];
  const settled = () => receipts.filter((receipt) => receipt.status !== 'working').length;
  let bootstrapped = false;
  let delivered = 0;
  const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === 'getAgentConfiguration') return configurations[Math.min(delivered, 2) - 1 || 0];
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
      if (delivered < asks.length && settled() === delivered) {
        if (delivered === 1 && hooks?.betweenTurns) {
          await hooks.betweenTurns(paths);
        }
        const ask = asks[delivered]!;
        delivered += 1;
        return {
          items: [
            {
              id: ask.id,
              authorId: HUMAN,
              createdAt: delivered,
              type: 'message',
              body: ask.body,
              attachments: [],
            },
          ],
          cursor: ask.id,
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

  const mountedInventories: string[][] = [];
  let activations = 0;
  const acp = new AcpClient({ agentBinary: config.agentBinary, agentEnv: {} });
  vi.spyOn(acp, 'start').mockImplementation(async () => {
    activations += 1;
  });
  vi.spyOn(acp, 'sessionNew').mockImplementation(async (input: { systemPrompt?: string }) => {
    mountedInventories.push(
      config.agentKind === 'goose'
        ? Object.keys(
            parseYaml(await readFile(join(paths.agentHomeRoot, 'goose/config/config.yaml'), 'utf8'))
              .extensions ?? {},
          ).sort()
        : Object.keys(
            parseToml(
              await readFile(
                join(paths.agentHomeRoot, `${config.agentKind}/config.toml`),
                'utf8',
              ).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return '';
                throw error;
              }),
            ).mcp_servers ?? {},
          ).sort(),
    );
    systemPrompts.push(input.systemPrompt ?? '');
    return { sessionId: `room-session-${activations}`, raw: {} };
  });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp, 'setModel').mockResolvedValue(undefined);
  vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionPrompt').mockImplementation(async () => ({
    stopReason: 'end_turn',
    updates: [],
    agentText: 'Done.',
    toolCalls: [],
  }));

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
  await vi.waitFor(() => expect(settled()).toBe(asks.length), { timeout: 10_000 });
  abort.abort();
  await running.catch(() => undefined);
  await scheduler.dispose();

  const day = new Date().toISOString().slice(0, 10);
  const written = await readFile(join(traceDir, `turns-${day}.jsonl`), 'utf8');
  const traces = written
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as TurnTraceRecord);
  return { activations, traces, sessionPrompts: systemPrompts, mountedInventories };
}

const unchanged: AgentConfiguration = { commands: [], yoloMode: false };

describe('retained Room session', () => {
  it('answers a follow-up on the process the first turn spawned', async () => {
    const { activations, traces } = await twoTurns([unchanged, unchanged]);

    expect(activations).toBe(1);
    expect(traces.map((trace) => trace.attempts[0]!.activation)).toEqual(['cold', 'warm']);
  });

  it('discards the retained session the moment its configuration changes', async () => {
    for (const changed of [
      { ...unchanged, model: 'z-ai/glm-5.3-flash' },
      { ...unchanged, effort: 'high' },
      { ...unchanged, soul: { name: 'Otter', instructions: 'Answer as an otter.' } },
    ] satisfies AgentConfiguration[]) {
      const prompts: string[] = [];
      const { activations, traces } = await twoTurns([unchanged, changed], prompts);

      // A stale persona or model pin surviving a config change is a bug, not a
      // saving: the second turn spawns a second harness process.
      expect(activations, JSON.stringify(changed)).toBe(2);
      expect(traces.map((trace) => trace.attempts[0]!.activation)).toEqual(['cold', 'cold']);
      if (changed.soul) expect(prompts[1]).toContain('Answer as an otter.');
    }
  });

  it('discards the retained session when any imported MCP server is added', async () => {
    const { activations, traces, mountedInventories } = await twoTurns([unchanged, unchanged], [], {
      thirdTurn: true,
      betweenTurns: async ({ operatorHome }) => {
        await mkdir(join(operatorHome, '.codex'), { recursive: true });
        await writeFile(
          join(operatorHome, '.codex/config.toml'),
          '[mcp_servers.files]\ncommand = "files-mcp"\n',
        );
      },
    });

    expect(mountedInventories).toEqual([[], ['files']]);
    expect(activations).toBe(2);
    expect(traces.map((trace) => trace.attempts[0]!.activation)).toEqual(['cold', 'cold', 'warm']);
  });

  it.each(['codex', 'grok'] as const)(
    'restarts %s when an inline TOML server is removed',
    async (agentKind) => {
      const { activations, traces, mountedInventories } = await twoTurns(
        [unchanged, unchanged],
        [],
        {
          agentKind,
          thirdTurn: true,
          beforeTurns: async ({ operatorHome }) => {
            await mkdir(join(operatorHome, `.${agentKind}`), { recursive: true });
            await writeFile(
              join(operatorHome, `.${agentKind}/config.toml`),
              '[mcp_servers]\nfiles = { command = "files-mcp" }\n',
            );
          },
          betweenTurns: async ({ operatorHome }) => {
            await writeFile(join(operatorHome, `.${agentKind}/config.toml`), '');
          },
        },
      );
      expect(mountedInventories).toEqual([['files'], []]);
      expect(activations).toBe(2);
      expect(traces.map((trace) => trace.attempts[0]!.activation)).toEqual([
        'cold',
        'cold',
        'warm',
      ]);
    },
  );

  it.each([
    ['extensions: {}\n', 'extensions:\n    "files": {cmd: files-mcp}\n', [], ['files']],
    ["extensions:\n    'squire': {cmd: squire-mcp}\n", 'extensions: {}\n', ['squire'], []],
  ] as const)(
    'restarts Goose when its copied extension set changes',
    async (before, after, first, second) => {
      const { activations, traces, mountedInventories } = await twoTurns(
        [unchanged, unchanged],
        [],
        {
          agentKind: 'goose',
          thirdTurn: true,
          beforeTurns: async ({ operatorHome }) => {
            await mkdir(join(operatorHome, '.config/goose'), { recursive: true });
            await writeFile(join(operatorHome, '.config/goose/config.yaml'), before);
          },
          betweenTurns: async ({ operatorHome }) => {
            await writeFile(join(operatorHome, '.config/goose/config.yaml'), after);
          },
        },
      );
      expect(mountedInventories).toEqual([first, second]);
      expect(activations).toBe(2);
      expect(traces.map((trace) => trace.attempts[0]!.activation)).toEqual([
        'cold',
        'cold',
        'warm',
      ]);
    },
  );

  it('retains the replacement using the inventory preparation actually supplies', async () => {
    const { activations, traces, mountedInventories } = await twoTurns([unchanged, unchanged], [], {
      thirdTurn: true,
      betweenTurns: async ({ agentHomeRoot }) => {
        await mkdir(join(agentHomeRoot, 'codex'), { recursive: true });
        await writeFile(
          join(agentHomeRoot, 'codex/config.toml'),
          ['[mcp_servers.squire]', 'command = "npx"', 'args = ["-y", "@trusty-squire/mcp"]'].join(
            '\n',
          ),
        );
      },
    });
    expect(mountedInventories).toEqual([[], []]);
    expect(activations).toBe(2);
    expect(traces.map((trace) => trace.attempts[0]!.activation)).toEqual(['cold', 'cold', 'warm']);
  });
});
