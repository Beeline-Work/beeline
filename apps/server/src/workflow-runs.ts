import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { WELCOME_VIDEO_SLUG } from './welcome-video-workflow.js';
import { CommandRefusalError, ExpectedRefusalError } from './command-refusal.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { createHash } from 'node:crypto';
import { shortRunId, type WorkflowReadContract, type WorkflowReadState, type WorkflowRunReadResult, type WorkflowReceipt } from '@beeline/api-contract/daemon';
import { workflowRunStatus } from '@beeline/api-contract/phone';
import type { SystemSubject, WorkflowRunStatus } from '@beeline/api-contract/phone';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { firstHealthyAgent, roomAgentHealth, type AgentHealthReason } from './agent-health.js';
import { ensureSystemDirectMessageRoom, ensureSystemIdentity, systemIdentityMention, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { welcomeVideoRoleHolders, workflowGatePrompt, cancelWorkflowRun } from './workflow-runs-cancel-run-timers.js';
import { handoff, settleWorkflowGate, abandonCornerWorkflowRuns, liveWorkflowRun, saveWorkflow, activeRunIdsForSchedule } from './workflow-runs-repeated-result.js';
import { startWorkflow, assignWorkflowRole, archiveWorkflow, describedLegacyWorkflowContract, backfillWorkflowSkillDescriptions, closeStaleWorkflowGateChoices } from './workflow-runs-start-workflow.js';



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
export type TriedAgent = { agentId: string; reason: string };


export type WorkflowRunCard = {
  runId: string;
  seq: number;
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
  /** Start card only: the run's status, saved by `saveRunStatus` whenever it changes. */
  runStatus?: WorkflowRunStatus;
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


export type IdentityRow = { id: string; kind: 'human' | 'agent'; name: string; handle?: string | null };


export async function loadIdentityRow(db: SqlDatabase, id: string): Promise<IdentityRow> {
  const row = (
    await db.query<IdentityRow>(`SELECT id,kind,name,handle FROM identities WHERE id=$1`, [id])
  ).rows[0];
  if (!row) throw new Error('identity not found');
  return row;
}


/** How a system line names each id: `@handle`, falling back to the raw id for an unknown one. */
export async function mentionsFor(db: SqlDatabase, ids: readonly string[]): Promise<Map<string, string>> {
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
export async function loadRunStarter(db: SqlDatabase, roomId: string, runId: string): Promise<IdentityRow> {
  const start = await loadRunStart(db, roomId, runId);
  return loadIdentityRow(db, start.card.requesterId ?? start.authorId);
}


export type RunHead = { id: string; authorId: string; createdAt: Date; card: WorkflowRunCard };


export async function loadRunStart(db: SqlDatabase, roomId: string, runId: string): Promise<RunHead> {
  const row = (await db.query<{ id: string; author_id: string; created_at: Date; card: WorkflowRunCard }>(
    `SELECT id,author_id,created_at,card FROM messages WHERE room_id=$1 AND id=$2 AND card_type=$3`,
    [roomId, runId, WORKFLOW_HANDOFF_CARD_TYPE],
  )).rows[0];
  if (!row) throw new Error('workflow start is unavailable');
  return { id: row.id, authorId: row.author_id, createdAt: row.created_at, card: row.card };
}


export async function loadRunHead(
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


export async function loadRun(
  db: SqlDatabase,
  roomId: string,
  runId: string,
): Promise<WorkflowRunCard | undefined> {
  return (await loadRunHead(db, roomId, runId))?.card;
}


/** The start card's immutable list-bound-role map; `{}` for a run with no list-bound role. */
export async function loadRunRoleAgents(
  db: SqlDatabase,
  roomId: string,
  runId: string,
): Promise<Record<string, string[]>> {
  return (await loadRunStart(db, roomId, runId)).card.roleAgents ?? {};
}


export async function pickWorkflowAgent(db: SqlDatabase, roomId: string, list: string[], exclude: string[], slug?: string): Promise<string | null> {
  if (slug !== WELCOME_VIDEO_SLUG) return firstHealthyAgent(db, roomId, list, exclude);
  const health = await roomAgentHealth(db, roomId, list);
  const free = (await db.query<{ agent_id: string }>(
    `SELECT agent_id FROM free_agents WHERE agent_id=ANY($1::text[]) AND removed_at IS NULL`, [list])).rows;
  const hosted = new Set(free.map(row => row.agent_id));
  // A hosted starter can be asleep before its first job; dispatch wakes its machine.
  return list.find(id => !exclude.includes(id) && (health.get(id)?.healthy ||
    (health.get(id)?.reason === 'offline' && hosted.has(id)))) ?? null;
}


/**
 * Resolve `role`'s binding to a concrete agent id, picking the first healthy
 * agent on its list only the FIRST time a list-bound role is dispatched —
 * once resolved, `roleBindings[role]` holds that agent and is reused as-is
 * for the rest of the run (sticky), matching "keep the agent that took a role
 * unless it fails." Mutates `roleBindings` in place on success.
 */
export async function resolveRoleBinding(
  db: SqlDatabase,
  input: {
    roomId: string;
    roleBindings: Record<string, string>;
    roleAgents: Record<string, string[]>;
    role: string;
    workflowSlug?: string;
    runId?: string;
  },
): Promise<{ agentId: string } | { exhausted: true }> {
  const otherRole = input.role === 'checker' ? 'maker' : input.role === 'maker' ? 'checker' : undefined;
  const excluded = input.workflowSlug === WELCOME_VIDEO_SLUG && otherRole
    ? await welcomeVideoRoleHolders(db, input.roomId, input.runId, otherRole, input.roleBindings[otherRole]) : [];
  const current = input.roleBindings[input.role];
  if (current && excluded.includes(current)) delete input.roleBindings[input.role];
  if (current && !excluded.includes(current)) return { agentId: current };
  const picked = await pickWorkflowAgent(db, input.roomId, input.roleAgents[input.role] ?? [], excluded, input.workflowSlug);
  if (!picked) return { exhausted: true };
  input.roleBindings[input.role] = picked;
  return { agentId: picked };
}


export const HEALTH_LABEL: Record<AgentHealthReason, string> = {
  offline: systemMessage("workflow-runs.offline"),
};


/** Every agent on a role list with why it cannot take the step now. */
export async function roleReasons(
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
          ? systemMessage("workflow-runs.not-in-this-room")
          : !status.healthy
            ? HEALTH_LABEL[status.reason!]
            : index < cursorIndex
              ? systemMessage("workflow-runs.earlier-on-the-list")
              : systemMessage("workflow-runs.eligible");
      return systemMessage("workflow-runs.agent-health", names.get(id), why);
    })
    .join(systemMessage("workflow-runs.list-separator"));
}


/**
 * A role with nobody eligible is named in the run, with each listed agent's
 * reason, rather than silently stalling. The run stays parked at this state:
 * a human can address any Room member and ask it to call
 * `assign_workflow_role`, which binds a specific agent and re-wakes it with no
 * health filter. For an agent-started run, this also wakes the starter. One
 * line per dispatch card: a repeat for the same card is a no-op.
 */
export async function noteWorkflowRoleExhausted(
  db: SqlDatabase,
  input: {
    roomId: string;
    runId: string;
    workflowSlug: string;
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
    subject: { kind: 'system', name: systemMessage("workflow-runs.no-agent-on-the-role-s-list", input.role) },
    verb: systemMessage("workflow-runs.is-healthy"),
    consequence: systemMessage("workflow-runs.ask-an-agent-to-call-assign-workflow-role-to-bind-another-agent-i", reasons ? systemMessage("workflow-runs.in-run", reasons, shortRunId(input.runId)) : systemMessage("workflow-runs.in-run-2", shortRunId(input.runId))).slice(0, 600),
    ...(starter.kind === 'agent'
      ? {
          kind: 'workflow-handoff' as const,
          wakes: [starter.id],
          // The wake names the full run id for the starter to act on.
          card: { runId: input.runId, workflowSlug: input.workflowSlug },
        }
      : {}),
    afterMessageId: input.afterMessageId,
  });
}


/** The exact pinned version, independent of the slug's current/archived state. */
export async function loadPinnedContract(
  db: SqlDatabase,
  roomId: string,
  slug: string,
  version: number,
): Promise<WorkflowReadContract | undefined> {
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
  return JSON.parse(row.markdown) as WorkflowReadContract;
}


/** The one writer of a run's status: decided by `workflowRunStatus` when the run moves and saved on its start card. */
export async function saveRunStatus(
  db: SqlDatabase,
  scope: { roomId: string; runId: string; contract: WorkflowReadContract },
  state: string,
  recorded?: WorkflowRunStatus,
): Promise<void> {
  await db.query(
    `UPDATE messages SET card=card || jsonb_build_object('runStatus',$3::text)
     WHERE id=$1 AND room_id=$2 AND card_type='workflow-handoff'`,
    [scope.runId, scope.roomId, workflowRunStatus(scope.contract, state, recorded)],
  );
}


// The daemon authorizes this Room before lookup; never search outside it.
export async function resolveWorkflowRunId(db: SqlDatabase, roomId: string, runId: string): Promise<string> {
  if (typeof runId !== 'string' || !runId) throw new CommandRefusalError('runId is required', 400);
  // Run IDs are 32 random bytes encoded as hex. Keep full-ID callers on the
  // existing path, including taking the write lock before reading run state.
  if (runId.length === 64) return runId;
  if (runId.length < 8) throw new CommandRefusalError('workflow run ID prefixes must contain at least 8 characters', 400);
  const matches = (await db.query<{ run_id: string }>(
    `SELECT DISTINCT card->>'runId' AS run_id FROM messages
     WHERE room_id=$1 AND card_type=$2
       AND left(card->>'runId',length($3::text))=$3
     ORDER BY run_id`,
    [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId],
  )).rows;
  if (!matches.length) throw new CommandRefusalError('workflow run is unavailable in this Room', 404);
  if (matches.length > 1) throw new CommandRefusalError(`workflow run ID prefix is ambiguous: ${matches.map(row => row.run_id).join(', ')}`, 400);
  return matches[0]!.run_id;
}


export async function getWorkflowRun(
  db: SqlDatabase,
  roomId: string,
  runId: string,
): Promise<WorkflowRunReadResult> {
  runId = await resolveWorkflowRunId(db, roomId, runId);
  const rows = (await db.query<{ id: string; author_id: string; created_at: Date; card: WorkflowRunCard }>(
    `SELECT id,author_id,created_at,card FROM messages
     WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$3
     ORDER BY (card->>'seq')::int ASC NULLS FIRST,created_at,id`,
    [roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId],
  )).rows;
  const run = rows.at(-1)?.card;
  if (!run) throw new ExpectedRefusalError('workflow run is unavailable in this Room');
  const contract = await loadPinnedContract(db, roomId, run.workflowSlug, run.workflowVersion);
  if (!contract) throw new Error('workflow contract version is unavailable');
  const state = contract.handoffs[run.toState];
  const status = rows.find((row) => row.id === runId)?.card.runStatus;
  if (!status) throw new Error('workflow run is unavailable in this Room');
  const activeState = status === 'live' ? state : undefined;
  const role = activeState && 'role' in activeState ? activeState.role : undefined;
  return {
    runId,
    workflowSlug: run.workflowSlug,
    workflowVersion: run.workflowVersion,
    state: run.toState,
    attempt: run.seq,
    status,
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
export async function workflowRequester(
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
 * The identity a workflow turn answers to, for resource authority such as
 * connected apps. The latest person who answered a gate wins, read from the
 * server-written receipt actor rather than agent-supplied contents, so an
 * agent handoff cannot name a person; otherwise the person the run started
 * from. A run with no person on record — started by an agent or a schedule,
 * with no person's gate answer — resolves to an agent (the run's own starter
 * when that is an agent, else the agent being woken), so app use stays
 * refused there.
 *
 * `undefined` when the command is not a wake from a saved run, so a normal
 * turn keeps its own root requester. `rootSourceMessageId` is used rather than
 * the turn's own source so a delegated or failover turn keeps the run's one
 * requester: a handoff card is written by the agent handing off, and a lease
 * failover card by the system, but both cite the run.
 */
export async function workflowRunRequester(
  db: SqlDatabase,
  input: { roomId: string; agentId: string; rootSourceMessageId: string },
): Promise<{ id: string; kind: 'human' | 'agent' } | undefined> {
  const card = (
    await db.query<{ run_id: string }>(
      `SELECT card->>'runId' run_id FROM messages
       WHERE id=$1 AND room_id=$2 AND card_type=$3`,
      [input.rootSourceMessageId, input.roomId, WORKFLOW_HANDOFF_CARD_TYPE],
    )
  ).rows[0];
  if (!card?.run_id) return undefined;
  const runId = card.run_id;
  const answered = (
    await db.query<{ id: string; kind: 'human' | 'agent' }>(
      `SELECT identity.id,identity.kind
       FROM messages card
       JOIN identities identity ON identity.id=card.card->'receipt'->'exit'->>'actorId'
       WHERE card.room_id=$1 AND card.card_type=$2 AND card.card->>'runId'=$3
         AND identity.kind='human' AND NOT COALESCE(identity.hidden_from_roster,false)
       ORDER BY (card.card->>'seq')::int DESC NULLS LAST,card.created_at DESC,card.id DESC
       LIMIT 1`,
      [input.roomId, WORKFLOW_HANDOFF_CARD_TYPE, runId],
    )
  ).rows[0];
  if (answered) return answered;
  const start = await loadRunStart(db, input.roomId, runId);
  const requester = (
    await db.query<{ id: string; kind: 'human' | 'agent'; hidden: boolean }>(
      `SELECT id,kind,COALESCE(hidden_from_roster,false) hidden FROM identities WHERE id=$1`,
      [start.card.requesterId ?? start.authorId],
    )
  ).rows[0];
  if (requester?.kind === 'human' && !requester.hidden)
    return { id: requester.id, kind: 'human' };
  if (requester?.kind === 'agent') return { id: requester.id, kind: 'agent' };
  return { id: input.agentId, kind: 'agent' };
}


/**
 * The person a run's notices go to: the person who started it. A human start
 * is that person; an agent's start answers the person whose message it
 * served; a scheduled start carries the owner the schedule recorded when it
 * was created (`agent_schedules.owner_id`, or its human creator). Never the
 * hidden scheduler or system identities. `null` when no person is on record,
 * and notices then go to the Room's admins (`runNoticeRecipients`).
 */
export async function resolveRunOwner(
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


/** The run owner while they are still in the Room, otherwise the Workspace's human admins. */
export async function runNoticeRecipients(db: SqlDatabase, roomId: string, ownerId: string | null): Promise<string[]> {
    db = new CornerAccessDatabase(db);
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
       AND member.room_id IS NULL
       AND member.removed_at IS NULL AND member.role IN ('owner','admin')
     JOIN identities identity ON identity.id=member.identity_id AND identity.kind='human'
       AND NOT COALESCE(identity.hidden_from_roster,false)
     WHERE room.id=$1 ORDER BY identity.id`,
    [roomId],
  );
  return admins.rows.map((row) => row.id);
}


/** One `@system` DM line to the run's owner (or the Room's admins); a repeat for the same key is a no-op. */
export async function noticeRunOwner(
  db: SqlDatabase,
  scope: RunScope,
  key: string,
  line: { subject: SystemSubject; verb: string; object?: string; consequence?: string },
): Promise<void> {
  const owner = (await loadRunStart(db, scope.roomId, scope.runId)).card.ownerId;
  await ensureSystemIdentity(db);
  for (const recipient of await runNoticeRecipients(db, scope.roomId, owner ?? null)) {
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
export type RunScope = {
  roomId: string;
  workspaceId: string;
  runId: string;
  head: RunHead;
  run: WorkflowRunCard;
  contract: WorkflowReadContract;
  stateName: string;
  state: WorkflowReadState | undefined;
  /** The status saved on the start card. */
  status: WorkflowRunStatus;
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


export async function lockWorkflowRun(db: SqlDatabase, runId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [workflowRunLockKey(runId)]);
}


/** Lock the run, then read its newest card and pinned contract. */
export async function openRun(db: SqlDatabase, roomId: string, runId: string): Promise<RunScope> {
  runId = await resolveWorkflowRunId(db, roomId, runId);
  await lockWorkflowRun(db, runId);
  const room = (
    await db.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [roomId])
  ).rows[0];
  if (!room) throw new Error('workflow room not found');
  const head = await loadRunHead(db, roomId, runId);
  if (!head) throw new ExpectedRefusalError('workflow run is unavailable in this Room');
  const run = head.card;
  const contract = await loadPinnedContract(db, roomId, run.workflowSlug, run.workflowVersion);
  if (!contract) throw new Error('workflow contract version is unavailable');
  const state = contract.handoffs[run.toState];
  const status = (await loadRunStart(db, roomId, runId)).card.runStatus;
  if (!status) throw new Error('workflow run status is unavailable');
  return {
    roomId,
    workspaceId: room.workspace_id,
    runId,
    head,
    run,
    contract,
    stateName: run.toState,
    state,
    status,
    ended: !state || status !== 'live',
  };
}


/** Cancel pending wakes; an already executing turn retains its output binding. */
export async function cancelRunWakes(db: SqlDatabase, roomId: string, runId: string): Promise<void> {
  await db.query(
    `WITH due AS MATERIALIZED (
       SELECT command.id FROM agent_commands command
       JOIN messages message ON message.id=command.source_message_id
       WHERE command.room_id=$1 AND message.card->>'runId'=$2
         AND command.state='pending'
       FOR UPDATE OF command SKIP LOCKED
     ), cancelled AS (
       SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(command.id,command.generation_id,'cancelled','workflow_attempt_advanced',NULL) ended FROM agent_commands command ,due WHERE command.id=due.id) terminal) SELECT * FROM cancelled`,
    [roomId, runId],
  );
}
export { workflowGatePrompt } from './workflow-runs-cancel-run-timers.js';
export { cancelWorkflowRun } from './workflow-runs-cancel-run-timers.js';
export { handoff } from './workflow-runs-repeated-result.js';
export { settleWorkflowGate } from './workflow-runs-repeated-result.js';
export { abandonCornerWorkflowRuns } from './workflow-runs-repeated-result.js';
export { liveWorkflowRun } from './workflow-runs-repeated-result.js';
export { saveWorkflow } from './workflow-runs-repeated-result.js';
export { activeRunIdsForSchedule } from './workflow-runs-repeated-result.js';
export { startWorkflow } from './workflow-runs-start-workflow.js';
export { assignWorkflowRole } from './workflow-runs-start-workflow.js';
export { archiveWorkflow } from './workflow-runs-start-workflow.js';
export { describedLegacyWorkflowContract } from './workflow-runs-start-workflow.js';
export { backfillWorkflowSkillDescriptions } from './workflow-runs-start-workflow.js';
export { closeStaleWorkflowGateChoices } from './workflow-runs-start-workflow.js';
