import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CronExpressionParser } from 'cron-parser';
import {
  checkWorkflowDefinition,
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
  layer: WorkflowLayer;
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
  layer: run.layer,
  state: run.state,
  status: run.status,
  ...(run.deadline_at ? { deadlineAt: run.deadline_at.getTime() } : {}),
  ...(run.error ? { error: run.error } : {}),
});

const WORKFLOW_RUN_TURN_CAP = 100;
const WORKSPACE_DAILY_TURN_CAP = 1_000;

async function reserveWorkflowTurn(db: SqlDatabase, run: Run): Promise<void> {
  const runBudget = await db.query(
    `UPDATE workflow_runs SET turns_used=turns_used+1 WHERE id=$1 AND turns_used<$2 RETURNING id`,
    [run.id, WORKFLOW_RUN_TURN_CAP],
  );
  if (!runBudget.rowCount) throw new Error('workflow run agent-turn cap reached');
  const workspaceBudget = await db.query(
    `INSERT INTO workflow_workspace_day_turns(workspace_id,day,used)
     SELECT workspace_id,(now() at time zone 'UTC')::date,1 FROM rooms WHERE id=$1
     ON CONFLICT(workspace_id,day) DO UPDATE SET used=workflow_workspace_day_turns.used+1
       WHERE workflow_workspace_day_turns.used<$2 RETURNING used`,
    [run.room_id, WORKSPACE_DAILY_TURN_CAP],
  );
  if (!workspaceBudget.rowCount) {
    await db.query(`UPDATE workflow_runs SET turns_used=turns_used-1 WHERE id=$1`, [run.id]);
    throw new Error('workspace daily workflow agent-turn cap reached (UTC day)');
  }
}

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

async function cancelRunAssignments(db: SqlDatabase, run: Run): Promise<void> {
  await db.query(`UPDATE agent_commands SET state='cancelled',completed_at=now()
    WHERE id IN (SELECT command_id FROM workflow_run_assignments
      WHERE run_id=$1 AND sequence=$2 AND status='pending')
      AND state IN ('pending','claimed')`, [run.id, run.sequence]);
  await db.query(`UPDATE workflow_run_assignments SET status='failed'
    WHERE run_id=$1 AND sequence=$2 AND status='pending'`, [run.id, run.sequence]);
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
  input?: Record<string, string>,
): Promise<void> {
  const agentId = run.roles[role];
  if (!agentId) throw new Error(`workflow role ${role} is not bound`);
  const member = await db.query(`SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2
    AND removed_at IS NULL FOR SHARE`, [run.room_id, agentId]);
  if (!member.rowCount) throw new Error(`workflow role ${role} is no longer a Room member`);
  await reserveWorkflowTurn(db, run);
  await ensureSystemIdentity(db);
  const note = await systemLine(db, {
    roomId: run.room_id,
    subject: { kind: 'person', id: SYSTEM_IDENTITY_ID, name: SYSTEM_IDENTITY_NAME },
    verb: 'started workflow step',
    object: `${run.name}: ${run.state} (${skill})`,
    consequence: `Run ${run.id}, sequence ${run.sequence}. Input ${JSON.stringify(Object.fromEntries(
      Object.entries(input ?? {}).map(([key, source]) => [key, run.context[source.slice(2)]]),
    ))}. Return structured output matching ${JSON.stringify(output)} with complete_workflow_step.`,
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
      state.step.input,
    );
  } else if (state.kind === 'parallel') {
    run.status = 'running';
    for (const [slot, step] of state.steps.entries())
      await wake(db, run, parent, slot, step.role, step.skill, step.output, step.timeoutSeconds,
        step.input);
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
    await cancelRunAssignments(db, run);
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
  const checked = await workspaceWorkflowCheck(db, roomId, value);
  if (!checked.ok) throw new Error(`workflow definition is invalid: ${JSON.stringify(checked.errors)}`);
  const definition = readWorkflowDefinition(value)!;
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

export async function checkWorkflow(db: SqlDatabase, roomId: string, value: unknown) {
  return workspaceWorkflowCheck(db, roomId, value);
}

async function workspaceWorkflowCheck(db: SqlDatabase, roomId: string, value: unknown) {
  const skills = await db.query<{ slug: string }>(
    `SELECT skill.slug FROM workspace_skills skill JOIN rooms room ON room.workspace_id=skill.workspace_id
     WHERE room.id=$1 AND skill.state='active'`, [roomId],
  );
  const knownSkills = new Set(skills.rows.map((row) => row.slug));
  knownSkills.add('code-change');
  knownSkills.add('code-review');
  return checkWorkflowDefinition(value, { knownSkills });
}

type WorkflowLayer = 'built-in' | 'workspace' | 'room';
type WorkflowEntry = { name: string; purpose: string; trigger: WorkflowDefinition['trigger'];
  layer: WorkflowLayer; version: number; definition: WorkflowDefinition };

const builtInDefinitions = (() => {
  const value = JSON.parse(readFileSync(new URL('../../../workflows/code-corner/WORKFLOW.json', import.meta.url), 'utf8'));
  const definition = readWorkflowDefinition(value);
  if (!definition) throw new Error('built-in code-corner workflow is invalid');
  return [definition];
})();

async function workflowEntries(db: SqlDatabase, roomId: string): Promise<WorkflowEntry[]> {
  const room = (await db.query<{ workspace_id: string; code_corner: boolean }>(
    `SELECT room.workspace_id,(room.parent_id IS NOT NULL AND fact.lane='code') code_corner
     FROM rooms room LEFT JOIN corner_facts fact ON fact.corner_id=room.id WHERE room.id=$1`, [roomId],
  )).rows[0];
  if (!room) throw new Error('Room not found');
  const published = await db.query<{ name: string; revision: number; definition: WorkflowDefinition }>(
    `SELECT DISTINCT ON (name) name,revision,definition FROM workspace_workflow_definitions
     WHERE workspace_id=$1 ORDER BY name,revision DESC`, [room.workspace_id],
  );
  const drafts = await db.query<{ name: string; revision: number; definition: WorkflowDefinition }>(
    `SELECT DISTINCT ON (name) name,revision,definition FROM workflow_definitions
     WHERE room_id=$1 ORDER BY name,revision DESC`, [roomId],
  );
  const entry = (definition: WorkflowDefinition, revision: number, layer: WorkflowLayer): WorkflowEntry => ({
    name: definition.name, purpose: definition.purpose ?? '', trigger: definition.trigger,
    layer, version: revision, definition,
  });
  const effective = new Map<string, WorkflowEntry>();
  for (const row of drafts.rows) effective.set(row.name, entry(row.definition, row.revision, 'room'));
  for (const row of published.rows) effective.set(row.name, entry(row.definition, row.revision, 'workspace'));
  if (room.code_corner)
    for (const definition of builtInDefinitions)
      effective.set(definition.name, entry(definition, 1, 'built-in'));
  return [...effective.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listWorkflows(db: SqlDatabase, roomId: string) {
  return (await workflowEntries(db, roomId)).map(({ definition: _definition, ...entry }) => entry);
}

export async function readWorkflow(db: SqlDatabase, roomId: string, name: string,
  layer?: WorkflowLayer, revision?: number): Promise<WorkflowEntry> {
  if (!layer) {
    const found = (await workflowEntries(db, roomId)).find((entry) => entry.name === name);
    if (!found) throw new Error('workflow not found');
    return revision === undefined ? found : readWorkflow(db, roomId, name, found.layer, revision);
  }
  if (layer === 'built-in') {
    const available = (await workflowEntries(db, roomId)).some((entry) =>
      entry.layer === 'built-in' && entry.name === name);
    if (!available) throw new Error('workflow not available in this Room');
    const found = builtInDefinitions.find((definition) => definition.name === name);
    if (!found || (revision !== undefined && revision !== 1)) throw new Error('workflow not found');
    return { name, purpose: found.purpose ?? '', trigger: found.trigger,
      layer, version: 1, definition: found };
  }
  const room = (await db.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM rooms WHERE id=$1`, [roomId],
  )).rows[0];
  if (!room) throw new Error('Room not found');
  const workspace = layer === 'workspace';
  const rows = await db.query<{ revision: number; definition: WorkflowDefinition }>(
    workspace
      ? `SELECT revision,definition FROM workspace_workflow_definitions WHERE workspace_id=$1 AND name=$2
         AND ($3::integer IS NULL OR revision=$3) ORDER BY revision DESC LIMIT 1`
      : `SELECT revision,definition FROM workflow_definitions WHERE room_id=$1 AND name=$2
         AND ($3::integer IS NULL OR revision=$3) ORDER BY revision DESC LIMIT 1`,
    [workspace ? room.workspace_id : roomId, name, revision ?? null],
  );
  const found = rows.rows[0];
  if (!found) throw new Error('workflow not found');
  return { name, purpose: found.definition.purpose ?? '', trigger: found.definition.trigger,
    layer: workspace ? 'workspace' as const : 'room' as const,
    version: found.revision, definition: found.definition };
}

export async function publishWorkflow(db: SqlDatabase, roomId: string, name: string,
  parent: CommandRow) {
  const room = (await db.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM rooms WHERE id=$1`, [roomId],
  )).rows[0];
  if (!room) throw new Error('Room not found');
  const draft = await readWorkflow(db, roomId, name, 'room');
  const check = await workspaceWorkflowCheck(db, roomId, draft.definition);
  if (!check.ok) throw new Error(`workflow definition is invalid: ${JSON.stringify(check.errors)}`);
  const choice = await postRoomChoice(db, { roomId, agentId: parent.agent_id,
    mode: 'question', prompt: `Publish workflow ${name} version ${draft.version} to this workspace?`,
    options: [
      { label: 'Approve', consequence: 'Publish this exact draft version.' },
      { label: 'Deny', consequence: 'Keep it as a Room draft.' },
    ],
  });
  await db.query(
    `INSERT INTO workflow_publication_choices(choice_id,room_id,workspace_id,name,source_revision,definition,requested_by)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [choice.choiceId, roomId, room.workspace_id, name, draft.version,
      JSON.stringify(draft.definition), parent.agent_id],
  );
  return { choiceId: choice.choiceId, name, sourceRevision: draft.version };
}

export async function settleWorkflowPublicationChoice(db: SqlDatabase, choiceId: string,
  optionId: string, viewerId: string) {
  const pending = (await db.query<{ room_id: string; workspace_id: string; name: string; source_revision: number;
    definition: WorkflowDefinition; status: string }>(
    `SELECT room_id,workspace_id,name,source_revision,definition,status FROM workflow_publication_choices
     WHERE choice_id=$1 FOR UPDATE`, [choiceId],
  )).rows[0];
  if (!pending || pending.status !== 'pending') return;
  const approved = optionId === 'A';
  if (approved) {
    const check = await workspaceWorkflowCheck(db, pending.room_id, pending.definition);
    if (!check.ok) throw new Error('approved workflow failed its pinned check');
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `workspace-workflow:${pending.workspace_id}:${pending.name}`,
    ]);
    const previous = (await db.query<{ revision: number }>(
      `SELECT revision FROM workspace_workflow_definitions WHERE workspace_id=$1 AND name=$2
       ORDER BY revision DESC LIMIT 1`, [pending.workspace_id, pending.name],
    )).rows[0];
    await db.query(
      `INSERT INTO workspace_workflow_definitions(workspace_id,name,revision,definition,published_by,source_revision,source_room_id)
       VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [pending.workspace_id, pending.name, (previous?.revision ?? 0) + 1,
        JSON.stringify(pending.definition), viewerId, pending.source_revision, pending.room_id],
    );
  }
  await db.query(`UPDATE workflow_publication_choices SET status=$2,decided_by=$3,decided_at=now()
    WHERE choice_id=$1`, [choiceId, approved ? 'approved' : 'denied', viewerId]);
}

export async function startWorkflowRun(
  db: SqlDatabase,
  roomId: string,
  name: string,
  roles: Record<string, string>,
  parent: CommandRow,
  triggerMessageId?: string,
  layer?: WorkflowLayer,
) {
  const saved = await readWorkflow(db, roomId, name, layer);
  const active = (
    await db.query<{ count: number }>(
      `SELECT count(*)::int count FROM workflow_runs WHERE room_id=$1 AND status IN ('running','waiting')`,
      [roomId],
    )
  ).rows[0]!.count;
  if (active >= 50) throw new Error('too many active workflow runs in this Room');
  const definition = readWorkflowDefinition(saved.definition);
  if (!definition) throw new Error('stored workflow definition is invalid');
  const check = await workspaceWorkflowCheck(db, roomId, definition);
  if (!check.ok) throw new Error(`workflow failed its start check: ${JSON.stringify(check.errors)}`);
  const sideEffect = Object.values(definition.states).some((state) =>
    (state.kind === 'step' ? [state.step] : state.kind === 'parallel' ? state.steps : [])
      .some((step) => Boolean(step.effects?.length)));
  const approvalRequired = saved.layer === 'room' &&
    (check.bounds.durationMs > 30 * 60_000 || check.bounds.agentTurns > 10 || sideEffect);
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
    revision: saved.version,
    layer: saved.layer,
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
    `INSERT INTO workflow_runs(id,room_id,name,revision,layer,definition,roles,state,status,source_command_id,trigger_message_id)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING`,
    [
      run.id,
      roomId,
      name,
      run.revision,
      run.layer,
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
  if (approvalRequired) {
    run.status = 'waiting';
    await save(db, run);
    const choice = await postRoomChoice(db, { roomId, agentId: parent.agent_id,
      mode: 'question', prompt: `Start workflow ${name} version ${saved.version}?`,
      constraint: `Bound ${Math.ceil(check.bounds.durationMs / 60_000)} minutes and ${check.bounds.agentTurns} agent turns.`,
      options: [
        { label: 'Approve', consequence: 'Start this workflow run.' },
        { label: 'Deny', consequence: 'Do not start this run.' },
      ],
    });
    await db.query(`INSERT INTO workflow_start_choices(choice_id,run_id) VALUES($1,$2)`,
      [choice.choiceId, run.id]);
    await log(db, run, 'approval_requested', { choiceId: choice.choiceId });
  } else await dispatchOrFail(db, run, parent);
  return runView(run);
}

export async function settleWorkflowStartChoice(db: SqlDatabase, choiceId: string,
  optionId: string, viewerId: string) {
  const choice = (await db.query<{ run_id: string; status: string }>(
    `SELECT run_id,status FROM workflow_start_choices WHERE choice_id=$1 FOR UPDATE`, [choiceId],
  )).rows[0];
  if (!choice || choice.status !== 'pending') return;
  const run = (await db.query<Run>(`SELECT * FROM workflow_runs WHERE id=$1 FOR UPDATE`,
    [choice.run_id])).rows[0];
  if (!run || run.status !== 'waiting') return;
  const approved = optionId === 'A';
  await db.query(`UPDATE workflow_start_choices SET status=$2,decided_by=$3,decided_at=now()
    WHERE choice_id=$1`, [choiceId, approved ? 'approved' : 'denied', viewerId]);
  await log(db, run, approved ? 'start_approved' : 'start_denied', { viewerId, choiceId });
  if (!approved) {
    run.status = 'failed';
    run.error = 'Human denied workflow start';
    await save(db, run);
    return;
  }
  const parent = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`,
    [run.source_command_id])).rows[0];
  if (!parent) throw new Error('workflow source command is missing');
  await dispatchOrFail(db, run, parent);
}

export async function overrideWorkflowRun(db: SqlDatabase, input: {
  roomId: string; runId: string; action: 'jump' | 'reassign' | 'kill'; state?: string;
  role?: string; agentId?: string; reason: string;
}, viewerId: string) {
  if (!input.reason.trim() || input.reason.length > 500) throw new Error('override reason is required');
  const human = (await db.query<{ identity_id: string }>(
    `SELECT m.identity_id FROM memberships m JOIN identities i ON i.id=m.identity_id
     WHERE m.room_id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL AND i.kind='human'
     FOR SHARE OF m`, [input.roomId, viewerId],
  )).rows[0];
  if (!human) throw new Error('workflow override requires a current human Room member');
  const run = (await db.query<Run>(
    `SELECT * FROM workflow_runs WHERE id=$1 AND room_id=$2 FOR UPDATE`,
    [input.runId, input.roomId],
  )).rows[0];
  if (!run) throw new Error('workflow run not found');
  if (run.status === 'complete' || run.status === 'failed') throw new Error('workflow run has ended');
  const pendingStart = (await db.query(
    `SELECT 1 FROM workflow_start_choices WHERE run_id=$1 AND status='pending'`, [run.id],
  )).rowCount;
  if (pendingStart) throw new Error('workflow start still needs human approval');
  const retireAssignments = async () => {
    const gate = (await db.query<{ choice_id: string }>(
      `SELECT choice_id FROM workflow_run_gates WHERE run_id=$1 AND sequence=$2`,
      [run.id, run.sequence],
    )).rows[0];
    if (gate) await settleExpiredChoice(db, gate.choice_id, true);
    await cancelRunAssignments(db, run);
  };
  if (input.action === 'kill') {
    const fromState = run.state;
    await retireAssignments();
    run.status = 'failed';
    run.error = `Killed by human: ${input.reason}`;
    run.deadline_at = null;
    run.sequence++;
    await save(db, run);
    await log(db, run, 'override_kill', { viewerId, fromState, reason: input.reason });
    return;
  }
  if (input.action === 'reassign') {
    if (!input.role || !run.definition.roles.includes(input.role) || !input.agentId)
      throw new Error('valid role and agent are required');
    const member = (await db.query(
      `SELECT 1 FROM memberships m JOIN identities i ON i.id=m.identity_id AND i.kind='agent'
       WHERE m.room_id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL FOR SHARE OF m`,
      [input.roomId, input.agentId],
    )).rowCount;
    if (!member) throw new Error('replacement must be a current Room agent');
    const priorAgentId = run.roles[input.role];
    run.roles[input.role] = input.agentId;
    const state = run.definition.states[run.state];
    const assignedSlots = state?.kind === 'step'
      ? state.step.role === input.role ? [0] : []
      : state?.kind === 'parallel'
        ? state.steps.flatMap((step, index) => step.role === input.role ? [index] : [])
        : [];
    const parent = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`,
      [run.source_command_id])).rows[0];
    if (!parent) throw new Error('workflow source command is missing');
    for (const slot of assignedSlots) {
      const assignment = (await db.query<{ status: string; command_id: string }>(
        `SELECT status,command_id FROM workflow_run_assignments WHERE run_id=$1 AND sequence=$2 AND slot=$3`,
        [run.id, run.sequence, slot],
      )).rows[0];
      if (assignment?.status !== 'pending') continue;
      const note = await systemLine(db, {
        roomId: run.room_id,
        subject: { kind: 'person', id: viewerId, name: 'A Room member' },
        verb: 'reassigned workflow step', object: `${run.name}: ${run.state}`,
        consequence: `Run ${run.id}, sequence ${run.sequence}. ${input.reason}`,
      });
      const command = await createAgentCommand(db, { roomId: run.room_id,
        agentId: input.agentId, sourceMessageId: note.id, reason: 'workflow_reassigned',
        parent, retainDepth: true });
      if (!command) throw new Error('replacement agent cannot be woken');
      await db.query(`UPDATE agent_commands SET state='cancelled',completed_at=now()
        WHERE id=$1 AND state IN ('pending','claimed')`, [assignment.command_id]);
      await db.query(`UPDATE workflow_run_assignments SET agent_id=$4,command_id=$5
        WHERE run_id=$1 AND sequence=$2 AND slot=$3`,
        [run.id, run.sequence, slot, input.agentId, command.id]);
    }
    await save(db, run);
    await log(db, run, 'override_reassign', { viewerId, role: input.role,
      priorAgentId, agentId: input.agentId, reason: input.reason });
    return;
  }
  if (input.action === 'jump') {
    const target = input.state ? run.definition.states[input.state] : undefined;
    if (!target || target.kind === 'terminal')
      throw new Error('jump target must be a nonterminal state');
    const effects = target.kind === 'step' ? target.step.effects :
      target.kind === 'parallel' ? target.steps.flatMap((step) => step.effects ?? []) : [];
    if (effects?.length) throw new Error('jump cannot bypass a step with domain effects');
    const fromState = run.state;
    const parent = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`,
      [run.source_command_id])).rows[0];
    if (!parent) throw new Error('workflow source command is missing');
    await retireAssignments();
    run.state = input.state!;
    run.sequence++;
    run.deadline_at = null;
    await log(db, run, 'override_jump', { viewerId, fromState,
      toState: run.state, reason: input.reason });
    await dispatchOrFail(db, run, parent);
    return;
  }
  throw new Error('unknown workflow override');
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
    try { await reserveWorkflowTurn(db, run); }
    catch (cause) {
      run.status = 'failed';
      run.error = cause instanceof Error ? cause.message : 'workflow turn cap reached';
      run.deadline_at = null;
      await save(db, run);
      await log(db, run, 'failed', { error: run.error });
      return receipt({ state: run.state, status: run.status, error: run.error });
    }
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
  if (error && state.kind === 'parallel' && !state.on.failure) {
    await log(db, run, 'failure', {
      output,
      error,
      agentId: parent.agent_id,
      commandId: parent.id,
    });
    return receipt({ state: run.state, status: run.status, error });
  }
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
    if (run.name === 'code-corner' && event === 'check-completed') {
      const current = (await db.query<{ head_sha: string | null }>(
        `SELECT lifecycle->'pr'->>'headSha' head_sha FROM corner_facts WHERE corner_id=$1
         FOR SHARE`, [roomId],
      )).rows[0]?.head_sha;
      if (!current || payload.sha !== current) continue;
    }
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
    await dispatchOrFail(db, run, parent);
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
  await dispatchOrFail(db, run, parent);
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
            await reserveWorkflowTurn(tx, run);
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
        await dispatchOrFail(tx, run, parent);
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
