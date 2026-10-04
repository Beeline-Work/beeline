/**
 * The institutional-context prefetch fix (#1904), proven against the real
 * server: `DaemonService.execute()` in process, a real Pglite database, and
 * the real `CommandExecutionContext.bind()` wrapping both turn loops apply to
 * their `api`. Only the ACP harness is a stub — the model process, the one
 * layer a test cannot run.
 *
 * This exists to answer one review question directly: does moving the
 * `getInstitutionalContext` call ahead of `scheduler.run`/activation still
 * carry command authority (`commandTransaction` + `authorizedCommand`) when
 * it reaches the server? If the early call raced ahead of the command being
 * entered into `CommandExecutionContext`, `getInstitutionalContext` would
 * refuse every time and every turn would silently show the "did not load"
 * note — the fix would look shipped while doing nothing. Read the turn trace
 * and the captured prompt below, not just the reply, to see either way.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../server/src/database.js';
import { PgliteDatabase } from '../../server/src/test-support.js';
import { PhoneService } from '../../server/src/phone-service.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';
import type { TurnTraceRecord } from './turn-trace.js';

const AGENT_HEX = '11'.repeat(32);
const identity = identityFromKey(AGENT_HEX, 'Bee');
const AGENT = identity.publicKey;
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService, root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'institutional-context-integration-'));
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Bee','bee')`, [
    AGENT,
  ]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$1)`, [AGENT]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [WORKSPACE]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`, [
    WORKSPACE,
    AGENT,
  ]);
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(
    db,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    { enabled: true, live: true },
  );
}, 60_000);

afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});

/** A real human requester, membered into the given Room. */
async function seedRequester(roomId: string, name: string): Promise<string> {
  const id = createHash('sha256').update(`requester:${roomId}:${name}:${randomUUID()}`).digest('hex');
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human',$2,$3)`, [
    id,
    name,
    name.toLowerCase(),
  ]);
  for (const scopedRoomId of [null, roomId])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
      [WORKSPACE, scopedRoomId, id],
    );
  return id;
}

/** A real active `human_profile_fact`, through the real schema the server reads. */
async function seedProfileFact(
  roomId: string,
  requesterId: string,
  canonicalKey: string,
  body: string,
  keywords: readonly string[],
): Promise<void> {
  const sourceMessageId = randomUUID();
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,'source',$4)`,
    [sourceMessageId, roomId, requesterId, 'activity'],
  );
  await db.query(
    `INSERT INTO institutional_memory_items
       (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
        source_message_id,audience_kind,confidence,version,keywords)
     VALUES($1,$2,'human_profile_fact',$3,$4,$5,'active',$6,$7,'human_profile',0.9,1,$8::text[])`,
    [
      randomUUID(),
      WORKSPACE,
      requesterId,
      canonicalKey,
      body,
      roomId,
      sourceMessageId,
      keywords,
    ],
  );
}

function localApi(agentId: string): DaemonApiClient {
  return { execute: (name: string, input: never) => daemon.execute(name as never, input, agentId) } as unknown as DaemonApiClient;
}

/** The turn-trace JSONL line for one completed attempt in this room/corner. */
async function readInstitutionalMemoryOutcome(
  traceDir: string,
  roomId: string,
): Promise<{ outcome: string | undefined; requestId: string }> {
  const files = await readdir(traceDir);
  const records: TurnTraceRecord[] = [];
  for (const file of files) {
    const text = await readFile(join(traceDir, file), 'utf8');
    for (const line of text.trim().split('\n').filter(Boolean)) records.push(JSON.parse(line));
  }
  const record = records.find((entry) => entry.roomId === roomId && entry.outcome === 'complete');
  if (!record) throw new Error(`no completed turn trace for ${roomId}`);
  return {
    outcome: record.attempts[record.attempts.length - 1]?.institutionalMemory,
    requestId: record.requestId,
  };
}

describe('institutional context prefetch, proven against the real server', () => {
  it('serves a real saved profile fact in a Room turn, and the daemon\'s claim precedes the fetch', async () => {
    const roomId = randomUUID();
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [roomId, WORKSPACE]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [
      WORKSPACE,
      roomId,
      AGENT,
    ]);
    const human = await seedRequester(roomId, 'Daeun');
    await seedProfileFact(
      roomId,
      human,
      'requester.wife.daeun.tokyo_delivery',
      'Daeun receives packages at the Motoazabu address in Tokyo.',
      ['daeun', 'tokyo', 'delivery', 'address'],
    );

    const traceDir = join(root, roomId, 'traces');
    const agentHomeRoot = join(root, roomId, 'agent-home');
    await mkdir(agentHomeRoot, { recursive: true });
    const runtime = {
      agent: { name: 'Bee', publicKey: AGENT, secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'http://test', daemonToken: 'token' },
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    } as unknown as AgentRuntimeRecord;
    const config = {
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: {},
      workspaceRoot: join(root, roomId, 'room'),
      autoApprovePermissions: true,
      accessPolicy: 'everyone',
      agentHomeRoot,
      turnTraceDir: traceDir,
    } as BodyConfig;

    let pushCommands: ((commands: readonly AgentCommand[]) => void) | undefined;
    const api = {
      execute: (name: string, input: never) => daemon.execute(name as never, input, AGENT),
      connection: () => ({ baseUrl: 'http://test', daemonToken: 'token', agentId: AGENT }),
      liveSubscribe: (
        _roomId: string,
        _cursor: unknown,
        _items: unknown,
        onState: (connected: boolean, capabilities: { pushIntake: boolean; connectionPresence: boolean }) => void,
        _presence: unknown,
        onCommands: (commands: readonly AgentCommand[]) => void,
      ) => {
        pushCommands = onCommands;
        onState(true, { pushIntake: true, connectionPresence: true });
        return () => {
          pushCommands = undefined;
        };
      },
    } as unknown as DaemonApiClient;
    const prompts: string[] = [];
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    vi.spyOn(acp, 'setModel').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(async (_sessionId, prompt) => {
      prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
      return { stopReason: 'end_turn', updates: [], agentText: 'Done.', toolCalls: [] };
    });
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
      await phone.execute('sendRoomMessage', { roomId, text: '@bee where does Daeun receive packages in Tokyo?' }, human);
      await vi.waitFor(() => expect(pushCommands).toBeTypeOf('function'));
      pushCommands?.((await daemon.execute('getAgentCommands', { roomId }, AGENT)).commands);
      await vi.waitFor(
        async () =>
          expect(
            (await db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND status IN ('complete','failed')`, [roomId])).rowCount,
          ).toBeGreaterThan(0),
        { timeout: 10_000, interval: 25 },
      );
    } finally {
      abort.abort();
      await running.catch(() => undefined);
      await scheduler.dispose();
    }

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Daeun receives packages at the Motoazabu address in Tokyo.');
    const trace = await readInstitutionalMemoryOutcome(traceDir, roomId);
    expect(trace.outcome).toBe('served');
  }, 30_000);

  it('serves a real saved profile fact in a corner turn opened by the same server, the corner\'s own command claimed first', async () => {
    const roomId = randomUUID();
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [roomId, WORKSPACE]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [
      WORKSPACE,
      roomId,
      AGENT,
    ]);
    const human = await seedRequester(roomId, 'Ren');
    await seedProfileFact(
      roomId,
      human,
      'requester.ren.cake_order',
      "Ren's birthday cake order: red velvet, no nuts.",
      ['ren', 'birthday', 'cake', 'order'],
    );

    // Open the corner the way a Room agent really does: through a live Room
    // turn calling `open_corner`, so the corner's opening command is the
    // server's own real write, not a fixture.
    const roomAgentHomeRoot = join(root, roomId, 'agent-home');
    await mkdir(roomAgentHomeRoot, { recursive: true });
    const roomRuntime = {
      agent: { name: 'Bee', publicKey: AGENT, secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'http://test', daemonToken: 'token' },
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    } as unknown as AgentRuntimeRecord;
    const roomConfig = {
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: {},
      workspaceRoot: join(root, roomId, 'room'),
      autoApprovePermissions: true,
      accessPolicy: 'everyone',
      agentHomeRoot: roomAgentHomeRoot,
    } as BodyConfig;
    let roomPushCommands: ((commands: readonly AgentCommand[]) => void) | undefined;
    const roomApi = {
      execute: (name: string, input: never) => daemon.execute(name as never, input, AGENT),
      connection: () => ({ baseUrl: 'http://test', daemonToken: 'token', agentId: AGENT }),
      liveSubscribe: (
        _roomId: string,
        _cursor: unknown,
        _items: unknown,
        onState: (connected: boolean, capabilities: { pushIntake: boolean; connectionPresence: boolean }) => void,
        _presence: unknown,
        onCommands: (commands: readonly AgentCommand[]) => void,
      ) => {
        roomPushCommands = onCommands;
        onState(true, { pushIntake: true, connectionPresence: true });
        return () => {
          roomPushCommands = undefined;
        };
      },
    } as unknown as DaemonApiClient;
    const roomAcp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(roomAcp, 'start').mockResolvedValue(undefined);
    vi.spyOn(roomAcp, 'stop').mockResolvedValue(undefined);
    vi.spyOn(roomAcp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
    vi.spyOn(roomAcp, 'canPromptWithImages').mockReturnValue(false);
    vi.spyOn(roomAcp, 'setModel').mockResolvedValue(undefined);
    let cornerId: string | undefined;
    vi.spyOn(roomAcp, 'sessionPrompt').mockImplementation(async (_sessionId, _prompt, _timeoutMs, _onChunk, _activity, onToolCalls) => {
      const files = await readdir(roomAgentHomeRoot);
      const file = files.find((name) => name.startsWith('beeline-command-'));
      const context = JSON.parse(await readFile(join(roomAgentHomeRoot, file!), 'utf8')) as {
        roomId: string;
        requestId: string;
        generationId: string;
      };
      const created = await daemon.execute(
        'createCorner',
        { ...context, name: 'Cake order', objective: "Fulfill Ren's birthday cake order" } as never,
        AGENT,
      );
      cornerId = (created as { cornerId: string }).cornerId;
      onToolCalls?.([{ id: 'call-1', title: 'mcp__beeline-agent__open_corner', status: 'completed' }]);
      return {
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Taking the cake order into a corner.',
        toolCalls: [{ id: 'call-1', title: 'mcp__beeline-agent__open_corner', status: 'completed' }],
      };
    });
    const roomScheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const roomAbort = new AbortController();
    const roomLoop = new MonolithRoomTurnLoop({
      roomId,
      workspaceId: WORKSPACE,
      cwd: roomConfig.workspaceRoot,
      runtime: roomRuntime,
      config: roomConfig,
      api: roomApi,
      scheduler: roomScheduler,
      health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
      signal: roomAbort.signal,
      pollMs: 10,
      createAcpClient: () => roomAcp,
    });
    const roomRunning = roomLoop.run();
    try {
      await phone.execute('sendRoomMessage', { roomId, text: '@bee handle the cake order' }, human);
      await vi.waitFor(() => expect(roomPushCommands).toBeTypeOf('function'));
      roomPushCommands?.((await daemon.execute('getAgentCommands', { roomId }, AGENT)).commands);
      await vi.waitFor(() => expect(cornerId).toBeDefined(), { timeout: 10_000, interval: 25 });
    } finally {
      roomAbort.abort();
      await roomRunning.catch(() => undefined);
      await roomScheduler.dispose();
    }
    if (!cornerId) throw new Error('the Room turn never opened a corner');

    // Now run the corner's own turn against its real, server-created objective command.
    const cornerTraceDir = join(root, cornerId, 'traces');
    const cornerAgentHomeRoot = join(root, cornerId, 'agent-home');
    const worktreePath = join(root, cornerId, 'scratch');
    await mkdir(cornerAgentHomeRoot, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    const cornerConfig = {
      ...roomConfig,
      agentHomeRoot: cornerAgentHomeRoot,
      workspaceRoot: worktreePath,
      turnTraceDir: cornerTraceDir,
    } as BodyConfig;
    let cornerPushCommands: ((commands: readonly AgentCommand[]) => void) | undefined;
    const cornerApi = {
      execute: (name: string, input: never) => daemon.execute(name as never, input, AGENT),
      connection: () => ({ baseUrl: 'http://test', daemonToken: 'token', agentId: AGENT }),
      liveSubscribe: (
        _roomId: string,
        _cursor: unknown,
        _items: unknown,
        onState: (connected: boolean, capabilities: { pushIntake: boolean; connectionPresence: boolean }) => void,
        _presence: unknown,
        onCommands: (commands: readonly AgentCommand[]) => void,
      ) => {
        cornerPushCommands = onCommands;
        onState(true, { pushIntake: true, connectionPresence: true });
        return () => {
          cornerPushCommands = undefined;
        };
      },
    } as unknown as DaemonApiClient;
    const cornerPrompts: string[] = [];
    const cornerAcp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(cornerAcp, 'start').mockResolvedValue(undefined);
    vi.spyOn(cornerAcp, 'stop').mockResolvedValue(undefined);
    vi.spyOn(cornerAcp, 'sessionNew').mockResolvedValue({ sessionId: 'corner-session', raw: {} });
    vi.spyOn(cornerAcp, 'canPromptWithImages').mockReturnValue(false);
    vi.spyOn(cornerAcp, 'setModel').mockResolvedValue(undefined);
    vi.spyOn(cornerAcp, 'sessionPrompt').mockImplementation(async (_sessionId, prompt) => {
      cornerPrompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
      return { stopReason: 'end_turn', updates: [], agentText: 'On it.', toolCalls: [] };
    });
    const cornerScheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const cornerAbort = new AbortController();
    const cornerLoop = new MonolithCornerTurnLoop({
      cornerId,
      parentRoomId: roomId,
      workspaceId: WORKSPACE,
      objective: "Fulfill Ren's birthday cake order",
      worktreePath,
      lane: 'no_code',
      runtime: roomRuntime,
      config: cornerConfig,
      api: cornerApi,
      scheduler: cornerScheduler,
      signal: cornerAbort.signal,
      pollMs: 10,
      onPoll: vi.fn(),
      onFailure: vi.fn(),
      onCloseRequested: vi.fn(async () => undefined),
      createAcpClient: () => cornerAcp,
    });
    const cornerRunning = cornerLoop.run();
    try {
      await vi.waitFor(() => expect(cornerPushCommands).toBeTypeOf('function'));
      cornerPushCommands?.((await daemon.execute('getAgentCommands', { roomId: cornerId }, AGENT)).commands);
      await vi.waitFor(
        async () =>
          expect(
            (await db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND status IN ('complete','failed')`, [cornerId])).rowCount,
          ).toBeGreaterThan(0),
        { timeout: 10_000, interval: 25 },
      );
    } finally {
      cornerAbort.abort();
      await cornerRunning.catch(() => undefined);
      await cornerScheduler.dispose();
    }

    expect(cornerPrompts.length).toBeGreaterThan(0);
    expect(cornerPrompts[0]).toContain("Ren's birthday cake order: red velvet, no nuts.");
    // The local trace is written asynchronously after the server receipt.
    await vi.waitFor(async () => {
      const trace = await readInstitutionalMemoryOutcome(cornerTraceDir, cornerId);
      expect(trace.outcome).toBe('served');
    }, { timeout: 10_000, interval: 25 });
  }, 30_000);

  it('serves the SECOND requester\'s own fact when their turn is queued behind a still-running first turn in the same Room', async () => {
    const roomId = randomUUID();
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [roomId, WORKSPACE]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [
      WORKSPACE,
      roomId,
      AGENT,
    ]);
    const first = await seedRequester(roomId, 'Amir');
    const second = await seedRequester(roomId, 'Priya');
    await seedProfileFact(roomId, first, 'requester.amir.office', 'Amir works from the Austin office.', [
      'amir',
      'austin',
      'office',
    ]);
    await seedProfileFact(roomId, second, 'requester.priya.office', 'Priya works from the Berlin office.', [
      'priya',
      'berlin',
      'office',
    ]);

    const traceDir = join(root, roomId, 'traces');
    const agentHomeRoot = join(root, roomId, 'agent-home');
    await mkdir(agentHomeRoot, { recursive: true });
    const runtime = {
      agent: { name: 'Bee', publicKey: AGENT, secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'http://test', daemonToken: 'token' },
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    } as unknown as AgentRuntimeRecord;
    const config = {
      agentBinary: '/fake-agent',
      agentKind: 'codex',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: {},
      workspaceRoot: join(root, roomId, 'room'),
      autoApprovePermissions: true,
      accessPolicy: 'everyone',
      agentHomeRoot,
      turnTraceDir: traceDir,
    } as BodyConfig;
    let pushCommands: ((commands: readonly AgentCommand[]) => void) | undefined;
    const api = {
      execute: (name: string, input: never) => daemon.execute(name as never, input, AGENT),
      connection: () => ({ baseUrl: 'http://test', daemonToken: 'token', agentId: AGENT }),
      liveSubscribe: (
        _roomId: string,
        _cursor: unknown,
        _items: unknown,
        onState: (connected: boolean, capabilities: { pushIntake: boolean; connectionPresence: boolean }) => void,
        _presence: unknown,
        onCommands: (commands: readonly AgentCommand[]) => void,
      ) => {
        pushCommands = onCommands;
        onState(true, { pushIntake: true, connectionPresence: true });
        return () => {
          pushCommands = undefined;
        };
      },
    } as unknown as DaemonApiClient;
    const prompts: string[] = [];
    // The first turn blocks here until the test releases it, so the second
    // message is genuinely queued behind a still-running turn, not merely
    // sent-and-forgotten before the first one starts.
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnBlocked = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let promptCount = 0;
    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'stop').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    vi.spyOn(acp, 'setModel').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionPrompt').mockImplementation(async (_sessionId, prompt) => {
      promptCount += 1;
      if (promptCount === 1) await firstTurnBlocked;
      prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
      return { stopReason: 'end_turn', updates: [], agentText: `Answer ${promptCount}.`, toolCalls: [] };
    });
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
      await phone.execute('sendRoomMessage', { roomId, text: '@bee where does Amir work from?' }, first);
      await vi.waitFor(() => expect(pushCommands).toBeTypeOf('function'));
      pushCommands?.((await daemon.execute('getAgentCommands', { roomId }, AGENT)).commands);
      // Wait until the first turn is genuinely inside its (blocked) prompt call.
      await vi.waitFor(() => expect(promptCount).toBe(1));

      await phone.execute('sendRoomMessage', { roomId, text: '@bee where does Priya work from?' }, second);
      pushCommands?.((await daemon.execute('getAgentCommands', { roomId }, AGENT)).commands);
      // The second command is real and claimed-pending, but the loop is busy —
      // give it a beat to prove it does NOT start a second concurrent prompt.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(promptCount).toBe(1);

      releaseFirstTurn?.();
      await vi.waitFor(() => expect(promptCount).toBe(2), { timeout: 10_000, interval: 25 });
      await vi.waitFor(
        async () =>
          expect(
            (
              await db.query(
                `SELECT count(*)::text n FROM agent_turns WHERE room_id=$1 AND status IN ('complete','failed')`,
                [roomId],
              )
            ).rows[0]!.n,
          ).toBe('2'),
        { timeout: 10_000, interval: 25 },
      );
    } finally {
      abort.abort();
      await running.catch(() => undefined);
      await scheduler.dispose();
    }

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Amir works from the Austin office.');
    expect(prompts[0]).not.toContain('Berlin');
    // The second, queued turn is served with the SECOND requester's own
    // fact — not empty, not the first requester's, not a leftover from the
    // still-settling first turn's command context.
    expect(prompts[1]).toContain('Priya works from the Berlin office.');
    expect(prompts[1]).not.toContain('Austin');

    await vi.waitFor(async () => {
      const files = await readdir(traceDir);
      const records: TurnTraceRecord[] = [];
      for (const file of files) {
        const text = await readFile(join(traceDir, file), 'utf8');
        for (const line of text.trim().split('\n').filter(Boolean)) records.push(JSON.parse(line));
      }
      const outcomes = records
        .filter((entry) => entry.roomId === roomId && entry.outcome === 'complete')
        .map((entry) => entry.attempts[entry.attempts.length - 1]?.institutionalMemory);
      expect(outcomes).toEqual(['served', 'served']);
    }, { timeout: 10_000, interval: 25 });
  }, 30_000);
});
