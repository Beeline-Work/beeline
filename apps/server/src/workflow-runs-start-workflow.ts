import { resourceRequester } from './resource-requester.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { CommandRefusalError, ExpectedRefusalError } from './command-refusal.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { humanRoomAdmin, WorkflowAuthorizationError } from './workflow-admin.js';
import { createHash, randomBytes } from 'node:crypto';
import { shortRunId, isAgentIdentityReference, WORKFLOW_ROLE_AGENTS_MAX, type WorkflowContract, type WorkflowReadContract, type WorkflowGateState, type WorkflowHandoffState, type WorkflowRoleBinding } from '@beeline/api-contract/daemon';
import { workflowRunStatus } from '@beeline/api-contract/phone';
import { FEEDBACK_TRIAGE_CONTRACT, FEEDBACK_TRIAGE_SLUG } from './feedback-triage-workflow.js';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { closeRunChoices } from './room-choice.js';
import { identitySubject, systemLine } from './system-line.js';
import { workflowStartLockKey, liveWorkflowRun, scheduleTriggerPeriod, validateWorkflowBindings, roleAgentList } from './workflow-runs-repeated-result.js';
import { loadIdentityRow, lockWorkflowRun, resolveRoleBinding, WORKFLOW_HANDOFF_CARD_TYPE, workflowRequester, resolveRunOwner, openRun, mentionsFor, workflowRunRequester, loadRun, loadPinnedContract } from './workflow-runs.js';
import { dispatchState, authorizeRunControl, moveRole } from './workflow-runs-cancel-run-timers.js';



export async function startWorkflow(
  database: SqlDatabase,
  command: Pick<CommandRow, 'room_id' | 'agent_id'> & { reason?: string; source_message_id?: string | null; root_source_message_id?: string },
  input: { name: string; roleBindings: Readonly<Record<string, WorkflowRoleBinding>> },
): Promise<{ runId: string; state: string }> {
    database = new CornerAccessDatabase(database);
  if (typeof input.name !== 'string' || !input.name) throw new Error('workflow name is required');
  if (!input.roleBindings || typeof input.roleBindings !== 'object') {
    throw new Error('roleBindings is required');
  }

  return database.transaction(async (db) => {
    // One live run of a workflow per Room, for people, agents and schedules
    // alike: the check and the start card commit under this one lock.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      workflowStartLockKey(command.room_id, input.name),
    ]);
    const live = await liveWorkflowRun(db, command.room_id, input.name);
    if (live) {
      throw new Error(
        `${input.name} already has a live run ${live.runId} in this Room, at ${live.state}. Continue it or cancel it before starting another.`,
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
    const contract = JSON.parse(skill.markdown) as WorkflowReadContract;
    const trigger = command.source_message_id
      ? await scheduleTriggerPeriod(db, command.source_message_id)
      : undefined;
    await validateWorkflowBindings(db, command.room_id, contract, input);
    const missingRole = contract.roles.find((role) => !input.roleBindings[role]);
    if (missingRole) throw new ExpectedRefusalError(`role binding is missing for ${missingRole}`);
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
        throw new CommandRefusalError(
          `role binding for ${role} must be an agent id or a member handle, or a list of 1-${WORKFLOW_ROLE_AGENTS_MAX} distinct ones`,
          400,
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
        throw new CommandRefusalError(`${notAgent} is not a current agent member of this Room`, 400);
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
      workflowSlug: contract.name,
      runId,
    });
    const exhausted = 'exhausted' in resolution;
    await systemLine(db, {
      id: runId,
      roomId: command.room_id,
      authorId: command.agent_id,
      subject: identitySubject(starter),
      verb: systemMessage("workflow-runs.started-workflow"),
      object: contract.name,
      consequence: systemMessage("workflow-runs.run", shortRunId(runId)),
      kind: 'workflow-handoff',
      ...(!exhausted && !isGate ? { wakes: [(resolution as { agentId: string }).agentId] } : {}),
      presentation: 'system',
      cardType: WORKFLOW_HANDOFF_CARD_TYPE,
      card: {
        runId,
        seq: 0,
        runStatus: 'live',
        workflowSlug: contract.name,
        workflowVersion: skill.current_version,
        requesterId: await workflowRequester(db, command),
        ownerId: await resolveRunOwner(db, command),
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
    if (command.source_message_id) await db.query(
      `WITH linked AS (
        UPDATE subscription_webhook_calls SET run_id=$2 WHERE wake_message_id=$1 RETURNING subscription_id
      ) UPDATE agent_subscriptions subscription SET fired_count=subscription.fired_count
        FROM linked WHERE subscription.id=linked.subscription_id`,
      [command.source_message_id, runId]);
    await dispatchState(db, {
      workspaceId: room.workspace_id,
      roomId: command.room_id,
      runId,
      contract,
      roleBindings,
      roleAgents,
      stateName: contract.start,
      attempt: 0,
      cardId: runId,
      exhausted,
    });
    return { runId, state: contract.start };
  });
}


export async function resolveHandleBinding(db: SqlDatabase, roomId: string, entry: string): Promise<string> {
  if (typeof (entry as unknown) !== 'string') return entry;
  if (entry.startsWith('@')) return memberIdForHandle(db, roomId, entry);
  if (isAgentIdentityReference(entry)) return entry;
  return (await roomMemberIdForHandle(db, roomId, entry)) ?? entry;
}


/** The identity id of a current Room member with this handle, or undefined when none has it. */
export async function roomMemberIdForHandle(
  db: SqlDatabase,
  roomId: string,
  handle: string,
): Promise<string | undefined> {
    db = new CornerAccessDatabase(db);
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
export async function memberIdForHandle(db: SqlDatabase, roomId: string, raw: string): Promise<string> {
  const handle = raw.replace(/^@/, '');
  const id = await roomMemberIdForHandle(db, roomId, handle);
  if (!id) throw new CommandRefusalError(`@${handle} is not a current member of this Room`, 400);
  return id;
}



/**
 * An explicit override: bind a specific agent to the current role, or any
 * declared role while waiting at a gate, list-bound or not — the recovery path when
 * nobody on a list is eligible, a woken run starter's way to rebind a stuck
 * role, or simply an explicit choice at any time. The target is not
 * health-filtered (an explicit choice overrides "healthy") and need not be on
 * any list, but must be a current agent member of the Room — not a way to
 * bind an outsider.
 */
export async function assignWorkflowRole(
  database: SqlDatabase,
  command: CommandRow,
  input: { runId: string; role: string; targetAgentId: string },
): Promise<{ runId: string; state: string }> {
    database = new CornerAccessDatabase(database);
  if (typeof input.runId !== 'string' || !input.runId) throw new Error('runId is required');
  if (typeof input.role !== 'string' || !input.role) throw new Error('role is required');
  if (typeof input.targetAgentId !== 'string' || !input.targetAgentId) {
    throw new Error('targetAgentId is required');
  }
  return database.transaction(async (db) => {
    const scope = await openRun(db, command.room_id, input.runId);
    await authorizeRunControl(db, command, scope.run, 'reassign this run');
    const targetAgentId = isAgentIdentityReference(input.targetAgentId)
      ? input.targetAgentId
      : await memberIdForHandle(db, command.room_id, input.targetAgentId);
    const { run, state } = scope;
    if (scope.ended || !state) throw new Error('this workflow run has already ended');
    const currentRole = (state as WorkflowHandoffState | WorkflowGateState).role;
    if (!scope.contract.roles.includes(input.role)) {
      throw new ExpectedRefusalError(`unknown workflow role: ${input.role}`);
    }
    if (currentRole !== input.role && state.kind !== 'gate') {
      throw new ExpectedRefusalError(`this run is currently at the ${currentRole} role, not ${input.role}`);
    }
    const member = await db.query(
      `SELECT 1 FROM memberships member
       JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
       WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL`,
      [command.room_id, targetAgentId],
    );
    if (!member.rowCount) {
      throw new ExpectedRefusalError(`${targetAgentId} is not a current agent member of this Room`);
    }
    const caller = await mentionsFor(db, [command.agent_id]);
    await moveRole(db, scope, {
      role: input.role,
      picked: targetAgentId,
      tried: (run.tried ?? []).filter((entry) => entry.agentId !== targetAgentId),
      why: `${caller.get(command.agent_id)} assigned it`,
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
  return database.transaction(async (db) => {
    const room = (await db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM rooms WHERE id=$1`, [command.room_id],
    )).rows[0];
    if (!room) throw new Error('workflow room not found');
    // Archiving deletes a saved workflow for the whole Workspace, so only a
    // human Workspace admin may do it; who saved it grants nothing.
    const skill = (await db.query<{ id: string }>(
      `SELECT skill.id FROM workspace_skills skill
       WHERE skill.workspace_id=$1 AND skill.slug=$2 AND skill.kind='workflow'
       FOR UPDATE OF skill`,
      [room.workspace_id, input.name],
    )).rows[0];
    if (!skill) return { slug: input.name, archived: false };
    const resolved = await resourceRequester(db, command);
    const workflow = resolved && await workflowRunRequester(db, {
      roomId: command.room_id, agentId: command.agent_id,
      rootSourceMessageId: command.root_source_message_id,
    });
    const actorId = workflow?.id ?? resolved?.requester.id ?? command.agent_id;
    if (!(await humanRoomAdmin(db, command.room_id, actorId)))
      throw new WorkflowAuthorizationError('workspace admins only: only a workspace admin can archive this workflow', 403);
    const result = await db.query(
      `UPDATE workspace_skills SET state='stale',updated_at=now() WHERE id=$1 AND state='active'`,
      [skill.id],
    );
    return { slug: input.name, archived: Boolean(result.rowCount) };
  });
}


export const LEGACY_STEP_PLACEHOLDER = /^Step .+: describe what this step does$/;


export function stepDescription(name: string, state: Record<string, unknown>): string {
  const hint = typeof state.hint === 'string' ? state.hint.replace(/\s+/g, ' ').trim() : '';
  if (hint && !hint.includes('describe what this step does')) return hint.slice(0, 140).trim();
  if (state.kind === 'terminal') {
    const endings: Record<string, string> = {
      done: 'The workflow finished.',
      failed: 'The workflow stopped because a step failed.',
      abandoned: 'The workflow was closed before it finished.',
    };
    return endings[String(state.status)] ?? 'The workflow ended.';
  }
  const fields = Array.isArray(state.requires)
    ? state.requires.filter((field): field is string => typeof field === 'string')
        .map((field) => field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
          .replace(/\bpr\b/gi, 'PR').replace(/\burl\b/gi, 'URL'))
    : [];
  if (state.kind === 'gate')
    return fields.length ? `Ask a person for ${fields.join(', ')}.`.slice(0, 140) : 'Ask a person to choose how the workflow continues.';
  if (fields.length) return `Produce ${fields.join(', ')} for ${name.replace(/[_-]/g, ' ')}.`.slice(0, 140);
  return `Complete ${name.replace(/[_-]/g, ' ')} and report its outcome.`.slice(0, 140);
}


export function describedLegacyWorkflowState(name: string, raw: unknown, seeded?: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const state = raw as Record<string, unknown>;
  if (typeof state.does === 'string' && state.does.trim() && !LEGACY_STEP_PLACEHOLDER.test(state.does)) return state;
  const seededDoes = seeded && typeof seeded === 'object' && !Array.isArray(seeded)
    ? (seeded as Record<string, unknown>).does : undefined;
  return {
    ...state,
    does: typeof seededDoes === 'string' && seededDoes.trim() ? seededDoes : stepDescription(name, state),
  };
}


/**
 * The pure half of `backfillWorkflowSkillDescriptions`: fills whichever of
 * `summary`/per-step `does` a contract is missing or previously received as
 * a placeholder, leaving every edge, role
 * binding and loop rule untouched. Every `handoffs` entry gets a `does`,
 * terminal states included: `validateSavedWorkflow` (PR #2083) requires one on
 * every state with no exception, so a contract missing it on even one
 * terminal state would still be refused the next time it is saved. Exported
 * so a caller describing a legacy contract before saving it uses the same
 * deterministic wording as the migration.
 */
export function describedLegacyWorkflowContract(
  contract: WorkflowReadContract,
  seeded?: WorkflowContract,
): WorkflowReadContract {
  const next: Record<string, unknown> = { ...contract };
  if (typeof next.summary !== 'string' || !(next.summary as string).trim() || next.summary === 'Summary not written yet') {
    const description = typeof next.description === 'string' ? (next.description as string).trim() : '';
    next.summary = seeded?.summary || description || `Run the ${contract.name} workflow.`;
  }
  const handoffs = next.handoffs;
  if (handoffs && typeof handoffs === 'object' && !Array.isArray(handoffs)) {
    next.handoffs = Object.fromEntries(
      Object.entries(handoffs as Record<string, unknown>).map(([name, raw]) => [
        name,
        describedLegacyWorkflowState(name, raw, seeded?.handoffs[name]),
      ]),
    );
  }
  return next as WorkflowReadContract;
}


/**
 * `validateSavedWorkflow` (PR #2083) made a NEW save require a `summary` and
 * every state's `does`; every workflow skill version saved before that rule
 * existed has neither, and a pinned run keeps reading its exact saved
 * version forever (`loadPinnedContract`), so those old versions are never
 * re-validated on their own. Keeps `content_hash` honest (every
 * other reader treats it as `sha256(markdown)`, e.g.
 * `feedback-triage-workflow.ts`'s re-seed check). Idempotent: a version
 * already carrying useful fields round-trips to the same markdown and is left
 * untouched. Run from `migrateData()`.
 */
export async function backfillWorkflowSkillDescriptions(database: SqlDatabase): Promise<number> {
  const rows = await database.query<{ skill_id: string; version: number; markdown: string; slug: string; extractor_version: string }>(
    `SELECT version.skill_id,version.version,version.markdown,version.extractor_version,skill.slug
     FROM workspace_skill_versions version
     JOIN workspace_skills skill ON skill.id=version.skill_id
     WHERE skill.kind='workflow'
     ORDER BY version.skill_id,version.version`,
  );
  let changed = 0;
  for (const row of rows.rows) {
    let contract: WorkflowReadContract;
    try {
      contract = JSON.parse(row.markdown) as WorkflowReadContract;
    } catch {
      continue;
    }
    const seeded = row.slug === FEEDBACK_TRIAGE_SLUG && row.extractor_version === 'feedback-triage-v1'
      ? FEEDBACK_TRIAGE_CONTRACT : undefined;
    const described = describedLegacyWorkflowContract(contract, seeded);
    if (JSON.stringify(described) === JSON.stringify(contract)) continue;
    const markdown = JSON.stringify(described);
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


/**
 * `handoff()` now closes a gate's open choice itself (`closeRunChoices`,
 * `room-choice.ts`) whenever the run leaves that gate or ends, and
 * `postRoomChoice` lazily sweeps a stranded row for the asking agent before
 * its next ask. Both are forward-looking: this is the immediate, one-time
 * counterpart that closes every already-stranded row at deploy time, rather
 * than waiting on that exact agent's next ask in that Room. A choice tied to
 * a run is only legitimately still open while that run is live and
 * currently sitting at a gate state; anything else — the run has ended
 * (cancelled or terminal) or moved on to a non-gate state — means the gate
 * was left without the choice ever closing. Idempotent: a choice closed by
 * any of the three paths never matches `status='open'` again. Run from
 * `migrateData()`.
 */
export async function closeStaleWorkflowGateChoices(database: SqlDatabase): Promise<number> {
  const openGateChoices = await database.query<{ room_id: string; run_id: string }>(
    `SELECT DISTINCT choice.room_id,choicemsg.card->>'runId' run_id
     FROM room_choices choice
     JOIN messages choicemsg ON choicemsg.id=choice.message_id
     WHERE choice.status='open' AND choicemsg.card->>'runId' IS NOT NULL`,
  );
  let closed = 0;
  for (const row of openGateChoices.rows) {
    const run = await loadRun(database, row.room_id, row.run_id);
    if (!run) continue;
    const contract = await loadPinnedContract(database, row.room_id, run.workflowSlug, run.workflowVersion);
    const state = contract?.handoffs[run.toState];
    const stillGated = contract && state?.kind === 'gate' &&
      workflowRunStatus(contract, run.toState, run.cancellation ? 'abandoned' : run.status) === 'live';
    if (stillGated) continue;
    await closeRunChoices(database, row.room_id, row.run_id);
    closed++;
  }
  if (closed)
    console.log(`closeStaleWorkflowGateChoices: closed ${closed} stale run(s)' open choice(s)`);
  return closed;
}
