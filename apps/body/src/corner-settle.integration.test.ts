/**
 * The corner-open settle scenarios, driven through the real server.
 *
 * Everything below the harness is the product: a real `MonolithRoomTurnLoop`
 * takes a real `agent_commands` row, opens a real corner through
 * `DaemonService.createCorner`, and settles through `DaemonService`'s real
 * write path into a real database. Every assertion reads what
 * `PhoneService.readRoom` actually hands a phone — the card, the durable reply
 * and the turn receipt together — because the reported production loss was
 * precisely a difference between what the reader watched arrive and what the
 * Room held afterwards. Only the ACP harness is a stub: it is the model
 * process, the one layer a test cannot run.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoomView, RoomViewMessage } from '@beeline/api-contract/phone';
import { PgliteDatabase } from '../../server/src/test-support.js';
import { migrate } from '../../server/src/database.js';
import { PhoneService } from '../../server/src/phone-service.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { AcpClient, AcpRequestTimeoutError, type ToolCallEntry } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop, ROOM_PROMPT_INACTIVITY_TIMEOUT_MS } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

const AGENT_HEX = '11'.repeat(32);
const identity = identityFromKey(AGENT_HEX, 'Bee');
const AGENT = identity.publicKey;
const HUMAN = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OPEN_CORNER_CALL: ToolCallEntry = {
  id: 'call-1',
  title: 'mcp__beeline-agent__open_corner',
  status: 'completed',
};

let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService, root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'corner-settle-'));
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Captain','captain'),($2,'agent','Bee','bee')`,
    [HUMAN, AGENT],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [WORKSPACE]);
  for (const who of [HUMAN, AGENT])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
      [WORKSPACE, who],
    );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 60_000);

afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});

/** The live turn context the loop wrote for the MCP surface: exactly what
 *  `open_corner` reads before it calls `createCorner` on the server. */
async function activeTurnContext(agentHomeRoot: string): Promise<{
  roomId: string;
  requestId: string;
  generationId: string;
}> {
  const names = await readdir(agentHomeRoot);
  const file = names.find((name) => name.startsWith('beeline-command-'));
  if (!file) throw new Error('the turn wrote no command context file');
  const value = JSON.parse(await readFile(join(agentHomeRoot, file), 'utf8')) as {
    roomId?: string;
    requestId?: string;
    generationId?: string;
  };
  if (!value.roomId || !value.requestId || !value.generationId)
    throw new Error('no active server command');
  return value as { roomId: string; requestId: string; generationId: string };
}

type PromptHooks = {
  readonly agentHomeRoot: string;
  readonly onChunk: (delta: string, full: string, currentRun?: string) => void;
  readonly onToolCalls: (calls: readonly ToolCallEntry[]) => void;
  /** Open a real corner on the server the way `open_corner` does. */
  readonly openCorner: (name: string, objective: string) => Promise<string>;
};

async function runScenario(options: {
  ask: string;
  agentKind?: string;
  agentCommand?: string;
  prompt: (hooks: PromptHooks) => Promise<Awaited<ReturnType<AcpClient['sessionPrompt']>>>;
}): Promise<{ roomId: string; view: RoomView }> {
  const roomId = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
    roomId,
    WORKSPACE,
  ]);
  for (const who of [HUMAN, AGENT])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
      [WORKSPACE, roomId, who],
    );
  const agentCommand = options.agentCommand ?? '/fake-agent';
  const agentKind = options.agentKind ?? 'codex';
  const agentHomeRoot = join(root, roomId, 'agent-home');
  await mkdir(agentHomeRoot, { recursive: true });
  const agent = {
    name: 'Bee',
    publicKey: AGENT,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
  };
  const runtime = {
    agent,
    rooms: [],
    supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'http://test', daemonToken: 'token' },
    agentBinary: agentCommand,
    agentKind,
    agentCommand,
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
  } as unknown as AgentRuntimeRecord;
  const config = {
    agentBinary: agentCommand,
    agentKind,
    agentCommand,
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    workspaceRoot: join(root, roomId, 'room'),
    autoApprovePermissions: true,
    accessPolicy: 'everyone',
    agentHomeRoot,
    operatorHome: join(root, roomId, 'operator-home'),
  } as BodyConfig;
  const api = {
    execute: (name: string, input: never) => daemon.execute(name as never, input, AGENT),
    connection: () => ({ baseUrl: 'http://test', daemonToken: 'token', agentId: AGENT }),
  } as unknown as DaemonApiClient;
  const acp = new AcpClient({ agentBinary: agentCommand, agentEnv: {} });
  vi.spyOn(acp, 'start').mockResolvedValue(undefined);
  vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
  vi.spyOn(acp, 'setModel').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionPrompt').mockImplementation(
    (_sessionId, _prompt, _timeoutMs, onChunk, _activity, onToolCalls) =>
      options.prompt({
        agentHomeRoot,
        onChunk: (delta, full, currentRun) => onChunk?.(delta, full, currentRun),
        onToolCalls: (calls) => onToolCalls?.(calls),
        openCorner: async (name, objective) => {
          const context = await activeTurnContext(agentHomeRoot);
          const created = await daemon.execute(
            'createCorner',
            { ...context, name, objective } as never,
            AGENT,
          );
          return (created as { cornerId: string }).cornerId;
        },
      }),
  );
  const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
  const abort = new AbortController();
  const loop = new MonolithRoomTurnLoop({
    roomId,
    workspaceId: WORKSPACE,
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
  try {
    await phone.execute('sendRoomMessage', { roomId, text: `@bee ${options.ask}` }, HUMAN);
    await vi.waitFor(
      async () =>
        expect(
          (
            await db.query(
              `SELECT 1 FROM agent_turns WHERE room_id=$1 AND status IN ('complete','failed')`,
              [roomId],
            )
          ).rowCount,
        ).toBeGreaterThan(0),
      { timeout: 10_000, interval: 25 },
    );
  } finally {
    abort.abort();
    await running.catch(() => undefined);
    await scheduler.dispose();
  }
  const view = await phone.readRoom(roomId, HUMAN);
  expect(view).not.toBeNull();
  return { roomId, view: view! };
}

/** The corner-open card the server owns, as the phone receives it. */
const cornerCards = (view: RoomView): RoomViewMessage[] =>
  view.messages.filter((message) => message.daemonFact?.type === 'corner-open');

/** The agent's durable prose rows, as the phone receives them. */
const agentReplies = (view: RoomView): RoomViewMessage[] =>
  view.messages.filter(
    (message) => message.presentation === 'message' && message.author.pubkey === AGENT,
  );

describe('a Room turn that opens a corner, read back through the server', () => {
  it('keeps the streamed reply alongside the corner card', async () => {
    const answer = 'Taking the widget fix into a corner; I will report back when checks pass.';
    const { view } = await runScenario({
      ask: 'fix the widget',
      prompt: async ({ onChunk, onToolCalls, openCorner }) => {
        onChunk(answer, answer, answer);
        await openCorner('Widget fix', 'Fix the widget end to end');
        onToolCalls([OPEN_CORNER_CALL]);
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: answer,
          toolCalls: [OPEN_CORNER_CALL],
        };
      },
    });
    expect(cornerCards(view)).toHaveLength(1);
    expect(agentReplies(view).map((message) => message.text)).toEqual([answer]);
    expect(view.latestAgentTurns).toContainEqual(
      expect.objectContaining({ agentPubkey: AGENT, status: 'complete' }),
    );
  });

  it('settles through the card alone when the last run produced no text', async () => {
    const { view } = await runScenario({
      ask: 'take the widget fix away',
      prompt: async ({ onToolCalls, openCorner }) => {
        await openCorner('Widget fix', 'Fix the widget end to end');
        onToolCalls([OPEN_CORNER_CALL]);
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: '',
          toolCalls: [OPEN_CORNER_CALL],
        };
      },
    });
    expect(cornerCards(view)).toHaveLength(1);
    expect(agentReplies(view)).toEqual([]);
    expect(view.latestAgentTurns).toContainEqual(
      expect.objectContaining({ agentPubkey: AGENT, status: 'complete' }),
    );
  });

  it('settles the last run, not the joined stream, when the turn then times out', async () => {
    const narration = 'Let me take this into a corner.';
    const answer = 'Here is what I found: the cards go stale.';
    const { view } = await runScenario({
      ask: 'why do the cards go stale',
      prompt: async ({ onChunk, onToolCalls, openCorner }) => {
        onChunk(narration, narration, narration);
        await openCorner('Stale cards', 'Find why the cards go stale');
        onToolCalls([OPEN_CORNER_CALL]);
        onChunk(answer, `${narration}\n\n${answer}`, answer);
        await new Promise((resolve) => setImmediate(resolve));
        throw new AcpRequestTimeoutError(
          'session/prompt',
          ROOM_PROMPT_INACTIVITY_TIMEOUT_MS,
          '',
          true,
        );
      },
    });
    expect(cornerCards(view)).toHaveLength(1);
    expect(agentReplies(view).map((message) => message.text)).toEqual([answer]);
    expect(view.latestAgentTurns).toContainEqual(
      expect.objectContaining({ agentPubkey: AGENT, status: 'complete' }),
    );
  });
});

describe('a Room turn whose recovered text is only harness preamble', () => {
  it('is a failed turn in the Room, not an empty reply', async () => {
    const { roomId, view } = await runScenario({
      ask: "what's up",
      agentKind: 'pi',
      agentCommand: '/opt/harness/pi-acp',
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
                content: [
                  { type: 'text', text: 'pi v0.85.1\n\n## Skills\n- /home/agent/skills/skill.md' },
                ],
                stopReason: 'stop',
              },
            }),
          ].join('\n'),
        );
        return { stopReason: 'end_turn', updates: [], agentText: '', toolCalls: [] };
      },
    });
    expect(agentReplies(view)).toEqual([]);
    expect(view.latestAgentTurns).toContainEqual(
      expect.objectContaining({ agentPubkey: AGENT, status: 'failed' }),
    );
    // The stored reason names the branch that actually read pi's record and
    // sanitized its text away — a record the explainer never located phrases
    // it differently and cannot pass this test in the same shape.
    const stored = await db.query<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM agent_turns WHERE room_id=$1 AND status='failed'`,
      [roomId],
    );
    expect(stored.rows.map((row) => row.failure_reason ?? '')).toContainEqual(
      expect.stringContaining('pi recorded the answer but the ACP stream delivered no text'),
    );
    // The Room says so: a failed turn is a durable fact, never silence.
    expect(view.messages.some((message) => message.presentation === 'system')).toBe(true);
  });
});
