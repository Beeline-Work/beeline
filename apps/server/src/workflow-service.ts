import { createHash, randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import {
  readWorkflowDefinition,
  workflowOutputError,
  type WorkflowDefinition,
  type WorkflowState,
} from '@beeline/api-contract/workflows';
import { SYSTEM_IDENTITY_ID, SYSTEM_IDENTITY_NAME } from '@beeline/api-contract/system-identity';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import { postRoomChoice, settleExpiredChoice } from './room-choice.js';

type Run = {
  id: string;
  room_id: string;
  name: string;
  revision: number;
  definition: WorkflowDefinition;
  roles: Record<string, string>;
  state: string;
  status: 'running' | 'waiting' | 'failed' | 'complete';
  sequence: number;
  deadline_at: Date | null;
  loop_counts: Record<string, number>;
  context: Record<string, unknown>;
  source_command_id: string;
  error: string | null;
};

const runView = (run: Run) => ({
  runId: run.id,
  name: run.name,
  revision: run.revision,
  state: run.state,
  status: run.status,
  ...(run.deadline_at ? { deadlineAt: run.deadline_at.getTime() } : {}),
  ...(run.error ? { error: run.error } : {}),
});

async function log(db: SqlDatabase, run: Run, event: string, payload: unknown): Promise<void> {
  await db.query(
    `INSERT INTO workflow_run_log(run_id,sequence,state,event,payload) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [run.id, run.sequence, run.state, event, JSON.stringify(payload)],
  );
}

async function save(db: SqlDatabase, run: Run): Promise<void> {
  await db.query(
    `UPDATE workflow_runs SET state=$2,status=$3,sequence=$4,deadline_at=$5,
       loop_counts=$6::jsonb,error=$7,context=$8::jsonb,source_command_id=$9,updated_at=now() WHERE id=$1`,
    [
      run.id,
      run.state,
      run.status,
      run.sequence,
      run.deadline_at,
      JSON.stringify(run.loop_counts),
      run.error,
      JSON.stringify(run.context),
      run.source_command_id,
    ],
  );
}

async function wake(
  db: SqlDatabase,
  run: Run,
  parent: CommandRow,
  slot: number,
  role: string,
  skill: string,
  output: unknown,
  seconds: number,
): Promise<void> {
  const agentId = run.roles[role];
  if (!agentId) throw new Error(`workflow role ${role} is not bound`);
  await ensureSystemIdentity(db);
  const note = await systemLine(db, {
    roomId: run.room_id,
    subject: { kind: 'person', id: SYSTEM_IDENTITY_ID, name: SYSTEM_IDENTITY_NAME },
    verb: 'started workflow step',
    object: `${run.name}: ${run.state} (${skill})`,
    consequence: `Run ${run.id}, sequence ${run.sequence}. Use read_workflow_run for prior inputs and return structured output matching ${JSON.stringify(output)} with complete_workflow_step.`,
  });
  const command = await createAgentCommand(db, {
    roomId: run.room_id,
    agentId,
    sourceMessageId: note.id,
    reason: 'workflow_step',
    parent,
    retainDepth: true,
  });
  if (!command) throw new Error(`workflow role ${role} is no longer a Room member`);
  await db.query(
    `INSERT INTO workflow_run_assignments(run_id,sequence,slot,agent_id,command_id,status)
     VALUES($1,$2,$3,$4,$5,'pending')`,
    [run.id, run.sequence, slot, agentId, command.id],
  );
  run.deadline_at = new Date(Date.now() + seconds * 1000);
}

async function dispatch(db: SqlDatabase, run: Run, parent: CommandRow): Promise<void> {
  if (run.sequence >= 100) {
    run.status = 'failed';
    run.deadline_at = null;
    run.error = 'workflow transition limit exceeded';
    await save(db, run);
    await log(db, run, 'failed', { error: run.error });
    return;
  }
  const state = run.definition.states[run.state];
  if (!state) throw new Error('workflow state is absent from pinned definition');
  if (state.kind === 'terminal') {
    run.status = run.error ? 'failed' : 'complete';
    run.deadline_at = null;
  } else if (state.kind === 'step') {
    run.status = 'running';
    await wake(
      db,
      run,
      parent,
      0,
      state.step.role,
      state.step.skill,
      state.step.output,
      state.step.timeoutSeconds,
    );
  } else if (state.kind === 'parallel') {
    run.status = 'running';
    for (const [slot, step] of state.steps.entries())
      await wake(db, run, parent, slot, step.role, step.skill, step.output, step.timeoutSeconds);
    run.deadline_at = new Date(Date.now() + state.deadlineSeconds * 1000);
  } else if (state.kind === 'gate') {
    run.status = 'waiting';
    run.deadline_at = new Date(Date.now() + state.timeoutSeconds * 1000);
    const choice = await postRoomChoice(db, {
      roomId: run.room_id,
      agentId: parent.agent_id,
      mode: 'question',
      prompt: `Continue ${run.name} at ${state.human}?`,
      options: [
        { label: 'Approve', consequence: 'Continue the workflow.' },
        { label: 'Deny', consequence: 'Follow the denied path.' },
      ],
    });
    await db.query(`INSERT INTO workflow_run_gates(choice_id,run_id,sequence) VALUES($1,$2,$3)`, [
      choice.choiceId,
      run.id,
      run.sequence,
    ]);
  } else {
    run.status = 'waiting';
    run.deadline_at = new Date(Date.now() + state.timeoutSeconds * 1000);
  }
  await save(db, run);
  await log(db, run, 'entered', { deadlineAt: run.deadline_at?.toISOString() ?? null });
}

async function dispatchOrFail(db: SqlDatabase, run: Run, parent: CommandRow): Promise<void> {
  try {
    await dispatch(db, run, parent);
  } catch (cause) {
    run.status = 'failed';
    run.deadline_at = null;
    run.error = cause instanceof Error ? cause.message.slice(0, 500) : 'workflow dispatch failed';
    await save(db, run);
    await log(db, run, 'failed', { error: run.error });
  }
}

export async function putWorkflowDefinition(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  value: unknown,
  roles: Record<string, string> | undefined,
  parent: CommandRow,
) {
  const definition = readWorkflowDefinition(value);
  if (!definition) throw new Error('workflow definition is invalid');
  if (
    roles &&
    (Object.keys(roles).length !== definition.roles.length ||
      !definition.roles.every((role) => typeof roles[role] === 'string'))
  )
    throw new Error('every workflow role must be bound once');
  if (definition.trigger.kind !== 'manual' && !roles)
    throw new Error('event and schedule workflows require saved role bindings');
  const nextRun =
    definition.trigger.kind === 'schedule'
      ? CronExpressionParser.parse(definition.trigger.value!, { currentDate: new Date() })
          .next()
          .toDate()
      : null;
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `workflow:${roomId}:${definition.name}`,
  ]);
  const latest = (
    await db.query<{ revision: number }>(
      `SELECT revision FROM workflow_definitions WHERE room_id=$1 AND name=$2 ORDER BY revision DESC LIMIT 1`,
      [roomId, definition.name],
    )
  ).rows[0];
  const revision = (latest?.revision ?? 0) + 1;
  await db.query(
    `INSERT INTO workflow_definitions(room_id,name,revision,definition,author_id,role_bindings,source_command_id,next_run_at)
     VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8)`,
    [
      roomId,
      definition.name,
      revision,
      JSON.stringify(definition),
      agentId,
      roles ? JSON.stringify(roles) : null,
      parent.id,
      nextRun,
    ],
  );
  return { name: definition.name, revision };
}

export async function startWorkflowRun(
  db: SqlDatabase,
  roomId: string,
  name: string,
  roles: Record<string, string>,
  parent: CommandRow,
  triggerMessageId?: string,
) {
  const saved = (
    await db.query<{ revision: number; definition: WorkflowDefinition }>(
      `SELECT revision,definition FROM workflow_definitions WHERE room_id=$1 AND name=$2 ORDER BY revision DESC LIMIT 1`,
      [roomId, name],
    )
  ).rows[0];
  if (!saved) throw new Error('workflow definition not found');
  const active = (
    await db.query<{ count: number }>(
      `SELECT count(*)::int count FROM workflow_runs WHERE room_id=$1 AND status IN ('running','waiting')`,
      [roomId],
    )
  ).rows[0]!.count;
  if (active >= 50) throw new Error('too many active workflow runs in this Room');
  const definition = readWorkflowDefinition(saved.definition);
  if (!definition) throw new Error('stored workflow definition is invalid');
  if (
    Object.keys(roles).length !== definition.roles.length ||
    !definition.roles.every((role) => typeof roles[role] === 'string')
  )
    throw new Error('every workflow role must be bound once');
  const members = await db.query<{ identity_id: string }>(
    `SELECT m.identity_id FROM memberships m JOIN identities i ON i.id=m.identity_id AND i.kind='agent'
     WHERE m.room_id=$1 AND m.removed_at IS NULL AND m.identity_id=ANY($2::text[]) FOR SHARE OF m`,
    [roomId, Object.values(roles)],
  );
  if (
    new Set(members.rows.map((row) => row.identity_id)).size !== new Set(Object.values(roles)).size
  )
    throw new Error('workflow roles must be current Room agents');
  const run: Run = {
    id: randomUUID(),
    room_id: roomId,
    name,
    revision: saved.revision,
    definition,
    roles,
    state: definition.start,
    status: 'running',
    sequence: 0,
    deadline_at: null,
    loop_counts: {},
    context: {},
    source_command_id: parent.id,
    error: null,
  };
  const inserted = await db.query(
    `INSERT INTO workflow_runs(id,room_id,name,revision,definition,roles,state,status,source_command_id,trigger_message_id)
     VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING`,
    [
      run.id,
      roomId,
      name,
      run.revision,
      JSON.stringify(definition),
      JSON.stringify(roles),
      run.state,
      run.status,
      parent.id,
      triggerMessageId ?? null,
    ],
  );
  if (!inserted.rowCount && triggerMessageId) {
    const existing = (
      await db.query<Run>(
        `SELECT * FROM workflow_runs WHERE room_id=$1 AND name=$2 AND revision=$3 AND trigger_message_id=$4`,
        [roomId, name, run.revision, triggerMessageId],
      )
    ).rows[0];
    if (existing) return runView(existing);
    throw new Error('workflow run trigger conflict');
  }
  await dispatchOrFail(db, run, parent);
  return runView(run);
}

type Assignment = {
  sequence: number;
  slot: number;
  status: string;
  output: unknown;
  agent_id: string;
  attempts: number;
};

export async function completeWorkflowStep(
  db: SqlDatabase,
  roomId: string,
  runId: string,
  sequence: number,
  output: unknown,
  outcome: 'success' | 'failure',
  parent: CommandRow,
) {
  const inputHash = createHash('sha256').update(JSON.stringify({ output, outcome })).digest('hex');
  const previous = (
    await db.query<{
      input_hash: string;
      response: { state: string; status: Run['status']; error?: string };
    }>(
      `SELECT input_hash,response FROM workflow_step_receipts WHERE command_id=$1 AND run_id=$2 AND sequence=$3`,
      [parent.id, runId, sequence],
    )
  ).rows[0];
  if (previous) {
    if (previous.input_hash !== inputHash) throw new Error('workflow step receipt conflict');
    return previous.response;
  }
  const receipt = async (result: { state: string; status: Run['status']; error?: string }) => {
    await db.query(
      `INSERT INTO workflow_step_receipts(command_id,run_id,sequence,input_hash,response)
      VALUES($1,$2,$3,$4,$5::jsonb)`,
      [parent.id, runId, sequence, inputHash, JSON.stringify(result)],
    );
    return result;
  };
  const run = (
    await db.query<Run>(`SELECT * FROM workflow_runs WHERE id=$1 AND room_id=$2 FOR UPDATE`, [
      runId,
      roomId,
    ])
  ).rows[0];
  if (!run) throw new Error('workflow run not found');
  const assignment = (
    await db.query<Assignment>(
      `SELECT sequence,slot,status,output,agent_id,attempts FROM workflow_run_assignments
     WHERE run_id=$1 AND command_id=$2`,
      [runId, parent.id],
    )
  ).rows[0];
  if (!assignment) throw new Error('workflow step is not assigned to this turn');
  if (assignment.agent_id !== parent.agent_id) throw new Error('workflow step agent mismatch');
  if (assignment.status === 'complete' || sequence < run.sequence)
    return { state: run.state, status: run.status, ...(run.error ? { error: run.error } : {}) };
  if (assignment.sequence !== sequence || run.sequence !== sequence || run.status !== 'running')
    throw new Error('workflow step is stale');
  const state = run.definition.states[run.state];
  if (!state || (state.kind !== 'step' && state.kind !== 'parallel'))
    throw new Error('workflow is not on an agent step');
  const step = state.kind === 'step' ? state.step : state.steps[assignment.slot];
  if (!step) throw new Error('workflow step slot is invalid');
  const error = workflowOutputError(step, output);
  if (error && assignment.attempts === 0) {
    const note = await systemLine(db, {
      roomId,
      subject: { kind: 'person', id: SYSTEM_IDENTITY_ID, name: SYSTEM_IDENTITY_NAME },
      verb: 'rejected workflow output',
      object: `${run.name}: ${run.state}`,
      consequence: `${error}. Return the required structured output with complete_workflow_step.`,
    });
    const retry = await createAgentCommand(db, {
      roomId,
      agentId: parent.agent_id,
      sourceMessageId: note.id,
      reason: 'workflow_validation_retry',
      parent,
      retainDepth: true,
    });
    if (!retry) throw new Error('workflow retry agent left the Room');
    await db.query(
      `UPDATE workflow_run_assignments SET command_id=$3,attempts=1 WHERE run_id=$1 AND command_id=$2`,
      [runId, parent.id, retry.id],
    );
    await log(db, run, 'validation_retry', { error });
    return receipt({ state: run.state, status: run.status, error });
  }
  const resultOutcome = error
    ? 'failure'
    : state.kind === 'step' && state.guard && outcome === 'success'
      ? String((output as Record<string, unknown>)[state.guard.field])
      : outcome;
  await db.query(
    `UPDATE workflow_run_assignments SET status=$3,output=$4::jsonb WHERE run_id=$1 AND command_id=$2`,
    [runId, parent.id, error ? 'failed' : 'complete', JSON.stringify(output)],
  );
  if (!error && state.kind === 'parallel') {
    const assignments = await db.query<Assignment>(
      `SELECT sequence,slot,status,output,agent_id,attempts FROM workflow_run_assignments
       WHERE run_id=$1 AND sequence=$2 ORDER BY slot`,
      [runId, sequence],
    );
    const completed = assignments.rows.filter((item) => item.status === 'complete').length;
    const required =
      state.join === 'all' ? state.steps.length : state.join === 'any' ? 1 : state.quorum!;
    if (completed < required) return receipt({ state: run.state, status: run.status });
    run.context[run.state] = {
      outputs: assignments.rows
        .filter((item) => item.status === 'complete')
        .map((item) => item.output),
      missing: assignments.rows
        .filter((item) => item.status !== 'complete')
        .map((item) => state.steps[item.slot]?.role),
    };
  }
  let next = state.on[resultOutcome];
  if (!next) throw new Error(`workflow outcome ${resultOutcome} is not configured`);
  let loopExceeded = false;
  if (state.kind === 'step' && state.loop && next === state.loop.to) {
    const count = (run.loop_counts[run.state] ?? 0) + 1;
    run.loop_counts[run.state] = count;
    if (count > state.loop.maxIterations) {
      next = state.loop.onExceeded;
      loopExceeded = true;
    }
  }
  const previousState = run.state;
  await log(db, run, resultOutcome, {
    output,
    error,
    agentId: parent.agent_id,
    commandId: parent.id,
  });
  if (!error && output && typeof output === 'object' && !Array.isArray(output)) {
    const fields = output as Record<string, unknown>;
    if (state.kind === 'step') run.context[run.state] = output;
    for (const key of Object.keys(step.output)) run.context[key] = fields[key];
  }
  run.source_command_id = parent.id;
  run.sequence++;
  run.state = next;
  run.error = error
    ? `Step ${previousState}: ${error}`
    : outcome === 'failure'
      ? `Step ${previousState} failed`
      : loopExceeded
        ? 'workflow loop cap exceeded'
        : null;
  await dispatchOrFail(db, run, parent);
  return receipt({
    state: run.state,
    status: run.status,
    ...(run.error ? { error: run.error } : {}),
  });
}

export async function listWorkflowRuns(db: SqlDatabase, roomId: string) {
  const runs = await db.query<Run>(
    `SELECT * FROM workflow_runs WHERE room_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [roomId],
  );
  const failures = await db.query<{
    name: string;
    revision: number;
    trigger_id: string;
    error: string;
    created_at: Date;
  }>(
    `SELECT name,revision,trigger_id,error,created_at FROM workflow_trigger_failures
      WHERE room_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [roomId],
  );
  return {
    runs: runs.rows.map(runView),
    triggerErrors: failures.rows.map((row) => ({
      name: row.name,
      revision: row.revision,
      triggerId: row.trigger_id,
      error: row.error,
      createdAt: row.created_at.getTime(),
    })),
  };
}

export async function readWorkflowRun(db: SqlDatabase, roomId: string, runId: string) {
  const run = (
    await db.query<Run>(`SELECT * FROM workflow_runs WHERE id=$1 AND room_id=$2`, [runId, roomId])
  ).rows[0];
  if (!run) throw new Error('workflow run not found');
  const events = await db.query<{
    sequence: number;
    state: string;
    event: string;
    payload: unknown;
    created_at: Date;
  }>(
    `SELECT sequence,state,event,payload,created_at FROM workflow_run_log
     WHERE run_id=$1 ORDER BY sequence,created_at,event LIMIT 500`,
    [runId],
  );
  return {
    run: { ...runView(run), context: run.context },
    log: events.rows.map((row) => ({
      sequence: row.sequence,
      state: row.state,
      event: row.event,
      payload: row.payload,
      createdAt: row.created_at.getTime(),
    })),
  };
}

/** Advance only waiting runs in this Room; one broken definition fails its run alone. */
export async function signalWorkflowEvent(
  db: SqlDatabase,
  roomId: string,
  event: string,
  payload: Record<string, unknown> = {},
  eventId?: string,
) {
  const candidates = await db.query<{ id: string }>(
    `SELECT id FROM workflow_runs WHERE room_id=$1 AND status='waiting' ORDER BY created_at LIMIT 100`,
    [roomId],
  );
  let advanced = 0;
  for (const candidate of candidates.rows) {
    const run = (
      await db.query<Run>(
        `SELECT * FROM workflow_runs WHERE id=$1 AND status='waiting' FOR UPDATE`,
        [candidate.id],
      )
    ).rows[0];
    if (!run) continue;
    const state = run.definition.states[run.state];
    if (!state || state.kind !== 'wait' || state.event !== event) continue;
    const matches = Object.entries(state.match ?? {}).every(([key, expected]) => {
      const resolved = expected.startsWith('$.') ? run.context[expected.slice(2)] : expected;
      return payload[key] === resolved;
    });
    if (!matches) continue;
    if (payload.outcome === 'failure' && !state.on.failure) continue;
    if (
      eventId &&
      !(
        await db.query(
          `INSERT INTO workflow_run_event_receipts(run_id,event_id) VALUES($1,$2)
           ON CONFLICT DO NOTHING RETURNING run_id`,
          [run.id, eventId],
        )
      ).rows.length
    )
      continue;
    const parent = (
      await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [
        run.source_command_id,
      ])
    ).rows[0];
    if (!parent) {
      run.status = 'failed';
      run.error = 'workflow source command is missing';
      await save(db, run);
      await log(db, run, 'failed', { error: run.error });
      continue;
    }
    const outcome = payload.outcome === 'failure' ? 'failure' : 'success';
    await log(db, run, 'event', { event, payload, outcome });
    let next = state.on[outcome]!;
    if (state.loop && next === state.loop.to) {
      const count = (run.loop_counts[run.state] ?? 0) + 1;
      run.loop_counts[run.state] = count;
      if (count > state.loop.maxIterations) {
        next = state.loop.onExceeded;
        run.error = 'workflow loop cap exceeded';
      }
    }
    run.state = next;
    run.sequence++;
    try {
      await dispatch(db, run, parent);
    } catch (cause) {
      run.status = 'failed';
      run.error = cause instanceof Error ? cause.message.slice(0, 500) : 'workflow dispatch failed';
      run.deadline_at = null;
      await save(db, run);
      await log(db, run, 'failed', { error: run.error });
    }
    advanced++;
  }
  if (eventId) {
    const triggers = await db.query<{
      name: string;
      revision: number;
      role_bindings: Record<string, string>;
      source_command_id: string;
    }>(
      `SELECT DISTINCT ON (name) name,revision,role_bindings,source_command_id
       FROM workflow_definitions WHERE room_id=$1 ORDER BY name,revision DESC`,
      [roomId],
    );
    for (const trigger of triggers.rows) {
      const row = (
        await db.query<{ definition: WorkflowDefinition }>(
          `SELECT definition FROM workflow_definitions WHERE room_id=$1 AND name=$2 AND revision=$3`,
          [roomId, trigger.name, trigger.revision],
        )
      ).rows[0];
      if (
        row?.definition.trigger.kind !== 'event' ||
        row.definition.trigger.value !== event ||
        !trigger.role_bindings
      )
        continue;
      try {
        const parent = (
          await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [
            trigger.source_command_id,
          ])
        ).rows[0];
        if (!parent) throw new Error('workflow definition source command is missing');
        await startWorkflowRun(db, roomId, trigger.name, trigger.role_bindings, parent, eventId);
        advanced++;
      } catch (cause) {
        // One definition must not prevent this event or another run from committing.
        await db.query(
          `INSERT INTO workflow_trigger_failures(room_id,name,revision,trigger_id,error)
             VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [
            roomId,
            trigger.name,
            trigger.revision,
            eventId,
            cause instanceof Error ? cause.message.slice(0, 500) : 'workflow trigger failed',
          ],
        );
        console.error('workflow event trigger failed', {
          roomId,
          name: trigger.name,
          revision: trigger.revision,
          event,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }
  return advanced;
}

/** Called only after answerRoomChoice verified and committed a human answer. */
export async function settleWorkflowGateChoice(
  db: SqlDatabase,
  choiceId: string,
  optionId: string,
  viewerId: string,
) {
  const gate = (
    await db.query<{ run_id: string; sequence: number }>(
      `SELECT run_id,sequence FROM workflow_run_gates WHERE choice_id=$1`,
      [choiceId],
    )
  ).rows[0];
  if (!gate) return;
  const run = (
    await db.query<Run>(`SELECT * FROM workflow_runs WHERE id=$1 FOR UPDATE`, [gate.run_id])
  ).rows[0];
  if (!run || run.sequence !== gate.sequence || run.status !== 'waiting') return;
  const state = run.definition.states[run.state];
  if (!state || state.kind !== 'gate') return;
  const parent = (
    await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [run.source_command_id])
  ).rows[0];
  if (!parent) throw new Error('workflow source command is missing');
  const outcome = optionId === 'A' ? 'approved' : 'denied';
  const next = state.on[outcome];
  if (!next) throw new Error('workflow gate edge is missing');
  await log(db, run, outcome, { choiceId, viewerId });
  run.state = next;
  run.sequence++;
  run.error = outcome === 'denied' ? `Human denied ${state.human}` : null;
  try {
    await dispatch(db, run, parent);
  } catch (cause) {
    run.status = 'failed';
    run.error = cause instanceof Error ? cause.message.slice(0, 500) : 'workflow dispatch failed';
    run.deadline_at = null;
    await save(db, run);
    await log(db, run, 'failed', { error: run.error });
  }
}

export async function nextWorkflowDeadline(db: SqlDatabase): Promise<Date | undefined> {
  const row = (
    await db.query<{ deadline_at: Date | null }>(
      `SELECT min(deadline_at) deadline_at FROM workflow_runs
     WHERE status IN ('running','waiting') AND deadline_at IS NOT NULL`,
    )
  ).rows[0];
  return row?.deadline_at ?? undefined;
}

export async function nextWorkflowSchedule(db: SqlDatabase): Promise<Date | undefined> {
  const row = (
    await db.query<{ next_run_at: Date | null }>(
      `SELECT min(latest.next_run_at) next_run_at FROM (
       SELECT DISTINCT ON (room_id,name) next_run_at FROM workflow_definitions
       ORDER BY room_id,name,revision DESC
     ) latest WHERE latest.next_run_at IS NOT NULL`,
    )
  ).rows[0];
  return row?.next_run_at ?? undefined;
}

export async function runDueWorkflowSchedules(db: SqlDatabase, now = new Date()): Promise<number> {
  const due = await db.query<{ room_id: string; name: string; revision: number }>(
    `SELECT room_id,name,revision FROM (
       SELECT DISTINCT ON (room_id,name) room_id,name,revision,next_run_at
       FROM workflow_definitions ORDER BY room_id,name,revision DESC
     ) latest WHERE next_run_at<=$1 ORDER BY next_run_at LIMIT 50`,
    [now],
  );
  let started = 0;
  for (const candidate of due.rows) {
    try {
      await db.transaction(async (tx) => {
        const saved = (
          await tx.query<{
            definition: WorkflowDefinition;
            role_bindings: Record<string, string>;
            source_command_id: string;
            next_run_at: Date;
          }>(
            `SELECT definition,role_bindings,source_command_id,next_run_at
           FROM workflow_definitions WHERE room_id=$1 AND name=$2 AND revision=$3
             AND next_run_at<=$4 FOR UPDATE SKIP LOCKED`,
            [candidate.room_id, candidate.name, candidate.revision, now],
          )
        ).rows[0];
        if (!saved) return;
        const parent = (
          await tx.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [
            saved.source_command_id,
          ])
        ).rows[0];
        if (!parent) throw new Error('workflow definition source command is missing');
        const next = CronExpressionParser.parse(saved.definition.trigger.value!, {
          currentDate: now,
        })
          .next()
          .toDate();
        await tx.query(
          `UPDATE workflow_definitions SET next_run_at=$4
          WHERE room_id=$1 AND name=$2 AND revision=$3`,
          [candidate.room_id, candidate.name, candidate.revision, next],
        );
        await startWorkflowRun(
          tx,
          candidate.room_id,
          candidate.name,
          saved.role_bindings,
          parent,
          `schedule:${saved.next_run_at.toISOString()}`,
        );
        started++;
      });
    } catch (cause) {
      const error =
        cause instanceof Error ? cause.message.slice(0, 500) : 'workflow schedule failed';
      await db.transaction(async (tx) => {
        const row = (
          await tx.query<{ definition: WorkflowDefinition; next_run_at: Date }>(
            `SELECT definition,next_run_at FROM workflow_definitions
            WHERE room_id=$1 AND name=$2 AND revision=$3 FOR UPDATE`,
            [candidate.room_id, candidate.name, candidate.revision],
          )
        ).rows[0];
        if (!row || row.next_run_at > now) return;
        const triggerId = `schedule:${row.next_run_at.toISOString()}`;
        await tx.query(
          `INSERT INTO workflow_trigger_failures(room_id,name,revision,trigger_id,error)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [candidate.room_id, candidate.name, candidate.revision, triggerId, error],
        );
        const next = CronExpressionParser.parse(row.definition.trigger.value!, { currentDate: now })
          .next()
          .toDate();
        await tx.query(
          `UPDATE workflow_definitions SET next_run_at=$4
          WHERE room_id=$1 AND name=$2 AND revision=$3`,
          [candidate.room_id, candidate.name, candidate.revision, next],
        );
      });
    }
  }
  return started;
}

/** The background leader drives deadlines; every run is locked and settled independently. */
export async function runDueWorkflowDeadlines(db: SqlDatabase, now = new Date()): Promise<number> {
  const due = await db.query<{ id: string }>(
    `SELECT id FROM workflow_runs WHERE status IN ('running','waiting')
       AND deadline_at<=$1 ORDER BY deadline_at,id LIMIT 50`,
    [now],
  );
  let settled = 0;
  for (const candidate of due.rows) {
    try {
      await db.transaction(async (tx) => {
        const run = (
          await tx.query<Run>(
            `SELECT * FROM workflow_runs WHERE id=$1 AND status IN ('running','waiting')
           AND deadline_at<=$2 FOR UPDATE SKIP LOCKED`,
            [candidate.id, now],
          )
        ).rows[0];
        if (!run) return;
        const state = run.definition.states[run.state];
        if (!state || state.kind === 'terminal') {
          run.status = 'failed';
          run.error = 'workflow state is invalid';
          run.deadline_at = null;
          await save(tx, run);
          await log(tx, run, 'failed', { error: run.error });
          return;
        }
        const parent = (
          await tx.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [
            run.source_command_id,
          ])
        ).rows[0];
        if (!parent) {
          run.status = 'failed';
          run.error = 'workflow source command is missing';
          run.deadline_at = null;
          await save(tx, run);
          await log(tx, run, 'failed', { error: run.error });
          return;
        }
        if (state.kind === 'step') {
          const assignment = (
            await tx.query<{ command_id: string; timeout_retries: number }>(
              `SELECT command_id,timeout_retries FROM workflow_run_assignments
             WHERE run_id=$1 AND sequence=$2 AND slot=0 AND status='pending' FOR UPDATE`,
              [run.id, run.sequence],
            )
          ).rows[0];
          if (assignment && assignment.timeout_retries < state.step.retries) {
            const note = await systemLine(tx, {
              roomId: run.room_id,
              subject: { kind: 'person', id: SYSTEM_IDENTITY_ID, name: SYSTEM_IDENTITY_NAME },
              verb: 'retried workflow step',
              object: `${run.name}: ${run.state}`,
              consequence: `Run ${run.id}, sequence ${run.sequence}. The prior attempt timed out.`,
            });
            const command = await createAgentCommand(tx, {
              roomId: run.room_id,
              agentId: run.roles[state.step.role]!,
              sourceMessageId: note.id,
              reason: 'workflow_timeout_retry',
              parent,
              retainDepth: true,
            });
            if (command) {
              await tx.query(
                `UPDATE workflow_run_assignments SET command_id=$3,timeout_retries=timeout_retries+1
                 WHERE run_id=$1 AND sequence=$2 AND slot=0`,
                [run.id, run.sequence, command.id],
              );
              run.deadline_at = new Date(now.getTime() + state.step.timeoutSeconds * 1000);
              await save(tx, run);
              await log(tx, run, `timeout_retry_${assignment.timeout_retries + 1}`, {});
              settled++;
              return;
            }
          }
        }
        if (state.kind === 'parallel') {
          const assignments = await tx.query<{ slot: number; output: unknown; status: string }>(
            `SELECT slot,output,status FROM workflow_run_assignments WHERE run_id=$1 AND sequence=$2 ORDER BY slot`,
            [run.id, run.sequence],
          );
          run.context[run.state] = {
            outputs: assignments.rows
              .filter((item) => item.status === 'complete')
              .map((item) => item.output),
            missing: assignments.rows
              .filter((item) => item.status !== 'complete')
              .map((item) => state.steps[item.slot]?.role),
          };
        }
        if (state.kind === 'gate') {
          const gate = (
            await tx.query<{ choice_id: string }>(
              `SELECT choice_id FROM workflow_run_gates WHERE run_id=$1 AND sequence=$2`,
              [run.id, run.sequence],
            )
          ).rows[0];
          if (gate) await settleExpiredChoice(tx, gate.choice_id, true);
        }
        const next = state.kind === 'parallel' ? state.on.deadline : state.on.timeout;
        if (!next) throw new Error('workflow timeout edge is missing');
        await log(tx, run, 'timeout', { deadlineAt: run.deadline_at?.toISOString() });
        run.sequence++;
        if (state.kind === 'wait' && state.loop && next === state.loop.to) {
          const count = (run.loop_counts[run.state] ?? 0) + 1;
          run.loop_counts[run.state] = count;
          if (count > state.loop.maxIterations) {
            run.state = state.loop.onExceeded;
            run.error = 'workflow loop cap exceeded';
          } else {
            run.state = next;
            run.error = 'Workflow state timed out';
          }
        } else {
          run.state = next;
          run.error = 'Workflow state timed out';
        }
        try {
          await dispatch(tx, run, parent);
        } catch (cause) {
          run.status = 'failed';
          run.error =
            cause instanceof Error ? cause.message.slice(0, 500) : 'workflow dispatch failed';
          run.deadline_at = null;
          await save(tx, run);
          await log(tx, run, 'failed', { error: run.error });
        }
        settled++;
      });
    } catch (cause) {
      const error =
        cause instanceof Error ? cause.message.slice(0, 500) : 'workflow deadline failed';
      try {
        await db.transaction(async (tx) => {
          const run = (
            await tx.query<Run>(
              `SELECT * FROM workflow_runs WHERE id=$1 AND status IN ('running','waiting') FOR UPDATE`,
              [candidate.id],
            )
          ).rows[0];
          if (!run) return;
          run.status = 'failed';
          run.deadline_at = null;
          run.error = error;
          await save(tx, run);
          await log(tx, run, 'failed', { error });
        });
      } catch (recordError) {
        console.error('workflow deadline failure could not be recorded', {
          runId: candidate.id,
          error: recordError,
        });
      }
    }
  }
  return settled;
}
