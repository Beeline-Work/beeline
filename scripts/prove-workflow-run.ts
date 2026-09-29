#!/usr/bin/env node
/**
 * End-to-end acceptance proof for the core workflow-contract model: a real
 * HTTP server, two real agent daemon identities, a small two-role contract
 * with one capped loop, driven start to finish through save_workflow,
 * start_workflow, and handoff — never mocked, never the production
 * Workspace.
 *
 * Writes a human-readable transcript of every request and every Room message
 * produced to the path given as argv[2] (or prints it to stdout).
 *
 * Local invocation:
 *   npm run prove:workflow-run -- /path/to/real-run.md
 */
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { migrate } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { createAgentCommand } from '../apps/server/src/agent-command.js';

const HUMAN = 'a'.repeat(64);
const WRITER = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

const CONTRACT = {
  version: 1,
  name: 'draft-review',
  description: 'Draft a note and get it reviewed',
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
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Team')`,
    [ROOM, WORKSPACE, HUMAN],
  );
  for (const who of [HUMAN, WRITER, REVIEWER])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,$3),($1,$4,$2,$3)`,
      [WORKSPACE, who, who === HUMAN ? 'owner' : 'member', ROOM],
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
    dailyJobLimit: 20,
    leaseMs: 60_000,
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

  const commandsFor = async (agentId: string, token: string): Promise<Command[]> =>
    ((await call(`${agentId} polls its commands`, 'getAgentCommands', { roomId: ROOM }, token))
      .commands ?? []) as Command[];

  /** Claim the given command and post a `working` receipt, exactly as a real daemon does. */
  const claim = async (
    agentId: string,
    token: string,
    command: Command,
  ): Promise<{ requestId: string; generationId: string }> => {
    const generationId = `gen-${command.id.slice(0, 8)}`;
    await call(`${agentId} claims its turn`, 'claimAgentCommand', {
      roomId: ROOM,
      commandId: command.id,
      generationId,
    }, token);
    await call(`${agentId} starts working`, 'postAgentTurnReceipt', {
      roomId: ROOM,
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
  ): Promise<void> => {
    await call(`${agentId} ends its turn`, 'postAgentTurnReceipt', {
      roomId: ROOM,
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
  }, writerToken);
  if (draft1.state !== 'review') throw new Error(`expected review, got ${JSON.stringify(draft1)}`);
  await complete(WRITER, writerToken, turn1);

  // --- Turn 2 (reviewer): request changes (first pass through the capped loop). ---
  const reviewerPending1 = (await commandsFor(REVIEWER, reviewerToken))[0];
  if (!reviewerPending1) throw new Error('reviewer was never woken for the first review');
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

  const transcript = await database.query<{
    id: string;
    author_id: string;
    text: string;
    card_type: string | null;
    created_at: Date;
  }>(`SELECT id,author_id,text,card_type,created_at FROM messages WHERE room_id=$1 ORDER BY created_at,id`, [
    ROOM,
  ]);

  const lines: string[] = [];
  lines.push('# Real two-agent workflow run');
  lines.push('');
  lines.push(
    `A real local HTTP server (\`createBeelineServer\`, real \`DaemonService\`/\`PhoneService\`/auth stack, ` +
      `two real per-agent daemon tokens minted through \`TokenAuth\`) ran a disposable Workspace and Room. ` +
      `Nothing here is mocked and nothing touched the production Workspace.`,
  );
  lines.push('');
  lines.push(`- Workspace: \`${WORKSPACE}\` ("Workflow Proof Workspace")`);
  lines.push(`- Room: \`${ROOM}\` ("Team")`);
  lines.push(`- Writer agent: \`${WRITER}\` (@wren)`);
  lines.push(`- Reviewer agent: \`${REVIEWER}\` (@revi)`);
  lines.push(`- Run id: \`${runId}\``);
  lines.push('');
  lines.push('## Contract saved via `save_workflow`');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(CONTRACT, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Requests and responses, in order');
  lines.push('');
  for (const entry of log) {
    lines.push(`### ${entry.label}`);
    lines.push('');
    if (entry.request) {
      lines.push('Request:');
      lines.push('```json');
      lines.push(JSON.stringify(entry.request, null, 2));
      lines.push('```');
    }
    lines.push('Response:');
    lines.push('```json');
    lines.push(JSON.stringify(entry.response, null, 2));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Resulting Room transcript');
  lines.push('');
  for (const row of transcript.rows) {
    const who = row.author_id === HUMAN ? '@proofowner' : row.author_id === WRITER ? '@wren' : '@revi';
    lines.push(
      `- \`${row.created_at.toISOString()}\` ${who}${row.card_type ? ` [${row.card_type}]` : ''}: ${row.text}`,
    );
  }
  lines.push('');
  lines.push('## Verdict');
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

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();

  const output = lines.join('\n');
  const target = process.argv[2];
  if (target) {
    await writeFile(target, output, 'utf8');
    console.log(`wrote transcript to ${target}`);
  } else {
    console.log(output);
  }
  if (failures.length) {
    console.error(`\nFAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPASSED');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
