import { humanRoomAdmin, WorkflowAuthorizationError } from './workflow-admin.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  workflowSaveError,
  workflowContentsError,
  workflowReceiptError,
  type WorkflowReceiptInput,
  isAgentIdentityReference,
  WORKFLOW_ROLE_AGENTS_MAX,
  type WorkflowContract,
  type WorkflowGateState,
  type WorkflowHandoffState,
  type WorkflowRoleBinding,
  type WorkflowState,
  type WorkflowRunReadResult,
  type WorkflowReceipt,
} from '@beeline/api-contract/daemon';
import { bindWorkflowStepOutput } from './workflow-step-output.js';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { applySkillRevision, assertSkillTextSafe } from './institutional-skills.js';
import type { AfterCommit } from './institutional-memory-embeddings.js';
import { nextScheduleOccurrence, validateScheduleCadence } from './agent-schedules.js';
import { firstHealthyAgent, nextHealthyAgent } from './agent-health.js';
import { closeRunChoices, postRoomChoice } from './room-choice.js';
import { ensureSystemIdentity, identitySubject, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

/**
 * No run-state tables: a run is identified by its `start_workflow` message id
 * (`runId`), and its current step is the `toState` of the most recent
 * `workflow-handoff` card citing that id — the start message is itself the
 * first such card, so this is a single, uniform derivation with no separate
 * "or start if none exists" branch.
 */
export const WORKFLOW_HANDOFF_CARD_TYPE = 'workflow-handoff';

type WorkflowRunCard = {
  runId: string;
  /** Absent on cards written before per-run sequencing. */
  seq?: number;
  workflowSlug: string;
  workflowVersion: number;
  /** The agent holding each role; a list-bound role is absent until its first dispatch. */
  roleBindings: Record<string, string>;
  /**
   * Roles bound to an ordered list of agents rather than one, keyed by role
   * name — set once on the start card and never rewritten, so a later
   * reassignment can still walk the list after `roleBindings[role]` has
   * resolved to one agent. Absent entirely for a run with no list-bound role.
   */
  roleAgents?: Record<string, string[]>;
  toState: string;
  fromState?: string;
  outcome?: string;
  status?: 'done' | 'failed' | 'abandoned';
  requesterId?: string;
  cancellation?: { reason: string; actorId: string };
  contents?: unknown;
  receipt?: WorkflowReceipt;
  /** A same-state reassignment card (list failover or `assign_workflow_role`): no outcome, same toState as before. */
  reassigned?: true;
  trigger?: { scheduleId: string; period: string };
};

type IdentityRow = { id: string; kind: 'human' | 'agent'; name: string };

async function loadIdentityRow(db: SqlDatabase, id: string): Promise<IdentityRow> {
  const row = (
    await db.query<IdentityRow>(`SELECT id,kind,name FROM identities WHERE id=$1`, [id])
  ).rows[0];
  if (!row) throw new Error('identity not found');
  return row;
}

async function loadRun(
  db: SqlDatabase,
  roomId: string,
  runId: string,
): Promise<WorkflowRunCard | undefined> {
  const row = (
    await db.query<{ card: WorkflowRunCard }>(
      `SELECT card FROM messages
       WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$3
       ORDER BY (card->>'seq')::int DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
      [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId],
    )
  ).rows[0];
  return row?.card;
}

/** The start card's immutable list-bound-role map; `{}` for a run with no list-bound role. */
async function loadRunRoleAgents(
  db: SqlDatabase,
  roomId: string,
  runId: string,
): Promise<Record<string, string[]>> {
  const row = (
    await db.query<{ role_agents: Record<string, string[]> | null }>(
      `SELECT card->'roleAgents' role_agents FROM messages
       WHERE id=$1 AND room_id=$2 AND card_type=$3`,
      [runId, roomId, WORKFLOW_HANDOFF_CARD_TYPE],
    )
  ).rows[0];
  return row?.role_agents ?? {};
}

/**
 * Resolve `role`'s binding to a concrete agent id, picking the first healthy
 * agent on its list only the FIRST time a list-bound role is dispatched —
 * once resolved, `roleBindings[role]` holds that agent and is reused as-is
 * for the rest of the run (sticky), matching "keep the agent that took a role
 * unless it fails." Mutates `roleBindings` in place on success.
 */
async function resolveRoleBinding(
  db: SqlDatabase,
  input: {
    roomId: string;
    roleBindings: Record<string, string>;
    roleAgents: Record<string, string[]>;
    role: string;
  },
): Promise<{ agentId: string } | { exhausted: true }> {
  const current = input.roleBindings[input.role];
  if (current) return { agentId: current };
  const picked = await firstHealthyAgent(db, input.roomId, input.roleAgents[input.role] ?? []);
  if (!picked) return { exhausted: true };
  input.roleBindings[input.role] = picked;
  return { agentId: picked };
}

/**
 * A list-bound role with no healthy agent is named in the run rather than
 * silently stalling — the same "ask a human" shape as a corner reviewer list
 * with nobody healthy. The run stays parked at this state: a human can
 * address any Room member and ask it to call `assign_workflow_role`, which
 * binds a specific agent and re-wakes it with no health filter (an explicit
 * human choice overrides "healthy").
 */
async function noteWorkflowRoleExhausted(
  db: SqlDatabase,
  input: { roomId: string; runId: string; role: string; afterMessageId: string },
): Promise<void> {
  const id = createHash('sha256')
    .update(`beeline:workflow-role-exhausted:v1:${input.runId}:${input.role}:${input.afterMessageId}`)
    .digest('hex');
  await ensureSystemIdentity(db);
  await systemLine(db, {
    id,
    roomId: input.roomId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: `No agent on the ${input.role} role's list` },
    verb: 'is healthy',
    consequence: 'ask an agent to call assign_workflow_role to bind another agent in this Room',
    afterMessageId: input.afterMessageId,
  });
}

/** The exact pinned version, independent of the slug's current/archived state. */
async function loadPinnedContract(
  db: SqlDatabase,
  roomId: string,
  slug: string,
  version: number,
): Promise<WorkflowContract | undefined> {
  const row = (
    await db.query<{ markdown: string }>(
      `SELECT skillversion.markdown
       FROM rooms room
       JOIN workspace_skills skill ON skill.workspace_id=room.workspace_id
         AND skill.slug=$2 AND skill.kind='workflow'
       JOIN workspace_skill_versions skillversion
         ON skillversion.skill_id=skill.id AND skillversion.version=$3
       WHERE room.id=$1`,
      [roomId, slug, version],
    )
  ).rows[0];
  if (!row) return undefined;
  return JSON.parse(row.markdown) as WorkflowContract;
}

export async function getWorkflowRun(
  db: SqlDatabase,
  roomId: string,
  runId: string,
): Promise<WorkflowRunReadResult> {
  if (typeof runId !== 'string' || !runId) throw new Error('runId is required');
  const rows = (await db.query<{ id: string; author_id: string; created_at: Date; card: WorkflowRunCard }>(
    `SELECT id,author_id,created_at,card FROM messages
     WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$3
     ORDER BY (card->>'seq')::int ASC NULLS FIRST,created_at,id`,
    [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId],
  )).rows;
  const run = rows.at(-1)?.card;
  if (!run) throw new Error('workflow run is unavailable in this Room');
  const contract = await loadPinnedContract(db, roomId, run.workflowSlug, run.workflowVersion);
  if (!contract) throw new Error('workflow contract version is unavailable');
  const state = contract.handoffs[run.toState];
  const activeState = state && state.kind !== 'terminal' && !run.cancellation ? state : undefined;
  const role = activeState && 'role' in activeState ? activeState.role : undefined;
  return {
    runId,
    workflowSlug: run.workflowSlug,
    workflowVersion: run.workflowVersion,
    state: run.toState,
    status: run.cancellation ? 'abandoned' : state?.kind === 'terminal' ? state.status : 'live',
    ...(role ? { role, ...(run.roleBindings[role] ? { boundAgentId: run.roleBindings[role] } : {}) } : {}),
    allowedOutcomes: activeState && 'on' in activeState ? activeState.on : {},
    requiredFields: activeState && 'requires' in activeState ? activeState.requires : [],
    ...(state?.hint ? { receiptHint: state.hint } : {}),
    ...(run.cancellation ? { cancellation: run.cancellation } : {}),
    contract,
    history: rows.map(({ id, author_id, created_at, card }) => ({
      messageId: id,
      actorId: author_id,
      at: Math.floor(new Date(created_at).getTime() / 1000),
      toState: card.toState,
      ...(card.fromState ? { fromState: card.fromState } : {}),
      ...(card.outcome ? { outcome: card.outcome } : {}),
      ...(card.contents !== undefined ? { contents: card.contents } : {}),
      ...(card.receipt ? { receipt: card.receipt } : {}),
      ...(card.reassigned ? { reassigned: card.reassigned } : {}),
      ...(card.status ? { status: card.status } : {}),
      ...(card.cancellation ? { cancellation: card.cancellation } : {}),
    })),
  };
}

/** The authenticated command's root requester; agents cannot supply a different actor. */
async function workflowRequester(
  db: SqlDatabase,
  command: Pick<CommandRow, 'agent_id'> & { root_source_message_id?: string },
): Promise<string> {
  const root = command.root_source_message_id
    ? (await db.query<{ author_id: string }>(
        `SELECT author_id FROM messages WHERE id=$1 AND deleted_at IS NULL`,
        [command.root_source_message_id],
      )).rows[0]
    : undefined;
  return root?.author_id ?? command.agent_id;
}

export async function cancelWorkflowRun(
  database: SqlDatabase,
  command: CommandRow,
  input: { runId: string; reason: string },
): Promise<{ runId: string; state: string; status: 'abandoned'; reason: string }> {
  if (typeof input.runId !== 'string' || !input.runId) throw new Error('runId is required');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4000)
    throw new Error('cancellation reason must contain 1-4000 characters');
  return database.transaction(async (db) => {
    await lockWorkflowRun(db, input.runId);
    const run = await loadRun(db, command.room_id, input.runId);
    if (!run) throw new Error('workflow run is unavailable in this Room');
    const start = (await db.query<{ author_id: string; card: WorkflowRunCard }>(
      `SELECT author_id,card FROM messages WHERE room_id=$1 AND id=$2 AND card_type=$3`,
      [command.room_id, input.runId, WORKFLOW_HANDOFF_CARD_TYPE],
    )).rows[0];
    if (!start) throw new Error('workflow start is unavailable');
    const actorId = await workflowRequester(db, command);
    const roleOwners = await db.query(
      `SELECT 1 FROM agents WHERE agent_id=ANY($1::text[]) AND owner_id=$2`,
      [[...Object.values(run.roleBindings), ...Object.values(start.card.roleAgents ?? {}).flat()], actorId],
    );
    // Older runs retain the start card's author as their requester.
    if (
      actorId !== (start.card.requesterId ?? start.author_id) && !roleOwners.rowCount &&
      !(await humanRoomAdmin(db, command.room_id, actorId))
    ) {
      throw new WorkflowAuthorizationError(
        'only the run requester, a bound role owner, or a human Room admin can cancel this run',
        403,
      );
    }
    const contract = await loadPinnedContract(db, command.room_id, run.workflowSlug, run.workflowVersion);
    if (!contract) throw new Error('workflow contract version is unavailable');
    if (run.cancellation || contract.handoffs[run.toState]?.kind === 'terminal')
      throw new Error('this workflow run has already ended');
    await cancelWorkflowTimeout(db, input.runId, run.toState);
    const reason = input.reason.trim();
    await ensureSystemIdentity(db);
    await systemLine(db, {
      roomId: command.room_id,
      authorId: SYSTEM_IDENTITY_ID,
      subject: identitySubject(await loadIdentityRow(db, actorId)),
      verb: 'cancelled workflow',
      object: run.workflowSlug,
      consequence: `run ${input.runId}`,
      afterMessageId: input.runId,
      // No event kind: cancellation is a durable record that wakes nobody.
      presentation: 'card',
      cardType: WORKFLOW_HANDOFF_CARD_TYPE,
      card: {
        runId: input.runId,
        seq: (run.seq ?? 0) + 1,
        workflowSlug: run.workflowSlug,
        workflowVersion: run.workflowVersion,
        roleBindings: run.roleBindings,
        fromState: run.toState,
        toState: run.toState,
        outcome: 'cancelled',
        status: 'abandoned',
        cancellation: { reason, actorId },
        contents: { reason },
      },
    });
    await db.query(
      `UPDATE messages SET card=card || '{"active":false,"currentAgentId":null}'::jsonb
       WHERE id=$1 AND room_id=$2`, [input.runId, command.room_id],
    );
    await db.query(
      `UPDATE room_choices choice SET status='closed'
       FROM messages message WHERE choice.message_id=message.id AND choice.room_id=$1
         AND message.card->>'runId'=$2 AND choice.status='open'`,
      [command.room_id, input.runId],
    );
    await db.query(
      `UPDATE messages SET card=card || '{"status":"closed"}'::jsonb
       WHERE room_id=$1 AND card->>'runId'=$2 AND card_type='choice'`,
      [command.room_id, input.runId],
    );
    await db.query(
      `UPDATE agent_commands command SET state='cancelled',completed_at=now()
       FROM messages message WHERE command.source_message_id=message.id AND command.room_id=$1
         AND message.card->>'runId'=$2 AND command.state='pending'`,
      [command.room_id, input.runId],
    );
    return { runId: input.runId, state: run.toState, status: 'abandoned', reason };
  });
}

/** A deterministic uuid so a state's own pending timeout can be found and cancelled. */
function workflowTimeoutScheduleId(runId: string, stateName: string): string {
  const bytes = createHash('sha256')
    .update(`beeline:workflow-timeout:v1:${runId}:${stateName}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Serializes the whole "derive current state -> validate -> write the next
 * card" critical section per run. Without this, two concurrent handoffs (or
 * a handoff racing the run's own start) both read the same current state
 * under READ COMMITTED, both validate independently, and both insert a
 * `workflow-handoff` card — whichever commits last silently becomes the
 * run's canonical state per `loadRun`'s newest-card-wins derivation, even
 * though both wakes already fired. Taken as the FIRST statement in the
 * transaction, before any read, matching the discipline `resolveCascade`
 * already uses for a cascade's root lock.
 */
export function workflowRunLockKey(runId: string): string {
  return `workflow-run:${runId}`;
}

async function lockWorkflowRun(db: SqlDatabase, runId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [workflowRunLockKey(runId)]);
}

async function cancelWorkflowTimeout(db: SqlDatabase, runId: string, stateName: string): Promise<void> {
  await db.query(`DELETE FROM agent_schedules WHERE id=$1`, [
    workflowTimeoutScheduleId(runId, stateName),
  ]);
}

async function scheduleWorkflowTimeout(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    roomId: string;
    runId: string;
    workflowName: string;
    stateName: string;
    agentId: string;
    seconds: number;
    hint?: string;
  },
): Promise<void> {
  const everyMinutes = Math.max(1, Math.ceil(input.seconds / 60));
  const startsAt = Math.floor((Date.now() + input.seconds * 1_000) / 1_000);
  const cadence = { kind: 'interval' as const, everyMinutes, startsAt };
  validateScheduleCadence(cadence);
  const nextRunAt = nextScheduleOccurrence(cadence, new Date());
  await db.query(
    `INSERT INTO agent_schedules
       (id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at,workflow_run)
     VALUES($1,$2,$3,$4,$4,$5::jsonb,$6,1,$7,$8::jsonb)
     ON CONFLICT(id) DO UPDATE
       SET cadence=EXCLUDED.cadence,message=EXCLUDED.message,next_run_at=EXCLUDED.next_run_at,
           workflow_run=EXCLUDED.workflow_run,run_count=0,updated_at=now()`,
    [
      workflowTimeoutScheduleId(input.runId, input.stateName),
      input.workspaceId,
      input.roomId,
      input.agentId,
      JSON.stringify(cadence),
      `workflow run ${input.runId} timed out at ${input.stateName}; call handoff with outcome "timeout"${input.hint ? `; receipt hint: ${input.hint}` : ''}`,
      nextRunAt,
      JSON.stringify({ runId: input.runId, workflowSlug: input.workflowName }),
    ],
  );
}

function isHandoffState(state: WorkflowState): state is WorkflowHandoffState {
  return state.kind === undefined;
}

/** The gate card's question; the run page finds a gate's card by it. */
export function workflowGatePrompt(contract: Pick<WorkflowContract, 'name'>, stateName: string): string {
  return `${contract.name}: ${stateName}`.slice(0, 120);
}

/** Posts the gate's ask_choice card; the bound role's agent is woken once a human answers. */
async function postWorkflowGate(
  db: SqlDatabase,
  input: {
    roomId: string;
    runId: string;
    contract: WorkflowContract;
    roleBindings: Readonly<Record<string, string>>;
    stateName: string;
    state: WorkflowGateState;
  },
): Promise<void> {
  const askerAgentId = input.roleBindings[input.state.role];
  if (!askerAgentId) throw new Error(`no agent is bound to the ${input.state.role} role`);
  const choice = await postRoomChoice(db, {
    roomId: input.roomId,
    agentId: askerAgentId,
    mode: 'question',
    prompt: workflowGatePrompt(input.contract, input.stateName),
    options: Object.entries(input.state.on).map(([outcome, target]) => ({
      label: outcome,
      consequence: `go to ${target}`.slice(0, 80),
    })),
  });
  await db.query(
    `UPDATE messages SET card=card || $2::jsonb WHERE id=$1`,
    [choice.messageId, JSON.stringify({
      runId: input.runId,
      workflowSlug: input.contract.name,
      ...(input.state.hint ? { receiptHint: input.state.hint } : {}),
    })],
  );
}

export async function saveWorkflow(
  database: SqlDatabase,
  command: CommandRow,
  input: { contract: unknown },
  afterCommit?: AfterCommit,
): Promise<{ slug: string; version: number }> {
  const reason = workflowSaveError(input.contract);
  if (reason !== null) throw new Error(`workflow contract is invalid: ${reason}`);
  const contract = input.contract as WorkflowContract;
  const room = (
    await database.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [
      command.room_id,
    ])
  ).rows[0];
  if (!room) throw new Error('workflow room not found');
  const markdown = JSON.stringify(contract);
  assertSkillTextSafe(contract.description, markdown);
  return database.transaction(async (db) => {
    const member = await db.query(
      `SELECT 1 FROM identities identity JOIN memberships member ON member.identity_id=identity.id
    WHERE identity.id=$1 AND identity.kind='agent' AND member.room_id=$2 AND member.removed_at IS NULL`,
      [command.agent_id, command.room_id],
    );
    if (!member.rowCount)
      throw new Error('workflow saver must be a current agent member of this Room');
    const { skillId, version } = await applySkillRevision(
      db,
      {
        workspaceId: room.workspace_id,
        sourceRoomId: command.room_id,
        slug: contract.name,
        description: contract.description,
        markdown,
        kind: 'workflow',
        sourceMessageIds: [command.root_source_message_id],
      },
      afterCommit,
    );
    return { slug: contract.name, version };
  });
}

/** One agent id, or 1-WORKFLOW_ROLE_AGENTS_MAX distinct agent ids in order; `null` for anything else. */
function roleAgentList(binding: WorkflowRoleBinding): string[] | null {
  if (isAgentIdentityReference(binding)) return [binding];
  if (!Array.isArray(binding)) return null;
  if (!binding.length || binding.length > WORKFLOW_ROLE_AGENTS_MAX) return null;
  if (!binding.every(isAgentIdentityReference)) return null;
  return new Set(binding).size === binding.length ? [...binding] : null;
}

async function activeRunHeldByAgent(
  db: SqlDatabase,
  input: { roomId: string; agentId: string; workflowName: string },
): Promise<{ runId: string } | undefined> {
  const active = await db.query<{ id: string }>(
    `SELECT id FROM messages
     WHERE room_id=$1 AND card_type='workflow-handoff' AND card->>'active'='true'
       AND card->>'workflowSlug'=$2 AND card->>'currentAgentId'=$3
     ORDER BY id LIMIT 1`,
    [input.roomId, input.workflowName, input.agentId],
  );
  return active.rows[0] ? { runId: active.rows[0].id } : undefined;
}

/** The schedule occurrence (if any) whose wake message triggered this call. */
async function scheduleTriggerPeriod(
  db: SqlDatabase,
  sourceMessageId: string,
): Promise<{ scheduleId: string; period: string } | undefined> {
  const row = (
    await db.query<{ schedule_id: string; scheduled_for: Date }>(
      `SELECT schedule_id,scheduled_for FROM agent_schedule_occurrences WHERE message_id=$1`,
      [sourceMessageId],
    )
  ).rows[0];
  if (row) return { scheduleId: row.schedule_id, period: row.scheduled_for.toISOString() };
  const wake = (await db.query<{ trigger: { scheduleId: string; period: string } | null }>(
    `SELECT card->'trigger' trigger FROM messages WHERE id=$1`, [sourceMessageId],
  )).rows[0];
  return wake?.trigger?.scheduleId && wake.trigger.period ? wake.trigger : undefined;
}

/** An active run of `workflowName` in `roomId` whose start card recorded this exact schedule+period. */
async function activeRunForTrigger(
  db: SqlDatabase,
  roomId: string,
  workflowName: string,
  trigger: { scheduleId: string; period: string },
): Promise<{ runId: string } | undefined> {
  const active = await db.query<{ id: string }>(
    `SELECT id FROM messages
     WHERE room_id=$1 AND card_type='workflow-handoff' AND card->>'active'='true'
       AND card->>'workflowSlug'=$2
       AND card->'trigger'->>'scheduleId'=$3 AND card->'trigger'->>'period'=$4
     ORDER BY id LIMIT 1`,
    [roomId, workflowName, trigger.scheduleId, trigger.period],
  );
  return active.rows[0] ? { runId: active.rows[0].id } : undefined;
}

/** Every still-active run id this schedule has ever started (any workflow), for `list_schedules`. */
export async function activeRunIdsForSchedule(
  db: SqlDatabase,
  roomId: string,
  scheduleId: string,
): Promise<string[]> {
  const active = await db.query<{ id: string }>(
    `SELECT id FROM messages
     WHERE room_id=$1 AND card_type='workflow-handoff' AND card->>'active'='true'
       AND card->'trigger'->>'scheduleId'=$2
     ORDER BY id`,
    [roomId, scheduleId],
  );
  return active.rows.map((row) => row.id);
}

export async function startWorkflow(
  database: SqlDatabase,
  command: Pick<CommandRow, 'room_id' | 'agent_id'> & { reason?: string; source_message_id?: string; root_source_message_id?: string },
  input: { name: string; roleBindings: Readonly<Record<string, WorkflowRoleBinding>> },
): Promise<{ runId: string; state: string }> {
  if (typeof input.name !== 'string' || !input.name) throw new Error('workflow name is required');
  if (!input.roleBindings || typeof input.roleBindings !== 'object') {
    throw new Error('roleBindings is required');
  }

  return database.transaction(async (db) => {
    const held = await activeRunHeldByAgent(db, {
      roomId: command.room_id,
      agentId: command.agent_id,
      workflowName: input.name,
    });
    if (held) {
      throw new Error(
        `You are already in run ${held.runId} of ${input.name}. Continue it or hand off within it.`,
      );
    }
    const room = (
      await db.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [
        command.room_id,
      ])
    ).rows[0];
    if (!room) throw new Error('workflow room not found');
    const skill = (
      await db.query<{ current_version: number; markdown: string }>(
        `SELECT skill.current_version,version.markdown
         FROM workspace_skills skill
         JOIN workspace_skill_versions version
           ON version.skill_id=skill.id AND version.version=skill.current_version
         WHERE skill.workspace_id=$1 AND skill.slug=$2 AND skill.kind='workflow'
           AND skill.state='active' AND version.source_deleted_at IS NULL`,
        [room.workspace_id, input.name],
      )
    ).rows[0];
    if (!skill) throw new Error('workflow is unavailable');
    const contract = JSON.parse(skill.markdown) as WorkflowContract;
    const trigger = command.source_message_id
      ? await scheduleTriggerPeriod(db, command.source_message_id)
      : undefined;
    if (trigger) {
      const collision = await activeRunForTrigger(db, command.room_id, input.name, trigger);
      if (collision) {
        throw new Error(
          `${input.name} already has an active run ${collision.runId} started by this schedule for this period. Continue it, or ask a human admin to override.`,
        );
      }
    }
    const missingRole = contract.roles.find((role) => !input.roleBindings[role]);
    if (missingRole) throw new Error(`role binding is missing for ${missingRole}`);
    const roleBindings: Record<string, string> = {};
    const roleAgents: Record<string, string[]> = {};
    for (const role of contract.roles) {
      const raw = input.roleBindings[role]!;
      const agents = roleAgentList(
        typeof raw === 'string'
          ? await resolveHandleBinding(db, command.room_id, raw)
          : Array.isArray(raw)
            ? await Promise.all(
                raw.map((entry) => resolveHandleBinding(db, command.room_id, entry)),
              )
            : raw,
      );
      if (!agents) {
        throw new Error(
          `role binding for ${role} must be an agent id or a member handle, or a list of 1-${WORKFLOW_ROLE_AGENTS_MAX} distinct ones`,
        );
      }
      if (agents.length === 1) roleBindings[role] = agents[0]!;
      else roleAgents[role] = agents;
    }
    const boundIds = [
      ...new Set([...Object.values(roleBindings), ...Object.values(roleAgents).flat()]),
    ];
    if (boundIds.length) {
      const agents = await db.query<{ identity_id: string }>(
        `SELECT member.identity_id FROM memberships member
         JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
         WHERE member.room_id=$1 AND member.identity_id=ANY($2::text[]) AND member.removed_at IS NULL`,
        [command.room_id, boundIds],
      );
      const agentSet = new Set(agents.rows.map((row) => row.identity_id));
      const notAgent = boundIds.find((id) => !agentSet.has(id));
      if (notAgent) {
        throw new Error(`${notAgent} is not a current agent member of this Room`);
      }
    }
    const starter = await loadIdentityRow(db, command.agent_id);
    const runId = randomBytes(32).toString('hex');
    // No other writer can already hold this exact fresh, random runId, but
    // taking the lock here anyway keeps every run-card writer in this file
    // following the identical discipline handoff() below requires.
    await lockWorkflowRun(db, runId);
    const startState = contract.handoffs[contract.start]!;
    const isGate = startState.kind === 'gate';
    const startRole = (startState as WorkflowHandoffState | WorkflowGateState).role;
    const resolution = await resolveRoleBinding(db, {
      roomId: command.room_id,
      roleBindings,
      roleAgents,
      role: startRole,
    });
    const exhausted = 'exhausted' in resolution;
    await systemLine(db, {
      id: runId,
      roomId: command.room_id,
      authorId: command.agent_id,
      subject: identitySubject(starter),
      verb: 'started workflow',
      object: contract.name,
      consequence: `run ${runId}`,
      kind: 'workflow-handoff',
      ...(!exhausted && !isGate ? { wakes: [(resolution as { agentId: string }).agentId] } : {}),
      presentation: 'card',
      cardType: WORKFLOW_HANDOFF_CARD_TYPE,
      card: {
        runId,
        seq: 0,
        active: true,
        currentAgentId: exhausted ? null : (resolution as { agentId: string }).agentId,
        workflowSlug: contract.name,
        workflowVersion: skill.current_version,
        requesterId: await workflowRequester(db, command),
        startKind:
          starter?.kind === 'human'
            ? 'human_admin'
            : command.reason === 'schedule'
              ? 'schedule'
              : 'direct',
        roleBindings,
        ...(Object.keys(roleAgents).length ? { roleAgents } : {}),
        toState: contract.start,
        ...(startState.hint ? { receiptHint: startState.hint } : {}),
        ...(trigger ? { trigger } : {}),
      },
    });
    if (exhausted) {
      await noteWorkflowRoleExhausted(db, {
        roomId: command.room_id,
        runId,
        role: startRole,
        afterMessageId: runId,
      });
    } else if (isGate) {
      await postWorkflowGate(db, {
        roomId: command.room_id,
        runId,
        contract,
        roleBindings,
        stateName: contract.start,
        state: startState as WorkflowGateState,
      });
    } else if ((startState as WorkflowHandoffState).timeoutSeconds) {
      await scheduleWorkflowTimeout(db, {
        workspaceId: room.workspace_id,
        roomId: command.room_id,
        runId,
        workflowName: contract.name,
        stateName: contract.start,
        agentId: (resolution as { agentId: string }).agentId,
        seconds: (startState as WorkflowHandoffState).timeoutSeconds!,
        hint: startState.hint,
      });
    }
    return { runId, state: contract.start };
  });
}

export async function handoff(
  database: SqlDatabase,
  command: CommandRow,
  input: { runId: string; outcome: string; contents: unknown; receipt?: WorkflowReceiptInput },
): Promise<{ runId: string; state: string; status?: 'done' | 'failed' }> {
  if (typeof input.runId !== 'string' || !input.runId) throw new Error('runId is required');
  return database.transaction(async (db) => {
    // First statement, before any read: serializes this run's whole
    // read-validate-write critical section against every other handoff (or
    // the run's own start) so "what state is this run in" can never be
    // answered from a read another writer is about to make stale.
    await lockWorkflowRun(db, input.runId);
    const room = (
      await db.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [
        command.room_id,
      ])
    ).rows[0];
    if (!room) throw new Error('workflow room not found');
    const run = await loadRun(db, command.room_id, input.runId);
    if (!run) throw new Error('workflow run is unavailable in this Room');
    const contract = await loadPinnedContract(db, command.room_id, run.workflowSlug, run.workflowVersion);
    if (!contract) throw new Error('workflow contract version is unavailable');
    const stateName = run.toState;
    const state = contract.handoffs[stateName];
    if (run.cancellation || !state || state.kind === 'terminal') throw new Error('this workflow run has already ended');
    const role = (state as WorkflowHandoffState | WorkflowGateState).role;
    const boundAgentId = run.roleBindings[role];
    const on = (state as WorkflowHandoffState | WorkflowGateState).on;
    const contentsError = workflowContentsError(
      state as WorkflowHandoffState | WorkflowGateState,
      input.contents,
    );
    const receiptError = workflowReceiptError(input.receipt);
    const errors = [
      ...(boundAgentId !== command.agent_id ? [`this workflow state is bound to the ${role} role, not you`] : []),
      ...(!Object.hasOwn(on, input.outcome) ? ['invalid outcome'] : []),
      ...(contentsError ? [contentsError] : []),
      ...(contentsError?.startsWith('contents')
        ? (state as WorkflowHandoffState | WorkflowGateState).requires
            .filter((field) => !input.contents || typeof input.contents !== 'object' || Array.isArray(input.contents) ||
              (input.contents as Record<string, unknown>)[field] == null)
            .map((field) => `${field} is required`) : []),
      ...(receiptError ? [receiptError] : []),
    ];
    if (errors.length) {
      const outcomes = Object.entries(on).map(([outcome, target]) => `${outcome} -> ${target}`).join(', ');
      throw new Error(`${errors.join('; ')}; outcome must be one of: ${outcomes}`);
    }
    await bindWorkflowStepOutput(db, command, input.runId);
    await cancelWorkflowTimeout(db, input.runId, stateName);
    let toState = on[input.outcome]!;
    const loop = isHandoffState(state) ? state.loop : undefined;
    if (loop && loop.onEdge === input.outcome) {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `workflow-loop:${input.runId}:${stateName}:${input.outcome}`,
      ]);
      const countRow = (
        await db.query<{ count: string }>(
          `SELECT count(*)::text count FROM messages
           WHERE room_id=$1 AND card_type=$2
             AND card->>'runId'=$3 AND card->>'fromState'=$4 AND card->>'outcome'=$5`,
          [command.room_id, WORKFLOW_HANDOFF_CARD_TYPE, input.runId, stateName, input.outcome],
        )
      ).rows[0];
      if (Number(countRow?.count ?? 0) + 1 > loop.cap) toState = loop.onExceeded;
    }
    const nextState = contract.handoffs[toState];
    if (!nextState) throw new Error('workflow contract is internally inconsistent');
    const isTerminal = nextState.kind === 'terminal';
    const isGate = nextState.kind === 'gate';
    // Leaving a gate (by handoff instead of the card) or ending the run must
    // not strand that gate's open choice: it would refuse every later gate in
    // this Room. The card-answer path settles its own choice already.
    if (state.kind === 'gate' || isTerminal) {
      await closeRunChoices(db, command.room_id, input.runId);
    }
    const roleBindings = { ...run.roleBindings };
    const nextRole = isTerminal ? undefined : (nextState as WorkflowHandoffState | WorkflowGateState).role;
    const nextResolution = nextRole
      ? await resolveRoleBinding(db, {
          roomId: command.room_id,
          roleBindings,
          roleAgents: await loadRunRoleAgents(db, command.room_id, input.runId),
          role: nextRole,
        })
      : undefined;
    const exhausted = Boolean(nextResolution && 'exhausted' in nextResolution);
    const actor = await loadIdentityRow(db, command.agent_id);
    await systemLine(db, {
      id: randomBytes(32).toString('hex'),
      roomId: command.room_id,
      authorId: command.agent_id,
      subject: identitySubject(actor),
      verb: 'handed off',
      object: toState,
      consequence: `run ${input.runId} of ${run.workflowSlug}`,
      kind: 'workflow-handoff',
      ...(!isTerminal && !isGate && !exhausted
        ? { wakes: [(nextResolution as { agentId: string }).agentId] }
        : {}),
      presentation: 'card',
      cardType: WORKFLOW_HANDOFF_CARD_TYPE,
      card: {
        runId: input.runId,
        seq: (run.seq ?? 0) + 1,
        workflowSlug: run.workflowSlug,
        workflowVersion: run.workflowVersion,
        roleBindings,
        fromState: stateName,
        outcome: input.outcome,
        toState,
        contents: input.contents,
        receipt: { ...input.receipt, exit: { gate: input.outcome, actorId: command.agent_id } },
        ...(nextState.hint ? { receiptHint: nextState.hint } : {}),
        ...(isTerminal ? { status: (nextState as { status: 'done' | 'failed' }).status } : {}),
      },
    });
    await db.query(
      `UPDATE messages SET card=card || jsonb_build_object('active',$3::boolean,'currentAgentId',$4::text)
       WHERE id=$1 AND room_id=$2 AND card_type='workflow-handoff'`,
      [input.runId, command.room_id, !isTerminal,
        isTerminal || exhausted ? null : (nextResolution as { agentId: string }).agentId],
    );
    if (exhausted) {
      await noteWorkflowRoleExhausted(db, {
        roomId: command.room_id,
        runId: input.runId,
        role: nextRole!,
        afterMessageId: input.runId,
      });
    } else if (isGate) {
      await postWorkflowGate(db, {
        roomId: command.room_id,
        runId: input.runId,
        contract,
        roleBindings,
        stateName: toState,
        state: nextState as WorkflowGateState,
      });
    } else if (!isTerminal && (nextState as WorkflowHandoffState).timeoutSeconds) {
      await scheduleWorkflowTimeout(db, {
        workspaceId: room.workspace_id,
        roomId: command.room_id,
        runId: input.runId,
        workflowName: contract.name,
        stateName: toState,
        agentId: (nextResolution as { agentId: string }).agentId,
        seconds: (nextState as WorkflowHandoffState).timeoutSeconds!,
        hint: nextState.hint,
      });
    }
    return {
      runId: input.runId,
      state: toState,
      ...(isTerminal ? { status: (nextState as { status: 'done' | 'failed' }).status } : {}),
    };
  });
}

/**
 * Same-state reassignment: the run's `toState` does not change, only which
 * agent holds it. Reused by both automatic list failover and a human's
 * explicit `assign_workflow_role`; the caller decides `picked` (the next
 * healthy agent on the list, or the human's exact choice with no health filter).
 */
async function reassignRole(
  db: SqlDatabase,
  input: {
    roomId: string;
    runId: string;
    run: WorkflowRunCard;
    contract: WorkflowContract;
    role: string;
    picked: string;
  },
): Promise<void> {
  const roleBindings = { ...input.run.roleBindings, [input.role]: input.picked };
  const state = input.contract.handoffs[input.run.toState] as WorkflowHandoffState | WorkflowGateState;
  await ensureSystemIdentity(db);
  await systemLine(db, {
    id: randomBytes(32).toString('hex'),
    roomId: input.roomId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: 'the workflow' },
    verb: 'reassigned',
    object: input.role,
    consequence: `run ${input.runId} of ${input.run.workflowSlug}`,
    kind: 'workflow-handoff',
    ...(state.kind === 'gate' ? {} : { wakes: [input.picked] }),
    presentation: 'card',
    cardType: WORKFLOW_HANDOFF_CARD_TYPE,
    card: {
      runId: input.runId,
      seq: (input.run.seq ?? 0) + 1,
      workflowSlug: input.run.workflowSlug,
      workflowVersion: input.run.workflowVersion,
      roleBindings,
      toState: input.run.toState,
      reassigned: true,
      ...(state.hint ? { receiptHint: state.hint } : {}),
    },
  });
  await db.query(
    `UPDATE messages SET card=card || jsonb_build_object('currentAgentId',$3::text)
     WHERE id=$1 AND room_id=$2 AND card_type='workflow-handoff'`,
    [input.runId, input.roomId, input.picked],
  );
  if (state.kind === 'gate') {
    await postWorkflowGate(db, {
      roomId: input.roomId,
      runId: input.runId,
      contract: input.contract,
      roleBindings,
      stateName: input.run.toState,
      state,
    });
  } else if (state.timeoutSeconds) {
    await cancelWorkflowTimeout(db, input.runId, input.run.toState);
    const room = (
      await db.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [
        input.roomId,
      ])
    ).rows[0];
    if (room) {
      await scheduleWorkflowTimeout(db, {
        workspaceId: room.workspace_id,
        roomId: input.roomId,
        runId: input.runId,
        workflowName: input.run.workflowSlug,
        stateName: input.run.toState,
        agentId: input.picked,
        seconds: state.timeoutSeconds,
        hint: state.hint,
      });
    }
  }
}

/**
 * The one hook a failed/silent turn goes through to fail a workflow role over
 * to the next healthy agent on its list. Called unconditionally from
 * `turn-silence-notice.ts`'s `noteFirstSilence`, BEFORE its own human-trigger
 * requirement — a workflow dispatch's triggering message is normally
 * agent-authored (the previous role holder's handoff, or the run's own start
 * card), so gating this on "a human is further up the chain" would silently
 * never fire for the ordinary case. Runs in its own transaction. A no-op for
 * a single-agent role, a stale/superseded dispatch, or a turn that was never a
 * workflow dispatch at all — this must never throw into the ordinary
 * silence-notice path.
 */
export async function reassignFailedWorkflowRole(
  db: SqlDatabase,
  input: { roomId: string; requestId: string; agentId: string },
): Promise<void> {
  const trigger = (
    await db.query<{ run_id: string }>(
      `SELECT card->>'runId' run_id FROM messages WHERE id=$1 AND room_id=$2 AND card_type=$3`,
      [input.requestId, input.roomId, WORKFLOW_HANDOFF_CARD_TYPE],
    )
  ).rows[0];
  if (!trigger) return; // not a workflow dispatch
  // Same discipline as handoff()'s P0-1 fix: lock before reading the run's
  // current state, so a concurrent handoff/reassignment can never race this
  // read-validate-write sequence.
  await lockWorkflowRun(db, trigger.run_id);
  const latest = (
    await db.query<{ id: string; card: WorkflowRunCard }>(
      `SELECT id,card FROM messages WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$3
       ORDER BY (card->>'seq')::int DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
      [input.roomId, WORKFLOW_HANDOFF_CARD_TYPE, trigger.run_id],
    )
  ).rows[0];
  // Not a workflow dispatch, or a newer card already superseded this one.
  if (!latest || latest.id !== input.requestId) return;
  const run = latest.card;
  const contract = await loadPinnedContract(db, input.roomId, run.workflowSlug, run.workflowVersion);
  if (!contract) return;
  const state = contract.handoffs[run.toState];
  if (run.cancellation || !state || state.kind === 'terminal') return;
  const role = (state as WorkflowHandoffState | WorkflowGateState).role;
  if (run.roleBindings[role] !== input.agentId) return;
  const agents = (await loadRunRoleAgents(db, input.roomId, run.runId))[role];
  if (!agents) return;
  const picked = await nextHealthyAgent(db, input.roomId, agents, input.agentId);
  if (!picked) {
    await noteWorkflowRoleExhausted(db, {
      roomId: input.roomId,
      runId: run.runId,
      role,
      afterMessageId: input.requestId,
    });
    return;
  }
  await reassignRole(db, { roomId: input.roomId, runId: run.runId, run, contract, role, picked });
}

/**
 * A binding entry resolved to a Room member's id: an agent id is kept, and a
 * word matching a current member's handle (with or without the @) binds that
 * member. Any other word is returned unchanged and refused by `roleAgentList`.
 */
async function resolveHandleBinding(db: SqlDatabase, roomId: string, entry: string): Promise<string> {
  if (typeof (entry as unknown) !== 'string') return entry;
  if (entry.startsWith('@')) return memberIdForHandle(db, roomId, entry);
  if (isAgentIdentityReference(entry)) return entry;
  return (await roomMemberIdForHandle(db, roomId, entry)) ?? entry;
}

/** The identity id of a current Room member with this handle, or undefined when none has it. */
async function roomMemberIdForHandle(
  db: SqlDatabase,
  roomId: string,
  handle: string,
): Promise<string | undefined> {
  const row = (
    await db.query<{ identity_id: string }>(
      `SELECT m.identity_id FROM memberships m JOIN identities i ON i.id=m.identity_id
       WHERE m.room_id=$1 AND m.removed_at IS NULL AND lower(i.handle)=lower($2)`,
      [roomId, handle],
    )
  ).rows[0];
  return row?.identity_id;
}

/** The identity id of the current Room member with this handle (as agents see it in their member list). */
async function memberIdForHandle(db: SqlDatabase, roomId: string, raw: string): Promise<string> {
  const handle = raw.replace(/^@/, '');
  const id = await roomMemberIdForHandle(db, roomId, handle);
  if (!id) throw new Error(`@${handle} is not a current member of this Room`);
  return id;
}

/**
 * A human's explicit override: bind a specific agent to a list-bound role
 * this run is currently on — the "ask a human" recovery path when nobody on
 * the list is healthy, or simply a human's choice at any time. Unlike
 * automatic failover, the target is not health-filtered (an explicit human
 * choice overrides "healthy") and need not be on the list, but must be a
 * current agent member of the Room — not a way to bind an outsider.
 */
export async function assignWorkflowRole(
  database: SqlDatabase,
  command: CommandRow,
  input: { runId: string; role: string; targetAgentId: string },
): Promise<{ runId: string; state: string }> {
  if (typeof input.runId !== 'string' || !input.runId) throw new Error('runId is required');
  if (typeof input.role !== 'string' || !input.role) throw new Error('role is required');
  if (typeof input.targetAgentId !== 'string' || !input.targetAgentId) {
    throw new Error('targetAgentId is required');
  }
  return database.transaction(async (db) => {
    await lockWorkflowRun(db, input.runId);
    const targetAgentId = isAgentIdentityReference(input.targetAgentId)
      ? input.targetAgentId
      : await memberIdForHandle(db, command.room_id, input.targetAgentId);
    const run = await loadRun(db, command.room_id, input.runId);
    if (!run) throw new Error('workflow run is unavailable in this Room');
    const contract = await loadPinnedContract(db, command.room_id, run.workflowSlug, run.workflowVersion);
    if (!contract) throw new Error('workflow contract version is unavailable');
    const state = contract.handoffs[run.toState];
    if (run.cancellation || !state || state.kind === 'terminal') throw new Error('this workflow run has already ended');
    const currentRole = (state as WorkflowHandoffState | WorkflowGateState).role;
    if (currentRole !== input.role) {
      throw new Error(`this run is currently at the ${currentRole} role, not ${input.role}`);
    }
    const roleAgents = await loadRunRoleAgents(db, command.room_id, run.runId);
    if (!roleAgents[input.role]) {
      throw new Error(`the ${input.role} role is bound to one agent; it cannot be reassigned`);
    }
    const member = await db.query(
      `SELECT 1 FROM memberships member
       JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
       WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL`,
      [command.room_id, targetAgentId],
    );
    if (!member.rowCount) {
      throw new Error(`${targetAgentId} is not a current agent member of this Room`);
    }
    await reassignRole(db, {
      roomId: command.room_id,
      runId: run.runId,
      run,
      contract,
      role: input.role,
      picked: targetAgentId,
    });
    return { runId: run.runId, state: run.toState };
  });
}

export async function archiveWorkflow(
  database: SqlDatabase,
  command: CommandRow,
  input: { name: string },
): Promise<{ slug: string; archived: boolean }> {
  if (typeof input.name !== 'string' || !input.name) throw new Error('workflow name is required');
  const room = (
    await database.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [
      command.room_id,
    ])
  ).rows[0];
  if (!room) throw new Error('workflow room not found');
  const result = await database.query(
    `UPDATE workspace_skills SET state='stale',updated_at=now()
     WHERE workspace_id=$1 AND slug=$2 AND kind='workflow' AND state='active'`,
    [room.workspace_id, input.name],
  );
  return { slug: input.name, archived: Boolean(result.rowCount) };
}

function describedLegacyWorkflowState(name: string, raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const state = raw as Record<string, unknown>;
  if (typeof state.does === 'string' && state.does.trim()) return state;
  const role = typeof state.role === 'string' ? state.role : undefined;
  return {
    ...state,
    does: role
      ? `Step ${name} (${role}): describe what this step does`
      : `Step ${name}: describe what this step does`,
  };
}

/**
 * The pure half of `backfillWorkflowSkillDescriptions`: fills whichever of
 * `summary`/per-step `does` a contract is missing, with the exact
 * placeholders the backfill writes to storage, leaving every edge, role
 * binding and loop rule untouched. Every `handoffs` entry gets a `does`,
 * terminal states included: `workflowSaveError` (PR #2083) requires one on
 * every state with no exception, so a contract missing it on even one
 * terminal state would still be refused the next time it is saved. Exported
 * so a caller that must describe a legacy contract before saving it through
 * the NORMAL save path can match the backfill exactly instead of
 * hand-writing prose that could drift from it.
 */
export function describedLegacyWorkflowContract(contract: WorkflowContract): WorkflowContract {
  const next: Record<string, unknown> = { ...contract };
  if (typeof next.summary !== 'string' || !(next.summary as string).trim()) {
    const description = typeof next.description === 'string' ? (next.description as string).trim() : '';
    next.summary = description || 'Summary not written yet';
  }
  const handoffs = next.handoffs;
  if (handoffs && typeof handoffs === 'object' && !Array.isArray(handoffs)) {
    next.handoffs = Object.fromEntries(
      Object.entries(handoffs as Record<string, unknown>).map(([name, raw]) => [
        name,
        describedLegacyWorkflowState(name, raw),
      ]),
    );
  }
  return next as WorkflowContract;
}

/**
 * `workflowSaveError` (PR #2083) made a NEW save require a `summary` and
 * every state's `does`; every workflow skill version saved before that rule
 * existed has neither, and a pinned run keeps reading its exact saved
 * version forever (`loadPinnedContract`), so those old versions are never
 * re-validated on their own. Keeps `content_hash` honest (every
 * other reader treats it as `sha256(markdown)`, e.g.
 * `feedback-triage-workflow.ts`'s re-seed check). Idempotent: a version
 * already carrying both fields round-trips to the same markdown and is left
 * untouched. Run from `migrateData()`.
 */
export async function backfillWorkflowSkillDescriptions(database: SqlDatabase): Promise<number> {
  const rows = await database.query<{ skill_id: string; version: number; markdown: string }>(
    `SELECT version.skill_id,version.version,version.markdown
     FROM workspace_skill_versions version
     JOIN workspace_skills skill ON skill.id=version.skill_id
     WHERE skill.kind='workflow' AND version.source_deleted_at IS NULL
     ORDER BY version.skill_id,version.version`,
  );
  let changed = 0;
  for (const row of rows.rows) {
    let contract: WorkflowContract;
    try {
      contract = JSON.parse(row.markdown) as WorkflowContract;
    } catch {
      continue;
    }
    const markdown = JSON.stringify(describedLegacyWorkflowContract(contract));
    if (markdown === row.markdown) continue;
    await database.query(
      `UPDATE workspace_skill_versions SET markdown=$3,content_hash=$4
       WHERE skill_id=$1 AND version=$2`,
      [row.skill_id, row.version, markdown, createHash('sha256').update(markdown).digest('hex')],
    );
    changed++;
  }
  if (changed)
    console.log(`backfillWorkflowSkillDescriptions: filled summary/does on ${changed} workflow skill version(s)`);
  return changed;
}
