#!/usr/bin/env node
/**
 * End-to-end acceptance proof for the core workflow-contract model: a real
 * HTTP server, two real agent daemon identities, a small two-role contract
 * with one capped loop, driven start to finish through save_workflow,
 * start_workflow, and handoff — never mocked, never the production
 * Workspace.
 *
 * A second scenario (P1 follow-up) proves `save_skill`: one agent saves a
 * procedure directly from a Room conversation (no corner, no merge review),
 * and a different agent in a different Room of the same Workspace sees it in
 * its own per-turn index and loads it via `load_workspace_skill`.
 *
 * A third scenario proves the member-handle role binding fix: a bare handle
 * (no `@`) binds the member, and a word that is no current member's handle
 * is refused at start.
 *
 * These are agent CLIENTS — plain HTTP calls issuing the exact same daemon
 * operations a live LLM-backed harness would call — not live LLM-backed
 * agent harnesses. Stated here plainly, and again in the written transcript.
 *
 * Writes a human-readable transcript of every request and every Room message
 * produced to the path given as argv[2] (or prints it to stdout).
 *
 * Local invocation:
 *   npm run prove:workflow-run -- /path/to/real-run.md
 */
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { migrate } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { createAgentCommand } from '../apps/server/src/agent-command.js';
import { AgentScheduleLoop } from '../apps/server/src/agent-schedules.js';

const HUMAN = createHash('sha256').update('github:proof-owner').digest('hex');
const WRITER = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const PERSONAL_ROOM = '33333333-3333-4333-8333-333333333333';

const SKILL_SLUG = 'cartoon-short-video';
const SKILL_DESCRIPTION = 'Storyboard and render a short cartoon clip';
const SKILL_MARKDOWN =
  '# Cartoon short video\n\n' +
  '1. Write a one-paragraph beat sheet before opening any tool.\n' +
  '2. Storyboard every shot on paper first; keep each shot under four seconds.\n' +
  '3. Render at 12fps for the animatic pass, 24fps for the final pass.\n' +
  '4. Mix a scratch voice track before final animation so timing is locked.\n'.padEnd(
    7_000,
    ' Keep every asset in one project folder so the render pipeline can find it.\n',
  );

const CONTRACT = {
  version: 1,
  name: 'draft-review',
  description: 'Draft a note and get it reviewed',
  summary: 'Draft a note, request review, and revise within a bounded loop.',
  roles: ['writer', 'reviewer'],
  start: 'draft',
  handoffs: {
    draft: {
      role: 'writer',
      requires: ['text'],
      on: { submitted: 'review' },
    },
    review: {
      role: 'reviewer',
      hint: 'the review decision and evidence',
      requires: ['verdict'],
      on: { approved: 'done', changes_requested: 'draft' },
      loop: { onEdge: 'changes_requested', cap: 1, onExceeded: 'failed' },
    },
    done: { kind: 'terminal', status: 'done' },
    failed: { kind: 'terminal', status: 'failed' },
  },
};

type Command = {
  id: string;
  roomId: string;
  agentId: string;
  sourceMessageId: string;
  turnRequestId: string;
  reason: string;
  source?: { body: string };
};

/** A one-role flow used to prove a bare member handle binds that member. */
const CANDY_CONTRACT = {
  version: 1,
  name: 'handle-flow',
  description: 'A triager role bound to a member by bare handle',
  roles: ['triager'],
  start: 'triage',
  handoffs: {
    triage: { role: 'triager', requires: ['note'], on: { done: 'finished' } },
    finished: { kind: 'terminal', status: 'done' },
  },
};

const WAKE_CONTRACT = {
  version: 1,
  name: 'wake-proof',
  description: 'Verify timeout and gate wake context',
  roles: ['writer', 'reviewer'],
  start: 'wait',
  handoffs: {
    wait: { role: 'writer', requires: [], on: { advance: 'gate', timeout: 'gate' }, timeoutSeconds: 3600 },
    gate: { kind: 'gate', role: 'reviewer', requires: [], on: { approved: 'done', rejected: 'done' } },
    done: { kind: 'terminal', status: 'done' },
  },
};

type LogEntry = { label: string; request?: unknown; response: unknown };

async function main(): Promise<void> {
  const log: LogEntry[] = [];
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Proof Owner','proofowner'),
       ($2,'agent','Wren','wren'),
       ($3,'agent','Revi','revi')`,
    [HUMAN, WRITER, REVIEWER],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    WRITER,
    REVIEWER,
    HUMAN,
  ]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workflow Proof Workspace')`, [
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES
       ($1,$3,$4,'Team'),($2,$3,$4,'Personal')`,
    [ROOM, PERSONAL_ROOM, WORKSPACE, HUMAN],
  );
  for (const who of [HUMAN, WRITER, REVIEWER])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,$3),($1,$4,$2,$3)`,
      [WORKSPACE, who, who === HUMAN ? 'owner' : 'member', ROOM],
    );
  // The writer alone also holds the Personal Room the skill will be saved
  // from, so load_workspace_skill's cross-Room visibility is genuinely
  // cross-Room: the reviewer, who loads it, is never a member of Personal.
  for (const who of [HUMAN, WRITER])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
      [WORKSPACE, PERSONAL_ROOM, who, who === HUMAN ? 'owner' : 'member'],
    );

  const auth = new TokenAuth(database, async () => ({
    subject: 'proof-owner',
    login: 'proofowner',
    name: 'Proof Owner',
  }));
  const phone = new PhoneService(database, 'http://placeholder');
  const live = new LiveHub();
  const daemon = new DaemonService(database, live, undefined, undefined, false, undefined, false, undefined, undefined, undefined, {
    enabled: true,
    live: true,
  });
  const server = createBeelineServer({
    database,
    auth,
    phone,
    daemon,
    live,
    mediaMaximumBytes: 1024 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const daemonTokenFor = async (agentId: string) => {
    const exchange = await auth.createDaemonExchange(agentId);
    return (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  };
  const writerToken = await daemonTokenFor(WRITER);
  const reviewerToken = await daemonTokenFor(REVIEWER);

  const call = async (label: string, name: string, payload: unknown, token: string) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      log.push({
        label,
        request: { operation: name, ...(payload as object) },
        response: { httpStatus: response.status, ...(text ? JSON.parse(text) : {}) },
      });
      throw new Error(`${label} (${name}) -> HTTP ${response.status} ${text}`);
    }
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    log.push({ label, request: { operation: name, ...(payload as object) }, response: parsed });
    return parsed;
  };

  const commandsFor = async (agentId: string, token: string, roomId = ROOM): Promise<Command[]> =>
    ((await call(`${agentId} polls its commands`, 'getAgentCommands', { roomId }, token))
      .commands ?? []) as Command[];

  /** Claim the given command and post a `working` receipt, exactly as a real daemon does. */
  const claim = async (
    agentId: string,
    token: string,
    command: Command,
    roomId = ROOM,
  ): Promise<{ requestId: string; generationId: string }> => {
    const generationId = `gen-${command.id.slice(0, 8)}`;
    await call(`${agentId} claims its turn`, 'claimAgentCommand', {
      roomId,
      commandId: command.id,
      generationId,
    }, token);
    await call(`${agentId} starts working`, 'postAgentTurnReceipt', {
      roomId,
      agentId,
      requestId: command.turnRequestId,
      generationId,
      status: 'working',
    }, token);
    return { requestId: command.turnRequestId, generationId };
  };

  const complete = async (
    agentId: string,
    token: string,
    turn: { requestId: string; generationId: string },
    roomId = ROOM,
  ): Promise<void> => {
    await call(`${agentId} ends its turn`, 'postAgentTurnReceipt', {
      roomId,
      agentId,
      requestId: turn.requestId,
      generationId: turn.generationId,
      status: 'complete',
    }, token);
  };

  // Seed the very first turn the way a human's addressed message would: this
  // is scaffolding (an ordinary Room command), not something under test.
  const kickoff = 'kickoff-message';
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    kickoff,
    ROOM,
    HUMAN,
    'wren, please define and start our draft-review workflow',
  ]);
  const initialRow = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: WRITER,
    sourceMessageId: kickoff,
    reason: 'human_tag',
  });
  if (!initialRow) throw new Error('failed to seed the initial writer command');
  const initial: Command = {
    id: initialRow.id,
    roomId: initialRow.room_id,
    agentId: initialRow.agent_id,
    sourceMessageId: initialRow.source_message_id,
    turnRequestId: initialRow.turn_request_id,
    reason: initialRow.reason,
  };

  // --- Turn 1 (writer): save the contract and start a run. ---
  const turn1 = await claim(WRITER, writerToken, initial);
  const saved = await call(WRITER + ' saves the contract', 'saveWorkflow', {
    roomId: ROOM,
    requestId: turn1.requestId,
    generationId: turn1.generationId,
    agentId: WRITER,
    contract: CONTRACT,
  }, writerToken);
  if (saved.slug !== 'draft-review' || saved.version !== 1) {
    throw new Error(`unexpected save_workflow result: ${JSON.stringify(saved)}`);
  }
  const started = await call(WRITER + ' starts a run', 'startWorkflow', {
    roomId: ROOM,
    requestId: turn1.requestId,
    generationId: turn1.generationId,
    agentId: WRITER,
    name: 'draft-review',
    roleBindings: { writer: WRITER, reviewer: REVIEWER },
  }, writerToken);
  const runId = started.runId as string;
  if (started.state !== 'draft' || typeof runId !== 'string') {
    throw new Error(`unexpected start_workflow result: ${JSON.stringify(started)}`);
  }
  // --- Turn 1 continues: the writer submits its first draft. ---
  const draft1 = await call(WRITER + ' hands off the draft', 'handoff', {
    roomId: ROOM,
    requestId: turn1.requestId,
    generationId: turn1.generationId,
    agentId: WRITER,
    runId,
    outcome: 'submitted',
    contents: { text: 'Draft v1: the workflow ships next Tuesday.' },
    receipt: { line: 'Drafted the launch note.', refs: [
      { kind: 'file', label: 'Draft note', url: 'https://example.com/draft.txt' },
    ] },
  }, writerToken);
  if (draft1.state !== 'review') throw new Error(`expected review, got ${JSON.stringify(draft1)}`);
  const previewToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
  const previewResponse = await fetch(`${origin}/v1/phone/operations/readWorkflowRun`, {
    method: 'POST', headers: { authorization: `Bearer ${previewToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: ROOM, runId }),
  });
  if (!previewResponse.ok) throw new Error(`live readWorkflowRun returned HTTP ${previewResponse.status}`);
  const preview = await previewResponse.json() as { run?: { activeRunIds?: readonly string[] } };
  log.push({ label: 'A person opens the live workflow run', response: preview });
  if (!preview.run?.activeRunIds?.includes(runId))
    throw new Error(`live workflow read did not expose active run ${runId}`);
  const listResponse = await fetch(`${origin}/v1/phone/operations/listRoomWorkflowRuns`, {
    method: 'POST', headers: { authorization: `Bearer ${previewToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: ROOM }),
  });
  const listedRuns = await listResponse.json() as {
    workflows?: { workflowSlug: string; activeRunIds?: readonly string[] }[];
  };
  log.push({ label: 'A person lists live workflow runs', response: { httpStatus: listResponse.status, ...listedRuns } });
  if (!listResponse.ok || !listedRuns.workflows?.some((entry) =>
    entry.workflowSlug === 'draft-review' && entry.activeRunIds?.includes(runId)))
    throw new Error('workflow list did not expose its active run id');
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(preview), 'utf8');
  await complete(WRITER, writerToken, turn1);

  // --- Turn 2 (reviewer): request changes (first pass through the capped loop). ---
  const reviewerPending1 = (await commandsFor(REVIEWER, reviewerToken))[0];
  if (!reviewerPending1) throw new Error('reviewer was never woken for the first review');
  if (!reviewerPending1.source?.body.includes(`You are in run ${runId} of draft-review. Continue this run; do not start a new one.`))
    throw new Error('reviewer wake omitted its run id and continuation instruction');
  if (!reviewerPending1.source?.body.includes('the review decision and evidence'))
    throw new Error('the dispatched reviewer did not receive the state receipt hint');
  const turn2 = await claim(REVIEWER, reviewerToken, reviewerPending1);
  const review1 = await call(REVIEWER + ' requests changes', 'handoff', {
    roomId: ROOM,
    requestId: turn2.requestId,
    generationId: turn2.generationId,
    agentId: REVIEWER,
    runId,
    outcome: 'changes_requested',
    contents: { verdict: 'needs a launch date' },
  }, reviewerToken);
  if (review1.state !== 'draft') {
    throw new Error(`expected the capped loop to send this back to draft, got ${JSON.stringify(review1)}`);
  }
  await complete(REVIEWER, reviewerToken, turn2);

  // --- Turn 3 (writer): submit a second draft. ---
  const writerPending2 = (await commandsFor(WRITER, writerToken))[0];
  if (!writerPending2) throw new Error('writer was never woken after review requested changes');
  const turn3 = await claim(WRITER, writerToken, writerPending2);
  const draft2 = await call(WRITER + ' hands off a second draft', 'handoff', {
    roomId: ROOM,
    requestId: turn3.requestId,
    generationId: turn3.generationId,
    agentId: WRITER,
    runId,
    outcome: 'submitted',
    contents: { text: 'Draft v2: the workflow ships next Tuesday at 10am PT.' },
  }, writerToken);
  if (draft2.state !== 'review') throw new Error(`expected review, got ${JSON.stringify(draft2)}`);
  await complete(WRITER, writerToken, turn3);

  // --- Turn 4 (reviewer): request changes AGAIN — this is the loop's cap ---
  // (cap=1): the second "changes_requested" traversal must be redirected to
  // the loop's own onExceeded terminal instead of back to draft.
  const reviewerPending2 = (await commandsFor(REVIEWER, reviewerToken))[0];
  if (!reviewerPending2) throw new Error('reviewer was never woken for the second review');
  const turn4 = await claim(REVIEWER, reviewerToken, reviewerPending2);
  const review2 = await call(REVIEWER + ' requests changes again (loop cap)', 'handoff', {
    roomId: ROOM,
    requestId: turn4.requestId,
    generationId: turn4.generationId,
    agentId: REVIEWER,
    runId,
    outcome: 'changes_requested',
    contents: { verdict: 'still not there' },
  }, reviewerToken);
  await complete(REVIEWER, reviewerToken, turn4);

  const failures: string[] = [];
  if (review2.state !== 'failed' || review2.status !== 'failed') {
    failures.push(
      `expected the capped loop to force the run to the terminal "failed" state, got ${JSON.stringify(review2)}`,
    );
  }
  // One more real turn for the reviewer (seeded the same scaffolding way the
  // very first turn was) to prove a handoff on an already-ended run is
  // refused as a business rule, not merely because no turn is active.
  const strayMessage = 'stray-followup-message';
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    strayMessage,
    ROOM,
    HUMAN,
    'revi, can you take another look?',
  ]);
  const strayRow = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: REVIEWER,
    sourceMessageId: strayMessage,
    reason: 'human_tag',
  });
  if (!strayRow) throw new Error('failed to seed the stray follow-up command');
  const stray: Command = {
    id: strayRow.id,
    roomId: strayRow.room_id,
    agentId: strayRow.agent_id,
    sourceMessageId: strayRow.source_message_id,
    turnRequestId: strayRow.turn_request_id,
    reason: strayRow.reason,
  };
  const turn5 = await claim(REVIEWER, reviewerToken, stray);
  const laterHandoff = await call(REVIEWER + ' tries to act on the ended run', 'handoff', {
    roomId: ROOM,
    requestId: turn5.requestId,
    generationId: turn5.generationId,
    agentId: REVIEWER,
    runId,
    outcome: 'approved',
    contents: { verdict: 'too late' },
  }, reviewerToken).catch((error: Error) => error.message);
  await complete(REVIEWER, reviewerToken, turn5);
  if (typeof laterHandoff !== 'string' || !laterHandoff.includes('already ended')) {
    failures.push(`expected a handoff on the ended run to be refused, got ${JSON.stringify(laterHandoff)}`);
  }

  // A person opens the run through the same authenticated operation the app uses.
  const { accessToken } = await auth.exchangeGitHubOidc('proof');
  const response = await fetch(`${origin}/v1/phone/operations/readWorkflowRun`, {
    method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: ROOM, runId }),
  });
  if (!response.ok) throw new Error(`readWorkflowRun returned HTTP ${response.status}`);
  const detail = await response.json() as import('../packages/api-contract/src/phone.js').WorkflowRunDetailView;
  log.push({ label: 'A person opens the workflow run', request: { operation: 'readWorkflowRun', roomId: ROOM, runId }, response: detail });
  if (detail.contract.summary !== CONTRACT.summary ||
      detail.history[1]?.receipt?.line !== 'Drafted the launch note.' ||
      detail.history[1]?.receipt?.refs?.[0]?.kind !== 'file' ||
      detail.history[1]?.receipt?.exit.actorId !== WRITER ||
      detail.history[2]?.receipt?.line !== undefined ||
      detail.history[2]?.receipt?.refs !== undefined)
    failures.push('phone read did not preserve the summary, supplied receipt, engine actor, or empty receipt');
  const part1LogCount = log.length;
  const skillFailures: string[] = [];
  // ================= Scenario 2: save_skill cross-Room visibility =================
  // The writer saves a procedure directly from a Personal-Room conversation
  // (no corner, no merge review), and the reviewer — who is not a member of
  // Personal at all — sees it in its own per-turn index in the Team Room and
  // loads it via load_workspace_skill. This is the P1 follow-up: an agent
  // previously had no way to do this and wrongly proposed opening a corner.
  const skillKickoff = 'skill-kickoff-message';
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    skillKickoff,
    PERSONAL_ROOM,
    HUMAN,
    'wren, save what we just figured out about making a cartoon short video as a skill',
  ]);
  const skillCommandRow = await createAgentCommand(database, {
    roomId: PERSONAL_ROOM,
    agentId: WRITER,
    sourceMessageId: skillKickoff,
    reason: 'human_tag',
  });
  if (!skillCommandRow) throw new Error('failed to seed the writer skill-save command');
  const skillCommand: Command = {
    id: skillCommandRow.id,
    roomId: skillCommandRow.room_id,
    agentId: skillCommandRow.agent_id,
    sourceMessageId: skillCommandRow.source_message_id,
    turnRequestId: skillCommandRow.turn_request_id,
    reason: skillCommandRow.reason,
  };
  const skillTurn = await claim(WRITER, writerToken, skillCommand, PERSONAL_ROOM);
  const savedSkill = await call(WRITER + ' saves a skill directly from conversation', 'saveSkill', {
    roomId: PERSONAL_ROOM,
    requestId: skillTurn.requestId,
    generationId: skillTurn.generationId,
    agentId: WRITER,
    slug: SKILL_SLUG,
    description: SKILL_DESCRIPTION,
    markdown: SKILL_MARKDOWN,
  }, writerToken);
  if (savedSkill.slug !== SKILL_SLUG || savedSkill.version !== 1) {
    skillFailures.push(`unexpected save_skill result: ${JSON.stringify(savedSkill)}`);
  }
  await complete(WRITER, writerToken, skillTurn, PERSONAL_ROOM);

  // A message in the Team Room whose words overlap the skill's slug/
  // description, so the reviewer's per-turn index has something to match.
  const skillDiscoveryMessage = 'skill-discovery-message';
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    skillDiscoveryMessage,
    ROOM,
    HUMAN,
    'revi, can you help me storyboard a short cartoon video?',
  ]);
  const discoveryCommandRow = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: REVIEWER,
    sourceMessageId: skillDiscoveryMessage,
    reason: 'human_tag',
  });
  if (!discoveryCommandRow) throw new Error('failed to seed the reviewer discovery command');
  const discoveryCommand: Command = {
    id: discoveryCommandRow.id,
    roomId: discoveryCommandRow.room_id,
    agentId: discoveryCommandRow.agent_id,
    sourceMessageId: discoveryCommandRow.source_message_id,
    turnRequestId: discoveryCommandRow.turn_request_id,
    reason: discoveryCommandRow.reason,
  };
  const discoveryTurn = await claim(REVIEWER, reviewerToken, discoveryCommand);
  const discovered = await call(REVIEWER + " reads its per-turn index (getInstitutionalContext)", 'getInstitutionalContext', {
    roomId: ROOM,
    requestId: discoveryTurn.requestId,
    generationId: discoveryTurn.generationId,
    agentId: REVIEWER,
  }, reviewerToken);
  const indexLine = `Procedure ${SKILL_SLUG} (load_workspace_skill): ${SKILL_DESCRIPTION}`;
  const indexText = String((discovered as { text?: unknown }).text ?? '');
  if (!indexText.includes(indexLine)) {
    skillFailures.push(
      `expected the reviewer's per-turn index to list the skill, got: ${JSON.stringify(discovered)}`,
    );
  }
  const loadedSkill = await call(REVIEWER + ' loads it via load_workspace_skill', 'loadWorkspaceSkill', {
    roomId: ROOM,
    requestId: discoveryTurn.requestId,
    generationId: discoveryTurn.generationId,
    agentId: REVIEWER,
    slug: SKILL_SLUG,
  }, reviewerToken);
  const loadedMarkdown = String((loadedSkill as { markdown?: unknown }).markdown ?? '');
  if (!loadedMarkdown.includes('Write a one-paragraph beat sheet')) {
    skillFailures.push(`expected the loaded skill to carry its saved body, got: ${JSON.stringify(loadedSkill)}`);
  }
  if (String((loadedSkill as { sourceRoomId?: unknown }).sourceRoomId) !== PERSONAL_ROOM) {
    skillFailures.push(
      `expected the loaded skill's sourceRoomId to be the Personal Room it was saved from, got: ${JSON.stringify(loadedSkill)}`,
    );
  }
  await complete(REVIEWER, reviewerToken, discoveryTurn);
  const part2LogCount = log.length;

  const handleFailures: string[] = [];
  // ========== Scenario 3: a bare member handle binds the member at start ==========
  // The reported defect: "triager: \"candy\"" (a member's handle, no @) was read
  // as a class/tag word, so the run started and stranded at its first state.
  // The fix: a word matching a current member's handle binds that member, and
  // any other word is refused at start.
  const handleKickoff = 'handle-kickoff-message';
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    handleKickoff,
    ROOM,
    HUMAN,
    'wren, start the handle-flow workflow with triager bound to wren',
  ]);
  const handleCommandRow = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: WRITER,
    sourceMessageId: handleKickoff,
    reason: 'human_tag',
  });
  if (!handleCommandRow) throw new Error('failed to seed the writer handle-flow command');
  const handleCommand: Command = {
    id: handleCommandRow.id,
    roomId: handleCommandRow.room_id,
    agentId: handleCommandRow.agent_id,
    sourceMessageId: handleCommandRow.source_message_id,
    turnRequestId: handleCommandRow.turn_request_id,
    reason: handleCommandRow.reason,
  };
  const handleTurn = await claim(WRITER, writerToken, handleCommand);
  const savedHandleFlow = await call(WRITER + ' saves the handle-flow contract', 'saveWorkflow', {
    roomId: ROOM,
    requestId: handleTurn.requestId,
    generationId: handleTurn.generationId,
    agentId: WRITER,
    contract: CANDY_CONTRACT,
  }, writerToken);
  if (savedHandleFlow.slug !== 'handle-flow') {
    handleFailures.push(`unexpected save_workflow result: ${JSON.stringify(savedHandleFlow)}`);
  }
  // The reported input, verbatim: a bare member handle with no @.
  const handleStarted = await call(WRITER + " starts a run binding the triager by bare handle 'wren'", 'startWorkflow', {
    roomId: ROOM,
    requestId: handleTurn.requestId,
    generationId: handleTurn.generationId,
    agentId: WRITER,
    name: 'handle-flow',
    roleBindings: { triager: 'wren' },
  }, writerToken);
  const handleRunId = handleStarted.runId as string;
  if (handleStarted.state !== 'triage' || typeof handleRunId !== 'string') {
    handleFailures.push(`unexpected start_workflow result: ${JSON.stringify(handleStarted)}`);
  }
  const handleBinding = await database.query<{ triager: string }>(
    `SELECT card->'roleBindings'->>'triager' triager FROM messages WHERE id=$1`,
    [handleRunId],
  );
  if (handleBinding.rows[0]?.triager !== WRITER) {
    handleFailures.push(
      `expected the bare handle "wren" to bind the member ${WRITER} (@wren), got ${JSON.stringify(handleBinding.rows[0]?.triager)}`,
    );
  }
  const triagerCommands = await database.query<{ count: string }>(
    `SELECT count(*)::text count FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending'`,
    [ROOM, WRITER],
  );
  if (Number(triagerCommands.rows[0]?.count ?? 0) < 1) {
    handleFailures.push('expected the bound member @wren to be dispatched a pending command for the triage state');
  }
  await complete(WRITER, writerToken, handleTurn);
  const taggedMessage = 'handle-flow-human-tag';
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@wren please continue this run')`,
    [taggedMessage, ROOM, HUMAN]);
  const taggedCommand = await createAgentCommand(database, {
    roomId: ROOM, agentId: WRITER, sourceMessageId: taggedMessage, reason: 'human_tag',
  });
  if (!taggedCommand) throw new Error('human tag did not create a command');
  const taggedTurn = await claim(WRITER, writerToken, {
    id: taggedCommand.id, roomId: ROOM, agentId: WRITER,
    sourceMessageId: taggedCommand.source_message_id,
    turnRequestId: taggedCommand.turn_request_id, reason: taggedCommand.reason,
  });
  const duplicateError = await call(WRITER + ' tries to start the active handle-flow after a human tag', 'startWorkflow', {
    roomId: ROOM,
    requestId: taggedTurn.requestId,
    generationId: taggedTurn.generationId,
    agentId: WRITER,
    name: 'handle-flow',
    roleBindings: { triager: 'wren' },
  }, writerToken).catch((error: Error) => error.message);
  if (typeof duplicateError !== 'string' || !duplicateError.includes(
    `You are already in run ${handleRunId} of handle-flow. Continue it or hand off within it.`,
  )) handleFailures.push(`expected the current role to be refused a second run, got ${JSON.stringify(duplicateError)}`);
  await call(WRITER + ' finishes the handle-flow run', 'handoff', {
    roomId: ROOM,
    requestId: taggedTurn.requestId,
    generationId: taggedTurn.generationId,
    agentId: WRITER,
    runId: handleRunId,
    outcome: 'done',
    contents: { note: 'finished' },
  }, writerToken);
  // A word that is no member's handle must be refused at start, before any run is written.
  const unknownClassError = await call(WRITER + " tries a word that is no member's handle", 'startWorkflow', {
    roomId: ROOM,
    requestId: taggedTurn.requestId,
    generationId: taggedTurn.generationId,
    agentId: WRITER,
    name: 'handle-flow',
    roleBindings: { triager: 'nobodycarriesthis' },
  }, writerToken).catch((error: Error) => error.message);
  if (typeof unknownClassError !== 'string' || !unknownClassError.includes('must be an agent id or a member handle')) {
    handleFailures.push(
      `expected the at-start refusal for an unknown word, got ${JSON.stringify(unknownClassError)}`,
    );
  }
  await complete(WRITER, writerToken, taggedTurn);
  const part3LogCount = log.length;

  // Drive a due schedule through the real scheduler and HTTP operation boundary.
  const scheduleId = '44444444-4444-4444-8444-444444444444';
  await database.query(
    `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
     VALUES($1,$2,$3,$4,$4,$5::jsonb,'Start handle-flow',now()-interval '1 minute')`,
    [scheduleId, WORKSPACE, ROOM, WRITER, JSON.stringify({ kind: 'interval', everyMinutes: 60 })],
  );
  if (await new AgentScheduleLoop(database).runOnce() !== 1) throw new Error('schedule did not fire');
  const scheduled = (await commandsFor(WRITER, writerToken)).find((entry) => entry.reason === 'schedule');
  if (!scheduled) throw new Error('scheduled agent command was not delivered');
  const scheduledTurn = await claim(WRITER, writerToken, scheduled);
  const schedulePayload = {
    roomId: ROOM,
    requestId: scheduledTurn.requestId,
    generationId: scheduledTurn.generationId,
    agentId: WRITER,
    name: 'handle-flow',
    roleBindings: { triager: REVIEWER },
  };
  const scheduledRun = await call('schedule starts handle-flow', 'startWorkflow', schedulePayload, writerToken);
  const scheduledRunId = scheduledRun.runId as string;
  const scheduleRetry = await call('same schedule period retries handle-flow', 'startWorkflow', schedulePayload, writerToken)
    .catch((error: Error) => error.message);
  if (typeof scheduleRetry !== 'string' || !scheduleRetry.includes(`active run ${scheduledRunId} started by this schedule for this period`))
    throw new Error(`schedule retry did not name its active run: ${JSON.stringify(scheduleRetry)}`);
  const adminToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
  const adminResponse = await fetch(`${origin}/v1/phone/operations/startOwnedWorkflow`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: ROOM, name: 'handle-flow', roleBindings: { triager: REVIEWER } }),
  });
  const adminResult = await adminResponse.json() as { runId?: string };
  log.push({ label: 'human admin overrides the active schedule run', response: { httpStatus: adminResponse.status, ...adminResult } });
  if (!adminResponse.ok || !adminResult.runId || adminResult.runId === scheduledRunId)
    throw new Error(`human admin override failed: ${JSON.stringify(adminResult)}`);
  const adminCard = await database.query<{ author_id: string }>(`SELECT author_id FROM messages WHERE id=$1`, [adminResult.runId]);
  if (adminCard.rows[0]?.author_id !== HUMAN) throw new Error('override was not attributed to the human');
  const scheduleList = await call('agent reads its active schedule runs', 'listAgentSchedules', { roomId: ROOM, agentId: WRITER }, writerToken) as {
    schedules?: { scheduleId: string; activeRunIds?: readonly string[] }[];
  };
  if (!scheduleList.schedules?.find((entry) =>
    entry.scheduleId === scheduleId && entry.activeRunIds?.includes(scheduledRunId)))
    throw new Error('list_schedules did not expose the active scheduled run');
  await complete(WRITER, writerToken, scheduledTurn);

  const wakeMessage = 'wake-proof-message';
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'test workflow wakes')`,
    [wakeMessage, ROOM, HUMAN]);
  const wakeCommand = await createAgentCommand(database, {
    roomId: ROOM, agentId: WRITER, sourceMessageId: wakeMessage, reason: 'human_tag',
  });
  if (!wakeCommand) throw new Error('wake proof command was not created');
  const wakeTurn = await claim(WRITER, writerToken, {
    id: wakeCommand.id, roomId: ROOM, agentId: WRITER,
    sourceMessageId: wakeCommand.source_message_id,
    turnRequestId: wakeCommand.turn_request_id, reason: wakeCommand.reason,
  });
  await call('writer saves the wake proof workflow', 'saveWorkflow', {
    roomId: ROOM, requestId: wakeTurn.requestId, generationId: wakeTurn.generationId,
    agentId: WRITER, contract: WAKE_CONTRACT,
  }, writerToken);
  const wakeRun = await call('writer starts the wake proof workflow', 'startWorkflow', {
    roomId: ROOM, requestId: wakeTurn.requestId, generationId: wakeTurn.generationId,
    agentId: WRITER, name: 'wake-proof', roleBindings: { writer: WRITER, reviewer: REVIEWER },
  }, writerToken);
  const wakeRunId = wakeRun.runId as string;
  await database.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE workflow_run->>'runId'=$1`,
    [wakeRunId]);
  if (await new AgentScheduleLoop(database).runOnce() !== 1) throw new Error('workflow timeout did not fire');
  const timeoutWake = (await commandsFor(WRITER, writerToken)).find((entry) =>
    entry.source?.body.includes(`You are in run ${wakeRunId} of wake-proof. Continue this run; do not start a new one.`)
    && entry.reason === 'schedule');
  if (!timeoutWake) throw new Error('timeout wake omitted its run context');
  log.push({ label: 'writer receives the state timeout wake', response: timeoutWake });
  await call('writer advances to the gate', 'handoff', {
    roomId: ROOM, requestId: wakeTurn.requestId, generationId: wakeTurn.generationId,
    agentId: WRITER, runId: wakeRunId, outcome: 'advance', contents: {},
  }, writerToken);
  const openGate = (await database.query<{ id: string; options: { optionId: string; label: string }[] }>(
    `SELECT id,options FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND status='open'`, [ROOM, REVIEWER],
  )).rows[0];
  if (!openGate) throw new Error('workflow gate was not posted');
  const approved = openGate.options.find((entry) => entry.label === 'approved');
  if (!approved) throw new Error('workflow gate has no approved option');
  const answerResponse = await fetch(`${origin}/v1/phone/operations/answerChoice`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ choiceId: openGate.id, optionId: approved.optionId, note: 'ship it, but watch the logs' }),
  });
  const answerResult = await answerResponse.json() as Record<string, unknown>;
  log.push({ label: 'human answers the workflow gate', response: { httpStatus: answerResponse.status, ...answerResult } });
  if (!answerResponse.ok) throw new Error(`workflow gate answer failed: ${JSON.stringify(answerResult)}`);
  const gateWake = (await commandsFor(REVIEWER, reviewerToken)).find((entry) =>
    entry.source?.body.includes(`You are in run ${wakeRunId} of wake-proof. Continue this run; do not start a new one.`));
  if (!gateWake) throw new Error('settled gate wake omitted its run context');
  log.push({ label: 'reviewer receives the settled gate wake', response: gateWake });
  if (!gateWake.source?.body.includes('Their note with the answer: "ship it, but watch the logs"'))
    throw new Error('settled gate wake omitted the answer note');
  const runResponse = await fetch(`${origin}/v1/phone/operations/readWorkflowRun`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: ROOM, runId: wakeRunId }),
  });
  const runDetail = await runResponse.json() as { history?: { gate?: { answer?: string; note?: string } }[] };
  const answeredGate = runDetail.history?.find((step) => step.gate?.answer === 'approved')?.gate;
  log.push({ label: 'the run shows the gate answer and its note', response: { httpStatus: runResponse.status, gate: answeredGate } });
  if (answeredGate?.note !== 'ship it, but watch the logs') throw new Error('run view omitted the gate answer note');
  await complete(WRITER, writerToken, wakeTurn);

  const transcript = await database.query<{
    id: string;
    room_id: string;
    author_id: string;
    text: string;
    card_type: string | null;
    created_at: Date;
  }>(
    `SELECT id,room_id,author_id,text,card_type,created_at FROM messages
     WHERE room_id=ANY($1::uuid[]) ORDER BY created_at,id`,
    [[ROOM, PERSONAL_ROOM]],
  );

  const roomName = (roomId: string) => (roomId === ROOM ? 'Team' : 'Personal');
  const who = (authorId: string) =>
    authorId === HUMAN ? '@proofowner' : authorId === WRITER ? '@wren' : '@revi';

  const requestResponseSection = (entries: LogEntry[]): string[] => {
    const out: string[] = [];
    for (const entry of entries) {
      out.push(`### ${entry.label}`);
      out.push('');
      if (entry.request) {
        out.push('Request:');
        out.push('```json');
        out.push(JSON.stringify(entry.request, null, 2));
        out.push('```');
      }
      out.push('Response:');
      out.push('```json');
      out.push(JSON.stringify(entry.response, null, 2));
      out.push('```');
      out.push('');
    }
    return out;
  };

  const lines: string[] = [];
  lines.push('# Real two-agent workflow run');
  lines.push('');
  lines.push(
    `A real local HTTP server (\`createBeelineServer\`, real \`DaemonService\`/\`PhoneService\`/auth stack, ` +
      `two real per-agent daemon tokens minted through \`TokenAuth\`) ran a disposable Workspace with two ` +
      `Rooms. These are agent CLIENTS: plain HTTP calls issuing the exact same \`/v1/daemon/operations/*\` ` +
      `calls a live LLM-backed harness would make, driven by this script rather than by a running model — ` +
      `not live LLM-backed agent harnesses. Nothing here is mocked and nothing touched the production ` +
      `Workspace.`,
  );
  lines.push('');
  lines.push(`- Workspace: \`${WORKSPACE}\` ("Workflow Proof Workspace")`);
  lines.push(`- Team Room: \`${ROOM}\``);
  lines.push(`- Personal Room: \`${PERSONAL_ROOM}\``);
  lines.push(`- Writer agent: \`${WRITER}\` (@wren)`);
  lines.push(`- Reviewer agent: \`${REVIEWER}\` (@revi)`);
  lines.push('');
  lines.push('## Scenario 1: save_workflow, start_workflow, handoff');
  lines.push('');
  lines.push(`Run id: \`${runId}\``);
  lines.push('');
  lines.push('### Contract saved via `save_workflow`');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(CONTRACT, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### Requests and responses, in order');
  lines.push('');
  lines.push(...requestResponseSection(log.slice(0, part1LogCount)));
  lines.push('### Verdict');
  lines.push('');
  if (failures.length) {
    lines.push('**FAILED**');
    for (const failure of failures) lines.push(`- ${failure}`);
  } else {
    lines.push(
      'PASSED: save_workflow validated and stored the contract, start_workflow bound both roles and ' +
        'dispatched the first state, four real handoff() calls advanced the run across both agents, the ' +
        "capped loop's second traversal was redirected to its own onExceeded terminal instead of the " +
        'agent-requested target, and a handoff on the ended run was refused.',
    );
  }
  lines.push('');
  lines.push(
    '## Scenario 2: save_skill saved from one Room, discovered and loaded from another (P1 follow-up)',
  );
  lines.push('');
  lines.push(
    `@wren saves a procedure directly from a Personal-Room conversation — no corner, no merge review — ` +
      `and @revi, who is not a member of Personal at all, sees it in its own per-turn index while working ` +
      `in Team and loads it via \`load_workspace_skill\`.`,
  );
  lines.push('');
  lines.push('### Requests and responses, in order');
  lines.push('');
  lines.push(...requestResponseSection(log.slice(part1LogCount, part2LogCount)));
  lines.push('### Verdict');
  lines.push('');
  if (skillFailures.length) {
    lines.push('**FAILED**');
    for (const failure of skillFailures) lines.push(`- ${failure}`);
  } else {
    lines.push(
      'PASSED: save_skill validated and stored the procedure from a Personal-Room conversation with no ' +
        'corner and no merge review; a different agent with no membership in that Room saw it in its own ' +
        "per-turn index (`Procedure cartoon-short-video (load_workspace_skill): ...`) while working in a " +
        'different Room of the same Workspace, and loaded its full body via load_workspace_skill.',
    );
  }
  lines.push('');
  lines.push(
    '## Scenario 3: a bare member handle binds the member; an unknown word is refused at start',
  );
  lines.push('');
  lines.push(
    `@wren starts the one-role \`handle-flow\` workflow with \`roleBindings: { triager: "wren" }\` — a ` +
      `bare member handle with no @. The member @wren is bound and dispatched; after that run ends, the same turn tries ` +
      `\`roleBindings: { triager: "nobodycarriesthis" }\`, a word that is no current member's handle, ` +
      `which the server refuses at start instead of stranding a run.`,
  );
  lines.push('');
  lines.push('### Requests and responses, in order');
  lines.push('');
  lines.push(...requestResponseSection(log.slice(part2LogCount, part3LogCount)));
  lines.push('### Verdict');
  lines.push('');
  if (handleFailures.length) {
    lines.push('**FAILED**');
    for (const failure of handleFailures) lines.push(`- ${failure}`);
  } else {
    lines.push(
      'PASSED: start_workflow read the bare handle "wren" as the member @wren and bound and dispatched ' +
        'that exact agent (its id appears in the run card), and a word that is no current member\'s ' +
        'handle was refused at start with the "must be an agent id or a member handle" refusal ' +
        'before any run card was written.',
    );
  }
  lines.push('');
  lines.push('## Scenario 4: workflow run wakes and duplicate-run guard');
  lines.push('');
  lines.push(`An ordinary human tag woke the current role, which refused a duplicate of run \`${handleRunId}\`. The scheduler started run \`${scheduledRunId}\`; ` +
    `a retry for that schedule period was refused, while the human admin started a distinct run \`${adminResult.runId}\`. ` +
    `A state timeout and an answered gate both woke their agents with run \`${wakeRunId}\` and its workflow name.`);
  lines.push('');
  lines.push('### Requests and responses, in order');
  lines.push('');
  lines.push(...requestResponseSection(log.slice(part3LogCount)));
  lines.push('### Verdict');
  lines.push('');
  lines.push('PASSED: the live daemon and phone operations exposed exact run IDs in wakes, duplicate refusals, schedule reads, active workflow reads, and the human-attributed admin override.');
  lines.push('');
  lines.push('## Resulting transcript, both Rooms');
  lines.push('');
  for (const row of transcript.rows) {
    lines.push(
      `- \`${row.created_at.toISOString()}\` [${roomName(row.room_id)}] ${who(row.author_id)}` +
        `${row.card_type ? ` [${row.card_type}]` : ''}: ${row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text}`,
    );
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();

  const allFailures = [...failures, ...skillFailures, ...handleFailures];
  const output = lines.join('\n');
  const target = process.argv[2];
  if (target) {
    await writeFile(target, output, 'utf8');
    console.log(`wrote transcript to ${target}`);
  } else {
    console.log(output);
  }
  if (allFailures.length) {
    console.error(`\nFAILED: ${allFailures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPASSED: Live workflow HTTP proof, including run wakes, duplicate refusals, schedule visibility, and human admin override.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
