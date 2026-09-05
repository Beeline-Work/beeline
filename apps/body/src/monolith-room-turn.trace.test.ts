import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';
import { turnTraceDirectory, type TurnTraceRecord } from './turn-trace.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

interface Ask {
  id: string;
  body: string;
}

/**
 * Drive the real `MonolithRoomTurnLoop` — real scheduler, real trace wiring —
 * over a scripted harness, and read back the operator artifact it wrote.
 */
async function runTurns(options: {
  asks: readonly Ask[];
  agentCommand?: string;
  agentKind?: string;
  advertisedModel?: string;
  configOverrides?: Partial<BodyConfig>;
  prompt: (input: {
    attempt: number;
    ask: Ask;
    agentHomeRoot: string;
    onChunk?: (delta: string, full: string) => void;
    onToolCalls?: (calls: readonly { id?: string; status?: string }[]) => void;
  }) => Promise<Awaited<ReturnType<AcpClient['sessionPrompt']>>>;
}): Promise<{
  traces: TurnTraceRecord[];
  operations: string[];
  posted: Array<Record<string, unknown>>;
  activations: number;
}> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-trace-'));
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
  } as unknown as AgentRuntimeRecord;
  const traceDir = turnTraceDirectory(root);
  const config: BodyConfig = {
    agentBinary: options.agentCommand ?? '/fake-agent',
    agentKind: options.agentKind ?? 'codex',
    agentCommand: options.agentCommand ?? '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    workspaceRoot: join(root, 'room'),
    autoApprovePermissions: true,
    accessPolicy: 'everyone',
    agentHomeRoot,
    operatorHome: join(root, 'operator-home'),
    turnTraceDir: traceDir,
    ...options.configOverrides,
  } as BodyConfig;

  const operations: string[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const receipts: Array<Record<string, unknown>> = [];
  const settled = () => receipts.filter((receipt) => receipt.status !== 'working').length;
  let bootstrapped = false;
  let delivered = 0;
  let currentAsk: Ask = options.asks[0]!;
  const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
    operations.push(name);
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
    if (name === 'postRoomMessage') posted.push(input);
    if (name === 'postAgentTurnReceipt') receipts.push(input);
    if (name === 'getRoomInbox') {
      // One ask at a time, released only once the previous turn settled, so
      // each measurement is one turn and not a queue behind another.
      if (!bootstrapped) {
        bootstrapped = true;
        return { items: [], cursor: 'latest' };
      }
      if (delivered < options.asks.length && settled() === delivered) {
        const ask = options.asks[delivered]!;
        delivered += 1;
        currentAsk = ask;
        return {
          items: [
            {
              id: ask.id,
              authorId: HUMAN,
              createdAt: delivered,
              type: 'message',
              body: ask.body,
              mentionIds: [agent.publicKey],
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

  const acp = new AcpClient({ agentBinary: config.agentBinary, agentEnv: {} });
  let activations = 0;
  vi.spyOn(acp, 'start').mockImplementation(async () => {
    activations += 1;
  });
  vi.spyOn(acp, 'sessionNew').mockResolvedValue({
    sessionId: `room-session-${activations}`,
    raw: options.advertisedModel
      ? {
          models: {
            availableModels: [{ modelId: options.advertisedModel }],
            currentModelId: options.advertisedModel,
          },
        }
      : {},
  });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp, 'setModel').mockResolvedValue(undefined);
  let attempt = 0;
  vi.spyOn(acp, 'sessionPrompt').mockImplementation(
    (
      _sessionId: string,
      _prompt: unknown,
      _timeout?: number,
      onChunk?: (delta: string, full: string) => void,
      _onActivity?: unknown,
      onToolCalls?: (calls: readonly { id?: string; status?: string }[]) => void,
    ) => {
      attempt += 1;
      return options.prompt({
        attempt,
        ask: currentAsk,
        agentHomeRoot,
        ...(onChunk ? { onChunk } : {}),
        ...(onToolCalls ? { onToolCalls } : {}),
      });
    },
  );

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
    pollMs: 5,
    createAcpClient: () => acp,
  });
  const running = loop.run();
  await vi.waitFor(() => expect(settled()).toBe(options.asks.length), { timeout: 10_000 });
  abort.abort();
  await running.catch(() => undefined);
  await scheduler.dispose();

  const day = new Date().toISOString().slice(0, 10);
  const written = await readFile(join(traceDir, `turns-${day}.jsonl`), 'utf8');
  const traces = written
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as TurnTraceRecord);
  return { traces, operations, posted, activations };
}

const answer = (text: string) => ({
  stopReason: 'end_turn',
  updates: [],
  agentText: text,
  toolCalls: [],
});

describe('Room turn phase trace', () => {
  it('records a cold turn and the warm turn after it as separate timelines', async () => {
    const { traces, posted, activations } = await runTurns({
      asks: [
        { id: 'ask-1', body: 'first' },
        { id: 'ask-2', body: 'second' },
      ],
      prompt: async ({ ask, onChunk, onToolCalls }) => {
        onToolCalls?.([{ id: 'read-1', status: 'in_progress' }]);
        onChunk?.('Here', 'Here');
        onToolCalls?.([{ id: 'read-1', status: 'completed' }]);
        onChunk?.(' you go', 'Here you go');
        return answer(`Here you go for ${ask.id}`);
      },
    });

    expect(traces.map((trace) => trace.requestId)).toEqual(['ask-1', 'ask-2']);
    expect(traces.every((trace) => trace.outcome === 'complete')).toBe(true);
    // The harness was spawned once: the second turn reused the live session.
    expect(activations).toBe(1);
    expect(traces[0]!.attempts[0]!.activation).toBe('cold');
    expect(traces[1]!.attempts[0]!.activation).toBe('warm');
    for (const trace of traces) {
      const phases = trace.attempts[0]!.phases;
      // A complete timeline separates queue, activation, model and publish.
      expect(Object.keys(phases)).toEqual(
        expect.arrayContaining([
          'queue-wait',
          'context-fetch',
          'first-model-output',
          'model-stream',
          'tool-work',
          'publish',
        ]),
      );
      expect(trace.scheduler.atQueue).toBeDefined();
      expect(trace.scheduler.atAdmission).toBeDefined();
      expect(trace.attempts[0]!.toolCalls).toBe(1);
    }
    // Only the cold turn paid for an activation.
    expect(traces[0]!.attempts[0]!.phases.activation).toBeGreaterThanOrEqual(0);
    expect(traces[1]!.attempts[0]!.phases.activation).toBeUndefined();
    expect(posted.map((message) => message.text)).toEqual([
      'Here you go for ask-1',
      'Here you go for ask-2',
    ]);
  });

  it('gives a provider retry its own attempt with its own activation', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'beeline-trace-routing-'));
    roots.push(cacheRoot);
    await writeFile(
      join(cacheRoot, 'z-ai_glm-5.3-flash.json'),
      JSON.stringify({
        model: 'z-ai/glm-5.3-flash',
        fetchedAt: Date.now(),
        providers: ['venice', 'phala'],
        bar: 98,
        input: null,
      }),
    );
    await writeFile(
      join(cacheRoot, 'z-ai_glm-5.3-flash.probe.json'),
      JSON.stringify({
        model: 'z-ai/glm-5.3-flash',
        fetchedAt: Date.now(),
        answered: [
          { provider: 'venice', latencyMs: 700 },
          { provider: 'phala', latencyMs: 4700 },
        ],
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { traces, posted } = await runTurns({
      asks: [{ id: 'ask-1', body: 'first' }],
      agentCommand: '/opt/harness/pi-acp',
      agentKind: 'pi',
      advertisedModel: 'z-ai/glm-5.3-flash',
      configOverrides: {
        agentEnv: { OPENROUTER_API_KEY: 'k' },
        openRouterRoutingCacheDir: cacheRoot,
        modelSelection: { model: 'z-ai/glm-5.3-flash' },
      } as Partial<BodyConfig>,
      prompt: async ({ attempt, agentHomeRoot, onChunk }) => {
        // Attempt one is the C92 failure: 200, tool-enabled, and silent.
        const dir = join(agentHomeRoot, 'pi', 'sessions', '--room--');
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, `2026_room-session-${attempt}.jsonl`),
          [
            JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
            JSON.stringify({
              type: 'message',
              message: { role: 'assistant', content: [], stopReason: 'end_turn' },
            }),
          ].join('\n'),
        );
        if (attempt === 1) return answer('');
        onChunk?.('Sorry', 'Sorry');
        return answer('Sorry about that.');
      },
    });
    warn.mockRestore();

    expect(traces).toHaveLength(1);
    const [trace] = traces;
    expect(trace!.attempts.map((a) => a.attemptId)).toEqual(['ask-1#1', 'ask-1#2']);
    expect(trace!.attempts[0]!.activation).toBe('cold');
    // The retry re-pins to one named provider and re-activates: its own cold spawn.
    expect(trace!.attempts[1]).toMatchObject({ activation: 'cold', provider: 'phala' });
    expect(trace!.attempts[1]!.retryReason).toMatch(/no answer text|no text/);
    expect(trace!.attempts[1]!.phases.activation).toBeGreaterThanOrEqual(0);
    expect(trace!.attempts[1]!.phases.publish).toBeGreaterThanOrEqual(0);
    expect(posted.map((message) => message.text)).toEqual(['Sorry about that.']);
  });

  it('adds nothing to the Room: the same operations run with tracing on and off', async () => {
    const script = {
      asks: [{ id: 'ask-1', body: 'first' }],
      prompt: async ({ onChunk }: { onChunk?: (delta: string, full: string) => void }) => {
        onChunk?.('Hi', 'Hi');
        return answer('Hi');
      },
    };
    const traced = await runTurns(script as Parameters<typeof runTurns>[0]);
    const untraced = await runTurns({
      ...(script as Parameters<typeof runTurns>[0]),
      configOverrides: { turnTraceDir: undefined } as Partial<BodyConfig>,
    }).catch((error: unknown) => error);

    // With no trace directory nothing is written at all — the read throws.
    expect(String(untraced)).toMatch(/ENOENT/);
    // And with one, the Room saw only the operations it always sees.
    expect(new Set(traced.operations)).toEqual(
      new Set([
        'getRoomInbox',
        'getRoomAuthority',
        'getWorkspaceRoster',
        'postAgentActivity',
        'getAgentConfiguration',
        'getRoomRepositoryState',
        'getRoomConversation',
        'postAgentDraft',
        'postRoomMessage',
        'retractAgentLiveOutput',
        'postAgentTurnReceipt',
        'postAgentPresence',
      ]),
    );
    expect(traced.posted).toHaveLength(1);
  });
});
