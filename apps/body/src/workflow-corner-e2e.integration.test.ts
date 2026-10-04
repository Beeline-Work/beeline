import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from '../../server/src/database.js';
import { PgliteDatabase } from '../../server/src/test-support.js';
import { TokenAuth } from '../../server/src/auth.js';
import { PhoneService } from '../../server/src/phone-service.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { createBeelineServer } from '../../server/src/server.js';
import { createAgentCommand, type CommandRow } from '../../server/src/agent-command.js';
import { describedLegacyWorkflowContract, saveWorkflow } from '../../server/src/workflow-runs.js';
import type { TransactionalDatabase } from '@beeline/auth/store';
import { getPublicKey } from '@beeline/nostr';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { CommandExecutionContext } from './server-command-intake.js';
import { callAgentTool } from './read-only-mcp.js';

/**
 * End-to-end proof that a worker can actually execute a workflow run started
 * inside a corner, through the REAL agent MCP tool handlers
 * (`start_workflow`/`get_workflow_run`/`handoff`/`emit_event` in
 * `read-only-mcp.ts`) talking to a real `apps/server` (real Postgres-shaped
 * schema via pglite, real `DaemonService`/`PhoneService`/auth over HTTP) —
 * reproducing the exact failure the MM desk corner hit: `get_workflow_run`
 * from inside a corner used to send the PARENT Room id and get back 503
 * "workflow run is unavailable in this Room" (fixed by routing workflow-run
 * tools through `agentScheduleRoomId()`, which prefers
 * `BEELINE_DAEMON_CORNER_ID`), and `emit_event` waking an agent by bare
 * `@handle` instead of agent id.
 *
 * Every tool call below runs with the corner env exactly as production
 * mounts it: `BEELINE_DAEMON_ROOM_ID` is the PARENT Room, and
 * `BEELINE_DAEMON_CORNER_ID` is the corner — never the other way around.
 *
 * PR #2083 made a NEW `save_workflow` require a `summary` and a per-step
 * `does` (`workflowSaveError`); `database.ts`'s `backfillWorkflowSkillDescriptions`
 * migration fills those in for every workflow saved before that rule
 * existed. The contract here is saved through the NORMAL save path
 * (`saveWorkflow`, the same function `save_workflow` calls), described with
 * `describedLegacyWorkflowContract` — the exact pure half of that migration
 * — so it carries exactly what the migration would have filled in, with
 * every edge, role binding and loop rule of the real v4 contract unchanged.
 * The migration itself is covered on its own in `workflow-runs.test.ts`.
 */

const HOOK_TIMEOUT_MS = 30_000;

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PARENT_ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';

const HUMAN = createHash('sha256').update('mm-desk:owner').digest('hex');
const SCOUT = getPublicKey(new Uint8Array(32).fill(21)); // @baby
const VERIFIER = getPublicKey(new Uint8Array(32).fill(22)); // @vera
const TRADER = getPublicKey(new Uint8Array(32).fill(23)); // @trey
const AUDITOR = getPublicKey(new Uint8Array(32).fill(24)); // @jellybean

/** Verbatim copy of the real contract this proof must execute unchanged. */
const CONTRACT = {
  version: 1,
  name: 'related-market-arbitrage-paper',
  description: 'Daily four-agent entry funnel for paper arbitrage',
  roles: ['scout', 'verifier', 'trader', 'auditor'],
  start: 'scout',
  handoffs: {
    scout: {
      role: 'scout',
      requires: ['candidate_pairs', 'scan_scope', 'source_time'],
      on: { batch: 'verify', empty: 'score' },
    },
    verify: {
      role: 'verifier',
      requires: ['survivors', 'rejections', 'rule_evidence'],
      on: { passed: 'simulate', empty: 'scout' },
      loop: { onEdge: 'empty', cap: 1, onExceeded: 'score' },
    },
    simulate: {
      role: 'trader',
      requires: ['paper_fills', 'rejections', 'book_evidence', 'fee_model'],
      on: { filled: 'score', none: 'scout' },
      loop: { onEdge: 'none', cap: 1, onExceeded: 'score' },
    },
    score: {
      role: 'auditor',
      requires: ['funnel_counts', 'net_paper_floor', 'open_positions', 'decision', 'evidence'],
      on: { scored: 'done' },
    },
    done: { kind: 'terminal', status: 'done' },
  },
} as const;

const roots: string[] = [];
afterEach(
  async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  HOOK_TIMEOUT_MS,
);

let database: PgliteDatabase;
let server: ReturnType<typeof createBeelineServer>;
let origin: string;
let tokenOf: Record<string, string>;

const ENV_KEYS = [
  'BEELINE_DAEMON_BASE_URL',
  'BEELINE_DAEMON_TOKEN',
  'BEELINE_DAEMON_AGENT_ID',
  'BEELINE_DAEMON_ROOM_ID',
  'BEELINE_DAEMON_CORNER_ID',
  'BEELINE_TURN_CONTEXT_FILE',
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await new (await import('@beeline/auth/store')).AuthStore(
    database as unknown as TransactionalDatabase,
  ).migrate();

  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Owner','owner'),
       ($2,'agent','Baby','baby'),
       ($3,'agent','Vera','vera'),
       ($4,'agent','Trey','trey'),
       ($5,'agent','Jellybean','jellybean')`,
    [HUMAN, SCOUT, VERIFIER, TRADER, AUDITOR],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id) VALUES($1,$5),($2,$5),($3,$5),($4,$5)`,
    [SCOUT, VERIFIER, TRADER, AUDITOR, HUMAN],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Experiments HQ')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'experiments')`, [
    PARENT_ROOM,
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'MM desk')`,
    [CORNER, WORKSPACE, PARENT_ROOM],
  );
  for (const who of [HUMAN, SCOUT, VERIFIER, TRADER, AUDITOR]) {
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,$3),($1,$4,$2,$3),($1,$5,$2,$3)`,
      [WORKSPACE, who, who === HUMAN ? 'owner' : 'member', PARENT_ROOM, CORNER],
    );
  }

  const auth = new TokenAuth(database, async (proof) => ({
    subject: proof,
    login: proof,
    name: 'Owner',
  }));
  const phone = new PhoneService(database, 'http://placeholder');
  const live = new LiveHub();
  const daemon = new DaemonService(database, live);
  server = createBeelineServer({ database, auth, phone, daemon, live, mediaMaximumBytes: 1024 * 1024 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const daemonTokenFor = async (agentId: string) => {
    const exchange = await auth.createDaemonExchange(agentId);
    return (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  };
  tokenOf = {
    [SCOUT]: await daemonTokenFor(SCOUT),
    [VERIFIER]: await daemonTokenFor(VERIFIER),
    [TRADER]: await daemonTokenFor(TRADER),
    [AUDITOR]: await daemonTokenFor(AUDITOR),
  };

  // Save the contract through the NORMAL save path, described exactly as
  // `backfillWorkflowSkillDescriptions` would describe it (summary from the
  // contract's own description; a placeholder `does` per non-terminal
  // step) — the same shape every pre-PR #2083 workflow has after that
  // migration runs. Every edge, role binding and loop rule stays the real,
  // unchanged v4 contract.
  const seedCommand: CommandRow = {
    id: 'seed-save-workflow',
    room_id: CORNER,
    agent_id: AUDITOR,
    source_message_id: 'seed-save-workflow-msg',
    turn_request_id: 'seed-save-workflow-msg',
    action: 'input',
    reason: 'seed',
    root_command_id: 'seed-save-workflow',
    parent_command_id: null,
    root_source_message_id: 'seed-save-workflow-msg',
    agent_depth: 0,
    state: 'claimed',
    generation_id: null,
    lease_expires_at: null,
    result_message_id: null,
    hiccup_attempts: 0,
    lifecycle_before: null,
    restart_confirmed_at: null,
  };
  await saveWorkflow(
    database,
    seedCommand,
    { contract: describedLegacyWorkflowContract(CONTRACT) },
    undefined,
  );
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}, HOOK_TIMEOUT_MS);

/** A raw daemon-operation HTTP call, exactly what a live helper's command poller makes. */
async function call(name: string, payload: Record<string, unknown>, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} -> HTTP ${response.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

type Command = { id: string; room_id: string; agent_id: string; turn_request_id: string; root_command_id: string };

async function pendingCommandFor(agentId: string): Promise<Command> {
  const commands = (
    (await call('getAgentCommands', { roomId: CORNER }, tokenOf[agentId]!)).commands as Array<{
      id: string;
      roomId: string;
      agentId: string;
      turnRequestId: string;
      rootCommandId: string;
    }>
  ) ?? [];
  const found = commands[0];
  if (!found) throw new Error(`no pending command for ${agentId} in the corner`);
  return {
    id: found.id,
    room_id: found.roomId,
    agent_id: found.agentId,
    turn_request_id: found.turnRequestId,
    root_command_id: found.rootCommandId,
  };
}

/**
 * Claims a real turn for `agentId` and leaves `process.env` set up exactly
 * like a live helper spawning the agent MCP server for this turn: the
 * `BEELINE_TURN_CONTEXT_FILE` is the SAME `CommandExecutionContext` the real
 * daemon core writes per turn, carrying the claimed generation.
 */
async function claimTurn(agentId: string, command: Command, scratchRoot: string): Promise<CommandExecutionContext> {
  const context = new CommandExecutionContext(scratchRoot);
  await context.enter({
    roomId: CORNER,
    turnRequestId: command.turn_request_id,
    rootCommandId: command.root_command_id,
  } as AgentCommand);
  await call(
    'claimAgentCommand',
    { roomId: CORNER, commandId: command.id, generationId: context.generationId },
    tokenOf[agentId]!,
  );
  await call(
    'postAgentTurnReceipt',
    { roomId: CORNER, agentId, requestId: command.turn_request_id, generationId: context.generationId, status: 'working' },
    tokenOf[agentId]!,
  );
  return context;
}

/** Mounts `agentId`'s corner-turn env (parent Room + corner id) and calls one agent MCP tool. */
async function useToolRaw(
  agentId: string,
  context: CommandExecutionContext | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  process.env.BEELINE_DAEMON_BASE_URL = origin;
  process.env.BEELINE_DAEMON_TOKEN = tokenOf[agentId]!;
  process.env.BEELINE_DAEMON_AGENT_ID = agentId;
  process.env.BEELINE_DAEMON_ROOM_ID = PARENT_ROOM;
  process.env.BEELINE_DAEMON_CORNER_ID = CORNER;
  if (context) process.env.BEELINE_TURN_CONTEXT_FILE = context.path;
  else delete process.env.BEELINE_TURN_CONTEXT_FILE;
  return callAgentTool(name, args, `call-${Math.random().toString(16).slice(2)}`);
}

/** Same as `useToolRaw`, for the tools (start_workflow/get_workflow_run/handoff) that reply with JSON. */
async function useTool(
  agentId: string,
  context: CommandExecutionContext | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return JSON.parse(await useToolRaw(agentId, context, name, args)) as Record<string, unknown>;
}

async function seedHumanTag(agentId: string, text: string): Promise<Command> {
  const id = `seed-${agentId.slice(0, 8)}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    id,
    CORNER,
    HUMAN,
    text,
  ]);
  const row = await createAgentCommand(database, {
    roomId: CORNER,
    agentId,
    sourceMessageId: id,
    reason: 'human_tag',
  });
  if (!row) throw new Error(`failed to seed a command for ${agentId}`);
  return {
    id: row.id,
    room_id: row.room_id,
    agent_id: row.agent_id,
    turn_request_id: row.turn_request_id,
    root_command_id: row.root_command_id,
  };
}

it(
  'runs related-market-arbitrage-paper end to end inside a corner, through the real agent MCP tool handlers',
  { timeout: 60_000 },
  async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'beeline-workflow-e2e-'));
    roots.push(scratchRoot);

    const roleBindings = { scout: 'baby', verifier: 'vera', trader: 'trey', auditor: 'jellybean' };

    // ============================================================
    // Run A: the happy path, scout(batch) -> verify(passed) ->
    // simulate(filled) -> score(scored) -> done.
    // ============================================================
    const kickoffA = await seedHumanTag(AUDITOR, '@jellybean start the daily arb run');
    const auditorTurnA0 = await claimTurn(AUDITOR, kickoffA, scratchRoot);
    const started = await useTool(AUDITOR, auditorTurnA0, 'start_workflow', {
      name: CONTRACT.name,
      roleBindings,
    });
    const runA = started.runId as string;
    expect(runA).toBeTruthy();

    // Baby (scout) was woken automatically by the start card, in the CORNER —
    // not the parent Room. Before PR 2084 this get_workflow_run call sent the
    // parent Room id and the server answered 503.
    const scoutCommandA = await pendingCommandFor(SCOUT);
    expect(scoutCommandA.room_id).toBe(CORNER);
    const scoutTurnA = await claimTurn(SCOUT, scoutCommandA, scratchRoot);
    const scoutRead = await useTool(SCOUT, scoutTurnA, 'get_workflow_run', { runId: runA });
    expect(scoutRead).toMatchObject({ runId: runA, state: 'scout', role: 'scout', boundAgentId: SCOUT });
    expect(scoutRead.requiredFields).toEqual(['candidate_pairs', 'scan_scope', 'source_time']);
    const scoutHandoffA = await useTool(SCOUT, scoutTurnA, 'handoff', {
      runId: runA,
      outcome: 'batch',
      contents: { candidate_pairs: 7, scan_scope: 'us-equity-pairs', source_time: '2026-10-04T13:00:00Z' },
    });
    expect(scoutHandoffA).toMatchObject({ runId: runA, state: 'verify' });

    const verifierCommandA = await pendingCommandFor(VERIFIER);
    expect(verifierCommandA.room_id).toBe(CORNER);
    const verifierTurnA = await claimTurn(VERIFIER, verifierCommandA, scratchRoot);
    const verifierRead = await useTool(VERIFIER, verifierTurnA, 'get_workflow_run', { runId: runA });
    expect(verifierRead).toMatchObject({ runId: runA, state: 'verify', role: 'verifier', boundAgentId: VERIFIER });
    const verifierHandoffA = await useTool(VERIFIER, verifierTurnA, 'handoff', {
      runId: runA,
      outcome: 'passed',
      contents: { survivors: 5, rejections: 2, rule_evidence: 'spread>cost for 5/7 pairs' },
    });
    expect(verifierHandoffA).toMatchObject({ runId: runA, state: 'simulate' });

    const traderCommandA = await pendingCommandFor(TRADER);
    expect(traderCommandA.room_id).toBe(CORNER);
    const traderTurnA = await claimTurn(TRADER, traderCommandA, scratchRoot);
    const traderRead = await useTool(TRADER, traderTurnA, 'get_workflow_run', { runId: runA });
    expect(traderRead).toMatchObject({ runId: runA, state: 'simulate', role: 'trader', boundAgentId: TRADER });
    const traderHandoffA = await useTool(TRADER, traderTurnA, 'handoff', {
      runId: runA,
      outcome: 'filled',
      contents: {
        paper_fills: 5,
        rejections: 0,
        book_evidence: 'nbbo depth sufficient for all 5 legs',
        fee_model: 'maker-0.1bp',
      },
    });
    expect(traderHandoffA).toMatchObject({ runId: runA, state: 'score' });

    const auditorCommandA = await pendingCommandFor(AUDITOR);
    expect(auditorCommandA.room_id).toBe(CORNER);
    const auditorTurnA1 = await claimTurn(AUDITOR, auditorCommandA, scratchRoot);
    const auditorRead = await useTool(AUDITOR, auditorTurnA1, 'get_workflow_run', { runId: runA });
    expect(auditorRead).toMatchObject({ runId: runA, state: 'score', role: 'auditor', boundAgentId: AUDITOR });
    const auditorHandoffA = await useTool(AUDITOR, auditorTurnA1, 'handoff', {
      runId: runA,
      outcome: 'scored',
      contents: {
        funnel_counts: { scouted: 7, verified: 5, filled: 5 },
        net_paper_floor: 120.5,
        open_positions: 5,
        decision: 'approved',
        evidence: 'all 5 fills within fee model',
      },
    });
    expect(auditorHandoffA).toMatchObject({ runId: runA, state: 'done', status: 'done' });

    // From inside the corner, the auditor wakes tomorrow's scout by bare
    // @handle — exactly what Jellybean tried against Baby ("baby"), and
    // exactly what PR 2085 made work. `emit_event` replies with plain text
    // (not JSON), so its posted message is found back by querying the Room.
    const emittedText = await useToolRaw(AUDITOR, auditorTurnA1, 'emit_event', {
      kind: 'agent:handoff',
      consequence: "run A scored and closed; tomorrow's scan is clear to start",
      mentionAgentIds: ['baby'],
    });
    expect(emittedText).toBe('Posted agent:handoff in this Room and woke 1 agent(s).');
    const emittedMessage = await database.query<{ id: string }>(
      `SELECT id FROM messages WHERE room_id=$1 AND author_id=$2 AND system_event->>'kind'='agent:handoff'
       ORDER BY created_at DESC LIMIT 1`,
      [CORNER, AUDITOR],
    );
    const emittedId = emittedMessage.rows[0]?.id;
    expect(emittedId).toBeTruthy();
    const wokenByHandle = await database.query<{ agent_id: string }>(
      `SELECT agent_id FROM agent_commands WHERE source_message_id=$1`,
      [emittedId],
    );
    expect(wokenByHandle.rows.map((row) => row.agent_id)).toEqual([SCOUT]);

    const finalStateA = await database.query<{ to_state: string; status: string | null }>(
      `SELECT card->>'toState' to_state,card->>'status' status FROM messages
       WHERE room_id=$1 AND card_type='workflow-handoff' AND card->>'runId'=$2
       ORDER BY (card->>'seq')::int DESC LIMIT 1`,
      [CORNER, runA],
    );
    expect(finalStateA.rows[0]).toMatchObject({ to_state: 'done', status: 'done' });

    // ============================================================
    // Run B: the loop edge. verify(empty) sends the run back to scout
    // once (under the cap); the SECOND verify(empty) exceeds the cap
    // and is redirected straight to score, skipping simulate entirely.
    // ============================================================
    const kickoffB = await seedHumanTag(AUDITOR, '@jellybean start another arb run, quieter session');
    const auditorTurnB0 = await claimTurn(AUDITOR, kickoffB, scratchRoot);
    const startedB = await useTool(AUDITOR, auditorTurnB0, 'start_workflow', {
      name: CONTRACT.name,
      roleBindings,
    });
    const runB = startedB.runId as string;
    expect(runB).toBeTruthy();
    expect(runB).not.toBe(runA);

    const scoutCommandB1 = await pendingCommandFor(SCOUT);
    const scoutTurnB1 = await claimTurn(SCOUT, scoutCommandB1, scratchRoot);
    await useTool(SCOUT, scoutTurnB1, 'handoff', {
      runId: runB,
      outcome: 'batch',
      contents: { candidate_pairs: 3, scan_scope: 'us-equity-pairs', source_time: '2026-10-05T13:00:00Z' },
    });

    // First verify(empty): under the cap (0 prior -> 1), goes back to scout.
    const verifierCommandB1 = await pendingCommandFor(VERIFIER);
    const verifierTurnB1 = await claimTurn(VERIFIER, verifierCommandB1, scratchRoot);
    const verifyEmpty1 = await useTool(VERIFIER, verifierTurnB1, 'handoff', {
      runId: runB,
      outcome: 'empty',
      contents: { survivors: 0, rejections: 3, rule_evidence: 'no pair cleared the spread/cost bar' },
    });
    expect(verifyEmpty1).toMatchObject({ runId: runB, state: 'scout' });

    const scoutCommandB2 = await pendingCommandFor(SCOUT);
    const scoutTurnB2 = await claimTurn(SCOUT, scoutCommandB2, scratchRoot);
    await useTool(SCOUT, scoutTurnB2, 'handoff', {
      runId: runB,
      outcome: 'batch',
      contents: { candidate_pairs: 2, scan_scope: 'us-equity-pairs', source_time: '2026-10-05T13:30:00Z' },
    });

    // Second verify(empty) from state 'verify': the cap (1) is now exceeded,
    // so the engine redirects straight to the loop's onExceeded state
    // ('score'), skipping 'simulate' (the trader never touches this run).
    const verifierCommandB2 = await pendingCommandFor(VERIFIER);
    const verifierTurnB2 = await claimTurn(VERIFIER, verifierCommandB2, scratchRoot);
    const verifyEmpty2 = await useTool(VERIFIER, verifierTurnB2, 'handoff', {
      runId: runB,
      outcome: 'empty',
      contents: { survivors: 0, rejections: 2, rule_evidence: 'still nothing clears the bar' },
    });
    expect(verifyEmpty2).toMatchObject({ runId: runB, state: 'score' });

    const auditorCommandB = await pendingCommandFor(AUDITOR);
    expect(auditorCommandB.room_id).toBe(CORNER);
    const auditorTurnB1 = await claimTurn(AUDITOR, auditorCommandB, scratchRoot);
    const auditorReadB = await useTool(AUDITOR, auditorTurnB1, 'get_workflow_run', { runId: runB });
    expect(auditorReadB).toMatchObject({ runId: runB, state: 'score', role: 'auditor', boundAgentId: AUDITOR });
    const auditorHandoffB = await useTool(AUDITOR, auditorTurnB1, 'handoff', {
      runId: runB,
      outcome: 'scored',
      contents: {
        funnel_counts: { scouted: 5, verified: 0, filled: 0 },
        net_paper_floor: 0,
        open_positions: 0,
        decision: 'no-trade-day',
        evidence: 'both scans came back empty; loop cap exceeded into score',
      },
    });
    expect(auditorHandoffB).toMatchObject({ runId: runB, state: 'done', status: 'done' });

    // The trader (Trey) was never dispatched on run B at all.
    const traderDispatchedOnB = await database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='workflow-handoff'
         AND card->>'runId'=$2 AND card->>'fromState'='simulate'`,
      [CORNER, runB],
    );
    expect(traderDispatchedOnB.rowCount).toBe(0);
    // The loop actually exercised the cap: exactly two 'verify'->'empty' cards.
    const emptyLoopCards = await database.query(
      `SELECT card->>'toState' to_state FROM messages WHERE room_id=$1 AND card_type='workflow-handoff'
         AND card->>'runId'=$2 AND card->>'fromState'='verify' AND card->>'outcome'='empty'
       ORDER BY (card->>'seq')::int`,
      [CORNER, runB],
    );
    expect(emptyLoopCards.rows.map((row) => row.to_state)).toEqual(['scout', 'score']);
  },
);
