import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { WELCOME_VIDEO_SLUG } from './welcome-video-workflow.js';
import { reserveServiceReviewWorkspaces } from './service-review.js';
import { workflowTimerId } from './workflow-timer-id.js';
import { workflowRunIsLiveSql } from './workflow-run-saved-status.js';
import { humanRoomAdmin, humanRoomMember, WorkflowAuthorizationError } from './workflow-admin.js';
import { randomBytes } from 'node:crypto';
import { shortRunId, type WorkflowReceiptInput, WORKFLOW_DEFAULT_DEADLINE_SECONDS, type WorkflowReadContract, type WorkflowGateState, type WorkflowHandoffState, type WorkflowReadState } from '@beeline/api-contract/daemon';
import { FEEDBACK_TRIAGE_SLUG } from './feedback-triage-workflow.js';
import type { SystemSubject } from '@beeline/api-contract/phone';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { closeRunChoices, postRoomChoice } from './room-choice.js';
import { ensureSystemIdentity, identitySubject, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { loadRunStart, scheduleRunTimer, noteWorkflowRoleExhausted, WORKFLOW_LEGACY_STEP_TIMEOUT_SECONDS, openRun, RunScope, WORKFLOW_HANDOFF_CARD_TYPE, cancelRunWakes, cancelStepTimer, loadRunRoleAgents, resolveRoleBinding, saveRunStatus, TriedAgent, mentionsFor, pickWorkflowAgent, roleReasons, workflowRequester, WorkflowRunCard, loadIdentityRow } from './workflow-runs.js';



export async function cancelRunTimers(db: SqlDatabase, runId: string): Promise<void> {
  await db.query(`DELETE FROM agent_schedules WHERE id=ANY($1::uuid[])`, [
    [
      workflowTimerId(runId, 'step'),
      workflowTimerId(runId, 'deadline'),
    ],
  ]);
}


export function isHandoffState(state: WorkflowReadState | undefined): state is WorkflowHandoffState {
  return Boolean(state) && state!.kind === undefined;
}


/** The historical gate question, retained to locate pre-run-id cards. */
export function workflowGatePrompt(contract: Pick<WorkflowReadContract, 'name'>, stateName: string): string {
  return `${contract.name}: ${stateName}`.slice(0, 120);
}


export function durationText(seconds: number): string {
  if (seconds % 3600 === 0) return systemMessage("workflow-runs.h", seconds / 3600);
  if (seconds % 60 === 0) return systemMessage("workflow-runs.min", seconds / 60);
  return systemMessage("workflow-runs.s", seconds);
}


/**
 * Posts the gate's ask_choice card, for every run however it was started,
 * asked by the gate role's agent and carrying the run id and attempt. A
 * person's answer or Skip settles it through `settleWorkflowGate`; nothing
 * wakes the role's agent at a gate. A declared `timeoutSeconds` arms the
 * step timer that applies `default`.
 */
export async function postWorkflowGate(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    roomId: string;
    runId: string;
    attempt: number;
    contract: WorkflowReadContract;
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
    workflowRunId: input.runId,
    workflowOwnerId: (await loadRunStart(db, input.roomId, input.runId)).card.ownerId,
    mode: 'question',
    prompt: (input.state.does?.replace(/\s+/g, systemMessage("workflow-runs.space")).trim() ||
      systemMessage("workflow-runs.choose-the-next-step-for", input.contract.name.replace(/[-_]/g, systemMessage("workflow-runs.space")))).slice(0, 120),
    ...(input.state.default && input.state.timeoutSeconds
      ? { constraint: systemMessage("workflow-runs.no-answer-in-applies", durationText(input.state.timeoutSeconds), input.state.default) }
      : {}),
    options: Object.entries(input.state.on).map(([outcome, target]) => ({
      label: outcome,
      consequence: (input.contract.handoffs[target]?.does?.replace(/\s+/g, systemMessage("workflow-runs.space")).trim() ||
        systemMessage("workflow-runs.continue-to", target.replace(/[-_]/g, systemMessage("workflow-runs.space")))).slice(0, 80),
    })),
  });
  await db.query(
    `UPDATE messages SET card=card || $2::jsonb WHERE id=$1`,
    [choice.messageId, JSON.stringify({
      runId: input.runId,
      workflowSlug: input.contract.name,
      attempt: input.attempt,
      ...(input.state.hint ? { receiptHint: input.state.hint } : {}),
    })],
  );
  if (input.state.timeoutSeconds && input.state.default) {
    await scheduleRunTimer(db, {
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      runId: input.runId,
      workflowSlug: input.contract.name,
      timer: 'step',
      seconds: input.state.timeoutSeconds,
      attempt: input.attempt,
    });
  }
}


/** What a newly entered state needs after its card is written: a gate card, a step timer, or the exhausted line. */
export async function dispatchState(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    roomId: string;
    runId: string;
    contract: WorkflowReadContract;
    roleBindings: Record<string, string>;
    roleAgents: Record<string, string[]>;
    stateName: string;
    attempt: number;
    cardId: string;
    exhausted: boolean;
  },
): Promise<void> {
  const state = input.contract.handoffs[input.stateName]!;
  if (state.kind === 'terminal') return;
  if (input.exhausted) {
    const role = (state as WorkflowHandoffState | WorkflowGateState).role;
    await noteWorkflowRoleExhausted(db, {
      roomId: input.roomId,
      runId: input.runId,
      workflowSlug: input.contract.name,
      role,
      afterMessageId: input.cardId,
      list: input.roleAgents[role] ?? [],
      tried: [],
    });
  } else if (state.kind === 'gate') {
    await postWorkflowGate(db, {
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      runId: input.runId,
      attempt: input.attempt,
      contract: input.contract,
      roleBindings: input.roleBindings,
      stateName: input.stateName,
      state,
    });
    return;
  }
  // A parked handoff state keeps its timer too: when it fires, the engine
  // looks for an eligible agent again and otherwise applies `timeout`.
  if (isHandoffState(state)) {
    await scheduleRunTimer(db, {
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      runId: input.runId,
      workflowSlug: input.contract.name,
      timer: 'step',
      seconds: state.timeoutSeconds ?? WORKFLOW_LEGACY_STEP_TIMEOUT_SECONDS,
      attempt: input.attempt,
    });
  }
}


/** Restore missing timers without resetting a live lease or changing its pinned workflow. */
export async function backfillWorkflowRunTimers(database: SqlDatabase): Promise<number> {
  const starts = await database.query<{ id: string; room_id: string; created_at: Date }>(
    `SELECT id,room_id,created_at FROM messages
     WHERE card_type='workflow-handoff' AND id=card->>'runId'
       AND ${workflowRunIsLiveSql('card')}`,
  );
  let armed = 0;
  for (const start of starts.rows) {
    try {
      armed += await database.transaction(async (db) => {
        const scope = await openRun(db, start.room_id, start.id);
        if (scope.ended) return 0;
        const deadlineId = workflowTimerId(start.id, 'deadline');
        const stepId = workflowTimerId(start.id, 'step');
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM agent_schedules WHERE id=ANY($1::uuid[])`,
          [[deadlineId, stepId]],
        );
        const ids = new Set(existing.rows.map((row) => row.id));
        let changed = 0;
        if (!ids.has(deadlineId)) {
          const seconds = scope.contract.deadlineSeconds ?? WORKFLOW_DEFAULT_DEADLINE_SECONDS;
          await scheduleRunTimer(db, {
            workspaceId: scope.workspaceId,
            roomId: scope.roomId,
            runId: start.id,
            workflowSlug: scope.run.workflowSlug,
            timer: 'deadline',
            seconds,
            fireAt: new Date(Math.max(Date.now(), start.created_at.getTime() + seconds * 1_000)),
          });
          changed++;
        }
        if (isHandoffState(scope.state) && !ids.has(stepId)) {
          // Give the current attempt a full lease from recovery, so an old
          // timestamp cannot expire a step immediately while its agent works.
          await scheduleRunTimer(db, {
            workspaceId: scope.workspaceId,
            roomId: scope.roomId,
            runId: start.id,
            workflowSlug: scope.run.workflowSlug,
            timer: 'step',
            seconds: scope.state.timeoutSeconds ?? WORKFLOW_LEGACY_STEP_TIMEOUT_SECONDS,
            attempt: scope.run.seq,
          });
          changed++;
        }
        return changed;
      });
    } catch (error) {
      console.error(`backfillWorkflowRunTimers: failed to recover run ${start.id}`, error);
    }
  }
  if (armed) console.log(`backfillWorkflowRunTimers: armed ${armed} missing workflow timer(s)`);
  return armed;
}


export type CardLine = {
  authorId: string;
  subject: SystemSubject;
  verb: string;
  object?: string;
  consequence?: string;
};


/**
 * Take one of the current state's `on` edges and dispatch the state it
 * reaches. Shared by an agent's handoff, the engine's `timeout`, a gate
 * answer, Skip and a gate default. A declared loop cap redirects the edge to
 * its escape state. Returns the new state and its attempt.
 */
export async function enterState(
  db: SqlDatabase,
  scope: RunScope,
  input: {
    outcome: string;
    contents: unknown;
    receiptInput?: WorkflowReceiptInput;
    actorId: string;
    commandId?: string;
    /** The person's message the engine took as this exit's answer, when it was settled from chat. */
    sourceMessageId?: string;
    line: (toState: string) => CardLine;
  },
): Promise<{ state: string; attempt: number; status?: 'done' | 'failed' }> {
  const { run, contract, stateName, roomId, runId } = scope;
  const state = scope.state as WorkflowHandoffState | WorkflowGateState;
  let toState = state.on[input.outcome]!;
  const loop = isHandoffState(state) ? state.loop : undefined;
  if (loop && loop.onEdge === input.outcome) {
    const countRow = (
      await db.query<{ count: string }>(
        `SELECT count(*)::text count FROM messages
         WHERE room_id=$1 AND card_type=$2
           AND card->>'runId'=$3 AND card->>'fromState'=$4 AND card->>'outcome'=$5`,
        [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId, stateName, input.outcome],
      )
    ).rows[0];
    if (Number(countRow?.count ?? 0) + 1 > loop.cap) toState = loop.onExceeded;
  }
  const nextState = contract.handoffs[toState];
  if (!nextState) throw new Error('workflow contract is internally inconsistent');
  const isTerminal = nextState.kind === 'terminal';
  const isGate = nextState.kind === 'gate';
  await cancelRunWakes(db, roomId, runId);
  if (isTerminal) await cancelRunTimers(db, runId);
  else await cancelStepTimer(db, runId);
  // Leaving a gate or ending the run must not strand an open gate choice: it
  // would refuse every later gate this agent asks in this Room.
  if (state.kind === 'gate' || isTerminal) await closeRunChoices(db, roomId, runId);
  const roleBindings = { ...run.roleBindings };
  const roleAgents = await loadRunRoleAgents(db, roomId, runId);
  const nextRole = isTerminal ? undefined : (nextState as WorkflowHandoffState | WorkflowGateState).role;
  const nextResolution = nextRole
    ? await resolveRoleBinding(db, { roomId, roleBindings, roleAgents, role: nextRole, workflowSlug: run.workflowSlug, runId })
    : undefined;
  const exhausted = Boolean(nextResolution && 'exhausted' in nextResolution);
  const nextAgentId = nextResolution && !exhausted ? (nextResolution as { agentId: string }).agentId : null;
  if ((contract.name === FEEDBACK_TRIAGE_SLUG || contract.name === 'workspace-walk') && toState === 'browse') {
    if (!nextAgentId || nextAgentId !== roleBindings.triager)
      throw new Error('Service review must use the scheduled triager');
    const daily = contract.name === 'workspace-walk';
    const window = await db.query<{ days: 1 | 14 }>(`SELECT CASE
      WHEN extract(isodow FROM now() AT TIME ZONE 'America/New_York')=1 THEN 14 ELSE 1 END AS days`);
    await reserveServiceReviewWorkspaces(db,nextAgentId,runId,daily,daily ? window.rows[0]!.days : 1);
  }
  const attempt = run.seq + 1;
  const cardId = randomBytes(32).toString('hex');
  const status = isTerminal ? (nextState as { status: 'done' | 'failed' }).status : undefined;
  await systemLine(db, {
    id: cardId,
    roomId,
    ...input.line(toState),
    kind: 'workflow-handoff',
    ...(!isTerminal && !isGate && nextAgentId ? { wakes: [nextAgentId] } : {}),
    presentation: 'system',
    cardType: WORKFLOW_HANDOFF_CARD_TYPE,
    card: {
      runId,
      seq: attempt,
      workflowSlug: run.workflowSlug,
      workflowVersion: run.workflowVersion,
      roleBindings,
      fromState: stateName,
      outcome: input.outcome,
      toState,
      contents: input.contents,
      receipt: { ...input.receiptInput, exit: { gate: input.outcome, actorId: input.actorId, ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}) } },
      answers: run.seq,
      ...(input.commandId ? { commandId: input.commandId } : {}),
      ...(nextState.hint ? { receiptHint: nextState.hint } : {}),
      ...(status ? { status } : {}),
    },
  });
  await saveRunStatus(db, scope, toState);
  await dispatchState(db, {
    workspaceId: scope.workspaceId,
    roomId,
    runId,
    contract,
    roleBindings,
    roleAgents,
    stateName: toState,
    attempt,
    cardId,
    exhausted,
  });
  return { state: toState, attempt, ...(status ? { status } : {}) };
}


/**
 * Same-state reassignment: the run's `toState` does not change, only which
 * agent holds it, under a new attempt. Reused by list failover (`blocked`,
 * an expired step, a failed turn) and an explicit `assign_workflow_role`;
 * the caller decides `picked`.
 */
export async function moveRole(
  db: SqlDatabase,
  scope: RunScope,
  input: { role: string; picked: string; tried: TriedAgent[]; why: string; line?: Partial<CardLine> },
): Promise<{ state: string; attempt: number }> {
  const { run, roomId, runId, stateName } = scope;
  const state = scope.state as WorkflowHandoffState | WorkflowGateState;
  const otherRole = input.role === 'checker' ? 'maker' : input.role === 'maker' ? 'checker' : undefined;
  if (run.workflowSlug === WELCOME_VIDEO_SLUG && otherRole &&
    (await welcomeVideoRoleHolders(db, roomId, runId, otherRole, run.roleBindings[otherRole])).includes(input.picked))
    throw new Error('The welcome video maker and checker must not be the same agent in a run.');
  const roleBindings = { ...run.roleBindings, [input.role]: input.picked };
  const from = run.roleBindings[input.role];
  const names = await mentionsFor(db, [input.picked, ...(from ? [from] : [])]);
  await cancelRunWakes(db, roomId, runId);
  await cancelStepTimer(db, runId);
  if (state.kind === 'gate') await closeRunChoices(db, roomId, runId);
  const attempt = run.seq + 1;
  const cardId = randomBytes(32).toString('hex');
  await ensureSystemIdentity(db);
  await systemLine(db, {
    id: cardId,
    roomId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: systemMessage("workflow-runs.the-workflow") },
    verb: systemMessage("workflow-runs.moved"),
    object: stateName,
    consequence:
      systemMessage("workflow-runs.to-because-in-run-of", from ? systemMessage("workflow-runs.from", names.get(from)) : '', names.get(input.picked), input.why, shortRunId(runId), run.workflowSlug).slice(0, 600),
    ...input.line,
    kind: 'workflow-handoff',
    ...(state.kind === 'gate' ? {} : { wakes: [input.picked] }),
    presentation: 'system',
    cardType: WORKFLOW_HANDOFF_CARD_TYPE,
    card: {
      runId,
      seq: attempt,
      workflowSlug: run.workflowSlug,
      workflowVersion: run.workflowVersion,
      roleBindings,
      toState: stateName,
      reassigned: true,
      answers: run.seq,
      ...(input.tried.length ? { tried: input.tried } : {}),
      ...(state.hint ? { receiptHint: state.hint } : {}),
    },
  });
  await dispatchState(db, {
    workspaceId: scope.workspaceId,
    roomId,
    runId,
    contract: scope.contract,
    roleBindings,
    roleAgents: {},
    stateName,
    attempt,
    cardId,
    exhausted: false,
  });
  return { state: stateName, attempt };
}


/** End a live run where it stands: a person's cancellation or an engine close such as a passed deadline. */
export async function closeRun(
  db: SqlDatabase,
  scope: RunScope,
  input: {
    status: 'failed' | 'abandoned';
    outcome: string;
    reason: string;
    cancellation?: { reason: string; actorId: string };
    line: CardLine;
  },
): Promise<void> {
  const { run, roomId, runId, stateName } = scope;
  await cancelRunWakes(db, roomId, runId);
  await cancelRunTimers(db, runId);
  await closeRunChoices(db, roomId, runId);
  await ensureSystemIdentity(db);
  await systemLine(db, {
    roomId,
    ...input.line,
    afterMessageId: runId,
    // No event kind: a closed run is a durable record that wakes nobody.
    presentation: 'system',
    cardType: WORKFLOW_HANDOFF_CARD_TYPE,
    card: {
      runId,
      seq: run.seq + 1,
      workflowSlug: run.workflowSlug,
      workflowVersion: run.workflowVersion,
      roleBindings: run.roleBindings,
      fromState: stateName,
      toState: stateName,
      outcome: input.outcome,
      status: input.status,
      answers: run.seq,
      ...(input.cancellation ? { cancellation: input.cancellation } : { closure: { reason: input.reason } }),
      contents: { reason: input.reason },
    },
  });
  await saveRunStatus(db, scope, stateName, input.status);
}


/** Every agent that has held this role in the run, including earlier failovers. */
export async function welcomeVideoRoleHolders(db: SqlDatabase, roomId: string, runId: string | undefined, role: 'maker' | 'checker', current?: string): Promise<string[]> {
  const rows = runId ? (await db.query<{ holder: string | null }>(
    `SELECT DISTINCT card->'roleBindings'->>$4 holder FROM messages
     WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$3`,
    [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId, role])).rows : [];
  return [...new Set([...rows.map(row => row.holder), current].filter((id): id is string => Boolean(id)))];
}


/** The agents a step's role may walk: its ordered list, or its one bound agent. */
export async function roleList(db: SqlDatabase, scope: RunScope, role: string): Promise<string[]> {
  const agents = (await loadRunRoleAgents(db, scope.roomId, scope.runId))[role];
  if (agents?.length) {
    const otherRole = role === 'checker' ? 'maker' : role === 'maker' ? 'checker' : undefined;
    if (scope.run.workflowSlug === WELCOME_VIDEO_SLUG && otherRole) {
      const excluded = await welcomeVideoRoleHolders(db, scope.roomId, scope.runId, otherRole, scope.run.roleBindings[otherRole]);
      return agents.filter(agent => !excluded.includes(agent));
    }
    return agents;
  }
  const bound = scope.run.roleBindings[role];
  return bound ? [bound] : [];
}


/**
 * Move a handoff step past `leaving` to the next eligible agent on its role
 * list: forward only, each agent once per state visit, skipping anyone
 * unhealthy or no longer in the Room. With nobody left, `timeout` applies the
 * step's `timeout` outcome as the system (when it declares one); otherwise,
 * and always for `wait`, the run posts each agent's reason and waits.
 * Without a timeout outcome, retry the whole list after another full lease.
 */
export async function failOver(
  db: SqlDatabase,
  scope: RunScope,
  input: { leaving?: string; why: string; whenExhausted: 'timeout' | 'wait'; retryRoleList?: boolean },
): Promise<{ state: string; attempt: number; status?: 'done' | 'failed' }> {
  const state = scope.state as WorkflowHandoffState;
  const role = state.role;
  const tried = input.retryRoleList ? [] : [
    ...(scope.run.tried ?? []).filter((entry) => entry.agentId !== input.leaving),
    ...(input.leaving ? [{ agentId: input.leaving, reason: input.why }] : []),
  ];
  const list = await roleList(db, scope, role);
  const cursor = input.retryRoleList ? undefined : input.leaving ?? scope.run.roleBindings[role];
  const start = cursor && list.includes(cursor) ? list.indexOf(cursor) + 1 : 0;
  const picked = await pickWorkflowAgent(
    db, scope.roomId, list.slice(start), tried.map((entry) => entry.agentId), scope.run.workflowSlug,
  );
  if (picked) return moveRole(db, scope, { role, picked, tried, why: input.why });
  const reasons = list.length ? await roleReasons(db, { roomId: scope.roomId, list, tried, cursor }) : '';
  if (input.whenExhausted === 'timeout' && Object.hasOwn(state.on, 'timeout')) {
    return enterState(db, scope, {
      outcome: 'timeout',
      contents: { reason: reasons || input.why },
      actorId: SYSTEM_IDENTITY_ID,
      line: (toState) => ({
        authorId: SYSTEM_IDENTITY_ID,
        subject: { kind: 'system', name: systemMessage("workflow-runs.the-workflow") },
        verb: systemMessage("workflow-runs.applied"),
        object: systemMessage("workflow-runs.timeout"),
        consequence:
          systemMessage("workflow-runs.at-and-went-to-because-nobody-on-the-role-is-left-in-run-of", scope.stateName, toState, role, reasons ? systemMessage("workflow-runs.health-reasons", reasons) : '', shortRunId(scope.runId), scope.run.workflowSlug).slice(0, 600),
      }),
    });
  }
  await noteWorkflowRoleExhausted(db, {
    roomId: scope.roomId,
    runId: scope.runId,
    workflowSlug: scope.run.workflowSlug,
    role,
    afterMessageId: scope.head.id,
    list,
    tried,
    ...(cursor ? { cursor } : {}),
  });
  if (!Object.hasOwn(state.on, 'timeout')) {
    await scheduleRunTimer(db, {
      workspaceId: scope.workspaceId,
      roomId: scope.roomId,
      runId: scope.runId,
      workflowSlug: scope.run.workflowSlug,
      timer: 'step',
      seconds: state.timeoutSeconds ?? WORKFLOW_LEGACY_STEP_TIMEOUT_SECONDS,
      attempt: scope.run.seq,
      retryRoleList: true,
    });
  }
  return { state: scope.stateName, attempt: scope.run.seq };
}


/** Explicit workflow controls use the command's requester, never the executing agent's privileges. */
export async function authorizeWorkflowControl(
  db: SqlDatabase,
  command: CommandRow,
  input: {
    requesterId: string | null;
    agentIds: string[];
    authority: string;
    action: string;
    /** Any human in the Room may take this action (cancelling a run). */
    roomMembers?: boolean;
  },
): Promise<string> {
  const actorId = await workflowRequester(db, command);
  if (input.roomMembers && (await humanRoomMember(db, command.room_id, actorId))) return actorId;
  const roleOwners = await db.query(
    `SELECT 1 FROM agents WHERE agent_id=ANY($1::text[]) AND owner_id=$2`,
    [input.agentIds, actorId],
  );
  if (
    actorId !== input.requesterId && !roleOwners.rowCount &&
    !(await humanRoomAdmin(db, command.room_id, actorId))
  ) {
    throw new WorkflowAuthorizationError(
      `only ${input.authority}, or a workspace admin can ${input.action}`,
      403,
    );
  }
  return actorId;
}


export async function authorizeRunControl(
  db: SqlDatabase,
  command: CommandRow,
  run: WorkflowRunCard,
  action: string,
  roomMembers = false,
): Promise<string> {
  const start = await loadRunStart(db, command.room_id, run.runId);
  return authorizeWorkflowControl(db, command, {
    requesterId: start.card.requesterId ?? start.authorId,
    agentIds: [...Object.values(run.roleBindings), ...Object.values(start.card.roleAgents ?? {}).flat()],
    authority: roomMembers ? 'a person in this Room, the run requester, a bound role owner' : 'the run requester, a bound role owner',
    action,
    roomMembers,
  });
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
    const scope = await openRun(db, command.room_id, input.runId);
    input = { ...input, runId: scope.runId };
    const { run } = scope;
    const actorId = await authorizeRunControl(db, command, run, 'cancel this run', true);
    if (scope.ended) throw new Error('this workflow run has already ended');
    const reason = input.reason.trim();
    await closeRun(db, scope, {
      status: 'abandoned',
      outcome: 'cancelled',
      reason,
      cancellation: { reason, actorId },
      line: {
        authorId: SYSTEM_IDENTITY_ID,
        subject: identitySubject(await loadIdentityRow(db, actorId)),
        verb: systemMessage("workflow-runs.cancelled-workflow"),
        object: run.workflowSlug,
        consequence: systemMessage("workflow-runs.run", shortRunId(input.runId)),
      },
    });
    return { runId: input.runId, state: run.toState, status: 'abandoned', reason };
  });
}


/**
 * The attempt the command was woken for: the dispatch card it answers, or for
 * any other wake citing this run, the attempt current when that wake was
 * posted. `undefined` when the command did not come from this run at all.
 */
export async function provenanceAttempt(
  db: SqlDatabase,
  roomId: string,
  runId: string,
  sourceMessageId: string | null | undefined,
): Promise<number | undefined> {
  if (!sourceMessageId) return undefined;
  const source = (
    await db.query<{ card_type: string | null; card: WorkflowRunCard | null; created_at: Date }>(
      `SELECT source.card_type,source.card,source.created_at FROM messages source
       WHERE source.room_id=$2 AND source.card->>'runId'=$3
         AND source.id=$1`,
      [sourceMessageId, roomId, runId],
    )
  ).rows[0];
  if (!source?.card || source.card.runId !== runId) return undefined;
  if (source.card_type === WORKFLOW_HANDOFF_CARD_TYPE) return source.card.seq;
  const prior = (
    await db.query<{ seq: string | null }>(
      `SELECT card->>'seq' seq FROM messages
       WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$3 AND created_at<=$4
       ORDER BY (card->>'seq')::int DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
      [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId, source.created_at],
    )
  ).rows[0];
  return prior ? Number(prior.seq) : undefined;
}


/** The newest card of this run a command's own handoff wrote, if any. */
export async function cardByCommand(
  db: SqlDatabase,
  roomId: string,
  runId: string,
  commandId: string,
): Promise<{ id: string; card: WorkflowRunCard } | undefined> {
  return (
    await db.query<{ id: string; card: WorkflowRunCard }>(
      `SELECT id,card FROM messages
       WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$3 AND card->>'commandId'=$4
       ORDER BY (card->>'seq')::int DESC NULLS LAST LIMIT 1`,
      [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId, commandId],
    )
  ).rows[0];
}


export type HandoffResult =
  | { runId: string; state: string; attempt: number; status?: 'done' | 'failed' }
  | {
      alreadyAdvanced: true;
      runId: string;
      state: string;
      seq: number;
      status?: 'done' | 'failed' | 'abandoned';
    };


export function alreadyAdvanced(scope: RunScope): HandoffResult {
  const { status } = scope;
  return {
    alreadyAdvanced: true,
    runId: scope.runId,
    state: scope.stateName,
    seq: scope.run.seq,
    ...(status !== 'live' ? { status } : {}),
  };
}
