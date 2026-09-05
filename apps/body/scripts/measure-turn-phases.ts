/**
 * Measure where a turn's time goes, through the real turn loop.
 *
 * This drives the shipped `MonolithRoomTurnLoop` — the real `SessionScheduler`,
 * the real ACP client, the real `turn-trace.ts` wiring — and prints the
 * timelines it writes to the operator artifact. Nothing here reimplements the
 * measurement; it only supplies the two things a workstation does not have:
 *
 *   - a monolith server (the `DaemonApiClient` is stubbed, so `context-fetch`
 *     measures only the local attachment work, not a real server round trip);
 *   - a way to summon a C92 empty completion on demand (the retry scenario
 *     scripts the harness; the loop, the re-pin and the trace are all real).
 *
 * Scenarios:
 *   live   cold + warm turns against a REAL harness and a REAL model.
 *   retry  a real re-pin over a scripted empty completion.
 *   gap    the same two turns with a real WAIT between them, so the follow-up
 *          is one a five-minute idle window would have made cold. Pass
 *          `--idle-ms 300000` to measure the window this repo used to ship.
 *   ceiling  N Rooms' worth of REAL harness processes held by the real
 *          scheduler, so the resident cost of retention and the ceiling that
 *          bounds it are both a number.
 *
 * Usage:
 *   node --import tsx apps/body/scripts/measure-turn-phases.ts live [--harness goose]
 *   node --import tsx apps/body/scripts/measure-turn-phases.ts retry
 *   node --import tsx apps/body/scripts/measure-turn-phases.ts gap [--harness claude] \
 *     [--gap-ms 330000] [--idle-ms 300000]
 *   node --import tsx apps/body/scripts/measure-turn-phases.ts ceiling [--harness claude] \
 *     [--rooms 5] [--max-warm 2]
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../src/acp.js';
import type { AgentKind } from '../src/agent-command.js';
import { prepareRoomAgentHome } from '../src/agent-home.js';
import type { BodyConfig } from '../src/config.js';
import type { DaemonApiClient } from '../src/daemon-api-client.js';
import { MonolithRoomTurnLoop } from '../src/monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from '../src/runtime.js';
import { DEFAULT_MAX_WARM_SESSIONS, SessionScheduler } from '../src/session-scheduler.js';
import {
  formatDuration,
  TURN_PHASES,
  turnTraceDirectory,
  type TurnTraceRecord,
} from '../src/turn-trace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const READ_ONLY_MCP = resolve(HERE, '..', 'dist', 'read-only-mcp.js');
const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);

interface Ask {
  id: string;
  body: string;
}

interface Rig {
  traces: TurnTraceRecord[];
  posted: string[];
  /** What the daemon was holding resident while the gap was open. */
  residentDuringGap?: Resident;
}

/** Live descendant processes of this measurement run, and what they cost. */
interface Resident {
  processes: number;
  rssMb: number;
  commands: string[];
}

/**
 * The real resident cost, read from the OS rather than inferred. Every ACP
 * harness and every MCP server a retained session holds open is a descendant
 * of this process, so the process tree IS the ceiling made visible.
 */
function residentProcesses(): Resident {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map(([pid, ppid, rss, ...comm]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      comm: comm.join(' '),
    }));
  const children = new Map<number, typeof rows>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const found: typeof rows = [];
  const queue = [process.pid];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return {
    processes: found.length,
    rssMb: Math.round(found.reduce((total, row) => total + row.rssKb, 0) / 1024),
    commands: [...new Set(found.map((row) => row.comm))].sort(),
  };
}

async function runRig(options: {
  asks: readonly Ask[];
  agentKind: string;
  agentCommand: string;
  agentArgs: string[];
  modelSelection?: { model?: string; effort?: string };
  configOverrides?: Partial<BodyConfig>;
  /** Occupy the scheduler's only slot for this long, so turn one really queues. */
  holdSlotMs?: number;
  /** Real wall-clock silence between the first turn and the follow-up. */
  gapMs?: number;
  /** Retention window under test. Omit for the shipped default. */
  idleMs?: number;
  /** Present only for the scripted-harness scenario. */
  fakePrompt?: (attempt: number) => Promise<{
    stopReason: string;
    updates: unknown[];
    agentText: string;
    toolCalls: unknown[];
  }>;
}): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-measure-'));
  const identity = identityFromKey(AGENT_HEX, 'Bee');
  const runtime = {
    agent: {
      name: 'Bee',
      publicKey: identity.publicKey,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    },
    rooms: [],
    supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
  } as unknown as AgentRuntimeRecord;
  const traceDir = turnTraceDirectory(root);
  const cwd = join(root, 'room');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, 'README.md'), '# Measurement room\n\nA repository checkout stand-in.\n');
  const config = {
    agentBinary: options.agentCommand,
    agentKind: options.agentKind,
    agentCommand: options.agentCommand,
    agentArgs: options.agentArgs,
    mcpBinary: 'node',
    readonlyMcpCommand: 'node',
    readonlyMcpArgs: [READ_ONLY_MCP],
    agentEnv: {},
    workspaceRoot: cwd,
    autoApprovePermissions: false,
    accessPolicy: 'everyone',
    agentHomeRoot: join(root, 'agent-home'),
    operatorHome: process.env.HOME,
    turnTraceDir: traceDir,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...options.configOverrides,
  } as unknown as BodyConfig;

  const posted: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const settled = () => receipts.filter((receipt) => receipt.status !== 'working').length;
  let bootstrapped = false;
  let delivered = 0;
  let quietSince: number | undefined;
  const execute = async (name: string, input: Record<string, unknown>) => {
    if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
    if (name === 'getRoomRepositoryState') return { resolution: 'none' };
    if (name === 'getWorkspaceRoster') {
      return {
        members: [
          { identityId: runtime.agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
          { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'owner' },
        ],
      };
    }
    if (name === 'postRoomMessage') posted.push(String(input.text));
    if (name === 'postAgentTurnReceipt') receipts.push(input);
    if (name === 'getRoomInbox') {
      if (!bootstrapped) {
        bootstrapped = true;
        return { items: [], cursor: 'latest' };
      }
      if (delivered < options.asks.length && settled() === delivered) {
        // A gap is silence the daemon actually lived through, not a fast-forward.
        if (delivered > 0 && options.gapMs) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince < options.gapMs) return { items: [], cursor: 'latest' };
        }
        const ask = options.asks[delivered]!;
        delivered += 1;
        return {
          items: [
            {
              id: ask.id,
              authorId: HUMAN,
              createdAt: delivered,
              type: 'message',
              body: ask.body,
              mentionIds: [runtime.agent.publicKey],
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
  };
  const api = {
    execute,
    connection: () => ({
      baseUrl: 'https://server.example',
      daemonToken: 'daemon-token',
      agentId: runtime.agent.publicKey,
    }),
  } as unknown as DaemonApiClient;

  // Capacity one, so the held slot below is a real capacity wait.
  const scheduler = new SessionScheduler({
    maxLiveSessions: 1,
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
  });
  // Attempts count across clients: a provider re-pin spawns a NEW client.
  let attempt = 0;
  const abort = new AbortController();
  const loop = new MonolithRoomTurnLoop({
    roomId: 'measure-room',
    workspaceId: 'measure-workspace',
    cwd,
    runtime,
    config,
    api,
    scheduler,
    health: { poll: () => undefined, failure: () => undefined, presence: () => undefined },
    signal: abort.signal,
    pollMs: 200,
    ...(options.fakePrompt
      ? {
          createAcpClient: (clientOptions: ConstructorParameters<typeof AcpClient>[0]) => {
            const client = new AcpClient(clientOptions);
            Object.defineProperty(client, 'isAlive', { get: () => true });
            Object.assign(client, {
              start: async () => undefined,
              sessionNew: async () => ({
                sessionId: 'measure-session',
                raw: options.modelSelection?.model
                  ? {
                      models: {
                        availableModels: [{ modelId: options.modelSelection.model }],
                        currentModelId: options.modelSelection.model,
                      },
                    }
                  : {},
              }),
              canPromptWithImages: () => false,
              setModel: async () => undefined,
              stop: async () => undefined,
              sessionPrompt: async (
                _sessionId: string,
                _prompt: unknown,
                _timeout?: number,
                onChunk?: (delta: string, full: string) => void,
              ) => {
                attempt += 1;
                const result = await options.fakePrompt!(attempt);
                if (result.agentText) onChunk?.(result.agentText, result.agentText);
                return result;
              },
            });
            return client;
          },
        }
      : {}),
  });

  if (options.holdSlotMs) {
    // A second logical channel holds the scheduler's only slot, so the first
    // turn's queue-wait is a real capacity wait through the real scheduler.
    void scheduler.run(
      'other-room',
      {
        activate: async () => 'held-session',
        suspend: async () => undefined,
      },
      () => new Promise<void>((done) => setTimeout(done, options.holdSlotMs)),
      { priority: 'background', roomKey: 'other-room' },
    );
  }

  const running = loop.run();
  const deadline = Date.now() + 240_000 + (options.gapMs ?? 0);
  let residentDuringGap: Resident | undefined;
  while (settled() < options.asks.length && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 250));
    // Sample at the END of the gap: what retention is still holding when the
    // captain comes back is the number that matters.
    if (quietSince && options.gapMs && Date.now() - quietSince >= options.gapMs - 1_000) {
      residentDuringGap ??= residentProcesses();
    }
  }
  abort.abort();
  await running.catch(() => undefined);
  await scheduler.dispose();

  const day = new Date().toISOString().slice(0, 10);
  const written = await readFile(join(traceDir, `turns-${day}.jsonl`), 'utf8');
  const traces = written
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as TurnTraceRecord);
  return { traces, posted, ...(residentDuringGap ? { residentDuringGap } : {}) };
}

function table(record: TurnTraceRecord, title: string): string {
  const lines = [`### ${title}`, ''];
  for (const attempt of record.attempts) {
    const head = [
      `attempt ${attempt.attempt} (\`${attempt.attemptId}\`)`,
      `${attempt.activation} activation`,
      ...(attempt.capacityWait ? ['waited for a scheduler slot'] : []),
      ...(attempt.provider ? [`re-pinned to \`${attempt.provider}\``] : []),
    ].join(' — ');
    lines.push(record.attempts.length > 1 ? `**${head}**` : `_${head}_`, '');
    if (attempt.retryReason) lines.push(`Retried because: \`${attempt.retryReason}\``, '');
    lines.push('| phase | time |', '| --- | --- |');
    for (const phase of TURN_PHASES) {
      const value = attempt.phases[phase];
      if (value === undefined) continue;
      lines.push(
        `| ${phase}${phase === 'tool-work' ? ' _(nested in the model phases)_' : ''} | ${formatDuration(value)} |`,
      );
    }
    if (attempt.toolCalls) lines.push(`| tool calls | ${attempt.toolCalls} |`);
    lines.push('');
  }
  lines.push(
    `**Total ${formatDuration(record.totalMs)}** · outcome \`${record.outcome}\`` +
      (record.scheduler.atQueue
        ? ` · scheduler at enqueue: ${JSON.stringify(record.scheduler.atQueue)}`
        : ''),
    '',
  );
  return lines.join('\n');
}

/** Harness name to the ACP command the daemon would actually spawn. */
const LIVE_HARNESSES: Record<string, { kind: AgentKind; executable: string; args: string[] }> = {
  goose: { kind: 'goose', executable: 'goose', args: ['acp'] },
  claude: { kind: 'claude', executable: 'claude-agent-acp', args: [] },
  codex: { kind: 'codex', executable: 'codex-acp', args: [] },
  pi: { kind: 'pi', executable: 'pi-acp', args: [] },
};

async function live(harness: string): Promise<void> {
  const spec = LIVE_HARNESSES[harness];
  if (!spec) throw new Error(`unknown harness ${harness}`);
  // Absolute: the spawned harness gets a curated env, not the operator's shell.
  const command = execFileSync('which', [spec.executable], { encoding: 'utf8' }).trim();
  const { traces, posted } = await runRig({
    asks: [
      { id: 'ask-cold', body: 'In one short sentence, what does this repository checkout contain?' },
      { id: 'ask-warm', body: 'In one short sentence, name one thing you would check next.' },
    ],
    agentKind: spec.kind,
    agentCommand: command,
    agentArgs: spec.args,
    configOverrides: {
      agentEnv: { PATH: process.env.PATH ?? '' },
    } as Partial<BodyConfig>,
    holdSlotMs: 1_500,
  });
  console.log(`\nReplies: ${JSON.stringify(posted, null, 2)}\n`);
  console.log(table(traces[0]!, 'Cold turn — real harness, real model'));
  if (traces[1]) console.log(table(traces[1], 'Warm turn — same live session'));
}

async function retry(): Promise<void> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'beeline-measure-routing-'));
  const model = 'z-ai/glm-5.3-flash';
  await writeFile(
    join(cacheRoot, 'z-ai_glm-5.3-flash.json'),
    JSON.stringify({
      model,
      fetchedAt: Date.now(),
      providers: ['venice', 'phala'],
      bar: 98,
      input: null,
    }),
  );
  await writeFile(
    join(cacheRoot, 'z-ai_glm-5.3-flash.probe.json'),
    JSON.stringify({
      model,
      fetchedAt: Date.now(),
      answered: [
        { provider: 'venice', latencyMs: 700 },
        { provider: 'phala', latencyMs: 4700 },
      ],
    }),
  );
  const { traces, posted } = await runRig({
    asks: [{ id: 'ask-retry', body: 'Say hello.' }],
    agentKind: 'pi',
    agentCommand: '/opt/harness/pi-acp',
    agentArgs: [],
    modelSelection: { model },
    configOverrides: {
      agentEnv: { OPENROUTER_API_KEY: 'measurement' },
      openRouterRoutingCacheDir: cacheRoot,
    } as Partial<BodyConfig>,
    // Attempt one is the C92 shape: a tool-enabled 200 that says nothing.
    fakePrompt: async (attempt) => {
      await new Promise((done) => setTimeout(done, attempt === 1 ? 4_000 : 1_600));
      return attempt === 1
        ? { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] }
        : {
            stopReason: 'end_turn',
            updates: [],
            agentText: 'Hello — sorry about the false start.',
            toolCalls: [],
          };
    },
  });
  console.log(`\nReplies: ${JSON.stringify(posted, null, 2)}\n`);
  console.log(table(traces[0]!, 'Retry turn — real re-pin over a scripted empty completion'));
}

async function gap(harness: string, gapMs: number, idleMs?: number): Promise<void> {
  const spec = LIVE_HARNESSES[harness];
  if (!spec) throw new Error(`unknown harness ${harness}`);
  const command = execFileSync('which', [spec.executable], { encoding: 'utf8' }).trim();
  console.log(
    `Cold turn, then ${formatDuration(gapMs)} of silence, then a follow-up.` +
      ` Retention window: ${idleMs ? formatDuration(idleMs) : 'the shipped default'}.`,
  );
  const { traces, posted, residentDuringGap } = await runRig({
    asks: [
      { id: 'ask-cold', body: 'In one short sentence, what does this repository checkout contain?' },
      { id: 'ask-gap', body: 'In one short sentence, name one thing you would check next.' },
    ],
    agentKind: spec.kind,
    agentCommand: command,
    agentArgs: spec.args,
    configOverrides: { agentEnv: { PATH: process.env.PATH ?? '' } } as Partial<BodyConfig>,
    holdSlotMs: 1_500,
    gapMs,
    ...(idleMs ? { idleMs } : {}),
  });
  console.log(`\nReplies: ${JSON.stringify(posted, null, 2)}\n`);
  console.log(table(traces[0]!, 'Cold turn — real harness, real model'));
  if (traces[1]) {
    console.log(table(traces[1], `Follow-up after ${formatDuration(gapMs)} of silence`));
  }
  if (residentDuringGap) {
    console.log(
      `Resident at the end of the gap: ${residentDuringGap.processes} process(es), ` +
        `${residentDuringGap.rssMb}MB RSS — ${residentDuringGap.commands.join(', ')}\n`,
    );
  }
}

/**
 * What retention actually costs, and what bounds it.
 *
 * Real harness processes through the real scheduler, one per Room, with no
 * model turn: the resident cost of a retained session is its process, and this
 * measures that without spending a provider's tokens to learn it.
 */
async function ceiling(harness: string, rooms: number, maxWarm: number): Promise<void> {
  const spec = LIVE_HARNESSES[harness];
  if (!spec) throw new Error(`unknown harness ${harness}`);
  const command = execFileSync('which', [spec.executable], { encoding: 'utf8' }).trim();
  const root = await mkdtemp(join(tmpdir(), 'beeline-measure-ceiling-'));
  const cwd = join(root, 'room');
  await mkdir(cwd, { recursive: true });
  const scheduler = new SessionScheduler({ maxLiveSessions: rooms, maxWarmSessions: maxWarm });
  const clients: AcpClient[] = [];
  try {
    for (let index = 0; index < rooms; index += 1) {
      const agentEnv = {
        PATH: process.env.PATH ?? '',
        ...(await prepareRoomAgentHome({
          root: join(root, `agent-home-${index}`),
          operatorHome: process.env.HOME ?? '',
          agentKind: spec.kind,
        })),
      };
      let client: AcpClient | undefined;
      await scheduler.run(
        `room-${index}`,
        {
          activate: async () => {
            client = new AcpClient({
              agentCommand: command,
              agentArgs: spec.args,
              agentEnv,
              agentCwd: cwd,
              agentLabel: command,
              osSandbox: false,
              autoApprovePermissions: false,
            });
            clients.push(client);
            await client.start();
            const opened = await client.sessionNew({ cwd, mcpServers: [], mode: 'readonly' });
            return opened.sessionId;
          },
          suspend: async () => {
            if (client?.isAlive) await client.stop();
          },
        },
        async () => undefined,
        { roomKey: `room-${index}` },
      );
    }
    const held = residentProcesses();
    console.log(
      `### Retention ceiling — ${rooms} Rooms, \`maxWarm\` ${maxWarm}\n\n` +
        `| moment | scheduler | resident processes | RSS |\n| --- | --- | --- | --- |\n` +
        `| every Room answered | ${JSON.stringify(scheduler.snapshot())} | ${held.processes} | ${held.rssMb}MB |`,
    );
    await Reflect.get(scheduler, 'sweepIdle').call(scheduler);
    const culled = residentProcesses();
    console.log(
      `| after one sweep | ${JSON.stringify(scheduler.snapshot())} | ${culled.processes} | ${culled.rssMb}MB |\n`,
    );
  } finally {
    await scheduler.dispose();
    await Promise.all(clients.map((client) => client.stop().catch(() => undefined)));
  }
}

const [, , scenario = 'live', ...rest] = process.argv;
const flags = new Map<string, string>();
for (let index = 0; index < rest.length; index += 2) {
  if (rest[index]?.startsWith('--') && rest[index + 1]) {
    flags.set(rest[index]!.slice(2), rest[index + 1]!);
  }
}
const harness = flags.get('harness') ?? (scenario === 'live' ? 'goose' : 'claude');
if (scenario === 'retry') await retry();
else if (scenario === 'gap') {
  const idle = flags.get('idle-ms');
  await gap(
    harness,
    Number(flags.get('gap-ms') ?? 330_000),
    ...((idle ? [Number(idle)] : []) as [number?]),
  );
} else if (scenario === 'ceiling') {
  await ceiling(
    harness,
    Number(flags.get('rooms') ?? 5),
    Number(flags.get('max-warm') ?? DEFAULT_MAX_WARM_SESSIONS),
  );
} else await live(harness);
