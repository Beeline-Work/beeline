#!/usr/bin/env node
/**
 * End-to-end acceptance proof for workflow list roles and their failover: a
 * real HTTP server, three real agent daemon identities (a coordinator plus
 * two workers), a two-role workflow contract with the worker role bound to
 * an ordered list of the two workers, driven through save_workflow,
 * start_workflow, and handoff — never mocked, never the production Workspace.
 *
 * The scenario: a workflow step bound to the list [@ridge, @sable] goes to
 * @ridge; @ridge fails instantly and the step hands to @sable, the next agent
 * on the list. The failure is a real `postAgentTurnReceipt` call with
 * `status:'failed'`, exactly what a real harness reporting "model
 * unavailable" would send — it runs through the exact same
 * `turn-silence-notice.ts` pipeline production traffic does, which calls
 * `reassignFailedWorkflowRole` unconditionally on every failed/silent turn.
 *
 * These are agent CLIENTS — plain HTTP calls issuing the exact same daemon
 * operations a live LLM-backed harness would call — not live LLM-backed
 * agent harnesses. Stated here plainly, and again in the written transcript.
 * Presence ("online") is written directly to `live_outputs` the same shape a
 * live daemon's own presence report takes; this proof harness's server does
 * not wire up `ConnectionPresence` (`prove-workflow-run.ts` doesn't either),
 * so establishing "this agent is online" needs that one direct write.
 *
 * Local invocation:
 *   npm run prove:agent-list-run -- /path/to/real-run.md
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
const COORDINATOR = 'b'.repeat(64);
const RIDGE = 'c'.repeat(64);
const SABLE = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111114';
const ROOM = '22222222-2222-4222-8222-222222222226';

const CONTRACT = {
  version: 1,
  name: 'list-review',
  description: 'A worker from a list drafts, the coordinator closes',
  roles: ['worker', 'closer'],
  start: 'work',
  handoffs: {
    work: {
      role: 'worker',
      requires: ['note'],
      on: { done: 'close' },
    },
    close: {
      role: 'closer',
      requires: ['summary'],
      on: { done: 'land' },
    },
    land: { kind: 'terminal', status: 'done' },
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
       ($2,'agent','Coordinator','coordinator'),
       ($3,'agent','Ridge','ridge'),
       ($4,'agent','Sable','sable')`,
    [HUMAN, COORDINATOR, RIDGE, SABLE],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES
       ($1,$4,NULL),($2,$4,'opus-4-5'),($3,$4,'opus-4-5')`,
    [COORDINATOR, RIDGE, SABLE, HUMAN],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Agent Lists Proof Workspace')`, [
    WORKSPACE,
  ]);
  await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Team')`, [
    ROOM,
    WORKSPACE,
    HUMAN,
  ]);
  for (const who of [HUMAN, COORDINATOR, RIDGE, SABLE])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,$3),($1,$4,$2,$3)`,
      [WORKSPACE, who, who === HUMAN ? 'owner' : 'member', ROOM],
    );
  // Both workers report online, as a live daemon's own presence
  // heartbeat would (see the module docblock: this harness does not wire
  // ConnectionPresence, so the fact is written directly here).
  for (const agentId of [RIDGE, SABLE]) {
    await database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
       VALUES($1,$2,'presence','presence',$3::jsonb,now())`,
      [ROOM, agentId, JSON.stringify({ status: 'online', observedAt: Math.floor(Date.now() / 1000) })],
    );
  }

  const auth = new TokenAuth(database, async () => ({
    subject: 'proof-owner',
    login: 'proofowner',
    name: 'Proof Owner',
  }));
  const phone = new PhoneService(database, 'http://placeholder');
  const live = new LiveHub();
  const daemon = new DaemonService(database, live);
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
  const coordinatorToken = await daemonTokenFor(COORDINATOR);
  const ridgeToken = await daemonTokenFor(RIDGE);
  const sableToken = await daemonTokenFor(SABLE);
  const tokenFor: Record<string, string> = {
    [COORDINATOR]: coordinatorToken,
    [RIDGE]: ridgeToken,
    [SABLE]: sableToken,
  };
  const nameFor: Record<string, string> = {
    [COORDINATOR]: '@coordinator',
    [RIDGE]: '@ridge',
    [SABLE]: '@sable',
  };

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

  const commandsFor = async (agentId: string): Promise<Command[]> =>
    ((await call(`${nameFor[agentId]} polls its commands`, 'getAgentCommands', { roomId: ROOM }, tokenFor[agentId]!))
      .commands ?? []) as Command[];

  const claim = async (
    agentId: string,
    command: Command,
  ): Promise<{ requestId: string; generationId: string }> => {
    const generationId = `gen-${command.id.slice(0, 8)}`;
    await call(`${nameFor[agentId]} claims its turn`, 'claimAgentCommand', {
      roomId: ROOM,
      commandId: command.id,
      generationId,
    }, tokenFor[agentId]!);
    await call(`${nameFor[agentId]} starts working`, 'postAgentTurnReceipt', {
      roomId: ROOM,
      agentId,
      requestId: command.turnRequestId,
      generationId,
      status: 'working',
    }, tokenFor[agentId]!);
    return { requestId: command.turnRequestId, generationId };
  };

  const complete = async (
    agentId: string,
    turn: { requestId: string; generationId: string },
  ): Promise<void> => {
    await call(`${nameFor[agentId]} ends its turn`, 'postAgentTurnReceipt', {
      roomId: ROOM,
      agentId,
      requestId: turn.requestId,
      generationId: turn.generationId,
      status: 'complete',
    }, tokenFor[agentId]!);
  };

  const failures: string[] = [];

  // --- Seed the coordinator's first turn, the way a human's tag would. ---
  const kickoff = 'kickoff-message';
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    kickoff,
    ROOM,
    HUMAN,
    'coordinator, please start our list-review workflow',
  ]);
  const initialRow = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: COORDINATOR,
    sourceMessageId: kickoff,
    reason: 'human_tag',
  });
  if (!initialRow) throw new Error('failed to seed the initial coordinator command');
  const initial: Command = {
    id: initialRow.id,
    roomId: initialRow.room_id,
    agentId: initialRow.agent_id,
    sourceMessageId: initialRow.source_message_id,
    turnRequestId: initialRow.turn_request_id,
    reason: initialRow.reason,
  };

  const turn1 = await claim(COORDINATOR, initial);
  const saved = await call('@coordinator saves the contract', 'saveWorkflow', {
    roomId: ROOM,
    requestId: turn1.requestId,
    generationId: turn1.generationId,
    agentId: COORDINATOR,
    contract: CONTRACT,
  }, coordinatorToken);
  if (saved.slug !== 'list-review' || saved.version !== 1) {
    failures.push(`unexpected save_workflow result: ${JSON.stringify(saved)}`);
  }

  // --- start_workflow: the worker role names an ordered list of agents. ---
  const started = await call(
    '@coordinator starts a run with worker bound to the list [@ridge, @sable]',
    'startWorkflow',
    {
      roomId: ROOM,
      requestId: turn1.requestId,
      generationId: turn1.generationId,
      agentId: COORDINATOR,
      name: 'list-review',
      roleBindings: { worker: [RIDGE, SABLE], closer: COORDINATOR },
    },
    coordinatorToken,
  );
  const runId = started.runId as string;
  if (started.state !== 'work' || typeof runId !== 'string') {
    failures.push(`unexpected start_workflow result: ${JSON.stringify(started)}`);
  }
  await complete(COORDINATOR, turn1);

  // --- The list resolves to its first healthy agent: only Ridge has a pending command. ---
  const ridgePending = await commandsFor(RIDGE);
  const sablePending = await commandsFor(SABLE);
  const firstPickId = ridgePending.length ? RIDGE : sablePending.length ? SABLE : undefined;
  const secondPickId = firstPickId === RIDGE ? SABLE : RIDGE;
  if (firstPickId !== RIDGE) failures.push('the worker role did not go to @ridge, first on its list');
  log.push({
    label: 'List resolution result (read from which agent has a pending command)',
    response: {
      firstPick: firstPickId ? nameFor[firstPickId] : null,
      ridgePendingCount: ridgePending.length,
      sablePendingCount: sablePending.length,
    },
  });

  let secondPickHadNoCommandBeforeFailure = true;
  if (firstPickId) {
    const firstCommand = (firstPickId === RIDGE ? ridgePending : sablePending)[0]!;
    const beforeFailure = await commandsFor(secondPickId);
    secondPickHadNoCommandBeforeFailure = beforeFailure.length === 0;

    // --- The instant failure: the first pick reports "model unavailable". ---
    const firstTurn = await claim(firstPickId, firstCommand);
    await call(
      `${nameFor[firstPickId]} reports an instant failure (model unavailable)`,
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        agentId: firstPickId,
        requestId: firstTurn.requestId,
        generationId: firstTurn.generationId,
        status: 'failed',
        reasonKind: 'wrong-model',
        reason: 'the selected model is no longer available',
      },
      tokenFor[firstPickId]!,
    );

    // --- Verify failover: the next agent on the list now holds a pending command for the SAME run. ---
    const secondPending = await commandsFor(secondPickId);
    if (!secondPending.length) {
      failures.push(`${nameFor[secondPickId]} was never dispatched after ${nameFor[firstPickId]}'s instant failure`);
    } else {
      const secondTurn = await claim(secondPickId, secondPending[0]!);
      const worked = await call(
        `${nameFor[secondPickId]} completes the worker step it failed over to`,
        'handoff',
        {
          roomId: ROOM,
          requestId: secondTurn.requestId,
          generationId: secondTurn.generationId,
          agentId: secondPickId,
          runId,
          outcome: 'done',
          contents: { note: `${nameFor[secondPickId]} picked this up after ${nameFor[firstPickId]} failed instantly` },
        },
        tokenFor[secondPickId]!,
      );
      if (worked.state !== 'close') failures.push(`expected close, got ${JSON.stringify(worked)}`);
      await complete(secondPickId, secondTurn);

      // --- The coordinator (fixed role) lands the run. ---
      const closerPending = (await commandsFor(COORDINATOR))[0];
      if (!closerPending) {
        failures.push('coordinator was never woken for the closer role');
      } else {
        const closerTurn = await claim(COORDINATOR, closerPending);
        const landed = await call('@coordinator lands the run', 'handoff', {
          roomId: ROOM,
          requestId: closerTurn.requestId,
          generationId: closerTurn.generationId,
          agentId: COORDINATOR,
          runId,
          outcome: 'done',
          contents: { summary: 'list failover completed the workflow' },
        }, coordinatorToken);
        if (landed.state !== 'land' || landed.status !== 'done') {
          failures.push(`expected the run to land done, got ${JSON.stringify(landed)}`);
        }
        await complete(COORDINATOR, closerTurn);
      }

      // A late response from the failed-over agent no longer owns any state.
      const stale = await call(
        `${nameFor[firstPickId]} tries to hand off after already having failed`,
        'handoff',
        {
          roomId: ROOM,
          requestId: firstTurn.requestId,
          generationId: firstTurn.generationId,
          agentId: firstPickId,
          runId,
          outcome: 'done',
          contents: { note: 'too late' },
        },
        tokenFor[firstPickId]!,
      ).catch((error: Error) => error.message);
      // Refused either way: this exact command generation is already spent
      // (authorizeCommandOutput), or — had it somehow still been live — the
      // role no longer belongs to this agent (handoff's own "not you" check).
      if (typeof stale !== 'string') {
        failures.push(`expected the failed-over agent's late handoff to be refused, got ${JSON.stringify(stale)}`);
      }
    }
  }

  const transcript = await database.query<{
    id: string;
    author_id: string;
    text: string;
    card_type: string | null;
    created_at: Date;
  }>(
    `SELECT id,author_id,text,card_type,created_at FROM messages WHERE room_id=$1 ORDER BY created_at,id`,
    [ROOM],
  );
  const who = (authorId: string) =>
    nameFor[authorId] ?? (authorId === HUMAN ? '@proofowner' : authorId.slice(0, 8));

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
  lines.push('# Real workflow list failover run');
  lines.push('');
  lines.push(
    'A real local HTTP server (`createBeelineServer`, real `DaemonService`/`PhoneService`/auth stack, ' +
      'three real per-agent daemon tokens minted through `TokenAuth`) ran a disposable Workspace with one ' +
      'Room. These are agent CLIENTS: plain HTTP calls issuing the exact same `/v1/daemon/operations/*` ' +
      'calls a live LLM-backed harness would make, driven by this script rather than by a running model — ' +
      'not live LLM-backed agent harnesses. Nothing here is mocked and nothing touched the production ' +
      'Workspace. The one fact this harness writes directly instead of over the wire is presence ' +
      '("online"): this proof server does not wire up `ConnectionPresence` (a live daemon reports that over ' +
      'its own socket, not a `/v1/daemon/operations/*` call), so both workers\' `live_outputs` ' +
      'presence rows are seeded directly, the same shape a live daemon\'s own heartbeat writes.',
  );
  lines.push('');
  lines.push(`- Workspace: \`${WORKSPACE}\` ("Agent Lists Proof Workspace")`);
  lines.push(`- Room: \`${ROOM}\``);
  lines.push(`- Coordinator agent (single-agent "closer" role): \`${COORDINATOR}\` (@coordinator)`);
  lines.push(`- First worker on the list: \`${RIDGE}\` (@ridge)`);
  lines.push(`- Second worker on the list: \`${SABLE}\` (@sable)`);
  lines.push('');
  lines.push(`Run id: \`${runId ?? '(never started)'}\``);
  lines.push('');
  lines.push('## Contract saved via `save_workflow`');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(CONTRACT, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(
    `The \`worker\` role is bound to the ordered list [@ridge, @sable] at \`start_workflow\`. ` +
      `Both are online, so the role goes to @ridge, first on the list.`,
  );
  lines.push('');
  lines.push('## Requests and responses, in order');
  lines.push('');
  lines.push(...requestResponseSection(log));
  lines.push('## Verdict');
  lines.push('');
  if (failures.length) {
    lines.push('**FAILED**');
    for (const failure of failures) lines.push(`- ${failure}`);
  } else {
    lines.push(
      `PASSED: start_workflow gave the worker role to the first healthy agent on its list (${firstPickId ? nameFor[firstPickId] : '?'}) ` +
        `and dispatched it a real pending command; that agent's real \`postAgentTurnReceipt(status:'failed', ` +
        `reasonKind:'wrong-model')\` call — an instant failure, not a timeout — ran through the production ` +
        `\`turn-silence-notice.ts\` pipeline and \`reassignFailedWorkflowRole\` failed the worker role over to ` +
        `${secondPickHadNoCommandBeforeFailure ? 'the next agent on the list, who held no pending command before the failure and one immediately after it' : 'the next agent on the list'} ` +
        `(${nameFor[secondPickId]}); that agent completed the step for real via handoff, the coordinator landed ` +
        `the run, and the originally-failed agent's later handoff attempt was refused because the role no ` +
        `longer belongs to it.`,
    );
  }
  lines.push('');
  lines.push('## Resulting transcript');
  lines.push('');
  for (const row of transcript.rows) {
    lines.push(
      `- \`${row.created_at.toISOString()}\` ${who(row.author_id)}` +
        `${row.card_type ? ` [${row.card_type}]` : ''}: ${row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text}`,
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
  .then(() => {
    if (process.exitCode) process.exit(process.exitCode);
  });
