import { requireWorkflowOwner } from './workflow-ownership.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  workflowContractError,
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
} from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { applySkillRevision, assertSkillTextSafe } from './institutional-skills.js';
import type { AfterCommit } from './institutional-memory-embeddings.js';
import { nextScheduleOccurrence, validateScheduleCadence } from './agent-schedules.js';
import { firstHealthyAgent, nextHealthyAgent } from './agent-health.js';
import { postRoomChoice } from './room-choice.js';
import { CHOICE_WAKE_CARD_TYPES } from '@beeline/api-contract/phone';
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
  status?: 'done' | 'failed';
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
       ORDER BY created_at DESC,id DESC LIMIT 1`,
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
       (id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at)
     VALUES($1,$2,$3,$4,$4,$5::jsonb,$6,1,$7)
     ON CONFLICT(id) DO UPDATE
       SET cadence=EXCLUDED.cadence,message=EXCLUDED.message,next_run_at=EXCLUDED.next_run_at,
           run_count=0,updated_at=now()`,
    [
      workflowTimeoutScheduleId(input.runId, input.stateName),
      input.workspaceId,
      input.roomId,
      input.agentId,
      JSON.stringify(cadence),
      `workflow run ${input.runId} timed out at ${input.stateName}; call handoff with outcome "timeout"${input.hint ? `; receipt hint: ${input.hint}` : ''}`,
      nextRunAt,
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
  const reason = workflowContractError(input.contract);
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
    await db.query(
      `UPDATE workspace_skills SET creator_agent_id=$2,owner_agent_id=$2,ownership_initialized=true
    WHERE id=$1 AND $3=1`,
      [skillId, command.agent_id, version],
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

/**
 * The active run THIS wake is evidence of: the command's own triggering
 * message is a `workflow-handoff` card for the named workflow, the run it
 * names has not ended, and this agent is still the one bound to its current
 * state's role. A stale wake (the run already moved past this card, or past
 * this agent) is not "currently acting" and is left alone — only a genuinely
 * live hold on the named workflow blocks a fresh `start_workflow`.
 */
async function runThisWakeContinues(
  db: SqlDatabase,
  input: { roomId: string; agentId: string; sourceMessageId: string; workflowName: string },
): Promise<{ runId: string } | undefined> {
  const wake = (
    await db.query<{ card_type: string | null; card: WorkflowRunCard | null }>(
      `SELECT card_type,card FROM messages WHERE id=$1 AND room_id=$2`,
      [input.sourceMessageId, input.roomId],
    )
  ).rows[0];
  if (!wake?.card) return undefined;
  if (wake.card_type !== WORKFLOW_HANDOFF_CARD_TYPE &&
      !CHOICE_WAKE_CARD_TYPES.some((type) => type === wake.card_type)) return undefined;
  if (wake.card.workflowSlug !== input.workflowName) return undefined;
  const run = await loadRun(db, input.roomId, wake.card.runId);
  if (!run) return undefined;
  const contract = await loadPinnedContract(db, input.roomId, run.workflowSlug, run.workflowVersion);
  if (!contract) return undefined;
  const state = contract.handoffs[run.toState];
  if (!state || state.kind === 'terminal') return undefined;
  const role = (state as WorkflowHandoffState | WorkflowGateState).role;
  if (run.roleBindings[role] !== input.agentId) return undefined;
  return { runId: run.runId };
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
  const candidates = await db.query<{ id: string }>(
    `SELECT id FROM messages
     WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=id
       AND card->>'workflowSlug'=$3
       AND card->'trigger'->>'scheduleId'=$4 AND card->'trigger'->>'period'=$5`,
    [roomId, WORKFLOW_HANDOFF_CARD_TYPE, workflowName, trigger.scheduleId, trigger.period],
  );
  for (const candidate of candidates.rows) {
    const run = await loadRun(db, roomId, candidate.id);
    if (!run) continue;
    const contract = await loadPinnedContract(db, roomId, run.workflowSlug, run.workflowVersion);
    if (!contract) continue;
    const state = contract.handoffs[run.toState];
    if (state && state.kind !== 'terminal') return { runId: run.runId };
  }
  return undefined;
}

/** Every still-active run id this schedule has ever started (any workflow), for `list_schedules`. */
export async function activeRunIdsForSchedule(
  db: SqlDatabase,
  roomId: string,
  scheduleId: string,
): Promise<string[]> {
  const active = await db.query<{ run_id: string }>(
    `WITH starts AS (
       SELECT id,card->>'workflowSlug' slug,(card->>'workflowVersion')::int version
       FROM messages
       WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=id
         AND card->'trigger'->>'scheduleId'=$3
     ), latest AS (
       SELECT DISTINCT ON (message.card->>'runId')
         message.card->>'runId' run_id,message.card->>'toState' state
       FROM messages message JOIN starts ON starts.id=message.card->>'runId'
       WHERE message.room_id=$1 AND message.card_type=$2
       ORDER BY message.card->>'runId',message.created_at DESC,message.id DESC
     )
     SELECT starts.id run_id FROM starts
     JOIN latest ON latest.run_id=starts.id
     JOIN rooms room ON room.id=$1
     JOIN workspace_skills skill ON skill.workspace_id=room.workspace_id
       AND skill.slug=starts.slug AND skill.kind='workflow'
     JOIN workspace_skill_versions version
       ON version.skill_id=skill.id AND version.version=starts.version
     WHERE version.markdown::jsonb->'handoffs'->latest.state IS NOT NULL
       AND (version.markdown::jsonb->'handoffs'->latest.state->>'kind') IS DISTINCT FROM 'terminal'
     ORDER BY starts.id`,
    [roomId, WORKFLOW_HANDOFF_CARD_TYPE, scheduleId],
  );
  return active.rows.map((row) => row.run_id);
}

export async function startWorkflow(
  database: SqlDatabase,
  command: Pick<CommandRow, 'room_id' | 'agent_id'> & { reason?: string; source_message_id?: string },
  input: { name: string; roleBindings: Readonly<Record<string, WorkflowRoleBinding>> },
): Promise<{ runId: string; state: string }> {
  if (typeof input.name !== 'string' || !input.name) throw new Error('workflow name is required');
  if (!input.roleBindings || typeof input.roleBindings !== 'object') {
    throw new Error('roleBindings is required');
  }

  return database.transaction(async (db) => {
    if (command.source_message_id) {
      const held = await runThisWakeContinues(db, {
        roomId: command.room_id,
        agentId: command.agent_id,
        sourceMessageId: command.source_message_id,
        workflowName: input.name,
      });
      if (held) {
        throw new Error(
          `You are already in run ${held.runId} of ${input.name}. Continue it or hand off within it.`,
        );
      }
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
    const ownership = await requireWorkflowOwner(db, command.room_id, input.name, command.agent_id);
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
        workflowSlug: contract.name,
        workflowVersion: skill.current_version,
        ownerAtStart: ownership.owner!.id,
        startKind:
          starter?.kind === 'human'
            ? 'human_admin'
            : command.reason === 'schedule'
              ? 'schedule'
              : 'owner',
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
  if (typeof input.outcome !== 'string' || !input.outcome) throw new Error('outcome is required');
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
    if (!state || state.kind === 'terminal') throw new Error('this workflow run has already ended');
    const role = (state as WorkflowHandoffState | WorkflowGateState).role;
    const boundAgentId = run.roleBindings[role];
    if (boundAgentId !== command.agent_id) {
      throw new Error(`this workflow state is bound to the ${role} role, not you`);
    }
    const on = (state as WorkflowHandoffState | WorkflowGateState).on;
    if (!Object.hasOwn(on, input.outcome)) {
      throw new Error(`outcome must be one of: ${Object.keys(on).join(', ')}`);
    }
    const contentsError = workflowContentsError(
      state as WorkflowHandoffState | WorkflowGateState,
      input.contents,
    );
    if (contentsError) throw new Error(contentsError);
    const receiptError = workflowReceiptError(input.receipt);
    if (receiptError) throw new Error(receiptError);
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
      workflowSlug: input.run.workflowSlug,
      workflowVersion: input.run.workflowVersion,
      roleBindings,
      toState: input.run.toState,
      reassigned: true,
      ...(state.hint ? { receiptHint: state.hint } : {}),
    },
  });
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
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [input.roomId, WORKFLOW_HANDOFF_CARD_TYPE, trigger.run_id],
    )
  ).rows[0];
  // Not a workflow dispatch, or a newer card already superseded this one.
  if (!latest || latest.id !== input.requestId) return;
  const run = latest.card;
  const contract = await loadPinnedContract(db, input.roomId, run.workflowSlug, run.workflowVersion);
  if (!contract) return;
  const state = contract.handoffs[run.toState];
  if (!state || state.kind === 'terminal') return;
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
    if (!state || state.kind === 'terminal') throw new Error('this workflow run has already ended');
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
