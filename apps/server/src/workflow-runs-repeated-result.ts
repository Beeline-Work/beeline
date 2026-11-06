import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { applyFeedbackDispositions } from './feedback-dispositions.js';
import { completeServiceReview } from './service-review.js';
import { CommandRefusalError, ExpectedRefusalError } from './command-refusal.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { workflowRunIsLiveSql } from './workflow-run-saved-status.js';
import { humanRoomAdmin, WorkflowAuthorizationError } from './workflow-admin.js';
import { shortRunId, validateSavedWorkflow, workflowContentsError, workflowReceiptError, type WorkflowReceiptInput, isAgentIdentityReference, WORKFLOW_BLOCKED_OUTCOME, WORKFLOW_ROLE_AGENTS_MAX, type WorkflowContract, type WorkflowReadContract, type WorkflowGateState, type WorkflowHandoffState, type WorkflowRoleBinding } from '@beeline/api-contract/daemon';
import { bindWorkflowStepOutput } from './workflow-step-output.js';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { applySkillRevision, assertSkillTextSafe } from './institutional-skills.js';
import type { AfterCommit } from './institutional-memory-embeddings.js';
import { answerRoomChoice, skipRoomChoice } from './room-choice.js';
import { identitySubject, systemIdentityMention } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { RunScope, openRun, loadIdentityRow, noticeRunOwner, loadRun, workflowRequester } from './workflow-runs.js';
import { HandoffResult, provenanceAttempt, cardByCommand, alreadyAdvanced, isHandoffState, failOver, enterState, closeRun } from './workflow-runs-cancel-run-timers.js';



/** The head card's own result, for an identical repeat of the handoff that wrote it. */
export function repeatedResult(scope: RunScope): HandoffResult {
  return {
    runId: scope.runId,
    state: scope.stateName,
    attempt: scope.run.seq,
    ...(scope.run.status === 'done' || scope.run.status === 'failed' ? { status: scope.run.status } : {}),
  };
}


export async function handoff(
  database: SqlDatabase,
  command: CommandRow,
  input: {
    runId: string;
    outcome: string;
    contents: unknown;
    receipt?: WorkflowReceiptInput;
    attempt?: number;
  },
): Promise<HandoffResult> {
  if (typeof input.runId !== 'string' || !input.runId) throw new Error('runId is required');
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 0))
    throw new Error('attempt must be a whole number from the run wake');
  return database.transaction(async (db) => {
    // Resolve prefixes before locking, then serialize the run's state reads
    // and writes against every other writer on the canonical ID.
    const scope = await openRun(db, command.room_id, input.runId);
    input = { ...input, runId: scope.runId };
    const { run, stateName } = scope;
    const current = run.seq;
    let attempt =
      input.attempt ??
      (await provenanceAttempt(db, command.room_id, input.runId, command.source_message_id));
    if (attempt === undefined) {
      // No wake from this run: a bound agent's handoff acts on the current
      // card, once per command.
      const own = await cardByCommand(db, command.room_id, input.runId, command.id);
      if (own) {
        return own.id === scope.head.id && run.outcome === input.outcome
          ? repeatedResult(scope)
          : alreadyAdvanced(scope);
      }
      attempt = current;
    }
    if (attempt !== current) {
      return run.answers === attempt && run.outcome === input.outcome && scope.head.authorId === command.agent_id
        ? repeatedResult(scope)
        : alreadyAdvanced(scope);
    }
    const state = scope.state;
    if (scope.ended || !state) throw new Error('this workflow run has already ended');
    if (state.kind === 'gate') {
      const role = state.role;
      const boundAgentId = run.roleBindings[role];
      if (boundAgentId !== command.agent_id)
        throw new Error(`this workflow state is bound to the ${role} role, not you`);
      const answer = await gateMessageAnswer(db, command, input.runId, current, state, input.outcome);
      if (!answer)
        throw new Error(
          `${stateName} is a gate; a person answers it on its card in the Room, and it cannot be handed off`,
        );
      await bindWorkflowStepOutput(db, command, input.runId);
      await settleWorkflowGate(db, {
        choiceId: answer.choiceId,
        viewerId: answer.viewerId,
        optionId: answer.optionId,
        sourceMessageId: command.source_message_id ?? undefined,
      });
      const after = await openRun(db, command.room_id, input.runId);
      return {
        runId: input.runId,
        state: after.stateName,
        attempt: after.run.seq,
        ...(after.run.status === 'done' || after.run.status === 'failed' ? { status: after.run.status } : {}),
      };
    }
    const role = (state as WorkflowHandoffState | WorkflowGateState).role;
    const boundAgentId = run.roleBindings[role];
    const on = (state as WorkflowHandoffState).on;
    const builtInBlocked =
      input.outcome === WORKFLOW_BLOCKED_OUTCOME && isHandoffState(state) && !Object.hasOwn(on, WORKFLOW_BLOCKED_OUTCOME);
    if (builtInBlocked) {
      const reason = input.contents && typeof input.contents === 'object' && !Array.isArray(input.contents)
        ? (input.contents as Record<string, unknown>).reason
        : undefined;
      const errors = [
        ...(boundAgentId !== command.agent_id ? [`this workflow state is bound to the ${role} role, not you`] : []),
        ...(typeof reason !== 'string' || !reason.trim() || reason.length > 500
          ? ['blocked needs contents.reason: why you cannot do this step, 1-500 characters'] : []),
      ];
      if (errors.length) throw new ExpectedRefusalError(errors.join('; '));
      await bindWorkflowStepOutput(db, command, input.runId);
      const why = `${(reason as string).replace(/\s+/g, ' ').trim().slice(0, 200)}`;
      const result = await failOver(db, scope, {
        leaving: command.agent_id,
        why: `blocked (${why})`,
        whenExhausted: 'timeout',
      });
      return { runId: input.runId, ...result };
    }
    const declaredTimeout = isHandoffState(state) && input.outcome === 'timeout' && Object.hasOwn(on, 'timeout');
    const contentsState = declaredTimeout ? { requires: ['reason'] } : state as WorkflowHandoffState;
    const contentsError = workflowContentsError(contentsState, input.contents);
    const timeoutReason = declaredTimeout && input.contents && typeof input.contents === 'object'
      ? (input.contents as Record<string, unknown>).reason : undefined;
    const timeoutError = declaredTimeout &&
      (typeof timeoutReason !== 'string' || !timeoutReason.trim() || timeoutReason.length > 500)
      ? 'timeout needs contents.reason: why this step timed out, 1-500 characters' : undefined;
    const receiptError = workflowReceiptError(input.receipt);
    const errors = [
      ...(boundAgentId !== command.agent_id ? [`this workflow state is bound to the ${role} role, not you`] : []),
      ...(!Object.hasOwn(on, input.outcome) ? ['invalid outcome'] : []),
      ...(contentsError ? [contentsError] : []),
      ...(contentsError?.startsWith('contents')
        ? contentsState.requires
            .filter((field) => !input.contents || typeof input.contents !== 'object' || Array.isArray(input.contents) ||
              (input.contents as Record<string, unknown>)[field] == null)
            .map((field) => `${field} is required`) : []),
      ...(timeoutError ? [timeoutError] : []),
      ...(receiptError ? [receiptError] : []),
    ];
    if (errors.length) {
      const outcomes = Object.entries(on).map(([outcome, target]) => `${outcome} -> ${target}`).join(', ');
      const blocked = isHandoffState(state) && !Object.hasOwn(on, WORKFLOW_BLOCKED_OUTCOME)
        ? ', or blocked with contents.reason' : '';
      throw new ExpectedRefusalError(`${errors.join('; ')}; outcome must be one of: ${outcomes}${blocked}`);
    }
    if (scope.contract.name === 'feedback-triage' && stateName === 'pull' && contentsState.requires.includes('dispositions') && ['ranked', 'nothing_new'].includes(input.outcome)) {
      await applyFeedbackDispositions(db, command, (input.contents as Record<string, unknown>).dispositions);
    }
    if (scope.contract.name === 'workspace-walk' && stateName === 'browse' && input.outcome === 'reviewed') {
      await completeServiceReview(db,command.agent_id,input.runId,(input.contents as Record<string, unknown>).receipts);
    }
    await bindWorkflowStepOutput(db, command, input.runId);
    const actor = await loadIdentityRow(db, command.agent_id);
    const result = await enterState(db, scope, {
      outcome: input.outcome,
      contents: input.contents,
      ...(input.receipt ? { receiptInput: input.receipt } : {}),
      actorId: command.agent_id,
      commandId: command.id,
      line: (toState) => ({
        authorId: command.agent_id,
        subject: identitySubject(actor),
        verb: systemMessage("workflow-runs.handed-off"),
        object: toState,
        consequence: systemMessage("workflow-runs.run-of", shortRunId(input.runId), run.workflowSlug),
      }),
    });
    return { runId: input.runId, ...result };
  });
}


/**
 * The person's message that started this turn, resolved to the gate's own
 * open choice and the option its outcome names. `undefined` when the turn
 * was not started by a person, so the gate keeps today's refusal; the
 * caller then fails closed. The person is not checked for membership here:
 * `settleWorkflowGate` runs the same human-and-current-member authority
 * check as a card answer, and a message from a non-member is refused there.
 */
export async function gateMessageAnswer(
  db: SqlDatabase,
  command: CommandRow,
  runId: string,
  attempt: number,
  state: WorkflowGateState,
  outcome: string,
): Promise<{ choiceId: string; viewerId: string; optionId: string } | undefined> {
  const author = (
    await db.query<{ id: string; kind: string }>(
      `SELECT identity.id,identity.kind FROM messages message
       JOIN identities identity ON identity.id=message.author_id
       WHERE message.id=$1 AND message.room_id=$2`,
      [command.source_message_id, command.room_id],
    )
  ).rows[0];
  if (author?.kind !== 'human') return undefined;
  const choice = (
    await db.query<{ id: string; options: { optionId: string; label: string }[] }>(
      `SELECT choice.id,choice.options FROM room_choices choice
       JOIN messages message ON message.id=choice.message_id
       WHERE choice.room_id=$1 AND choice.workflow_run_id=$2 AND choice.status='open'
         AND COALESCE((message.card->>'attempt')::int,-1)=$3
       ORDER BY choice.created_at DESC,choice.id DESC LIMIT 1`,
      [command.room_id, runId, attempt],
    )
  ).rows[0];
  if (!choice) return undefined;
  const option = choice.options.find((entry) => entry.label === outcome);
  if (!option) {
    const outcomes = Object.entries(state.on).map(([name, target]) => `${name} -> ${target}`).join(', ');
    throw new Error(`outcome must be one of: ${outcomes}`);
  }
  return { choiceId: choice.id, viewerId: author.id, optionId: option.optionId };
}


/**
 * A person's answer or Skip on a workflow gate's card, applied under the run
 * lock as the gate's transition. `undefined` when the choice is not a
 * workflow gate, so the caller settles it as an ordinary choice. An answer
 * on a card whose gate already moved on is refused; Skip applies the gate's
 * `default` and notices the run owner, and a gate with no default refuses it.
 */
export async function settleWorkflowGate(
  db: SqlDatabase,
  input: { choiceId: string; viewerId: string; optionId?: string; note?: unknown; skip?: boolean; sourceMessageId?: string },
): Promise<{ choiceId: string; status: 'answered' | 'skipped'; roomId: string } | undefined> {
  const gate = (
    await db.query<{
      room_id: string;
      run_id: string | null;
      attempt: string | null;
      options: { optionId: string; label: string }[];
    }>(
      `SELECT choice.room_id,message.card->>'runId' run_id,message.card->>'attempt' attempt,choice.options
       FROM room_choices choice JOIN messages message ON message.id=choice.message_id
       WHERE choice.id::text=$1`,
      [input.choiceId],
    )
  ).rows[0];
  if (!gate?.run_id) return undefined;
  const scope = await openRun(db, gate.room_id, gate.run_id);
  const state = scope.state;
  if (
    scope.ended || state?.kind !== 'gate' ||
    (gate.attempt === null || Number(gate.attempt) !== scope.run.seq)
  )
    throw new Error('choice conflict: this gate already advanced');
  if (input.skip && !state.default) throw new Error('this gate needs an answer');
  const label = input.skip
    ? state.default!
    : gate.options.find((option) => option.optionId === input.optionId)?.label;
  if (!label || !Object.hasOwn(state.on, label)) throw new Error('choice option is invalid');
  const settled = input.skip
    ? await skipRoomChoice(db, { choiceId: input.choiceId, viewerId: input.viewerId }, { wake: false })
    : await answerRoomChoice(
        db,
        { choiceId: input.choiceId, optionId: input.optionId!, viewerId: input.viewerId, note: input.note },
        { wake: false },
      );
  const viewer = await loadIdentityRow(db, input.viewerId);
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.replace(/\s+/g, ' ').trim() : undefined;
  const attempt = scope.run.seq;
  await enterState(db, scope, {
    outcome: label,
    contents: input.skip
      ? { decision: label, defaultedBy: input.viewerId }
      : { decision: label, ...(note ? { note } : {}), answeredBy: input.viewerId },
    actorId: input.viewerId,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    line: (toState) => ({
      authorId: input.viewerId,
      subject: identitySubject(viewer),
      verb: input.skip ? systemMessage("workflow-runs.skipped") : input.sourceMessageId ? systemMessage("workflow-runs.answered") : systemMessage("workflow-runs.picked"),
      object: input.skip ? scope.stateName : label,
      consequence: input.skip
        ? systemMessage("workflow-runs.so-applied-and-run-went-to", label, shortRunId(scope.runId), toState)
        : input.sourceMessageId
          ? systemMessage("workflow-runs.by-message-at-so-run-went-to", scope.stateName, shortRunId(scope.runId), toState)
          : systemMessage("workflow-runs.at-so-run-went-to", scope.stateName, shortRunId(scope.runId), toState),
    }),
  });
  if (input.skip) {
    await noticeRunOwner(db, scope, `gate-default:${attempt}`, {
      subject: { kind: 'system', name: systemMessage("workflow-runs.the-gate-of", scope.stateName, scope.run.workflowSlug) },
      verb: systemMessage("workflow-runs.took-its-default"),
      object: label,
      consequence: systemMessage("workflow-runs.skipped-it-in-run", systemIdentityMention({ ...viewer, handle: viewer.handle ?? null }) || viewer.name, shortRunId(scope.runId)),
    });
  }
  return { choiceId: settled.choiceId, status: input.skip ? 'skipped' : 'answered', roomId: settled.roomId };
}


/** A closing corner abandons every live saved run inside it. Call within the close transaction. */
export async function abandonCornerWorkflowRuns(db: SqlDatabase, cornerId: string): Promise<number> {
  const live = await db.query<{ id: string }>(
    `SELECT id FROM messages
     WHERE room_id=$1 AND card_type='workflow-handoff' AND ${workflowRunIsLiveSql('card')}
     ORDER BY id`,
    [cornerId],
  );
  let abandoned = 0;
  for (const { id } of live.rows) {
    const scope = await openRun(db, cornerId, id);
    if (scope.ended) continue;
    await closeRun(db, scope, {
      status: 'abandoned',
      outcome: 'corner_closed',
      reason: 'corner closed',
      line: {
        authorId: SYSTEM_IDENTITY_ID,
        subject: { kind: 'system', name: systemMessage("workflow-runs.the-workflow") },
        verb: systemMessage("workflow-runs.closed"),
        object: systemMessage("workflow-runs.run-of", shortRunId(scope.runId), scope.run.workflowSlug),
        consequence: systemMessage("workflow-runs.as-abandoned-at-because-its-corner-closed", scope.stateName),
      },
    });
    abandoned += 1;
  }
  return abandoned;
}


/** The live run of `workflowName` in this Room, if one exists. */
export async function liveWorkflowRun(
  db: SqlDatabase,
  roomId: string,
  workflowName: string,
): Promise<{ runId: string; state: string; status: string; startedAt: Date } | undefined> {
  const active = (
    await db.query<{ id: string; created_at: Date }>(
      `SELECT id,created_at FROM messages
       WHERE room_id=$1 AND card_type='workflow-handoff' AND ${workflowRunIsLiveSql('card')}
         AND card->>'workflowSlug'=$2
       ORDER BY created_at,id LIMIT 1`,
      [roomId, workflowName],
    )
  ).rows[0];
  if (!active) return undefined;
  const run = await loadRun(db, roomId, active.id);
  return { runId: active.id, state: run?.toState ?? systemMessage("workflow-runs.unknown"), status: run?.status ?? systemMessage("workflow-runs.live"), startedAt: active.created_at };
}


/** Serializes starts of one workflow in one Room, so the live-run check and the start card commit together. */
export function workflowStartLockKey(roomId: string, workflowName: string): string {
  return `workflow-start:${roomId}:${workflowName}`;
}


export async function saveWorkflow(
  database: SqlDatabase,
  command: CommandRow,
  input: { contract: unknown },
  afterCommit?: AfterCommit,
): Promise<{ slug: string; version: number }> {
    database = new CornerAccessDatabase(database);
  const reason = validateSavedWorkflow(input.contract);
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
    // Anyone may save a new workflow. Saving an active one unchanged is a
    // no-op that writes nothing. Changing or reviving an existing saved
    // workflow changes it for the whole Workspace, so only a human Workspace
    // admin may. The revision lock is taken first, so a concurrent creation
    // cannot slip between this read and the write.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `workspace-skill:${room.workspace_id}:${contract.name}`,
    ]);
    const existing = (await db.query<{ unchanged: boolean; current_version: number }>(
      `SELECT skill.state='active' AND version.markdown=$3 unchanged,skill.current_version
       FROM workspace_skills skill
       LEFT JOIN workspace_skill_versions version ON version.skill_id=skill.id
         AND version.version=skill.current_version
       WHERE skill.workspace_id=$1 AND skill.slug=$2 AND skill.kind='workflow'
       FOR UPDATE OF skill`,
      [room.workspace_id, contract.name, markdown],
    )).rows[0];
    if (existing?.unchanged) return { slug: contract.name, version: existing.current_version };
    if (existing && !(await humanRoomAdmin(db, command.room_id, await workflowRequester(db, command))))
      throw new WorkflowAuthorizationError('workspace admins only: only a workspace admin can change this saved workflow', 403);
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
export function roleAgentList(binding: WorkflowRoleBinding): string[] | null {
  if (isAgentIdentityReference(binding)) return [binding];
  if (!Array.isArray(binding)) return null;
  if (!binding.length || binding.length > WORKFLOW_ROLE_AGENTS_MAX) return null;
  if (!binding.every(isAgentIdentityReference)) return null;
  return new Set(binding).size === binding.length ? [...binding] : null;
}


/** The schedule occurrence (if any) whose wake message triggered this call. */
export async function scheduleTriggerPeriod(
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


/** Every still-active run id this schedule has ever started (any workflow), for `list_schedules`. */
export async function activeRunIdsForSchedule(
  db: SqlDatabase,
  roomId: string,
  scheduleId: string,
): Promise<string[]> {
  const active = await db.query<{ id: string }>(
    `SELECT id FROM messages
     WHERE room_id=$1 AND card_type='workflow-handoff' AND ${workflowRunIsLiveSql('card')}
       AND card->'trigger'->>'scheduleId'=$2
     ORDER BY id`,
    [roomId, scheduleId],
  );
  return active.rows.map((row) => row.id);
}


/** Collect caller errors before constructing the unchanged workflow start card. */
export async function validateWorkflowBindings(
  db: SqlDatabase,
  roomId: string,
  contract: WorkflowReadContract,
  input: { roleBindings: Readonly<Record<string, WorkflowRoleBinding>> },
): Promise<void> {
  const members = (await db.query<{ identity_id: string; handle: string | null; kind: string }>(
    `SELECT member.identity_id,identity.handle,identity.kind FROM effective_memberships member
     JOIN identities identity ON identity.id=member.identity_id
     WHERE member.room_id=$1 AND member.removed_at IS NULL`, [roomId],
  )).rows;
  const agentMembers = members.filter(member => member.kind === 'agent');
  const allowed = agentMembers.map(member => member.handle ? `@${member.handle} (${member.identity_id})` : member.identity_id);
  const memberIds = new Set(agentMembers.map(member => member.identity_id));
  const errors: string[] = [];
  for (const role of contract.roles) {
    const raw = input.roleBindings[role];
    const entries = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
    const resolved = entries.map(entry => {
      if (typeof entry !== 'string') return entry;
      return members.find(member => member.handle?.toLowerCase() === entry.replace(/^@/, '').toLowerCase())?.identity_id ?? entry;
    });
    const agents = roleAgentList(resolved.length === 1 ? resolved[0] : resolved);
    if (!agents || agents.some(id => !memberIds.has(id))) {
      const outsiders = agents?.filter(id => !memberIds.has(id)) ?? [];
      const reason = raw === undefined ? `role binding is missing for ${role}` : outsiders.length
        ? `${outsiders.join(', ')} ${outsiders.length === 1 ? 'is' : 'are'} not a current agent member of this Room`
        : `must be an agent id or a member handle, or a list of 1-${WORKFLOW_ROLE_AGENTS_MAX} distinct ones`;
      errors.push(`${role}: given ${JSON.stringify(raw) ?? 'missing'}; ${reason}; allowed members: ${allowed.join(', ') || '(none)'}`);
      continue;
    }
  }
  for (const role of Object.keys(input.roleBindings)) {
    if (!contract.roles.includes(role)) errors.push(`${role}: given ${JSON.stringify(input.roleBindings[role])}; unknown role; allowed roles: ${contract.roles.join(', ')}`);
  }
  if (errors.length) throw new CommandRefusalError(`Invalid workflow bindings:\n${errors.join('\n')}`, 400);
}
