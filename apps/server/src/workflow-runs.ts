import { humanRoomAdmin, WorkflowAuthorizationError } from './workflow-admin.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  workflowSaveError,
  workflowContentsError,
  workflowReceiptError,
  type WorkflowReceiptInput,
  isAgentIdentityReference,
  WORKFLOW_BLOCKED_OUTCOME,
  WORKFLOW_DEFAULT_DEADLINE_SECONDS,
  WORKFLOW_ROLE_AGENTS_MAX,
  type WorkflowContract,
  type WorkflowGateState,
  type WorkflowHandoffState,
  type WorkflowRoleBinding,
  type WorkflowState,
  type WorkflowRunReadResult,
  type WorkflowReceipt,
} from '@beeline/api-contract/daemon';
import type { SystemSubject } from '@beeline/api-contract/phone';
import { bindWorkflowStepOutput } from './workflow-step-output.js';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { applySkillRevision, assertSkillTextSafe } from './institutional-skills.js';
import type { AfterCommit } from './institutional-memory-embeddings.js';
import { firstHealthyAgent, roomAgentHealth, type AgentHealthReason } from './agent-health.js';
import { answerRoomChoice, closeRunChoices, postRoomChoice, skipRoomChoice } from './room-choice.js';
import {
  ensureSystemDirectMessageRoom,
  ensureSystemIdentity,
  identitySubject,
  systemIdentityMention,
  systemLine,
} from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

/**
 * No run-state tables: a run is identified by its `start_workflow` message id
 * (`runId`), and its current step is the `toState` of the most recent
 * `workflow-handoff` card citing that id — the start message is itself the
 * first such card, so this is a single, uniform derivation with no separate
 * "or start if none exists" branch.
 *
 * A step's attempt is the `seq` of the card that dispatched it. Every writer
 * (agent handoff, `blocked`, step expiry, gate answer, Skip, gate default,
 * deadline, cancel, reassignment) takes the run lock, re-reads the newest
 * card, checks the attempt it acts on, and writes the next card through
 * `enterState`, `moveRole` or `closeRun`. Each of those cancels the run's
 * pending wakes and timers before it writes, so a stale wake or timer can
 * never move a later step.
 */
export const WORKFLOW_HANDOFF_CARD_TYPE = 'workflow-handoff';

/** One agent tried during a state visit, and why it left the step. */
type TriedAgent = { agentId: string; reason: string };

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
  /** Start card only: the person notices go to (see `resolveRunOwner`). */
  ownerId?: string | null;
  cancellation?: { reason: string; actorId: string };
  /** An engine close that is not a person's cancellation, such as a passed deadline. */
  closure?: { reason: string };
  contents?: unknown;
  receipt?: WorkflowReceipt;
  /** A same-state reassignment card (list failover or `assign_workflow_role`): no outcome, same toState as before. */
  reassigned?: true;
  /** The attempt this card replaced. */
  answers?: number;
  /** The agent command whose handoff wrote this card. */
  commandId?: string;
  /** Agents already tried in this state visit; reset whenever the run takes an `on` edge. */
  tried?: TriedAgent[];
  trigger?: { scheduleId: string; period: string };
};

type IdentityRow = { id: string; kind: 'human' | 'agent'; name: string; handle?: string | null };

async function loadIdentityRow(db: SqlDatabase, id: string): Promise<IdentityRow> {
  const row = (
    await db.query<IdentityRow>(`SELECT id,kind,name,handle FROM identities WHERE id=$1`, [id])
  ).rows[0];
  if (!row) throw new Error('identity not found');
  return row;
}

/** How a system line names each id: `@handle`, falling back to the raw id for an unknown one. */
async function mentionsFor(db: SqlDatabase, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = ids.length
    ? (
        await db.query<IdentityRow & { handle: string | null }>(
          `SELECT id,kind,name,handle FROM identities WHERE id=ANY($1::text[])`,
          [[...new Set(ids)]],
        )
      ).rows
    : [];
  const names = new Map(rows.map((row) => [row.id, systemIdentityMention(row) || row.name]));
  return new Map(ids.map((id) => [id, names.get(id) ?? id]));
}

/**
 * The run's starter: the start card's resolved requester, falling back to the
 * start message's own author for runs predating that field (same fallback
 * `cancelWorkflowRun` uses for cancel authority). An agent starter is woken
 * when a role has nobody left to take it.
 */
async function loadRunStarter(db: SqlDatabase, roomId: string, runId: string): Promise<IdentityRow> {
  const start = (
    await db.query<{ author_id: string; requester_id: string | null }>(
      `SELECT author_id,card->>'requesterId' requester_id FROM messages
       WHERE room_id=$1 AND id=$2 AND card_type=$3`,
      [roomId, runId, WORKFLOW_HANDOFF_CARD_TYPE],
    )
  ).rows[0];
  if (!start) throw new Error('workflow start is unavailable');
  return loadIdentityRow(db, start.requester_id ?? start.author_id);
}

type RunHead = { id: string; authorId: string; createdAt: Date; card: WorkflowRunCard };

async function loadRunHead(
  db: SqlDatabase,
  roomId: string,
  runId: string,
): Promise<RunHead | undefined> {
  const row = (
    await db.query<{ id: string; author_id: string; created_at: Date; card: WorkflowRunCard }>(
      `SELECT id,author_id,created_at,card FROM messages
       WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$3
       ORDER BY (card->>'seq')::int DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
      [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId],
    )
  ).rows[0];
  return row ? { id: row.id, authorId: row.author_id, createdAt: row.created_at, card: row.card } : undefined;
}

async function loadRun(
  db: SqlDatabase,
  roomId: string,
  runId: string,
): Promise<WorkflowRunCard | undefined> {
  return (await loadRunHead(db, roomId, runId))?.card;
}

function attemptOf(card: Pick<WorkflowRunCard, 'seq'>): number {
  return card.seq ?? 0;
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

const HEALTH_LABEL: Record<AgentHealthReason, string> = {
  offline: 'offline',
  'recent-failure': 'recent failure',
  'out-of-credit': 'out of credit',
};

/** Every agent on a role list with why it cannot take the step now. */
async function roleReasons(
  db: SqlDatabase,
  input: { roomId: string; list: readonly string[]; tried: readonly TriedAgent[]; cursor?: string },
): Promise<string> {
  const health = await roomAgentHealth(db, input.roomId, input.list);
  const names = await mentionsFor(db, input.list);
  const cursorIndex = input.cursor ? input.list.indexOf(input.cursor) : -1;
  return input.list
    .map((id, index) => {
      const tried = input.tried.find((entry) => entry.agentId === id);
      const status = health.get(id);
      const why = tried
        ? tried.reason
        : !status
          ? 'not in this Room'
          : !status.healthy
            ? HEALTH_LABEL[status.reason!]
            : index < cursorIndex
              ? 'earlier on the list'
              : 'eligible';
      return `${names.get(id)} ${why}`;
    })
    .join(', ');
}

/**
 * A role with nobody eligible is named in the run, with each listed agent's
 * reason, rather than silently stalling. The run stays parked at this state:
 * a human can address any Room member and ask it to call
 * `assign_workflow_role`, which binds a specific agent and re-wakes it with no
 * health filter. For an agent-started run, this also wakes the starter. One
 * line per dispatch card: a repeat for the same card is a no-op.
 */
async function noteWorkflowRoleExhausted(
  db: SqlDatabase,
  input: {
    roomId: string;
    runId: string;
    role: string;
    afterMessageId: string;
    list: readonly string[];
    tried: readonly TriedAgent[];
    cursor?: string;
  },
): Promise<void> {
  const id = createHash('sha256')
    .update(`beeline:workflow-role-exhausted:v1:${input.runId}:${input.role}:${input.afterMessageId}`)
    .digest('hex');
  const starter = await loadRunStarter(db, input.roomId, input.runId);
  const reasons = input.list.length ? await roleReasons(db, input) : '';
  await ensureSystemIdentity(db);
  await systemLine(db, {
    id,
    roomId: input.roomId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: `No agent on the ${input.role} role's list` },
    verb: 'is healthy',
    consequence: `${reasons ? `${reasons} in run ${input.runId}; ` : `in run ${input.runId}; `}ask an agent to call assign_workflow_role to bind another agent in this Room`.slice(0, 600),
    ...(starter.kind === 'agent' ? { kind: 'workflow-handoff' as const, wakes: [starter.id] } : {}),
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

function runEnded(run: WorkflowRunCard, state: WorkflowState | undefined): boolean {
  return Boolean(run.cancellation || run.status || !state || state.kind === 'terminal');
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
  const activeState = !runEnded(run, state) ? state : undefined;
  const role = activeState && 'role' in activeState ? activeState.role : undefined;
  return {
    runId,
    workflowSlug: run.workflowSlug,
    workflowVersion: run.workflowVersion,
    state: run.toState,
    attempt: attemptOf(run),
    status: run.cancellation
      ? 'abandoned'
      : run.status ?? (state?.kind === 'terminal' ? state.status : 'live'),
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

/**
 * The person a run's notices go to: the person who started it. A human start
 * is that person; an agent's start answers the person whose message it
 * served; a scheduled start carries the owner the schedule recorded when it
 * was created (`agent_schedules.owner_id`, or its human creator). Never the
 * hidden scheduler or system identities. `null` when no person is on record,
 * and notices then go to the Room's admins (`runNoticeRecipients`).
 */
async function resolveRunOwner(
  db: SqlDatabase,
  command: Pick<CommandRow, 'agent_id'> & { root_source_message_id?: string },
): Promise<string | null> {
  const starter = await loadIdentityRow(db, command.agent_id);
  if (starter.kind === 'human') return starter.id;
  if (!command.root_source_message_id) return null;
  const root = (
    await db.query<{ author_id: string; person: boolean; scheduled: boolean; owner_id: string | null }>(
      `SELECT message.author_id,
              identity.kind='human' AND NOT COALESCE(identity.hidden_from_roster,false) person,
              message.card ? 'trigger' scheduled,message.card->>'ownerId' owner_id
       FROM messages message JOIN identities identity ON identity.id=message.author_id
       WHERE message.id=$1 AND message.deleted_at IS NULL`,
      [command.root_source_message_id],
    )
  ).rows[0];
  if (!root) return null;
  if (root.scheduled && root.owner_id) return root.owner_id;
  return root.person ? root.author_id : null;
}

/** The run owner while they are still in the Room, otherwise the Room's human admins. */
async function runNoticeRecipients(db: SqlDatabase, roomId: string, ownerId: string | null): Promise<string[]> {
  if (ownerId) {
    const member = await db.query(
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [roomId, ownerId],
    );
    if (member.rowCount) return [ownerId];
  }
  const admins = await db.query<{ id: string }>(
    `SELECT DISTINCT identity.id FROM rooms room
     JOIN memberships member ON member.workspace_id=room.workspace_id
       AND (member.room_id=room.id OR member.room_id IS NULL)
       AND member.removed_at IS NULL AND member.role IN ('owner','admin')
     JOIN identities identity ON identity.id=member.identity_id AND identity.kind='human'
       AND NOT COALESCE(identity.hidden_from_roster,false)
     WHERE room.id=$1 ORDER BY identity.id`,
    [roomId],
  );
  return admins.rows.map((row) => row.id);
}

/** One `@system` DM line to the run's owner (or the Room's admins); a repeat for the same key is a no-op. */
async function noticeRunOwner(
  db: SqlDatabase,
  scope: RunScope,
  key: string,
  line: { subject: SystemSubject; verb: string; object?: string; consequence?: string },
): Promise<void> {
  const owner = (
    await db.query<{ owner_id: string | null }>(
      `SELECT card->>'ownerId' owner_id FROM messages WHERE id=$1 AND room_id=$2`,
      [scope.runId, scope.roomId],
    )
  ).rows[0];
  await ensureSystemIdentity(db);
  for (const recipient of await runNoticeRecipients(db, scope.roomId, owner?.owner_id ?? null)) {
    await systemLine(db, {
      id: createHash('sha256')
        .update(`beeline:workflow-owner-notice:v1:${scope.runId}:${key}:${recipient}`)
        .digest('hex'),
      roomId: await ensureSystemDirectMessageRoom(db, scope.workspaceId, recipient),
      authorId: SYSTEM_IDENTITY_ID,
      ...line,
    });
  }
}

/** The run context every transition writer works from; built under the run lock. */
type RunScope = {
  roomId: string;
  workspaceId: string;
  runId: string;
  head: RunHead;
  run: WorkflowRunCard;
  contract: WorkflowContract;
  stateName: string;
  state: WorkflowState | undefined;
  ended: boolean;
};

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

/** Lock the run, then read its newest card and pinned contract. */
async function openRun(db: SqlDatabase, roomId: string, runId: string): Promise<RunScope> {
  await lockWorkflowRun(db, runId);
  const room = (
    await db.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [roomId])
  ).rows[0];
  if (!room) throw new Error('workflow room not found');
  const head = await loadRunHead(db, roomId, runId);
  if (!head) throw new Error('workflow run is unavailable in this Room');
  const run = head.card;
  const contract = await loadPinnedContract(db, roomId, run.workflowSlug, run.workflowVersion);
  if (!contract) throw new Error('workflow contract version is unavailable');
  const state = contract.handoffs[run.toState];
  return {
    roomId,
    workspaceId: room.workspace_id,
    runId,
    head,
    run,
    contract,
    stateName: run.toState,
    state,
    ended: runEnded(run, state),
  };
}

/** Every pending wake from this run's cards and gate answers; the next card's own wake is created after. */
async function cancelRunWakes(db: SqlDatabase, roomId: string, runId: string): Promise<void> {
  await db.query(
    `UPDATE agent_commands command SET state='cancelled',completed_at=now()
     FROM messages message WHERE command.source_message_id=message.id AND command.room_id=$1
       AND message.card->>'runId'=$2 AND command.state='pending'`,
    [roomId, runId],
  );
}

type WorkflowTimerKind = 'step' | 'deadline';
/**
 * An engine timer is an `agent_schedules` row with `workflow_run` set, owned
 * by the system identity rather than any agent, so it fires whether or not
 * the step's agent is still in the Room and survives a restart.
 * `AgentScheduleLoop` hands due rows to `fireWorkflowTimer`. Rows written
 * before attempts existed carry no `timer` and act as the current step's.
 */
type WorkflowTimer = { runId: string; workflowSlug: string; timer?: WorkflowTimerKind; attempt?: number };

function scheduleUuid(key: string): string {
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function workflowTimerId(runId: string, timer: WorkflowTimerKind): string {
  return scheduleUuid(`beeline:workflow-timer:v2:${runId}:${timer}`);
}

/** The pre-attempt per-state timeout row, still cancelled so a deployed run cannot keep one. */
function legacyTimeoutScheduleId(runId: string, stateName: string): string {
  return scheduleUuid(`beeline:workflow-timeout:v1:${runId}:${stateName}`);
}

async function scheduleRunTimer(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    roomId: string;
    runId: string;
    workflowSlug: string;
    timer: WorkflowTimerKind;
    seconds: number;
    attempt?: number;
  },
): Promise<void> {
  await ensureSystemIdentity(db);
  const fireAt = new Date(Date.now() + input.seconds * 1_000);
  const cadence = {
    kind: 'interval' as const,
    everyMinutes: Math.max(1, Math.ceil(input.seconds / 60)),
    startsAt: Math.floor(fireAt.getTime() / 1_000),
  };
  const timer: WorkflowTimer = {
    runId: input.runId,
    workflowSlug: input.workflowSlug,
    timer: input.timer,
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  };
  await db.query(
    `INSERT INTO agent_schedules
       (id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at,workflow_run)
     VALUES($1,$2,$3,$4,$4,$5::jsonb,$6,1,$7,$8::jsonb)
     ON CONFLICT(id) DO UPDATE
       SET cadence=EXCLUDED.cadence,message=EXCLUDED.message,next_run_at=EXCLUDED.next_run_at,
           workflow_run=EXCLUDED.workflow_run,run_count=0,updated_at=now()`,
    [
      workflowTimerId(input.runId, input.timer),
      input.workspaceId,
      input.roomId,
      SYSTEM_IDENTITY_ID,
      JSON.stringify(cadence),
      input.timer === 'deadline'
        ? `workflow run ${input.runId} deadline`
        : `workflow run ${input.runId} step timeout for attempt ${input.attempt}`,
      fireAt,
      JSON.stringify(timer),
    ],
  );
}

async function cancelStepTimer(db: SqlDatabase, runId: string, stateName: string): Promise<void> {
  await db.query(`DELETE FROM agent_schedules WHERE id=ANY($1::uuid[])`, [
    [workflowTimerId(runId, 'step'), legacyTimeoutScheduleId(runId, stateName)],
  ]);
}

async function cancelRunTimers(db: SqlDatabase, runId: string, stateName: string): Promise<void> {
  await db.query(`DELETE FROM agent_schedules WHERE id=ANY($1::uuid[])`, [
    [
      workflowTimerId(runId, 'step'),
      workflowTimerId(runId, 'deadline'),
      legacyTimeoutScheduleId(runId, stateName),
    ],
  ]);
}

function isHandoffState(state: WorkflowState | undefined): state is WorkflowHandoffState {
  return Boolean(state) && state!.kind === undefined;
}

/** The gate card's question; the run page finds a gate's card by it. */
export function workflowGatePrompt(contract: Pick<WorkflowContract, 'name'>, stateName: string): string {
  return `${contract.name}: ${stateName}`.slice(0, 120);
}

function durationText(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/**
 * Posts the gate's ask_choice card, for every run however it was started,
 * asked by the gate role's agent and carrying the run id and attempt. A
 * person's answer or Skip settles it through `settleWorkflowGate`; nothing
 * wakes the role's agent at a gate. A declared `timeoutSeconds` arms the
 * step timer that applies `default`.
 */
async function postWorkflowGate(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    roomId: string;
    runId: string;
    attempt: number;
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
    ...(input.state.default && input.state.timeoutSeconds
      ? { constraint: `No answer in ${durationText(input.state.timeoutSeconds)} applies ${input.state.default}` }
      : {}),
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
async function dispatchState(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    roomId: string;
    runId: string;
    contract: WorkflowContract;
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
  if (isHandoffState(state) && state.timeoutSeconds) {
    await scheduleRunTimer(db, {
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      runId: input.runId,
      workflowSlug: input.contract.name,
      timer: 'step',
      seconds: state.timeoutSeconds,
      attempt: input.attempt,
    });
  }
}

type CardLine = {
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
async function enterState(
  db: SqlDatabase,
  scope: RunScope,
  input: {
    outcome: string;
    contents: unknown;
    receiptInput?: WorkflowReceiptInput;
    actorId: string;
    commandId?: string;
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
  if (isTerminal) await cancelRunTimers(db, runId, stateName);
  else await cancelStepTimer(db, runId, stateName);
  // Leaving a gate or ending the run must not strand an open gate choice: it
  // would refuse every later gate this agent asks in this Room.
  if (state.kind === 'gate' || isTerminal) await closeRunChoices(db, roomId, runId);
  const roleBindings = { ...run.roleBindings };
  const roleAgents = await loadRunRoleAgents(db, roomId, runId);
  const nextRole = isTerminal ? undefined : (nextState as WorkflowHandoffState | WorkflowGateState).role;
  const nextResolution = nextRole
    ? await resolveRoleBinding(db, { roomId, roleBindings, roleAgents, role: nextRole })
    : undefined;
  const exhausted = Boolean(nextResolution && 'exhausted' in nextResolution);
  const nextAgentId = nextResolution && !exhausted ? (nextResolution as { agentId: string }).agentId : null;
  const attempt = attemptOf(run) + 1;
  const cardId = randomBytes(32).toString('hex');
  const status = isTerminal ? (nextState as { status: 'done' | 'failed' }).status : undefined;
  await systemLine(db, {
    id: cardId,
    roomId,
    ...input.line(toState),
    kind: 'workflow-handoff',
    ...(!isTerminal && !isGate && nextAgentId ? { wakes: [nextAgentId] } : {}),
    presentation: 'card',
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
      receipt: { ...input.receiptInput, exit: { gate: input.outcome, actorId: input.actorId } },
      answers: attemptOf(run),
      ...(input.commandId ? { commandId: input.commandId } : {}),
      ...(nextState.hint ? { receiptHint: nextState.hint } : {}),
      ...(status ? { status } : {}),
    },
  });
  await db.query(
    `UPDATE messages SET card=card || jsonb_build_object('active',$3::boolean,'currentAgentId',$4::text)
     WHERE id=$1 AND room_id=$2 AND card_type='workflow-handoff'`,
    [runId, roomId, !isTerminal, nextAgentId],
  );
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
async function moveRole(
  db: SqlDatabase,
  scope: RunScope,
  input: { role: string; picked: string; tried: TriedAgent[]; why: string; line?: Partial<CardLine> },
): Promise<{ state: string; attempt: number }> {
  const { run, roomId, runId, stateName } = scope;
  const state = scope.state as WorkflowHandoffState | WorkflowGateState;
  const roleBindings = { ...run.roleBindings, [input.role]: input.picked };
  const from = run.roleBindings[input.role];
  const names = await mentionsFor(db, [input.picked, ...(from ? [from] : [])]);
  await cancelRunWakes(db, roomId, runId);
  await cancelStepTimer(db, runId, stateName);
  if (state.kind === 'gate') await closeRunChoices(db, roomId, runId);
  const attempt = attemptOf(run) + 1;
  const cardId = randomBytes(32).toString('hex');
  await ensureSystemIdentity(db);
  await systemLine(db, {
    id: cardId,
    roomId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: 'the workflow' },
    verb: 'moved',
    object: stateName,
    consequence:
      `${from ? `from ${names.get(from)} ` : ''}to ${names.get(input.picked)} because ${input.why} in run ${runId} of ${run.workflowSlug}`.slice(0, 600),
    ...input.line,
    kind: 'workflow-handoff',
    ...(state.kind === 'gate' ? {} : { wakes: [input.picked] }),
    presentation: 'card',
    cardType: WORKFLOW_HANDOFF_CARD_TYPE,
    card: {
      runId,
      seq: attempt,
      workflowSlug: run.workflowSlug,
      workflowVersion: run.workflowVersion,
      roleBindings,
      toState: stateName,
      reassigned: true,
      answers: attemptOf(run),
      ...(input.tried.length ? { tried: input.tried } : {}),
      ...(state.hint ? { receiptHint: state.hint } : {}),
    },
  });
  await db.query(
    `UPDATE messages SET card=card || jsonb_build_object('currentAgentId',$3::text)
     WHERE id=$1 AND room_id=$2 AND card_type='workflow-handoff'`,
    [runId, roomId, input.picked],
  );
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
async function closeRun(
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
  await cancelRunTimers(db, runId, stateName);
  await closeRunChoices(db, roomId, runId);
  await ensureSystemIdentity(db);
  await systemLine(db, {
    roomId,
    ...input.line,
    afterMessageId: runId,
    // No event kind: a closed run is a durable record that wakes nobody.
    presentation: 'card',
    cardType: WORKFLOW_HANDOFF_CARD_TYPE,
    card: {
      runId,
      seq: attemptOf(run) + 1,
      workflowSlug: run.workflowSlug,
      workflowVersion: run.workflowVersion,
      roleBindings: run.roleBindings,
      fromState: stateName,
      toState: stateName,
      outcome: input.outcome,
      status: input.status,
      answers: attemptOf(run),
      ...(input.cancellation ? { cancellation: input.cancellation } : { closure: { reason: input.reason } }),
      contents: { reason: input.reason },
    },
  });
  await db.query(
    `UPDATE messages SET card=card || '{"active":false,"currentAgentId":null}'::jsonb
     WHERE id=$1 AND room_id=$2`,
    [runId, roomId],
  );
}

/** The agents a step's role may walk: its ordered list, or its one bound agent. */
async function roleList(db: SqlDatabase, scope: RunScope, role: string): Promise<string[]> {
  const agents = (await loadRunRoleAgents(db, scope.roomId, scope.runId))[role];
  if (agents?.length) return agents;
  const bound = scope.run.roleBindings[role];
  return bound ? [bound] : [];
}

/**
 * Move a handoff step past `leaving` to the next eligible agent on its role
 * list: forward only, each agent once per state visit, skipping anyone
 * unhealthy or no longer in the Room. With nobody left, `timeout` applies the
 * step's `timeout` outcome as the system (when it declares one); otherwise,
 * and always for `wait`, the run posts each agent's reason and waits.
 */
async function failOver(
  db: SqlDatabase,
  scope: RunScope,
  input: { leaving?: string; why: string; whenExhausted: 'timeout' | 'wait' },
): Promise<{ state: string; attempt: number; status?: 'done' | 'failed' }> {
  const state = scope.state as WorkflowHandoffState;
  const role = state.role;
  const tried = [
    ...(scope.run.tried ?? []).filter((entry) => entry.agentId !== input.leaving),
    ...(input.leaving ? [{ agentId: input.leaving, reason: input.why }] : []),
  ];
  const list = await roleList(db, scope, role);
  const cursor = input.leaving ?? scope.run.roleBindings[role];
  const start = cursor && list.includes(cursor) ? list.indexOf(cursor) + 1 : 0;
  const picked = await firstHealthyAgent(
    db,
    scope.roomId,
    list.slice(start),
    tried.map((entry) => entry.agentId),
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
        subject: { kind: 'system', name: 'the workflow' },
        verb: 'applied',
        object: 'timeout',
        consequence:
          `at ${scope.stateName} and went to ${toState} because nobody on the ${role} role is left${reasons ? ` (${reasons})` : ''} in run ${scope.runId} of ${scope.run.workflowSlug}`.slice(0, 600),
      }),
    });
  }
  await noteWorkflowRoleExhausted(db, {
    roomId: scope.roomId,
    runId: scope.runId,
    role,
    afterMessageId: scope.head.id,
    list,
    tried,
    ...(cursor ? { cursor } : {}),
  });
  return { state: scope.stateName, attempt: attemptOf(scope.run) };
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
    const { run } = scope;
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
        verb: 'cancelled workflow',
        object: run.workflowSlug,
        consequence: `run ${input.runId}`,
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
async function provenanceAttempt(
  db: SqlDatabase,
  roomId: string,
  runId: string,
  sourceMessageId: string | undefined,
): Promise<number | undefined> {
  if (!sourceMessageId) return undefined;
  const source = (
    await db.query<{ card_type: string | null; card: WorkflowRunCard | null; created_at: Date }>(
      `SELECT card_type,card,created_at FROM messages WHERE id=$1 AND room_id=$2`,
      [sourceMessageId, roomId],
    )
  ).rows[0];
  if (!source?.card || source.card.runId !== runId) return undefined;
  if (source.card_type === WORKFLOW_HANDOFF_CARD_TYPE) return attemptOf(source.card);
  const prior = (
    await db.query<{ seq: string | null }>(
      `SELECT card->>'seq' seq FROM messages
       WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$3 AND created_at<=$4
       ORDER BY (card->>'seq')::int DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
      [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId, source.created_at],
    )
  ).rows[0];
  return prior ? Number(prior.seq ?? 0) : undefined;
}

/** The newest card of this run a command's own handoff wrote, if any. */
async function cardByCommand(
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

type HandoffResult =
  | { runId: string; state: string; attempt: number; status?: 'done' | 'failed' }
  | {
      alreadyAdvanced: true;
      runId: string;
      state: string;
      seq: number;
      status?: 'done' | 'failed' | 'abandoned';
    };

function alreadyAdvanced(scope: RunScope): HandoffResult {
  const status = scope.run.cancellation
    ? 'abandoned'
    : scope.run.status ?? (scope.state?.kind === 'terminal' ? scope.state.status : undefined);
  return {
    alreadyAdvanced: true,
    runId: scope.runId,
    state: scope.stateName,
    seq: attemptOf(scope.run),
    ...(status ? { status } : {}),
  };
}

/** The head card's own result, for an identical repeat of the handoff that wrote it. */
function repeatedResult(scope: RunScope): HandoffResult {
  return {
    runId: scope.runId,
    state: scope.stateName,
    attempt: attemptOf(scope.run),
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
    // First statement, before any read: serializes this run's whole
    // read-validate-write critical section against every other writer.
    const scope = await openRun(db, command.room_id, input.runId);
    const { run, stateName } = scope;
    const current = attemptOf(run);
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
      throw new Error(
        `${stateName} is a gate; a person answers it on its card in the Room, and it cannot be handed off`,
      );
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
      if (errors.length) throw new Error(errors.join('; '));
      await bindWorkflowStepOutput(db, command, input.runId);
      const why = `${(reason as string).replace(/\s+/g, ' ').trim().slice(0, 200)}`;
      const result = await failOver(db, scope, {
        leaving: command.agent_id,
        why: `blocked (${why})`,
        whenExhausted: 'timeout',
      });
      return { runId: input.runId, ...result };
    }
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
      const blocked = isHandoffState(state) && !Object.hasOwn(on, WORKFLOW_BLOCKED_OUTCOME)
        ? ', or blocked with contents.reason' : '';
      throw new Error(`${errors.join('; ')}; outcome must be one of: ${outcomes}${blocked}`);
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
        verb: 'handed off',
        object: toState,
        consequence: `run ${input.runId} of ${run.workflowSlug}`,
      }),
    });
    return { runId: input.runId, ...result };
  });
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
  input: { choiceId: string; viewerId: string; optionId?: string; note?: unknown; skip?: boolean },
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
    (gate.attempt !== null && Number(gate.attempt) !== attemptOf(scope.run))
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
  const attempt = attemptOf(scope.run);
  await enterState(db, scope, {
    outcome: label,
    contents: input.skip
      ? { decision: label, defaultedBy: input.viewerId }
      : { decision: label, ...(note ? { note } : {}), answeredBy: input.viewerId },
    actorId: input.viewerId,
    line: (toState) => ({
      authorId: input.viewerId,
      subject: identitySubject(viewer),
      verb: input.skip ? 'skipped' : 'picked',
      object: input.skip ? scope.stateName : label,
      consequence: input.skip
        ? `so ${label} applied and run ${scope.runId} went to ${toState}`
        : `at ${scope.stateName} so run ${scope.runId} went to ${toState}`,
    }),
  });
  if (input.skip) {
    await noticeRunOwner(db, scope, `gate-default:${attempt}`, {
      subject: { kind: 'system', name: `The ${scope.stateName} gate of ${scope.run.workflowSlug}` },
      verb: 'took its default',
      object: label,
      consequence: `${systemIdentityMention({ ...viewer, handle: viewer.handle ?? null }) || viewer.name} skipped it in run ${scope.runId}`,
    });
  }
  return { choiceId: settled.choiceId, status: input.skip ? 'skipped' : 'answered', roomId: settled.roomId };
}

/** A gate whose timeout passed takes its default as the system, and the run owner gets one notice. */
async function expireGate(db: SqlDatabase, scope: RunScope, state: WorkflowGateState): Promise<void> {
  const label = state.default!;
  const attempt = attemptOf(scope.run);
  const after = durationText(state.timeoutSeconds!);
  await enterState(db, scope, {
    outcome: label,
    contents: { decision: label, defaultedBy: 'system' },
    actorId: SYSTEM_IDENTITY_ID,
    line: (toState) => ({
      authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: 'the workflow' },
      verb: 'applied',
      object: label,
      consequence: `at ${scope.stateName} and went to ${toState} because nobody answered in ${after} in run ${scope.runId} of ${scope.run.workflowSlug}`,
    }),
  });
  await noticeRunOwner(db, scope, `gate-default:${attempt}`, {
    subject: { kind: 'system', name: `The ${scope.stateName} gate of ${scope.run.workflowSlug}` },
    verb: 'took its default',
    object: label,
    consequence: `nobody answered in ${after} in run ${scope.runId}`,
  });
}

/**
 * One due engine timer, under the run lock. A step timer for an older
 * attempt is stale and does nothing. A handoff step moves to its next
 * eligible agent (`lease expired`), and once the list is used up the engine
 * applies `timeout`; a gate applies its default; a deadline closes the run as
 * failed. Returns whether the run changed.
 */
export async function fireWorkflowTimer(
  database: SqlDatabase,
  row: { id: string; room_id: string; workflow_run: WorkflowTimer },
): Promise<boolean> {
  const timer = row.workflow_run;
  if (!timer?.runId) {
    await database.query(`DELETE FROM agent_schedules WHERE id=$1`, [row.id]);
    return false;
  }
  return database.transaction(async (db) => {
    await lockWorkflowRun(db, timer.runId);
    const claimed = await db.query(`DELETE FROM agent_schedules WHERE id=$1 RETURNING id`, [row.id]);
    if (!claimed.rowCount) return false;
    const scope = await openRun(db, row.room_id, timer.runId).catch(() => undefined);
    if (!scope || scope.ended || !scope.state) return false;
    if (timer.timer === 'deadline') {
      const start = (
        await db.query<{ deadline_seconds: number | null }>(
          `SELECT (card->>'deadlineSeconds')::int deadline_seconds FROM messages WHERE id=$1`,
          [scope.runId],
        )
      ).rows[0];
      const after = start?.deadline_seconds ? ` of ${durationText(start.deadline_seconds)}` : '';
      await closeRun(db, scope, {
        status: 'failed',
        outcome: 'deadline',
        reason: 'deadline',
        line: {
          authorId: SYSTEM_IDENTITY_ID,
          subject: { kind: 'system', name: 'the workflow' },
          verb: 'closed',
          object: `run ${scope.runId} of ${scope.run.workflowSlug}`,
          consequence: `as failed at ${scope.stateName} because it passed its deadline${after}`,
        },
      });
      return true;
    }
    if (timer.attempt !== undefined && timer.attempt !== attemptOf(scope.run)) return false;
    if (scope.state.kind === 'gate') {
      if (!scope.state.default) return false;
      await expireGate(db, scope, scope.state);
      return true;
    }
    if (!isHandoffState(scope.state)) return false;
    await failOver(db, scope, {
      leaving: scope.run.roleBindings[scope.state.role],
      why: 'its lease expired',
      whenExhausted: 'timeout',
    });
    return true;
  });
}

/**
 * A turn that answered the step's current attempt ended and the run did not
 * move: the agent did not hand off, so the step moves on as `blocked` with
 * reason no handoff. A turn woken by anything else, or by an older attempt,
 * is unrelated and changes nothing. Called from the turn's terminal
 * `complete` receipt, in its transaction.
 */
export async function failOverUnansweredTurn(
  db: SqlDatabase,
  input: { roomId: string; agentId: string; sourceMessageId: string },
): Promise<void> {
  const source = (
    await db.query<{ run_id: string }>(
      `SELECT card->>'runId' run_id FROM messages WHERE id=$1 AND room_id=$2 AND card->>'runId' IS NOT NULL`,
      [input.sourceMessageId, input.roomId],
    )
  ).rows[0];
  if (!source) return;
  const run = await db.query(
    `SELECT 1 FROM messages WHERE id=$1 AND room_id=$2 AND card_type=$3`,
    [source.run_id, input.roomId, WORKFLOW_HANDOFF_CARD_TYPE],
  );
  if (!run.rowCount) return;
  const scope = await openRun(db, input.roomId, source.run_id);
  if (scope.ended || !isHandoffState(scope.state)) return;
  if (scope.run.roleBindings[scope.state.role] !== input.agentId) return;
  const attempt = await provenanceAttempt(db, input.roomId, scope.runId, input.sourceMessageId);
  if (attempt !== attemptOf(scope.run)) return;
  await failOver(db, scope, {
    leaving: input.agentId,
    why: 'its turn ended with no handoff',
    whenExhausted: 'timeout',
  });
}

/** The live run of `workflowName` in this Room, if one exists. */
export async function liveWorkflowRun(
  db: SqlDatabase,
  roomId: string,
  workflowName: string,
): Promise<{ runId: string; state: string } | undefined> {
  const active = (
    await db.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE room_id=$1 AND card_type='workflow-handoff' AND card->>'active'='true'
         AND card->>'workflowSlug'=$2
       ORDER BY created_at,id LIMIT 1`,
      [roomId, workflowName],
    )
  ).rows[0];
  if (!active) return undefined;
  const run = await loadRun(db, roomId, active.id);
  return { runId: active.id, state: run?.toState ?? 'unknown' };
}

/** Serializes starts of one workflow in one Room, so the live-run check and the start card commit together. */
function workflowStartLockKey(roomId: string, workflowName: string): string {
  return `workflow-start:${roomId}:${workflowName}`;
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
    const contract = JSON.parse(skill.markdown) as WorkflowContract;
    const trigger = command.source_message_id
      ? await scheduleTriggerPeriod(db, command.source_message_id)
      : undefined;
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
    const deadlineSeconds = contract.deadlineSeconds ?? WORKFLOW_DEFAULT_DEADLINE_SECONDS;
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
        ownerId: await resolveRunOwner(db, command),
        deadlineSeconds,
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
    await scheduleRunTimer(db, {
      workspaceId: room.workspace_id,
      roomId: command.room_id,
      runId,
      workflowSlug: contract.name,
      timer: 'deadline',
      seconds: deadlineSeconds,
    });
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

/**
 * The one hook a failed/silent turn goes through to fail a workflow step over
 * to the next eligible agent on its role list. Called unconditionally from
 * `turn-silence-notice.ts`'s `noteFirstSilence`, BEFORE its own human-trigger
 * requirement — a workflow dispatch's triggering message is normally
 * agent-authored, so gating this on "a human is further up the chain" would
 * silently never fire for the ordinary case. Keyed on the attempt: the turn
 * fails over only when the wake it answered (a dispatch card, or any other
 * wake citing the run) belongs to the step's current attempt and its agent
 * still holds it. With nobody left the run names each agent's reason and
 * waits; the step timer, if any, then applies `timeout`. A no-op for a stale
 * wake or a turn that was never a workflow dispatch; it must never throw into
 * the ordinary silence-notice path.
 */
export async function reassignFailedWorkflowRole(
  db: SqlDatabase,
  input: { roomId: string; requestId: string; agentId: string; reason?: string | null },
): Promise<void> {
  const trigger = (
    await db.query<{ run_id: string }>(
      `SELECT card->>'runId' run_id FROM messages WHERE id=$1 AND room_id=$2 AND card->>'runId' IS NOT NULL`,
      [input.requestId, input.roomId],
    )
  ).rows[0];
  if (!trigger) return; // not a workflow wake
  const room = await db.query(
    `SELECT 1 FROM messages WHERE id=$1 AND room_id=$2 AND card_type=$3`,
    [trigger.run_id, input.roomId, WORKFLOW_HANDOFF_CARD_TYPE],
  );
  if (!room.rowCount) return;
  const scope = await openRun(db, input.roomId, trigger.run_id).catch(() => undefined);
  if (!scope || scope.ended || !isHandoffState(scope.state)) return;
  const attempt = await provenanceAttempt(db, input.roomId, scope.runId, input.requestId);
  if (attempt !== attemptOf(scope.run)) return;
  if (scope.run.roleBindings[scope.state.role] !== input.agentId) return;
  const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  await failOver(db, scope, {
    leaving: input.agentId,
    why: reason ? `its turn failed (${reason})` : 'its turn failed',
    whenExhausted: 'wait',
  });
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
 * An explicit override: bind a specific agent to the role this run is
 * currently on, list-bound or not — the "ask a human" recovery path when
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
  if (typeof input.runId !== 'string' || !input.runId) throw new Error('runId is required');
  if (typeof input.role !== 'string' || !input.role) throw new Error('role is required');
  if (typeof input.targetAgentId !== 'string' || !input.targetAgentId) {
    throw new Error('targetAgentId is required');
  }
  return database.transaction(async (db) => {
    const scope = await openRun(db, command.room_id, input.runId);
    const targetAgentId = isAgentIdentityReference(input.targetAgentId)
      ? input.targetAgentId
      : await memberIdForHandle(db, command.room_id, input.targetAgentId);
    const { run, state } = scope;
    if (scope.ended || !state) throw new Error('this workflow run has already ended');
    const currentRole = (state as WorkflowHandoffState | WorkflowGateState).role;
    if (currentRole !== input.role) {
      throw new Error(`this run is currently at the ${currentRole} role, not ${input.role}`);
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
    const stillGated = !run.cancellation && !run.status && state?.kind === 'gate';
    if (stillGated) continue;
    await closeRunChoices(database, row.room_id, row.run_id);
    closed++;
  }
  if (closed)
    console.log(`closeStaleWorkflowGateChoices: closed ${closed} stale run(s)' open choice(s)`);
  return closed;
}
