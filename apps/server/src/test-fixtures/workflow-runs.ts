// Shared isolated database/provider fixture for the workflow test files.
import { describedWorkflow, migratedDatabase } from "../../../../tests/helpers/server.js";
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, vi } from 'vitest';
import type { QueryResultRow } from 'pg';
import { type QueryResult, type SqlDatabase } from '../database.js';
import { PgliteDatabase } from "../../../../tests/helpers/server.js";
import { createAgentCommand, type CommandRow } from '../agent-command.js';
import { AgentScheduleLoop } from '../agent-schedules.js';
import { handoff, getWorkflowRun, saveWorkflow, settleWorkflowGate, startWorkflow } from '../workflow-runs.js';

/**
 * Records every SQL statement issued through this wrapper, in order,
 * including inside nested `transaction()` calls (PGlite's own transaction
 * primitive serializes fully on its single embedded connection, so it never
 * surfaces a `BEGIN` through the `SqlDatabase.query()` interface handoff()
 * writes against — only the statements the application code itself issues
 * are recorded here). This is how P0-1's fix is proven: not by reproducing
 * genuine concurrent Postgres connections (PGlite architecturally cannot —
 * see the concurrency describe block below), but by asserting the run lock
 * is the first thing handoff() does, before it ever reads the run's state.
 */
type RecordedCall = { sql: string; values?: unknown[] };

export class RecordingDatabase implements SqlDatabase {
  constructor(
    private readonly inner: SqlDatabase,
    readonly calls: RecordedCall[] = [],
  ) {}
  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
    return this.inner.query<Row>(sql, values);
  }
  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.inner.transaction((db) => work(new RecordingDatabase(db, this.calls)));
  }
}

export const WORKSPACE = '10000000-0000-4000-8000-000000000001';

export const ROOM = '20000000-0000-4000-8000-000000000001';

export const OWNER = 'a'.repeat(64);

export const IMPLEMENTER = 'b'.repeat(64);

export const REVIEWER = 'c'.repeat(64);

export const APPROVER = 'd'.repeat(64);

export const OUTSIDER = 'e'.repeat(64);

export const WORKER_A = '1'.repeat(64);

export const WORKER_B = '2'.repeat(64);

export let database: PgliteDatabase;

export const CONTRACT = {
  version: 1,
  name: 'corner',
  description: 'Implement, get checks green, get reviewed, and land a change',
  roles: ['implementer', 'reviewer', 'approver'],
  start: 'implement',
  handoffs: {
    implement: {
      role: 'implementer',
      requires: ['summary', 'prUrl'],
      on: { pushed: 'checks', stuck: 'ask_human' },
    },
    checks: {
      role: 'implementer',
      requires: ['headSha'],
      on: { passing: 'review', failing: 'implement' },
      loop: { onEdge: 'failing', cap: 2, onExceeded: 'ask_human' },
    },
    review: {
      role: 'reviewer',
      requires: ['verdict', 'notes'],
      on: { approved: 'human_approve', changes_requested: 'implement' },
      loop: { onEdge: 'changes_requested', cap: 2, onExceeded: 'ask_human' },
    },
    human_approve: {
      kind: 'gate',
      role: 'approver',
      requires: ['decision'],
      on: { approved: 'land', rejected: 'implement' },
    },
    ask_human: {
      kind: 'gate',
      role: 'approver',
      requires: ['decision'],
      on: { resume: 'implement', abandon: 'failed' },
    },
    land: { kind: 'terminal', status: 'done' },
    failed: { kind: 'terminal', status: 'failed' },
  },
};

export async function rootMessage(authorId: string, text = 'kick off the workflow'): Promise<string> {
  const id = `${authorId}-root-${Math.random().toString(16).slice(2)}`;
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    id,
    ROOM,
    authorId,
    text,
  ]);
  return id;
}

export async function commandFor(agentId: string, sourceMessageId?: string): Promise<CommandRow> {
  const sourceId = sourceMessageId ?? (await rootMessage(agentId === OWNER ? OWNER : IMPLEMENTER));
  const command = await createAgentCommand(database, {
    roomId: ROOM,
    agentId,
    sourceMessageId: sourceId,
    reason: 'test',
  });
  if (!command) throw new Error('failed to create test command');
  return command;
}

/** Editing or archiving a saved workflow is workspace-admin-only: run it from a human Workspace owner's message. */
export async function adminCommand(): Promise<CommandRow> {
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')
     ON CONFLICT DO NOTHING`,
    [WORKSPACE, OWNER],
  );
  return commandFor(IMPLEMENTER, await rootMessage(OWNER));
}

export async function pendingCommandsFor(agentId: string): Promise<number> {
  const rows = await database.query<{ count: string }>(
    `SELECT count(*)::text count FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending'`,
    [ROOM, agentId],
  );
  return Number(rows.rows[0]?.count ?? 0);
}

export async function reportPresence(agentId: string, status: 'online' | 'offline'): Promise<void> {
  await database.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
     VALUES($1,$2,'presence','presence',$3::jsonb,now())
     ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
    [ROOM, agentId, JSON.stringify({ status, observedAt: Math.floor(Date.now() / 1000) })],
  );
}

beforeEach(async () => {
  vi.mocked(randomBytes).mockReset();
  const crypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  vi.mocked(randomBytes).mockImplementation(crypto.randomBytes);
  database = await migratedDatabase();
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Owner'),($2,'agent','Impy'),($3,'agent','Ravi'),($4,'agent','Ada'),($5,'human','Outsider'),
       ($6,'agent','WorkerA'),($7,'agent','WorkerB')`,
    [OWNER, IMPLEMENTER, REVIEWER, APPROVER, OUTSIDER, WORKER_A, WORKER_B],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Team')`, [
    ROOM,
    WORKSPACE,
    OWNER,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$2,$6,'member'),
       ($1,$2,$7,'member'),($1,$2,$8,'member')`,
    [WORKSPACE, ROOM, OWNER, IMPLEMENTER, REVIEWER, APPROVER, WORKER_A, WORKER_B],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$2,'opus-4-5'),($3,$2,'opus-4-5')`,
    [WORKER_A, OWNER, WORKER_B],
  );
  await reportPresence(WORKER_A, 'online');
  await reportPresence(WORKER_B, 'online');
});

afterEach(async () => {
  await database.close();
});

/** The MM desk contract from the experiments Room; it passes the validator as written. */
export const MM_DESK = {
  version: 1,
  name: 'mm-desk-day',
  description: 'One UTC day of the MM desk: watch, risk, summary',
  roles: ['watcher', 'risk', 'summarizer'],
  start: 'watch',
  handoffs: {
    watch: {
      role: 'watcher',
      requires: ['note'],
      on: { escalate: 'risk', kill: 'kill_switch', close_day: 'summary' },
    },
    risk: {
      role: 'risk',
      requires: ['assessment'],
      on: { resume: 'watch', kill: 'kill_switch' },
      loop: { onEdge: 'resume', cap: 30, onExceeded: 'too_many_escalations' },
    },
    too_many_escalations: {
      kind: 'gate',
      role: 'risk',
      requires: ['decision'],
      on: { keep_going: 'watch', stop: 'stopped' },
    },
    kill_switch: {
      kind: 'gate',
      role: 'risk',
      requires: ['reason'],
      on: { resume: 'watch', stop: 'stopped' },
    },
    summary: { role: 'summarizer', requires: ['summary'], on: { posted: 'done' } },
    done: { kind: 'terminal', status: 'done' },
    stopped: { kind: 'terminal', status: 'failed' },
  },
};

export async function createSchedule(agentId: string, scheduleId: string): Promise<void> {
  await database.query(
    `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
     VALUES($1,$2,$3,$4,$4,$5::jsonb,'run the workflow',now())`,
    [scheduleId, WORKSPACE, ROOM, agentId, JSON.stringify({ kind: 'interval', everyMinutes: 60 })],
  );
}

export async function scheduleOccurrence(
  scheduleId: string,
  messageId: string,
  scheduledFor = new Date('2026-01-01T00:00:00Z'),
): Promise<void> {
  await database.query(
    `INSERT INTO agent_schedule_occurrences(schedule_id,scheduled_for,message_id) VALUES($1,$2,$3)`,
    [scheduleId, scheduledFor, messageId],
  );
}

/**
 * `rootAuthorId` defaults to the (agent) IMPLEMENTER, matching ordinary
 * dispatch; pass a human identity (e.g. OWNER) to simulate a human-started
 * run for tests exercising the human-facing gate choice card, which only an
 * agent-started run's starter now bypasses.
 */
export async function startedRun(rootAuthorId: string = IMPLEMENTER): Promise<{ runId: string }> {
  const command = await commandFor(IMPLEMENTER, await rootMessage(rootAuthorId));
  await saveWorkflow(database, command, { contract: describedWorkflow(CONTRACT)});
  return startWorkflow(database, command, {
    name: 'corner',
    roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
  });
}

/** A person answers (or skips) the run's open gate card. */
export async function answerGate(runId: string, label?: string, viewerId = OWNER) {
  const choice = (
    await database.query<{ id: string; options: { optionId: string; label: string }[] }>(
      `SELECT choice.id,choice.options FROM room_choices choice JOIN messages message ON message.id=choice.message_id
       WHERE choice.room_id=$1 AND choice.status='open' AND message.card->>'runId'=$2`,
      [ROOM, runId],
    )
  ).rows[0]!;
  return database.transaction(async (db) =>
    settleWorkflowGate(db, label === undefined
      ? { choiceId: choice.id, viewerId, skip: true }
      : { choiceId: choice.id, viewerId, optionId: choice.options.find((option) => option.label === label)!.optionId }),
  );
}

/** The newest workflow card of a run, i.e. the message a wake cites. */
export async function latestRunCard(runId: string): Promise<string> {
  return (
    await database.query<{ id: string }>(
      `SELECT id FROM messages WHERE room_id=$1 AND card_type='workflow-handoff'
         AND card->>'runId'=$2 ORDER BY (card->>'seq')::int DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
      [ROOM, runId],
    )
  ).rows[0]!.id;
}

export async function driveToApprovalGate(runId: string): Promise<void> {
  let command = await commandFor(IMPLEMENTER);
  await handoff(database, command, { runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' } });
  command = await commandFor(IMPLEMENTER);
  await handoff(database, command, { runId, outcome: 'passing', contents: { headSha: 'abc' } });
  command = await commandFor(REVIEWER);
  await handoff(database, command, {
    runId,
    outcome: 'approved',
    contents: { verdict: 'approve', notes: 'lgtm' },
  });
}

// A list role names an ordered list of agents instead of one; the run gives
// it to the first healthy agent on the list and fails over down the list.
export const LIST_CONTRACT = {
  version: 1,
  name: 'list-flow',
  description: 'A worker role bound to an ordered list of agents',
  roles: ['worker', 'closer'],
  start: 'work',
  handoffs: {
    work: {
      role: 'worker',
      requires: ['note'],
      on: { done: 'close', retry: 'work', timeout: 'failed' },
      loop: { onEdge: 'retry', cap: 3, onExceeded: 'failed' },
      timeoutSeconds: 3600,
    },
    close: {
      role: 'closer',
      requires: ['note'],
      on: { done: 'land' },
    },
    land: { kind: 'terminal', status: 'done' },
    failed: { kind: 'terminal', status: 'failed' },
  },
};

export async function listRunCard(runId: string): Promise<{
  seq?: number;
  toState: string;
  roleBindings: Record<string, string>;
  roleAgents?: Record<string, string[]>;
  reassigned?: true;
}> {
  const row = await database.query<{ card: any }>(
    `SELECT card FROM messages WHERE room_id=$1 AND card_type='workflow-handoff' AND card->>'runId'=$2
     ORDER BY (card->>'seq')::int DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
    [ROOM, runId],
  );
  return row.rows[0]!.card;
}

export async function startedListRun(
  worker: string | string[] = [WORKER_A, WORKER_B],
  closer = APPROVER,
): Promise<{ runId: string }> {
  const command = await commandFor(IMPLEMENTER);
  await saveWorkflow(database, command, { contract: describedWorkflow(LIST_CONTRACT)});
  return startWorkflow(database, command, {
    name: 'list-flow',
    roleBindings: { worker, closer },
  });
}

/** Rewrite a saved version as an older one would be: this state with no timeout or default. */
export async function withoutTimeouts(slug: string, stateName: string): Promise<void> {
  const row = (await database.query<{ skill_id: string; version: number; markdown: string }>(
    `SELECT version.skill_id,version.version,version.markdown FROM workspace_skill_versions version
     JOIN workspace_skills skill ON skill.id=version.skill_id WHERE skill.slug=$1 AND skill.kind='workflow'
     ORDER BY version.version DESC LIMIT 1`, [slug],
  )).rows[0]!;
  const contract = JSON.parse(row.markdown);
  const { timeoutSeconds: _timeout, default: _default, ...state } = contract.handoffs[stateName];
  if (state.on?.timeout) delete state.on.timeout;
  contract.handoffs[stateName] = state;
  await database.query(`UPDATE workspace_skill_versions SET markdown=$3 WHERE skill_id=$1 AND version=$2`,
    [row.skill_id, row.version, JSON.stringify(contract)]);
}

/** Every card of a run, oldest first. */
export async function runCards(runId: string): Promise<Array<{ id: string; author_id: string; text: string; card: any }>> {
  return (
    await database.query<{ id: string; author_id: string; text: string; card: any }>(
      `SELECT id,author_id,text,card FROM messages WHERE room_id=$1 AND card_type='workflow-handoff' AND card->>'runId'=$2
       ORDER BY (card->>'seq')::int`,
      [ROOM, runId],
    )
  ).rows;
}

/** Make the run's timer of this kind due now and run one scheduler pass. */
export async function fireTimer(runId: string, timer: 'step' | 'deadline'): Promise<number> {
  await database.query(
    `UPDATE agent_schedules SET next_run_at=now()-interval '1 minute'
     WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'=$2`,
    [runId, timer],
  );
  return new AgentScheduleLoop(database).runOnce();
}

export async function addAgent(id: string, online = true): Promise<void> {
  await database.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$2,'opus-4-5') ON CONFLICT DO NOTHING`, [id, OWNER]);
  await reportPresence(id, online ? 'online' : 'offline');
}

export const GATED = {
  version: 1,
  name: 'gated',
  description: 'Work, then a person signs off',
  roles: ['worker', 'approver'],
  start: 'work',
  deadlineSeconds: 7200,
  handoffs: {
    work: { role: 'worker', requires: ['note'], on: { done: 'sign_off' } },
    sign_off: {
      kind: 'gate', role: 'approver', requires: ['decision'],
      on: { publish: 'land', redo: 'work', stop: 'failed' },
      timeoutSeconds: 600, default: 'stop',
    },
    land: { kind: 'terminal', status: 'done' },
    failed: { kind: 'terminal', status: 'failed' },
  },
};

export async function startedGatedRun(starter: CommandRow | { room_id: string; agent_id: string }): Promise<string> {
  const saver = await commandFor(WORKER_A);
  await saveWorkflow(database, saver, { contract: describedWorkflow(GATED) });
  return (await startWorkflow(database, starter as CommandRow, {
    name: 'gated', roleBindings: { worker: WORKER_A, approver: APPROVER },
  })).runId;
}

export async function reachGate(runId: string): Promise<void> {
  const current = (await getWorkflowRun(database, ROOM, runId)).attempt;
  await handoff(database, await commandFor(WORKER_A), { runId, outcome: 'done', contents: { note: 'ok' }, attempt: current });
}

export async function ownerNotices(personId: string): Promise<string[]> {
  return (await database.query<{ text: string }>(
    `SELECT message.text FROM messages message JOIN rooms room ON room.id=message.room_id
     JOIN memberships member ON member.room_id=room.id AND member.identity_id=$1
     WHERE room.id<>$2 AND message.text LIKE '%took its default%'`,
    [personId, ROOM],
  )).rows.map((row) => row.text);
}
