import type { activeCornerHolds } from './corner-holds.js';
import { createHash } from 'node:crypto';
import type { WorkflowContract, WorkflowTerminalState } from '@beeline/api-contract/daemon';
import { cornerRunFromLifecycle, type CornerLifecycleView } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import {
  CORNER_CHECKS_BLOCKED_CARD_TYPE,
  CORNER_REVIEW_DEADLOCK_CARD_TYPE,
  createAgentCommand,
  repairReviewerCornerMembership,
  type CommandRow,
} from './agent-command.js';
import { cornerImplementerSql } from './corner-worker.js';
import {
  firstHealthyAgent,
  isCornerReviewer,
  nextHealthyAgent,
  reviewerList,
} from './agent-health.js';
import { CORNER_WORKFLOW_HANDOFF_CARD_TYPE } from './room-choice.js';
import { ensureSystemIdentity, GITHUB_SUBJECT, systemLine, type SystemLineInput } from './system-line.js';
import { WORKFLOW_HANDOFF_CARD_TYPE, workflowRunLockKey } from './workflow-runs.js';

/**
 * Corner bookkeeping cards use their OWN `card_type`
 * (`CORNER_WORKFLOW_HANDOFF_CARD_TYPE`, defined in `room-choice.ts` to avoid
 * a circular import here), distinct from the generic engine's
 * `WORKFLOW_HANDOFF_CARD_TYPE` (`workflow-handoff`) — the `kind` stays
 * `workflow-handoff` (still a registered event kind, still zero real wakes,
 * since corner cards never set `wakes` and nothing subscribes to this kind),
 * but the card_type lets this one specific shape be excluded from a corner's
 * visible transcript (`hiddenWakeCardSql`) without touching the generic
 * engine's own `workflow-handoff` cards, which — for an ordinary Room-based
 * workflow — ARE the real, intended visible handoff notice.
 */

/**
 * The corner lifecycle as a declarative contract, and the one
 * authority that moves a corner through it.
 *
 * Every corner state change goes through `advanceCorner`: lane open, lane
 * upgrade, push, checks passed/failed, review verdict, merge refusal, merge
 * webhook, brief revision and close. The callers (`createCorner`, `upgradeCornerLane`, the
 * GitHub webhook handlers, `routeSystemCommand`, `approveCornerMerge`,
 * `queueCornerWorkerAfterReview`, `closeCornerState`, and the server merge in
 * `GitHubOperations.landCorner`) only REPORT their event. Under the run lock,
 * `advanceCorner` reads the run's current state, validates the edge against
 * `CORNER_LIFECYCLE_CONTRACT`, applies the contract's loop caps, writes the
 * handoff card, and performs the edge's side effect — the one wake of the
 * next role, or the line naming the commissioning human. An event the current
 * state does not allow changes nothing and is logged. No other code path
 * issues a corner lifecycle wake.
 *
 * The server merges. A corner in `land` is merged by
 * `GitHubOperations.landCorner` once the complete gate (`cornerMergeGate`) is
 * open: the configured reviewer's PASS on the exact current head and latest
 * brief revision (or the reviewer is the author), checks green, worker yolo
 * on, no human hold, and a configured reviewer. The implementer is never woken
 * to merge. A refused merge returns the corner to `implement` with GitHub's
 * reason; the merge webhook moves it to `landed`.
 *
 * The contract is plain TypeScript. It is not a Workspace workflow: it is
 * never stored in `workspace_skills`, never listed or started as one, and a
 * Workspace workflow saved with the slug `corner` has no effect on corners.
 * It keeps the `WorkflowContract` shape only so the run page can draw it
 * (`version: 1` is that shape's fixed format marker, not a stored version).
 * Its cards name neither a workflow nor a version; the run page finds them by
 * their card type. A
 * corner's run id is its own room id — one run for its whole life — and its
 * current state is the newest card citing that run, projected onto
 * `corner_facts.workflow_state`/`workflow_outcome` in the same transaction
 * for the phone badge and the merge sweep.
 */
export const CORNER_LIFECYCLE_SLUG = 'corner';

export const CORNER_LIFECYCLE_CONTRACT: WorkflowContract = {
  version: 1,
  name: CORNER_LIFECYCLE_SLUG,
  description: 'Corner lifecycle: implement, check, review, merge, or close',
  roles: ['implementer', 'reviewer'],
  start: 'opened',
  handoffs: {
    // The lane is decided by `createCorner` in the same transaction that
    // opens the Room.
    opened: {
      kind: 'server',
      requires: [],
      on: { no_code: 'no_code_work', code: 'implement' },
    },
    // The opener's own turn. The only programmatic exit is a human asking for
    // the code upgrade.
    no_code_work: { role: 'implementer', requires: [], on: { upgrade_requested: 'upgrade_to_code' } },
    // `upgradeCornerLane`: lane flip + feature-branch write (which IS the CI
    // callback registration — GitHub webhook matching joins on it).
    upgrade_to_code: {
      kind: 'server',
      requires: ['branch', 'repositoryRoute', 'ciCallbackRegistered', 'mergeTarget'],
      on: { upgraded: 'implement' },
    },
    // The implementer's turn. A push reported by the GitHub webhook moves it
    // to checks. `rechecked` is a checks verdict on the same head arriving
    // after the one that sent the corner here (a re-run, or a reviewer
    // configured later); `rereview` is the reviewer's next verdict on the
    // same head after a changes-requested handback.
    implement: {
      role: 'implementer',
      requires: [],
      on: { pushed: 'checks', rechecked: 'checks', rereview: 'review', brief_revised: 'review' },
    },
    // Green wakes the reviewer (live from the parent Room's
    // `reviewer_agent_id`/`reviewer_fallback_ids`), or skips review when the
    // reviewer is the author; no configured reviewer or red wakes the
    // implementer. At the loop cap the corner names the commissioning human.
    checks: {
      kind: 'server',
      requires: [],
      on: { passing: 'review', failing: 'implement', no_reviewer: 'implement', brief_revised: 'review' },
      loop: { onEdge: 'failing', cap: 100, onExceeded: 'ask_human' },
    },
    // PASS is recorded by the configured reviewer's `approve_merge`; the end
    // of a review turn with no PASS for the current head hands back to the
    // implementer. The handback cap is counted per head and reset by a push
    // (`corner_facts.review_handback_head/count`).
    review: {
      role: 'reviewer',
      roleBinding: 'live:parent.reviewer_agent_id',
      requires: [],
      on: {
        approved: 'land',
        changes_requested: 'implement',
        pushed: 'checks',
        rechecked: 'checks',
        brief_revised: 'review',
      },
      loop: { onEdge: 'changes_requested', cap: 3, onExceeded: 'ask_human' },
    },
    // The server squash-merges the exact head once the complete gate is open
    // (`GitHubOperations.landCorner`). The merge webhook takes the implicit
    // edge to `landed`; GitHub refusing the merge returns to the implementer.
    land: {
      kind: 'server',
      requires: [],
      on: { merge_unconfirmed: 'ask_human', merge_refused: 'implement', pushed: 'checks', rechecked: 'checks', brief_revised: 'review' },
    },
    // A loop cap was reached. The corner names the commissioning human and
    // waits; a new push starts the next round.
    ask_human: { kind: 'server', requires: [], on: { pushed: 'checks', brief_revised: 'review', revision_work: 'implement', merge_refused: 'implement' } },
    landed: { kind: 'terminal', status: 'done' },
    closed: { kind: 'terminal', status: 'abandoned' },
  },
  // The merge webhook and a close request end a corner from wherever it sits.
  implicitEdges: ['landed', 'closed'],
  // Only an event from outside the run takes these: a new commit on the
  // branch, a check verdict re-reported on the same head, a reviewer's next
  // verdict after a handback, a brief revision, or GitHub refusing the merge.
  externalOutcomes: ['pushed', 'rechecked', 'rereview', 'merge_refused', 'brief_revised'],
};

/** The review handback cap, read from the contract. */
export const REVIEW_HANDBACK_LIMIT = loopCap('review');
/** The failing-checks cap, read from the contract. */
export const CHECKS_FAILING_LIMIT = loopCap('checks');

function loopCap(state: string): number {
  const handoff = CORNER_LIFECYCLE_CONTRACT.handoffs[state];
  const loop = handoff && 'loop' in handoff ? handoff.loop : undefined;
  if (!loop) throw new Error(`corner contract state ${state} declares no loop`);
  return loop.cap;
}

export type CornerLane = 'no_code' | 'code';

/** Everything that can move a corner. Each adapter reports exactly one of these. */
export type CornerEvent =
  | { kind: 'open'; lane: CornerLane; workspaceId: string; implementerAgentId: string }
  | {
      kind: 'upgrade';
      contents: {
        branch: string;
        repositoryRoute: string;
        ciCallbackRegistered: true;
        mergeTarget: string;
      };
    }
  | { kind: 'push'; headSha: string; contents: Record<string, unknown> }
  | { kind: 'checks'; result: 'passing' | 'failing'; sourceMessageId: string }
  | {
      kind: 'brief-revised';
      revision: number;
      sourceMessageId: string;
      authorAgentId: string;
      command: CommandRow;
    }
  /** Checks started again on the same head (a re-run); the verdict that follows is reported as `checks`. */
  | { kind: 'checks-pending' }
  | { kind: 'approval'; headSha: string }
  | { kind: 'review-ended'; review: CommandRow; verdictMessageId: string }
  | { kind: 'merge-unconfirmed'; number: number; error: string }
  | { kind: 'merge-refused'; headSha: string; reason: string }
  | { kind: 'merged'; contents: Record<string, unknown> }
  | { kind: 'closed' };

type RevisionWake = { queued: boolean; agentId?: string; reason?: string };
export type CornerAdvance = {
  wake?: RevisionWake;
  /** The run's state after the event, or undefined when the corner has no run. */
  state: string | undefined;
  /** False when the event was not allowed from the current state (logged). */
  accepted: boolean;
};

type RunState = {
  toState: string;
  outcome: string | undefined;
  /** The PR head the newest card was written for. */
  headSha: string | undefined;
  roleBindings: Record<string, string>;
  seq: number;
};

type CornerRow = {
  parent_id: string;
  workspace_id: string;
  worker_agent_id: string | null;
  owner_agent_id: string | null;
  commissioned_by: string | null;
  lifecycle: CornerLifecycleView;
  archived: boolean;
  lane: string;
  configured_reviewer_id: string | null;
  configured_reviewer_kind: string | null;
  configured_reviewer_name: string | null;
  reviewer_parent_member: boolean;
  reviewer_fallback_ids: string[];
};

/**
 * Serializes one corner run's whole read-current-state -> write-next-card
 * sequence, with the same key format as `workflow-runs.ts`'s `lockWorkflowRun`.
 * Taken as the transaction's FIRST statement, so two events against the same
 * corner (a push landing with a close, a redelivered webhook, two merge sweeps)
 * cannot both read the same state and both act on it.
 */
export async function lockCornerWorkflowRun(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [workflowRunLockKey(cornerId)]);
}

/**
 * The newest card wins. Ordering is this file's own monotonic `seq` embedded
 * in the card, never `created_at` (two cards written in one transaction can
 * share a timestamp) or the ids (a uuid start card and sha256 later cards).
 */
async function loadCornerWorkflowRunState(
  db: SqlDatabase,
  cornerId: string,
): Promise<RunState | undefined> {
  const row = (
    await db.query<{
      to_state: string;
      outcome: string | null;
      head_sha: string | null;
      role_bindings: Record<string, string> | null;
      seq: number | null;
    }>(
      `SELECT card->>'toState' to_state, card->>'outcome' outcome,
              COALESCE(card->'contents'->>'headSha',card->>'headSha') head_sha,
              card->'roleBindings' role_bindings,
              (card->>'seq')::int seq
       FROM messages
       WHERE room_id=$1::uuid AND card_type=$2 AND card->>'runId'=$1::text
       ORDER BY (card->>'seq')::int DESC LIMIT 1`,
      [cornerId, CORNER_WORKFLOW_HANDOFF_CARD_TYPE],
    )
  ).rows[0];
  if (!row?.to_state) return undefined;
  return {
    toState: row.to_state,
    outcome: row.outcome ?? undefined,
    headSha: row.head_sha ?? undefined,
    roleBindings: row.role_bindings ?? {},
    seq: row.seq ?? 0,
  };
}

async function loadCorner(db: SqlDatabase, cornerId: string): Promise<CornerRow | undefined> {
  return (
    await db.query<CornerRow>(
      `SELECT corner.parent_id,parent.workspace_id,
              ${cornerImplementerSql('fact', 'corner')} worker_agent_id,
              fact.owner_agent_id,fact.commissioned_by,fact.lifecycle,
              corner.archived_at IS NOT NULL archived,fact.lane,
              parent.reviewer_agent_id configured_reviewer_id,
              configured.kind configured_reviewer_kind,
              configured.name configured_reviewer_name,
              EXISTS (
                SELECT 1 FROM memberships reviewer_membership
                JOIN identities reviewer ON reviewer.id=reviewer_membership.identity_id
                  AND reviewer.kind='agent'
                WHERE reviewer_membership.room_id=parent.id
                  AND reviewer_membership.identity_id=parent.reviewer_agent_id
                  AND reviewer_membership.removed_at IS NULL
              ) reviewer_parent_member,
              parent.reviewer_fallback_ids
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       LEFT JOIN identities configured ON configured.id=parent.reviewer_agent_id
       WHERE fact.corner_id=$1
       FOR UPDATE OF fact`,
      [cornerId],
    )
  ).rows[0];
}

/**
 * Every corner-workflow card is authored by `@system`, never by the corner's
 * own implementer or reviewer agent — a card "written" by that agent would
 * inflate any query counting the agent's own conversational messages.
 */
async function cornerBookkeepingSubject(db: SqlDatabase): Promise<SystemLineInput['subject']> {
  await ensureSystemIdentity(db);
  return { kind: 'system', id: SYSTEM_IDENTITY_ID, name: '@system' };
}

function terminalStatus(toState: string): WorkflowTerminalState['status'] | undefined {
  const state = CORNER_LIFECYCLE_CONTRACT.handoffs[toState];
  return state?.kind === 'terminal' ? state.status : undefined;
}

/** The declared `on` edges of a state; empty for waiting and terminal states. */
function edgesOf(stateName: string): Readonly<Record<string, string>> {
  const state = CORNER_LIFECYCLE_CONTRACT.handoffs[stateName];
  return state && 'on' in state ? state.on : {};
}

const REVIEWER_ROLE_BINDING = 'live:parent.reviewer_agent_id';

/**
 * Starts the run card (seq 0). `id` is the corner's own id, as `startWorkflow`
 * uses the run id, so a retried `createCorner` transaction cannot duplicate it.
 */
async function writeStartCard(
  db: SqlDatabase,
  input: {
    cornerId: string;
    roleBindings: Record<string, string>;
    toState: string;
    /** Set only on a run derived from an older corner's lifecycle. */
    backfilled?: { outcome: string | undefined; headSha: string | undefined };
  },
): Promise<void> {
  const subject = await cornerBookkeepingSubject(db);
  await systemLine(db, {
    id: input.cornerId,
    roomId: input.cornerId,
    authorId: SYSTEM_IDENTITY_ID,
    subject,
    verb: 'started workflow',
    object: CORNER_LIFECYCLE_CONTRACT.name,
    kind: WORKFLOW_HANDOFF_CARD_TYPE,
    // Never a chat line: `hiddenWakeCardSql` excludes this card type from the
    // transcript a human reads.
    presentation: 'card',
    cardType: CORNER_WORKFLOW_HANDOFF_CARD_TYPE,
    card: {
      runId: input.cornerId,
      roleBindings: input.roleBindings,
      toState: input.toState,
      seq: 0,
      ...(input.backfilled
        ? {
            backfilledFrom: 'lifecycle',
            ...(input.backfilled.outcome ? { outcome: input.backfilled.outcome } : {}),
            ...(input.backfilled.headSha ? { headSha: input.backfilled.headSha } : {}),
          }
        : {}),
    },
  });
  await projectRunState(db, input.cornerId, input.toState, input.backfilled?.outcome);
}

async function projectRunState(
  db: SqlDatabase,
  cornerId: string,
  state: string,
  outcome: string | undefined,
): Promise<void> {
  await db.query(
    `UPDATE corner_facts SET workflow_state=$2,workflow_outcome=$3,updated_at=now() WHERE corner_id=$1`,
    [cornerId, state, outcome ?? null],
  );
}

/**
 * One validated transition inside an `advanceCorner` transaction. The edge
 * must be declared on the current state (or be an implicit edge); a loop edge
 * counted past its cap goes to the loop's `onExceeded` instead.
 */
class Transition {
  constructor(
    private readonly db: SqlDatabase,
    private readonly cornerId: string,
    public run: RunState,
    /** The corner's current PR head; every card records the head it was written for. */
    private readonly headSha: string | undefined,
  ) {}

  get state(): string {
    return this.run.toState;
  }

  allows(outcome: string): boolean {
    return Object.hasOwn(edgesOf(this.run.toState), outcome);
  }

  /** `loopCount` is this trip's number around the state's loop, when the edge is its loop edge. */
  async take(
    outcome: string,
    contents: Record<string, unknown> = {},
    loopCount?: number,
  ): Promise<string> {
    const fromState = this.run.toState;
    const implicit = CORNER_LIFECYCLE_CONTRACT.implicitEdges?.includes(outcome) ?? false;
    if (!implicit && !this.allows(outcome))
      throw new Error(`corner contract has no ${fromState} --${outcome}--> edge`);
    let toState = implicit ? outcome : edgesOf(fromState)[outcome]!;
    const state = CORNER_LIFECYCLE_CONTRACT.handoffs[fromState];
    const loop = state && 'loop' in state ? state.loop : undefined;
    if (loop && loop.onEdge === outcome && loopCount !== undefined && loopCount > loop.cap)
      toState = loop.onExceeded;
    const seq = this.run.seq + 1;
    const status = terminalStatus(toState);
    if (this.headSha && contents.headSha === undefined) contents = { ...contents, headSha: this.headSha };
    const subject = await cornerBookkeepingSubject(this.db);
    await systemLine(this.db, {
      id: createHash('sha256')
        .update(`beeline:corner-workflow:${this.cornerId}:${seq}:${fromState}:${outcome}`)
        .digest('hex'),
      roomId: this.cornerId,
      authorId: SYSTEM_IDENTITY_ID,
      subject,
      verb: 'handed off',
      object: toState,
      kind: WORKFLOW_HANDOFF_CARD_TYPE,
      // The card never wakes anyone itself (no `wakes`); the one wake of the
      // next role is this transition's own side effect in `advanceCorner`.
      presentation: 'card',
      cardType: CORNER_WORKFLOW_HANDOFF_CARD_TYPE,
      card: {
        runId: this.cornerId,
        roleBindings: this.run.roleBindings,
        fromState,
        outcome,
        toState,
        contents,
        receipt: { exit: { gate: outcome, actorId: SYSTEM_IDENTITY_ID } },
        seq,
        ...(status ? { status } : {}),
      },
    });
    await projectRunState(this.db, this.cornerId, toState, outcome);
    this.run = {
      ...this.run,
      toState,
      outcome,
      seq,
      headSha: typeof contents.headSha === 'string' ? contents.headSha : undefined,
    };
    return toState;
  }
}

function rejected(cornerId: string, event: CornerEvent, state: string | undefined, why: string) {
  console.info(
    `[corner-workflow] ${cornerId}: ignored ${event.kind} in ${state ?? 'no run'}: ${why}`,
  );
}

/**
 * The run a corner opened before the workflow run existed (#1918) is given
 * once, derived from its lifecycle (`cornerRunFromLifecycle`, the mapping the
 * phone badge uses) and from what was already dispatched for its current head:
 * a green head with a PASS is already `land`; a checks verdict whose wake
 * (reviewer on green, implementer on red) never went out is still `checks`,
 * so reporting that verdict again dispatches it.
 */
async function backfillRun(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
): Promise<RunState> {
  const derived = cornerRunFromLifecycle({ archived: corner.archived, lifecycle: corner.lifecycle });
  let toState = derived.state;
  let outcome = derived.outcome;
  if (!terminalStatus(toState) && corner.lane === 'no_code') {
    toState = 'no_code_work';
    outcome = undefined;
  } else if (toState === 'review') {
    if (await approvedCurrentHead(db, cornerId, corner)) {
      toState = 'land';
      outcome = 'approved';
    } else if (!(await checksVerdictDispatched(db, cornerId, 'check-passed', 'subscribed_event')))
      toState = 'checks';
  } else if (
    toState === 'implement' &&
    outcome === 'failing' &&
    !(await checksVerdictDispatched(db, cornerId, 'check-failed', 'corner_check'))
  ) {
    toState = 'checks';
    outcome = undefined;
  }
  const roleBindings = {
    implementer: corner.worker_agent_id ?? '',
    reviewer: REVIEWER_ROLE_BINDING,
  };
  const headSha = corner.lifecycle.pr?.headSha;
  await writeStartCard(db, {
    cornerId,
    roleBindings,
    toState,
    backfilled: { outcome, headSha },
  });
  return { toState, outcome, headSha, roleBindings, seq: 0 };
}

async function checksVerdictDispatched(
  db: SqlDatabase,
  cornerId: string,
  kind: 'check-passed' | 'check-failed',
  reason: string,
): Promise<boolean> {
  const dispatched = await db.query(
    `SELECT 1 FROM agent_commands command
     JOIN messages source ON source.id=command.source_message_id
     JOIN corner_facts fact ON fact.corner_id=command.room_id
     WHERE command.room_id=$1 AND command.reason=$2
       AND source.system_event->>'kind'=$3
       AND (source.system_event->'object'->>'headSha' IS NULL
            OR source.system_event->'object'->>'headSha'=fact.lifecycle->'pr'->>'headSha')
     LIMIT 1`,
    [cornerId, reason, kind],
  );
  return dispatched.rowCount > 0;
}

/**
 * The single entry point for every corner state change. Runs in the caller's
 * transaction when it has one. See the file header.
 */
export async function advanceCorner(
  database: SqlDatabase,
  cornerId: string,
  event: CornerEvent,
): Promise<CornerAdvance> {
  return database.transaction(async (db) => {
    await lockCornerWorkflowRun(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    if (!corner) {
      rejected(cornerId, event, undefined, 'corner not found');
      return { state: undefined, accepted: false };
    }
    let run = await loadCornerWorkflowRunState(db, cornerId);
    if (event.kind === 'open') {
      if (run) {
        rejected(cornerId, event, run.toState, 'run already started');
        return { state: run.toState, accepted: false };
      }
      const roleBindings = {
        implementer: event.implementerAgentId,
        // Never a real agent id, so the generic handoff() engine's own
        // `boundAgentId !== command.agent_id` check can never match it.
        reviewer: REVIEWER_ROLE_BINDING,
      };
      await writeStartCard(db, { cornerId, roleBindings, toState: 'opened' });
      const transition = new Transition(
        db,
        cornerId,
        { toState: 'opened', outcome: undefined, headSha: undefined, roleBindings, seq: 0 },
        corner.lifecycle.pr?.headSha,
      );
      return { state: await transition.take(event.lane), accepted: true };
    }
    run ??= await backfillRun(db, cornerId, corner);
    const transition = new Transition(db, cornerId, run, corner.lifecycle.pr?.headSha);
    if (terminalStatus(run.toState)) {
      rejected(cornerId, event, run.toState, 'run already ended');
      return { state: run.toState, accepted: false };
    }
    const accepted = await applyEvent(db, cornerId, corner, transition, event);
    if (!accepted.ok) {
      rejected(cornerId, event, run.toState, accepted.why);
      return { state: transition.state, accepted: false };
    }
    return { state: transition.state, accepted: true, ...(accepted.wake ? { wake: accepted.wake } : {}) };
  });
}

type Applied = { ok: true; wake?: RevisionWake } | { ok: false; why: string };
const OK: Applied = { ok: true };
const no = (why: string): Applied => ({ ok: false, why });

async function applyEvent(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
  event: Exclude<CornerEvent, { kind: 'open' }>,
): Promise<Applied> {
  switch (event.kind) {
    case 'upgrade':
      if (!transition.allows('upgrade_requested')) return no('not a no-code corner');
      await transition.take('upgrade_requested');
      await transition.take('upgraded', event.contents);
      return OK;
    case 'push':
      if (!transition.allows('pushed')) return no('no push edge');
      await transition.take('pushed', event.contents);
      return OK;
    case 'checks':
      return checksReported(db, cornerId, corner, transition, event);
    case 'brief-revised': {
      const resuming = transition.state === 'ask_human';
      if (corner.lifecycle.checks !== 'passing' && !resuming) return no('checks are not green');
      if (!transition.allows('brief_revised')) return no('no brief revision review edge');
      const reviewerAgentId = corner.lifecycle.checks === 'passing' ? await reachableReviewer(
        db, cornerId, corner, event.sourceMessageId, corner.lifecycle.pr?.headSha ?? null, event.authorAgentId,
      ) : undefined;
      if (!reviewerAgentId && !resuming) return no('no reachable reviewer for the revision');
      const agentId = reviewerAgentId ?? corner.worker_agent_id;
      if (!agentId) return { ok: true, wake: { queued: false, reason: 'No reachable implementer for the revision' } };
      const command = await createAgentCommand(db, {
        roomId: cornerId,
        agentId,
        sourceMessageId: event.sourceMessageId,
        reason: reviewerAgentId ? 'corner_check' : 'corner_brief_revision',
        parent: event.command,
        retainDepth: true,
      });
      if (!command) return { ok: true, wake: { queued: false, reason: 'The revision recipient cannot be woken' } };
      await transition.take(reviewerAgentId ? 'brief_revised' : 'revision_work', { briefRevision: event.revision });
      return { ok: true, wake: { queued: true, agentId } };
    }
    case 'checks-pending': {
      if (corner.lifecycle.checks !== 'pending') return no(`checks are ${corner.lifecycle.checks}`);
      const verdictHolds =
        transition.state === 'review' ||
        transition.state === 'land' ||
        (transition.state === 'implement' &&
          (transition.run.outcome === 'failing' || transition.run.outcome === 'no_reviewer'));
      if (!verdictHolds) return no('no checks verdict to re-run');
      await transition.take('rechecked');
      return OK;
    }
    case 'approval':
      return approvalRecorded(db, cornerId, corner, transition, event);
    case 'review-ended':
      return reviewEnded(db, cornerId, corner, transition, event);
    case 'merge-unconfirmed':
      if (!transition.allows('merge_unconfirmed')) return no('merge recovery already escalated');
      await transition.take('merge_unconfirmed');
      await ensureSystemIdentity(db);
      await systemLine(db, {
        roomId: cornerId, authorId: SYSTEM_IDENTITY_ID, subject: GITHUB_SUBJECT, verb: 'could not confirm the merge of',
        object: `pull request #${event.number}`, consequence: `${event.error} · merge outcome is unconfirmed`,
      });
      return OK;
    case 'merge-refused':
      return mergeRefused(db, cornerId, corner, transition, event);
    case 'merged':
      // Landing wakes no one in the parent Room: the merge card announces it,
      // and an agent with work left after the merge subscribes to `merged`.
      await transition.take('landed', event.contents);
      return OK;
    case 'closed':
      await transition.take('closed');
      return OK;
  }
}

/** Where a checks verdict leads, decided before any card is written. */
type ChecksPlan =
  | { outcome: 'failing' }
  | { outcome: 'no_reviewer' }
  | { outcome: 'passing'; skipReview: true }
  | { outcome: 'passing'; skipReview: false; reviewerAgentId: string };

async function checksReported(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
  event: Extract<CornerEvent, { kind: 'checks' }>,
): Promise<Applied> {
  // A fact replayed after the checks moved on is stale.
  if (corner.lifecycle.checks !== event.result) return no(`checks are ${corner.lifecycle.checks}`);
  const from = transition.state;
  if (!['checks', 'implement', 'review', 'land'].includes(from)) return no('no checks edge');
  const headSha = corner.lifecycle.pr?.headSha ?? null;
  let plan: ChecksPlan;
  if (event.result === 'failing') plan = { outcome: 'failing' };
  else if (!corner.configured_reviewer_id) plan = { outcome: 'no_reviewer' };
  else if (
    (corner.reviewer_parent_member && reviewerIsAuthor(corner)) ||
    (await approvedCurrentHead(db, cornerId, corner))
  )
    plan = { outcome: 'passing', skipReview: true };
  else {
    // A repeat of the verdict that already holds changes nothing, and must
    // not spend a reviewer pick, a membership repair, or a note.
    if ((from === 'review' || from === 'land') && transition.run.headSha === (headSha ?? undefined))
      return no('checks already passed on this head');
    const reviewerAgentId = await reachableReviewer(db, cornerId, corner, event.sourceMessageId, headSha);
    if (!reviewerAgentId) return no('configured reviewer is unreachable');
    plan = { outcome: 'passing', skipReview: false, reviewerAgentId };
  }
  if (from !== 'checks' && transition.run.headSha === (headSha ?? undefined)) {
    const repeat =
      (from === 'implement' && transition.run.outcome === plan.outcome) ||
      ((from === 'review' || from === 'land') && plan.outcome === 'passing');
    if (repeat) return no(`${plan.outcome} already holds on this head`);
  }
  const failingRound =
    plan.outcome === 'failing' ? (await countEdges(db, cornerId, 'checks', 'failing')) + 1 : undefined;
  const capped = failingRound !== undefined && failingRound > CHECKS_FAILING_LIMIT;
  // The wake goes out first: a verdict whose wake cannot be delivered (the
  // implementer is no longer a member) leaves the run in place, so the next
  // report of the same verdict retries it.
  if (!capped && plan.outcome !== 'passing') {
    if (!corner.worker_agent_id) return no('the corner has no implementer');
    const command = await createAgentCommand(db, {
      roomId: cornerId,
      agentId: corner.worker_agent_id,
      sourceMessageId: event.sourceMessageId,
      reason: 'corner_check',
    });
    if (!command) return no('the implementer cannot be woken');
  } else if (plan.outcome === 'passing' && !plan.skipReview) {
    const command = await createAgentCommand(db, {
      roomId: cornerId,
      agentId: plan.reviewerAgentId,
      sourceMessageId: event.sourceMessageId,
      reason: 'subscribed_event',
    });
    if (!command) return no('the reviewer cannot be woken');
  }
  if (from !== 'checks') await transition.take('rechecked');
  const toState = await transition.take(plan.outcome, headSha ? { headSha } : {}, failingRound);
  if (toState === 'ask_human') {
    await askHuman(db, cornerId, corner, {
      key: `checks-failing-limit:${headSha ?? event.sourceMessageId}`,
      consequence: `checks have failed ${CHECKS_FAILING_LIMIT} times in this corner`,
      cardType: CORNER_CHECKS_BLOCKED_CARD_TYPE,
      afterMessageId: event.sourceMessageId,
    });
    return OK;
  }
  if (plan.outcome === 'passing' && plan.skipReview) {
    await transition.take('approved', { verdict: 'approved' });
    return OK;
  }
  // `pr_checks_status` reports a dispatched wake from this projection.
  await db.query(`UPDATE corner_facts SET command_check_state=$2 WHERE corner_id=$1`, [
    cornerId,
    corner.lifecycle.checks,
  ]);
  return OK;
}

/**
 * Which reviewer a green head wakes, or undefined (after naming the gap in the
 * corner) when the configured reviewer cannot be reached. A configured
 * reviewer who is not a current member is never "no reviewer": it does not
 * fall through to the author path. A Room with fallback reviewers wakes the
 * first healthy agent on its list instead.
 */
async function reachableReviewer(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  sourceMessageId: string,
  headSha: string | null,
  revisionAuthorId?: string,
): Promise<string | undefined> {
  if (!corner.configured_reviewer_id) return undefined;
  if (corner.reviewer_fallback_ids.length)
    return dispatchableListReviewer(
      db, cornerId, corner, sourceMessageId, headSha, undefined, revisionAuthorId,
    );
  if (corner.configured_reviewer_id === revisionAuthorId) return undefined;
  if (!corner.reviewer_parent_member) {
    await noteUnreachableReviewer(db, {
      cornerId,
      sourceMessageId,
      reviewerId: corner.configured_reviewer_id,
      reviewerKind: corner.configured_reviewer_kind,
      reviewerName: corner.configured_reviewer_name,
      reason: REVIEWER_NOT_PARENT_MEMBER,
    });
    return undefined;
  }
  return (await readableByReviewer(db, cornerId, corner.configured_reviewer_id, sourceMessageId))
    ? corner.configured_reviewer_id
    : undefined;
}

/**
 * The first healthy agent on the parent Room's reviewer list, never the
 * corner's own author; after `failed` on the list when one is given. Names
 * the gap in the corner when nobody on the list can take the review.
 */
async function dispatchableListReviewer(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  sourceMessageId: string,
  headSha: string | null,
  failed?: string,
  revisionAuthorId?: string,
): Promise<string | undefined> {
  const list = reviewerList({
    reviewer_agent_id: corner.configured_reviewer_id,
    reviewer_fallback_ids: corner.reviewer_fallback_ids,
  }).filter((id) => id !== corner.owner_agent_id && id !== revisionAuthorId);
  const reviewerAgentId = failed
    ? await nextHealthyAgent(db, corner.parent_id, list, failed)
    : await firstHealthyAgent(db, corner.parent_id, list);
  if (!reviewerAgentId) {
    await noteReviewerListExhausted(db, { cornerId, sourceMessageId, headSha });
    return undefined;
  }
  return (await readableByReviewer(db, cornerId, reviewerAgentId, sourceMessageId))
    ? reviewerAgentId
    : undefined;
}

/**
 * Dispatch only when the reviewer can read the corner; a missing projection
 * is repaired, an unreachable reviewer is named instead of rerouting the
 * review to the owner (whose daemon would post it under the owner's name).
 */
async function readableByReviewer(
  db: SqlDatabase,
  cornerId: string,
  reviewerAgentId: string,
  sourceMessageId: string,
): Promise<boolean> {
  if (await repairReviewerCornerMembership(db, cornerId, reviewerAgentId)) return true;
  const reviewer = (
    await db.query<{ kind: string; name: string }>(`SELECT kind,name FROM identities WHERE id=$1`, [
      reviewerAgentId,
    ])
  ).rows[0];
  await noteUnreachableReviewer(db, {
    cornerId,
    sourceMessageId,
    reviewerId: reviewerAgentId,
    reviewerKind: reviewer?.kind ?? null,
    reviewerName: reviewer?.name ?? null,
    reason: REVIEWER_NOT_CORNER_MEMBER,
  });
  return false;
}

/**
 * The failed/silent turn hook for a list reviewer: when the reviewer woken by
 * a green head fails or goes silent, the review passes to the next healthy
 * agent on the parent Room's reviewer list. Called from
 * `turn-silence-notice.ts`'s `noteFirstSilence` beside the workflow-role
 * failover, in its own transaction. A no-op for a Room without fallback
 * reviewers, a turn that was not a review dispatch, or a corner that has
 * already moved past review on this head.
 */
export async function reassignFailedCornerReviewer(
  database: SqlDatabase,
  input: { roomId: string; requestId: string; agentId: string },
): Promise<void> {
  await database.transaction(async (db) => {
    const dispatch = await db.query(
      `SELECT 1 FROM messages WHERE id=$1 AND room_id=$2 AND system_event->>'kind'='check-passed'`,
      [input.requestId, input.roomId],
    );
    if (!dispatch.rowCount) return;
    await lockCornerWorkflowRun(db, input.roomId);
    const corner = await loadCorner(db, input.roomId);
    if (!corner?.configured_reviewer_id || !corner.reviewer_fallback_ids.length) return;
    if (corner.lifecycle.checks !== 'passing') return;
    const run = await loadCornerWorkflowRunState(db, input.roomId);
    if (run?.toState !== 'review') return;
    if (await approvedCurrentHead(db, input.roomId, corner)) return;
    if (!(await isCornerReviewer(db, input.roomId, input.agentId))) return;
    const next = await dispatchableListReviewer(
      db,
      input.roomId,
      corner,
      input.requestId,
      corner.lifecycle.pr?.headSha ?? null,
      input.agentId,
    );
    if (!next) return;
    await createAgentCommand(db, {
      roomId: input.roomId,
      agentId: next,
      sourceMessageId: input.requestId,
      reason: 'subscribed_event',
    });
  });
}

async function approvalRecorded(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
  event: Extract<CornerEvent, { kind: 'approval' }>,
): Promise<Applied> {
  if (corner.lifecycle.pr?.headSha !== event.headSha) return no('approval is not for the current head');
  // An approval while checks still run is kept; the checks-passed that
  // follows it skips the review and lands.
  if (corner.lifecycle.checks !== 'passing') return no('checks are not green yet');
  if (transition.state === 'implement' && transition.run.outcome === 'changes_requested')
    await transition.take('rereview');
  if (transition.state !== 'review') return no('not in review');
  await transition.take('approved', { verdict: 'approved', headSha: event.headSha });
  return OK;
}

/**
 * The reviewer's turn ended without a PASS for the current head: a rejection,
 * a stale-head refusal and a silent turn are one state, so the handback
 * carries the reviewer's closing text for the implementer to read. It fires
 * only while checks are green — a reviewer that ended its turn to wait for CI
 * has not finished. Handbacks are counted per head, a push resetting them.
 */
async function reviewEnded(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
  event: Extract<CornerEvent, { kind: 'review-ended' }>,
): Promise<Applied> {
  const headSha = corner.lifecycle.pr?.headSha;
  if (!headSha) return no('no pull request head');
  if (corner.lifecycle.checks !== 'passing') return no('checks are not green');
  if (await approvedCurrentHead(db, cornerId, corner)) return no('the current head is approved');
  if (transition.state === 'implement' && transition.run.outcome === 'changes_requested')
    await transition.take('rereview');
  if (transition.state !== 'review') return no('not in review');
  const handbacks =
    (
      await db.query<{ review_handback_count: number }>(
        `UPDATE corner_facts SET
           review_handback_head=$2,
           review_handback_count=CASE
             WHEN review_handback_head IS NOT DISTINCT FROM $2 THEN review_handback_count+1
             ELSE 1 END
         WHERE corner_id=$1
         RETURNING review_handback_count`,
        [cornerId, headSha],
      )
    ).rows[0]?.review_handback_count ?? 1;
  const toState = await transition.take(
    'changes_requested',
    { verdict: 'changes_requested', headSha },
    handbacks,
  );
  if (toState === 'ask_human') {
    await askHuman(db, cornerId, corner, {
      key: `review-handback-limit:${headSha}`,
      consequence: `review and fix have passed ${REVIEW_HANDBACK_LIMIT} times over this head with nothing new pushed`,
      cardType: CORNER_REVIEW_DEADLOCK_CARD_TYPE,
      afterMessageId: event.verdictMessageId,
    });
    return OK;
  }
  if (corner.worker_agent_id)
    await createAgentCommand(db, {
      roomId: cornerId,
      agentId: corner.worker_agent_id,
      sourceMessageId: event.verdictMessageId,
      parent: event.review,
      // Handing the branch back is a lifecycle transfer, not one agent
      // delegating to another, so it keeps the chain's depth. Otherwise the
      // review loop dies on COMMAND_MAX_DEPTH before the cap can reach the
      // person who could settle it.
      retainDepth: true,
      reason: 'corner_review',
    });
  return OK;
}

async function mergeRefused(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
  event: Extract<CornerEvent, { kind: 'merge-refused' }>,
): Promise<Applied> {
  if (!transition.allows('merge_refused')) return no('not landing');
  if (corner.lifecycle.pr?.headSha !== event.headSha) return no('the head moved');
  await transition.take('merge_refused', { headSha: event.headSha, reason: event.reason });
  const pullRequest = corner.lifecycle.pr;
  const line = await systemLine(db, {
    id: createHash('sha256')
      .update(`beeline:${cornerId}:github:merge-refused:${event.headSha}`)
      .digest('hex'),
    roomId: cornerId,
    authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
    subject: GITHUB_SUBJECT,
    verb: 'refused to merge',
    object: {
      text: pullRequest?.title ?? `pull request #${pullRequest?.number ?? ''}`,
      ...(pullRequest?.url ? { url: pullRequest.url } : {}),
      headSha: event.headSha,
    },
    consequence: event.reason,
  });
  if (corner.worker_agent_id)
    await wake(db, cornerId, corner.worker_agent_id, line.id, 'corner_merge_refused');
  return OK;
}

async function wake(
  db: SqlDatabase,
  cornerId: string,
  agentId: string,
  sourceMessageId: string,
  reason: string,
): Promise<void> {
  await createAgentCommand(db, { roomId: cornerId, agentId, sourceMessageId, reason });
}

async function countEdges(
  db: SqlDatabase,
  cornerId: string,
  fromState: string,
  outcome: string,
): Promise<number> {
  const row = (
    await db.query<{ count: string }>(
      `SELECT count(*)::text count FROM messages
       WHERE room_id=$1 AND card_type=$2 AND card->>'runId'=$1::text
         AND card->>'fromState'=$3 AND card->>'outcome'=$4`,
      [cornerId, CORNER_WORKFLOW_HANDOFF_CARD_TYPE, fromState, outcome],
    )
  ).rows[0];
  return Number(row?.count ?? 0);
}

/**
 * A loop cap was reached. A corner an agent opened off its own root message
 * records no requester, and is just as stuck, so the line is addressed to the
 * corner itself rather than dropped. The server authors it either way,
 * because push delivery never sends a person their own line.
 */
async function askHuman(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  input: { key: string; consequence: string; cardType: string; afterMessageId: string },
): Promise<void> {
  await ensureSystemIdentity(db);
  await systemLine(db, {
    id: createHash('sha256').update(`beeline:${cornerId}:${input.key}`).digest('hex'),
    roomId: cornerId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: corner.commissioned_by
      ? { kind: 'person', id: corner.commissioned_by, name: 'the requester' }
      : { kind: 'system', name: 'Somebody' },
    verb: 'may need to step in',
    consequence: input.consequence,
    afterMessageId: input.afterMessageId,
    cardType: input.cardType,
    card: { cornerId },
  });
}

const REVIEWER_NOT_PARENT_MEMBER = 'not a current member of the parent Room';
const REVIEWER_NOT_CORNER_MEMBER = 'not a current member of this corner';

/**
 * A configured reviewer that cannot be dispatched is named in the corner, not
 * collapsed into the no-reviewer author path. Deterministic id so a later
 * retry of the same gap does not spam.
 */
async function noteUnreachableReviewer(
  db: SqlDatabase,
  input: {
    cornerId: string;
    sourceMessageId: string;
    reviewerId: string;
    reviewerKind: string | null;
    reviewerName: string | null;
    reason: string;
  },
): Promise<void> {
  const id = createHash('sha256')
    .update(`beeline:${input.cornerId}:reviewer-unreachable:${input.reviewerId}:${input.reason}`)
    .digest('hex');
  await systemLine(db, {
    id,
    roomId: input.cornerId,
    subject: {
      kind: input.reviewerKind === 'human' ? 'person' : 'agent',
      id: input.reviewerId,
      name: input.reviewerName ?? 'the configured reviewer',
    },
    verb: 'could not be reached',
    consequence: input.reason,
    afterMessageId: input.sourceMessageId,
  });
}

/**
 * A reviewer list with no healthy agent is named in the corner rather than
 * silently falling back to the owner. The id is keyed per episode — the head
 * plus the triggering message — so a later independent gap is not swallowed
 * by `systemLine`'s dedupe.
 */
async function noteReviewerListExhausted(
  db: SqlDatabase,
  input: { cornerId: string; sourceMessageId: string; headSha: string | null },
): Promise<void> {
  const id = createHash('sha256')
    .update(
      `beeline:${input.cornerId}:reviewer-list-exhausted:${input.headSha ?? 'no-head'}:${input.sourceMessageId}`,
    )
    .digest('hex');
  await ensureSystemIdentity(db);
  await systemLine(db, {
    id,
    roomId: input.cornerId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: 'No reviewer on the list' },
    verb: 'is healthy enough to review this',
    consequence: 'a human can set a different reviewer, or wait for one on the list to come back healthy',
    afterMessageId: input.sourceMessageId,
  });
}

/**
 * The parent Room's reviewer opened this very corner: no OTHER agent's
 * approve_merge can ever exist for it, so requiring one is a permanent
 * deadlock, not a real gate.
 */
function reviewerIsAuthor(
  corner: Pick<CornerRow, 'owner_agent_id' | 'configured_reviewer_id' | 'reviewer_fallback_ids'>,
): boolean {
  if (!corner.owner_agent_id || !corner.configured_reviewer_id) return false;
  return reviewerList({
    reviewer_agent_id: corner.configured_reviewer_id,
    reviewer_fallback_ids: corner.reviewer_fallback_ids,
  }).every((id) => id === corner.owner_agent_id);
}

/** The configured reviewer's PASS on the corner's current head and latest brief revision, by a current parent member. */
async function approvedCurrentHead(
  db: SqlDatabase,
  cornerId: string,
  corner: Pick<CornerRow, 'lifecycle' | 'parent_id' | 'owner_agent_id'>,
): Promise<boolean> {
  const pr = corner.lifecycle.pr;
  if (!pr?.headSha || !pr.number) return false;
  return (
    (await approvingReviewer(db, { ...corner, cornerId, number: pr.number, headSha: pr.headSha })) !==
    undefined
  );
}

async function approvingReviewer(
  db: SqlDatabase,
  input: { cornerId: string; parent_id: string; owner_agent_id: string | null; number: number; headSha: string },
): Promise<string | undefined> {
  const approvedBy = (
    await db.query<{ approved_by: string }>(
      `SELECT approved_by FROM corner_merge_approvals
       WHERE corner_id=$1 AND pull_request_number=$2 AND head_sha=$3
         AND brief_revision IS NOT DISTINCT FROM
           (SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$1)`,
      [input.cornerId, input.number, input.headSha],
    )
  ).rows[0]?.approved_by;
  // The author on its own Room's reviewer list never approves its own work.
  if (!approvedBy || approvedBy === input.owner_agent_id) return undefined;
  // The same predicate `approve_merge` enforces: a configured reviewer (or a
  // current-member fallback) that is still a current member of the parent Room.
  return (await isCornerReviewer(db, input.cornerId, approvedBy)) ? approvedBy : undefined;
}

export type CornerMergeGate = {
  /** A reviewer is configured; the self-review bypass also requires current parent membership. */
  reviewerExists: boolean;
  reviewerIsAuthor: boolean;
  /** No PASS by the configured reviewer on this head and the latest brief revision, and the reviewer is not the author. */
  approvalPending: boolean;
  held: boolean;
  holds: Awaited<ReturnType<typeof activeCornerHolds>>;
  isWorkerYolo: boolean;
  /** Everything but checks: PASS (or self-review), yolo on, no hold, reviewer present. */
  open: boolean;
};

/**
 * The merge gate for one exact PR head, minus the checks verdict (the caller
 * supplies that from GitHub). Shared by `pr_checks_status` and the server
 * merge, so the gate an agent reads is the gate the server merges on.
 */
export async function cornerMergeGate(
  db: SqlDatabase,
  cornerId: string,
  head: { number: number; headSha: string },
): Promise<CornerMergeGate> {
  const gates = await cornerMergeGates(db, [
    { corner_id: cornerId, number: head.number, head_sha: head.headSha },
  ]);
  const gate = gates.get(cornerId);
  if (!gate) throw new Error('corner not found');
  return gate;
}

/** Shared gate facts and rules for a single head and the whole candidate sweep. */
async function cornerMergeGates(
  db: SqlDatabase,
  heads: { corner_id: string; number: number; head_sha: string }[],
): Promise<Map<string, CornerMergeGate>> {
  const rows = await db.query<{
    corner_id: string;
    owner_agent_id: string | null;
    configured_reviewer_id: string | null;
    reviewer_parent_member: boolean;
    reviewer_fallback_ids: string[];
    approved: boolean;
    holds: CornerMergeGate['holds'];
    yolo_mode: boolean | null;
  }>(
      `SELECT fact.corner_id,fact.owner_agent_id,
              parent.reviewer_agent_id configured_reviewer_id,parent.reviewer_fallback_ids,
              EXISTS (
                SELECT 1 FROM memberships member JOIN identities reviewer ON reviewer.id=member.identity_id
                WHERE member.room_id=parent.id AND member.identity_id=parent.reviewer_agent_id
                  AND member.removed_at IS NULL AND reviewer.kind='agent'
              ) reviewer_parent_member,
              EXISTS (
                SELECT 1 FROM corner_merge_approvals approval
                JOIN memberships member ON member.room_id=parent.id AND member.identity_id=approval.approved_by
                  AND member.removed_at IS NULL
                JOIN identities reviewer ON reviewer.id=member.identity_id AND reviewer.kind='agent'
                WHERE approval.corner_id=fact.corner_id AND approval.pull_request_number=head.number
                  AND approval.head_sha=head.head_sha
                  AND approval.brief_revision IS NOT DISTINCT FROM
                    (SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=fact.corner_id)
                  AND approval.approved_by IS DISTINCT FROM fact.owner_agent_id
                  AND parent.reviewer_agent_id IS NOT NULL
                  AND (approval.approved_by=parent.reviewer_agent_id OR approval.approved_by=ANY(parent.reviewer_fallback_ids))
              ) approved,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hold.id::text,'actorId',hold.actor_id,
                'standing',hold.standing,'setAt',hold.set_at::text) ORDER BY hold.set_at,hold.id)
                FROM corner_merge_holds hold WHERE hold.corner_id=fact.corner_id AND hold.released_at IS NULL),
                '[]'::jsonb) holds,
              (agent.yolo_mode AND workspace.visibility<>'public') yolo_mode
       FROM jsonb_to_recordset($1::jsonb) head(corner_id uuid,number int,head_sha text)
       JOIN corner_facts fact ON fact.corner_id=head.corner_id
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       JOIN workspaces workspace ON workspace.id=corner.workspace_id
       LEFT JOIN agents agent ON agent.agent_id=${cornerImplementerSql('fact', 'corner')}`,
    [JSON.stringify(heads)],
  );
  return new Map(rows.rows.map(corner => {
    const author = reviewerIsAuthor(corner);
    const reviewerExists = Boolean(corner.configured_reviewer_id) && (!author || corner.reviewer_parent_member);
    const approvalPending = Boolean(corner.configured_reviewer_id) && !author && !corner.approved;
    const held = corner.holds.length > 0;
    const isWorkerYolo = corner.yolo_mode === true;
    return [corner.corner_id, {
      reviewerExists,
      reviewerIsAuthor: author,
      approvalPending,
      held,
      holds: corner.holds,
      isWorkerYolo,
      open: reviewerExists && !approvalPending && !held && isWorkerYolo,
    }];
  }));
}

/**
 * Corners the server should try to merge now: sitting in `land`, green on
 * their recorded head, with no merge attempted for that head yet. The merge
 * sweep reads live GitHub state only for these.
 */
export async function cornersReadyToLand(db: SqlDatabase): Promise<string[]> {
  const rows = await db.query<{ corner_id: string; number: number; head_sha: string }>(
    `SELECT fact.corner_id,(fact.lifecycle->'pr'->>'number')::int number,
            fact.lifecycle->'pr'->>'headSha' head_sha
     FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
     WHERE fact.workflow_state='land' AND corner.archived_at IS NULL
       AND fact.lifecycle->>'checks'='passing'
       AND fact.lifecycle->'pr'->>'number' ~ '^[0-9]+$'
       AND fact.lifecycle->'pr'->>'headSha' IS NOT NULL
       AND fact.merge_attempt_head IS DISTINCT FROM fact.lifecycle->'pr'->>'headSha'`,
  );
  if (!rows.rows.length) return [];
  const gates = await cornerMergeGates(db, rows.rows);
  return rows.rows.filter(row => gates.get(row.corner_id)?.open).map(row => row.corner_id);
}

/**
 * Claims the one server merge attempt for this head, under the run lock and
 * only while the run is in `land` on that head. Returns false when the head
 * was already attempted or the corner moved on, so concurrent sweeps and
 * redelivered events never merge a head twice. Stale unfinished claims are
 * recovered only after reading GitHub to establish whether the merge landed.
 */
export async function claimCornerMergeAttempt(
  database: SqlDatabase,
  cornerId: string,
  headSha: string,
): Promise<boolean> {
  return database.transaction(async (db) => {
    await lockCornerWorkflowRun(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    const pr = corner?.lifecycle.pr;
    if (!corner || corner.archived || corner.lifecycle.checks !== 'passing' ||
        !pr?.number || pr.headSha !== headSha) return false;
    // Recheck local authority at claim after the earlier gate read.
    // No provider request belongs in this transaction.
    if (!(await cornerMergeGate(db, cornerId, { number: pr.number, headSha })).open) return false;
    const claimed = await db.query(
      `UPDATE corner_facts SET merge_attempt_head=$2,lifecycle=lifecycle-'mergeRecovery',updated_at=now()
       WHERE corner_id=$1 AND workflow_state='land'
         AND lifecycle->'pr'->>'headSha'=$2
         AND merge_attempt_head IS DISTINCT FROM $2
       RETURNING 1`,
      [cornerId, headSha],
    );
    return claimed.rowCount > 0;
  });
}

/** Five minutes exceeds the 15-second provider read timeout by a wide margin. */
const MERGE_CLAIM_GRACE_SECONDS = 300;

/** Shared by the background scan and its revalidation under the run lock. */
export async function unfinishedCornerMergeClaims(db: SqlDatabase, cornerId?: string) {
  return (await db.query<{ corner_id: string; number: number; head_sha: string }>(
    `SELECT fact.corner_id,(fact.lifecycle->'pr'->>'number')::int number,
            fact.merge_attempt_head head_sha
     FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
     WHERE fact.workflow_state IN ('land','ask_human') AND corner.archived_at IS NULL
       AND fact.merge_attempt_head=fact.lifecycle->'pr'->>'headSha'
       AND fact.lifecycle->'pr'->>'number' ~ '^[1-9][0-9]*$'
       AND (COALESCE((fact.lifecycle->'mergeRecovery'->>'nextAttemptAt')::double precision,
             extract(epoch FROM fact.updated_at)+$1) <= extract(epoch FROM clock_timestamp())
         OR EXISTS (SELECT 1 FROM messages m JOIN identities i ON i.id=m.author_id AND i.kind='human'
           WHERE m.room_id=fact.corner_id AND m.presentation='message'
             AND m.created_at > to_timestamp(COALESCE((fact.lifecycle->'mergeRecovery'->>'lastAttemptAt')::double precision,
               extract(epoch FROM fact.updated_at)))))
       AND ($2::uuid IS NULL OR fact.corner_id=$2)
       AND NOT EXISTS (SELECT 1 FROM messages refusal WHERE refusal.id=
         encode(sha256(convert_to('beeline:'||fact.corner_id::text||':github:merge-refused:'||fact.merge_attempt_head,'UTF8')),'hex'))`,
    [MERGE_CLAIM_GRACE_SECONDS, cornerId ?? null],
  )).rows;
}

/** Clear only the unfinished claim whose provider state was just read. */
export async function clearUnfinishedCornerMergeClaim(
  database: SqlDatabase, cornerId: string, headSha: string, number: number,
) {
  return database.transaction(async db => {
    await lockCornerWorkflowRun(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    const claim = (await unfinishedCornerMergeClaims(db, cornerId))[0];
    if (!corner || claim?.head_sha !== headSha || claim.number !== number) return;
    const gate = await cornerMergeGate(db, cornerId, { number: claim.number, headSha });
    if ((await loadCornerWorkflowRunState(db, cornerId))?.toState === 'ask_human')
      await advanceCorner(db, cornerId, { kind: 'merge-refused', headSha, reason: 'GitHub confirmed the pull request has not merged' });
    await db.query(`UPDATE corner_facts SET merge_attempt_head=NULL,lifecycle=lifecycle-'mergeRecovery',updated_at=now() WHERE corner_id=$1`, [cornerId]);
    // Only the normal sweep can act on an open gate, with a fresh GitHub read
    // and claim. A closed gate still clears the stale claim for later recovery.
    return gate.open && corner.lifecycle.checks === 'passing';
  });
}

/**
 * Gives every corner without a projected run state its run: the newest card
 * for corners opened since #1918, or one derived from the lifecycle for
 * corners opened before it. Run once from `migrateData()`.
 */
export async function backfillCornerWorkflowRuns(database: SqlDatabase): Promise<number> {
  const missing = await database.query<{ corner_id: string }>(
    `SELECT corner_id FROM corner_facts WHERE workflow_state IS NULL`,
  );
  for (const row of missing.rows) {
    await database.transaction(async (db) => {
      await lockCornerWorkflowRun(db, row.corner_id);
      const run = await loadCornerWorkflowRunState(db, row.corner_id);
      if (run) {
        await projectRunState(db, row.corner_id, run.toState, run.outcome);
        return;
      }
      const corner = await loadCorner(db, row.corner_id);
      if (corner) await backfillRun(db, row.corner_id, corner);
    });
  }
  if (missing.rowCount)
    console.log(`backfillCornerWorkflowRuns: projected ${missing.rowCount} corner run(s)`);
  return missing.rowCount;
}

/**
 * Deletes the copy of the corner contract that older servers seeded into every
 * Workspace as a `corner` workflow, with its versions. The corner lifecycle
 * never read it. Every such row carries a version written by the seed's
 * `corner-workflow-v1` extractor; a workflow a person saves later under the
 * slug `corner` has none, so it survives every run of `migrateData()`.
 */
export async function deleteStoredCornerWorkflows(database: SqlDatabase): Promise<number> {
  const deleted = await database.query(
    `DELETE FROM workspace_skills skill
     WHERE skill.slug=$1 AND skill.kind='workflow'
       AND EXISTS (
         SELECT 1 FROM workspace_skill_versions version
         WHERE version.skill_id=skill.id AND version.extractor_version='corner-workflow-v1'
       )`,
    [CORNER_LIFECYCLE_SLUG],
  );
  if (deleted.rowCount)
    console.log(`deleteStoredCornerWorkflows: deleted ${deleted.rowCount} stored corner workflow(s)`);
  return deleted.rowCount;
}
