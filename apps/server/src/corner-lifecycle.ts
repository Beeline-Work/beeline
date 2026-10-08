import type { activeCornerHolds } from './corner-holds.js';
import { createHash } from 'node:crypto';
import type { CornerLifecycleContract, WorkflowTerminalState } from '@beeline/api-contract/daemon';
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
import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';
import { ensureSystemIdentity, GITHUB_SUBJECT, systemLine, type SystemLineInput } from './system-line.js';
import { workflowRunLockKey } from './workflow-runs.js';

/**
 * Lifecycle cards retain their persisted discriminator for existing history.
 * They carry no workflow event kind: lifecycle wakes belong to advanceCorner.
 * hiddenWakeCardSql excludes these rows from the human conversation, while
 * actual workflows keep their visible workflow-handoff cards.
 */

/**
 * The corner lifecycle as a declarative contract, and the one
 * authority that moves a corner through it.
 *
 * Every corner state change goes through `advanceCorner`: open, push,
 * checks passed/failed, review verdict, merge refusal, merge webhook, brief
 * revision and close. The callers (`createCorner`, `createHumanCorner`, the
 * GitHub webhook handlers, `routeSystemCommand`, `approveCornerMerge`,
 * `queueCornerWorkerAfterReview`, `closeCornerState`, and the merge in
 * `GitHubOperations.landCorner`) only REPORT their event. Under the run lock,
 * `advanceCorner` reads the run's current state, validates the edge against
 * `CORNER_LIFECYCLE_CONTRACT`, applies the contract's loop caps, writes the
 * handoff card, and performs the edge's side effect — the one wake of the
 * next role, or the line naming the commissioning human. An event the current
 * state does not allow changes nothing and is logged. No other code path
 * issues a corner lifecycle wake.
 *
 * The merge rule is one sentence: a pull request merges when its checks are
 * green on the current head (read live from GitHub) and a non-author said yes
 * on that head, unless a hold stands. The yes is a configured reviewer
 * agent's `approve_merge` PASS (it wakes the implementer, whose
 * `merge_corner` runs `GitHubOperations.landCorner`) or a Workspace owner or
 * admin's order (`order_corner_merge` or the phone's approve call), which the
 * server lands at once through the same `landCorner`. A new commit cancels
 * the yes; a brief edit does not. With no other agent to review (no reviewer,
 * or the reviewer is the author) green checks go straight to waiting for a
 * person's yes. A refused merge returns the corner to `implement` with
 * GitHub's reason; the merge webhook moves it to `landed`.
 *
 * The contract is plain TypeScript. It is not a Workspace workflow: it is
 * never stored in `workspace_skills`, never listed or started as one, and a
 * Workspace workflow saved with the slug `corner` has no effect on corners.
 * Its schema is separate from saved workflows. A
 * corner's run id is its own room id — one run for its whole life — and its
 * current state is the newest card citing that run, projected onto
 * `corner_facts.workflow_state`/`workflow_outcome` in the same transaction
 * for the phone badge and the merge gate.
 */
export const CORNER_LIFECYCLE_SLUG = 'corner';

export const CORNER_LIFECYCLE_CONTRACT: CornerLifecycleContract = {
  version: 1,
  name: CORNER_LIFECYCLE_SLUG,
  description: 'Corner lifecycle: build, check, get a yes, merge, or close',
  summary: 'Build the agreed change, check it, get a non-author yes, and land it.',
  roles: ['implementer', 'reviewer'],
  start: 'opened',
  handoffs: {
    // `createCorner` / `createHumanCorner` report `open` in the same
    // transaction that opens the Room; every corner starts implementing. A
    // corner in a Room without a repository simply never pushes.
    opened: { does: 'Set up the corner for the agreed work.',
      kind: 'server',
      requires: [],
      on: { opened: 'implement' },
    },
    // The implementer's turn. A push reported by the GitHub webhook moves it
    // to checks. `rechecked` is a checks verdict on the same head arriving
    // after the one that sent the corner here (a re-run, or a reviewer
    // configured later); `rereview` is a yes on the same head after a
    // changes-requested handback.
    implement: { does: 'Build and prove the agreed change.',
      role: 'implementer',
      requires: [],
      on: { pushed: 'checks', rechecked: 'checks', rereview: 'review' },
    },
    // Green wakes the reviewer (live from the parent Room's
    // `reviewer_agent_id`/`reviewer_fallback_ids`); with no reviewer, or a
    // reviewer who is the author, green waits for a person's yes and says so.
    // Red wakes the implementer. At the loop cap the corner names the
    // commissioning human.
    checks: { does: 'Check the proposed change.',
      kind: 'server',
      requires: [],
      on: { passing: 'review', no_reviewer: 'review', failing: 'implement' },
      loop: { onEdge: 'failing', cap: 100, onExceeded: 'ask_human' },
    },
    // Waiting for a non-author yes on the current head. A reviewer's PASS
    // (`approve_merge`) takes `approved` and wakes the implementer to call
    // `merge_corner`; a person's order lands at once. The end of a review
    // turn with no yes for the current head hands back to the implementer;
    // the handback cap is counted per head and reset by a push
    // (`corner_facts.review_handback_head/count`). The merge webhook takes the
    // implicit edge to `landed`; GitHub refusing the merge returns to the
    // implementer.
    review: { does: 'Wait for a non-author yes on the current head.',
      role: 'reviewer',
      roleBinding: 'live:parent.reviewer_agent_id',
      requires: [],
      on: {
        approved: 'review',
        changes_requested: 'implement',
        pushed: 'checks',
        rechecked: 'checks',
        merge_refused: 'implement',
        merge_unconfirmed: 'ask_human',
      },
      loop: { onEdge: 'changes_requested', cap: 3, onExceeded: 'ask_human' },
    },
    // A loop cap was reached. The corner names the commissioning human and
    // waits; a new push starts the next round.
    ask_human: { does: 'Wait for a person to decide the next step.', kind: 'server', requires: [], on: { pushed: 'checks', revision_work: 'implement', merge_refused: 'implement' } },
    landed: { does: 'The change has landed.', kind: 'terminal', status: 'done' },
    closed: { does: 'The corner has closed.', kind: 'terminal', status: 'abandoned' },
  },
  // The merge webhook and a close request end a corner from wherever it sits.
  implicitEdges: ['landed', 'closed'],
  // Only an event from outside the run takes these: a new commit on the
  // branch, a check verdict re-reported on the same head, a yes after a
  // handback, or GitHub refusing the merge.
  externalOutcomes: ['pushed', 'rechecked', 'rereview', 'merge_refused'],
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

/** Everything that can move a corner. Each adapter reports exactly one of these. */
export type CornerEvent =
  | { kind: 'open'; workspaceId: string; implementerAgentId: string }
  | { kind: 'push'; headSha: string; contents: Record<string, unknown> }
  | { kind: 'checks'; result: 'passing' | 'failing'; sourceMessageId: string }
  | {
      kind: 'brief-revised';
      revision: number;
      sourceMessageId: string;
      command: CommandRow;
    }
  /** Checks started again on the same head (a re-run); the verdict that follows is reported as `checks`. */
  | { kind: 'checks-pending' }
  /** A non-author yes on this head: a reviewer's PASS wakes the implementer to merge; a person's order is landed by the caller. */
  | { kind: 'approval'; headSha: string; by: 'reviewer' | 'person' }
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
export async function lockCornerLifecycle(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [workflowRunLockKey(cornerId)]);
}

/**
 * The newest card wins. Ordering is this file's own monotonic `seq` embedded
 * in the card, never `created_at` (two cards written in one transaction can
 * share a timestamp) or the ids (a uuid start card and sha256 later cards).
 */
async function loadCornerLifecycleState(
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
      [cornerId, CORNER_LIFECYCLE_CARD_TYPE],
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
              corner.archived_at IS NOT NULL archived,
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
 * Every corner lifecycle card is authored by `@system`, never by the corner's
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
    verb: 'opened',
    object: 'corner',
    // Never a chat line: `hiddenWakeCardSql` excludes this card type from the
    // transcript a human reads.
    presentation: 'card',
    cardType: CORNER_LIFECYCLE_CARD_TYPE,
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

  /** The handoff card the last `take` wrote. */
  lastCardId: string | undefined;

  get state(): string {
    return this.run.toState;
  }

  allows(outcome: string): boolean {
    return Object.hasOwn(edgesOf(this.run.toState), outcome);
  }

  /**
   * `loopCount` is this trip's number around the state's loop, when the edge
   * is its loop edge.
   */
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
    const card = await systemLine(this.db, {
      id: createHash('sha256')
        .update(`beeline:corner-workflow:${this.cornerId}:${seq}:${fromState}:${outcome}`)
        .digest('hex'),
      roomId: this.cornerId,
      authorId: SYSTEM_IDENTITY_ID,
      subject,
      verb: 'handed off',
      object: toState,
      // The card never wakes anyone itself (no `wakes`); the one wake of the
      // next role is this transition's own side effect in `advanceCorner`.
      presentation: 'card',
      cardType: CORNER_LIFECYCLE_CARD_TYPE,
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
    this.lastCardId = card.id;
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
    `[corner-lifecycle] ${cornerId}: ignored ${event.kind} in ${state ?? 'no run'}: ${why}`,
  );
}

/**
 * The run a corner opened before the workflow run existed (#1918) is given
 * once, derived from its lifecycle (`cornerRunFromLifecycle`, the mapping the
 * phone badge uses) and from what was already dispatched for its current head:
 * a checks verdict whose wake
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
  if (toState === 'review') {
    if (!(await checksVerdictDispatched(db, cornerId, 'check-passed', 'subscribed_event')))
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
    await lockCornerLifecycle(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    if (!corner) {
      rejected(cornerId, event, undefined, 'corner not found');
      return { state: undefined, accepted: false };
    }
    let run = await loadCornerLifecycleState(db, cornerId);
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
      return { state: await transition.take('opened'), accepted: true };
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
    case 'push':
      if (!transition.allows('pushed')) return no('no push edge');
      await transition.take('pushed', event.contents);
      return OK;
    case 'checks':
      return checksReported(db, cornerId, corner, transition, event);
    case 'brief-revised': {
      // A brief edit wakes the implementer; it never cancels a yes or sends
      // the corner back to review.
      const agentId = corner.worker_agent_id
        ? await firstHealthyAgent(db, cornerId, [corner.worker_agent_id])
        : null;
      if (!agentId) return { ok: true, wake: { queued: false, reason: 'No reachable implementer for the revision' } };
      const command = await createAgentCommand(db, {
        roomId: cornerId,
        agentId,
        sourceMessageId: event.sourceMessageId,
        reason: 'corner_brief_revision',
        parent: event.command,
        retainDepth: true,
      });
      if (!command) return { ok: true, wake: { queued: false, reason: 'The revision recipient cannot be woken' } };
      if (transition.state === 'ask_human')
        await transition.take('revision_work', { briefRevision: event.revision });
      return { ok: true, wake: { queued: true, agentId } };
    }
    case 'checks-pending': {
      if (corner.lifecycle.checks !== 'pending') return no(`checks are ${corner.lifecycle.checks}`);
      const verdictHolds =
        transition.state === 'review' ||
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
  | { outcome: 'passing'; approved: true }
  | { outcome: 'passing'; approved: false; reviewerAgentId: string };

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
  if (!['checks', 'implement', 'review'].includes(from)) return no('no checks edge');
  const headSha = corner.lifecycle.pr?.headSha ?? null;
  const sameHead = transition.run.headSha === (headSha ?? undefined);
  // A repeat of the green verdict that already holds changes nothing, and
  // must not spend a reviewer pick, a membership repair, or a note. A head
  // waiting for a person's yes is re-planned: a reviewer configured since
  // then is woken.
  if (event.result === 'passing' && from === 'review' && sameHead && transition.run.outcome !== 'no_reviewer')
    return no('checks already passed on this head');
  let plan: ChecksPlan;
  if (event.result === 'failing') plan = { outcome: 'failing' };
  // A yes given while checks ran (a PASS or a person's order) needs no review.
  else if (await approvedCurrentHead(db, cornerId, corner)) plan = { outcome: 'passing', approved: true };
  // No other agent can review the author's own work, so a person's yes is
  // the only way it merges.
  else if (!corner.configured_reviewer_id || (corner.reviewer_parent_member && reviewerIsAuthor(corner)))
    plan = { outcome: 'no_reviewer' };
  else {
    const reviewerAgentId = await reachableReviewer(db, cornerId, corner, event.sourceMessageId, headSha);
    if (!reviewerAgentId) return no('configured reviewer is unreachable');
    plan = { outcome: 'passing', approved: false, reviewerAgentId };
  }
  if (from === 'review' && sameHead && plan.outcome === 'no_reviewer')
    return no('already waiting for a yes on this head');
  if (from === 'implement' && sameHead) {
    const repeat =
      transition.run.outcome === plan.outcome ||
      // The reviewer already ended a review on this head with a
      // changes-requested handback. A re-reported green for the same head is
      // not a new review: the implementer still owes a push, so do not wake
      // the reviewer again.
      (plan.outcome !== 'failing' && transition.run.outcome === 'changes_requested');
    if (repeat) return no(`${plan.outcome} already holds on this head`);
  }
  const failingRound =
    plan.outcome === 'failing' ? (await countEdges(db, cornerId, 'checks', 'failing')) + 1 : undefined;
  const capped = failingRound !== undefined && failingRound > CHECKS_FAILING_LIMIT;
  // The wake goes out first: a verdict whose wake cannot be delivered (the
  // implementer is no longer a member) leaves the run in place, so the next
  // report of the same verdict retries it.
  if (plan.outcome === 'failing' && !capped) {
    if (!corner.worker_agent_id) return no('the corner has no implementer');
    const command = await createAgentCommand(db, {
      roomId: cornerId,
      agentId: corner.worker_agent_id,
      sourceMessageId: event.sourceMessageId,
      reason: 'corner_check',
    });
    if (!command) return no('the implementer cannot be woken');
  } else if (plan.outcome === 'passing' && !plan.approved) {
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
  if (plan.outcome === 'no_reviewer') {
    await ensureSystemIdentity(db);
    await systemLine(db, {
      id: createHash('sha256').update(`beeline:${cornerId}:waiting-for-yes:${headSha ?? event.sourceMessageId}`).digest('hex'),
      roomId: cornerId,
      authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: 'A Workspace owner or admin' },
      verb: 'needs to approve',
      object: 'this pull request',
      consequence: 'checks passed and no other agent can review it',
      afterMessageId: event.sourceMessageId,
    });
    return OK;
  }
  if (plan.outcome === 'passing' && plan.approved) {
    await transition.take('approved', { verdict: 'approved' });
    await wakeToLand(db, cornerId, corner, transition);
  }
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
): Promise<string | undefined> {
  if (!corner.configured_reviewer_id) return undefined;
  if (corner.reviewer_fallback_ids.length)
    return dispatchableListReviewer(db, cornerId, corner, sourceMessageId, headSha);
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
): Promise<string | undefined> {
  const list = reviewerList({
    reviewer_agent_id: corner.configured_reviewer_id,
    reviewer_fallback_ids: corner.reviewer_fallback_ids,
  }).filter((id) => id !== corner.owner_agent_id);
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
    await lockCornerLifecycle(db, input.roomId);
    const corner = await loadCorner(db, input.roomId);
    if (!corner?.configured_reviewer_id || !corner.reviewer_fallback_ids.length) return;
    if (corner.lifecycle.checks !== 'passing') return;
    const run = await loadCornerLifecycleState(db, input.roomId);
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
  // A yes while checks still run is kept; the checks-passed that follows it
  // skips the review.
  if (corner.lifecycle.checks !== 'passing') return no('checks are not green yet');
  if (transition.state === 'implement' && transition.run.outcome === 'changes_requested')
    await transition.take('rereview');
  if (transition.state !== 'review') return no('not waiting for a yes');
  await transition.take('approved', { verdict: 'approved', headSha: event.headSha });
  // A person's order is landed by its caller at once; nobody else is woken.
  if (event.by === 'reviewer') await wakeToLand(db, cornerId, corner, transition);
  return OK;
}

/** A reviewer's PASS hands the merge to the implementer (`merge_corner`). */
async function wakeToLand(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
): Promise<void> {
  if (corner.worker_agent_id && transition.lastCardId)
    await wake(db, cornerId, corner.worker_agent_id, transition.lastCardId, 'corner_land');
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
  if (await approvedCurrentHead(db, cornerId, corner)) return no('the current head has a yes');
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
      [cornerId, CORNER_LIFECYCLE_CARD_TYPE, fromState, outcome],
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
 * approve_merge can ever exist for it, so only a human's
 * `order_corner_merge` merges it.
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

/** A non-author yes on the corner's current head (`cornerMergeGate`'s `approved`). */
async function approvedCurrentHead(
  db: SqlDatabase,
  cornerId: string,
  corner: Pick<CornerRow, 'lifecycle'>,
): Promise<boolean> {
  const pr = corner.lifecycle.pr;
  if (!pr?.headSha || !pr.number) return false;
  return (await cornerMergeGate(db, cornerId, { number: pr.number, headSha: pr.headSha })).approved;
}

export type CornerMergeGate = {
  /** A reviewer is configured; one who is the author must also be a current parent member. */
  reviewerExists: boolean;
  reviewerIsAuthor: boolean;
  /**
   * A non-author said yes on this exact head: a configured reviewer agent's
   * PASS (never the author's), or a current Workspace owner or admin's order.
   */
  approved: boolean;
  held: boolean;
  holds: Awaited<ReturnType<typeof activeCornerHolds>>;
  /** Everything but checks: a yes on this head and no hold. */
  open: boolean;
};

/**
 * The merge gate for one exact PR head, minus the checks verdict (the caller
 * supplies that live from GitHub). Shared by `pr_checks_status` and the server
 * merge, so the gate an agent reads is the gate `landCorner` merges on.
 */
export async function cornerMergeGate(
  db: SqlDatabase,
  cornerId: string,
  head: { number: number; headSha: string },
): Promise<CornerMergeGate> {
  const rows = await db.query<{
    owner_agent_id: string | null;
    configured_reviewer_id: string | null;
    reviewer_parent_member: boolean;
    reviewer_fallback_ids: string[];
    approved: boolean;
    holds: CornerMergeGate['holds'];
  }>(
      `SELECT fact.owner_agent_id,
              parent.reviewer_agent_id configured_reviewer_id,parent.reviewer_fallback_ids,
              EXISTS (
                SELECT 1 FROM memberships member JOIN identities reviewer ON reviewer.id=member.identity_id
                WHERE member.room_id=parent.id AND member.identity_id=parent.reviewer_agent_id
                  AND member.removed_at IS NULL AND reviewer.kind='agent'
              ) reviewer_parent_member,
              EXISTS (
                SELECT 1 FROM corner_merge_approvals approval
                WHERE approval.corner_id=fact.corner_id AND approval.pull_request_number=$2
                  AND approval.head_sha=$3
                  AND (
                    -- A configured reviewer agent, still a parent member, who is not the author.
                    EXISTS (
                      SELECT 1 FROM memberships member
                      JOIN identities reviewer ON reviewer.id=member.identity_id AND reviewer.kind='agent'
                      WHERE member.room_id=parent.id AND member.identity_id=approval.approved_by
                        AND member.removed_at IS NULL
                        AND approval.approved_by IS DISTINCT FROM fact.owner_agent_id
                        AND (approval.approved_by=parent.reviewer_agent_id
                          OR approval.approved_by=ANY(parent.reviewer_fallback_ids))
                    )
                    -- Or a current Workspace owner or admin.
                    OR EXISTS (
                      SELECT 1 FROM memberships workspace_member
                      JOIN identities person ON person.id=workspace_member.identity_id AND person.kind='human'
                      WHERE workspace_member.workspace_id=corner.workspace_id
                        AND workspace_member.room_id IS NULL
                        AND workspace_member.identity_id=approval.approved_by
                        AND workspace_member.removed_at IS NULL
                        AND workspace_member.role IN ('owner','admin')
                    )
                  )
              ) approved,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hold.id::text,'actorId',hold.actor_id,
                'standing',hold.standing,'setAt',hold.set_at::text) ORDER BY hold.set_at,hold.id)
                FROM corner_merge_holds hold WHERE hold.corner_id=fact.corner_id AND hold.released_at IS NULL),
                '[]'::jsonb) holds
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       WHERE fact.corner_id=$1`,
    [cornerId, head.number, head.headSha],
  );
  const corner = rows.rows[0];
  if (!corner) throw new Error('corner not found');
  const author = reviewerIsAuthor(corner);
  const held = corner.holds.length > 0;
  return {
    reviewerExists: Boolean(corner.configured_reviewer_id) && (!author || corner.reviewer_parent_member),
    reviewerIsAuthor: author,
    approved: corner.approved,
    held,
    holds: corner.holds,
    open: corner.approved && !held,
  };
}

/**
 * Claims the one merge attempt for this head, under the run lock and only
 * while the gate is open on that head. Returns false when the head was
 * already attempted or the corner moved on, so concurrent `merge_corner`
 * calls and redelivered events never merge a head twice. Stale unfinished claims are
 * recovered only after reading GitHub to establish whether the merge landed.
 */
export async function claimCornerMergeAttempt(
  database: SqlDatabase,
  cornerId: string,
  headSha: string,
): Promise<boolean> {
  return database.transaction(async (db) => {
    await lockCornerLifecycle(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    const pr = corner?.lifecycle.pr;
    if (!corner || corner.archived || !pr?.number || pr.headSha !== headSha) return false;
    // Recheck local authority at claim after the earlier gate read.
    // No provider request belongs in this transaction.
    const gate = await cornerMergeGate(db, cornerId, { number: pr.number, headSha });
    if (!gate.open) return false;
    const claimed = await db.query(
      `UPDATE corner_facts SET merge_attempt_head=$2,lifecycle=lifecycle-'mergeRecovery',updated_at=now()
       WHERE corner_id=$1
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
     WHERE fact.workflow_state IN ('review','ask_human') AND corner.archived_at IS NULL
       AND fact.merge_attempt_head=fact.lifecycle->'pr'->>'headSha'
       AND fact.lifecycle->'pr'->>'number' ~ '^[1-9][0-9]*$'
       AND (COALESCE((fact.lifecycle->'mergeRecovery'->>'nextAttemptAt')::double precision,
             extract(epoch FROM fact.updated_at)+$1) <= extract(epoch FROM clock_timestamp())
         OR (fact.lifecycle ? 'mergeRecovery' AND EXISTS (SELECT 1 FROM messages m JOIN identities i ON i.id=m.author_id AND i.kind='human'
           WHERE m.room_id=fact.corner_id AND m.presentation='message'
             AND m.created_at > to_timestamp((fact.lifecycle->'mergeRecovery'->>'lastAttemptAt')::double precision))))
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
    await lockCornerLifecycle(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    const claim = (await unfinishedCornerMergeClaims(db, cornerId))[0];
    if (!corner || claim?.head_sha !== headSha || claim.number !== number) return;
    const gate = await cornerMergeGate(db, cornerId, { number: claim.number, headSha });
    const refused = (await loadCornerLifecycleState(db, cornerId))?.toState === 'ask_human';
    if (refused)
      await advanceCorner(db, cornerId, { kind: 'merge-refused', headSha, reason: 'GitHub confirmed the pull request has not merged' });
    await db.query(`UPDATE corner_facts SET merge_attempt_head=NULL,lifecycle=lifecycle-'mergeRecovery',updated_at=now() WHERE corner_id=$1`, [cornerId]);
    // Only a fresh land attempt can act on an open gate, with a fresh GitHub read
    // (live checks) and claim. A closed gate, or a head just handed back as
    // refused, still clears the stale claim for later recovery.
    return !refused && gate.open;
  });
}

/**
 * Gives every corner without a projected run state its run: the newest card
 * for corners opened since #1918, or one derived from the lifecycle for
 * corners opened before it. Run once from `migrateData()`.
 */
export async function backfillCornerLifecycleRuns(database: SqlDatabase): Promise<number> {
  const missing = await database.query<{ corner_id: string }>(
    `SELECT corner_id FROM corner_facts WHERE workflow_state IS NULL`,
  );
  for (const row of missing.rows) {
    await database.transaction(async (db) => {
      await lockCornerLifecycle(db, row.corner_id);
      const run = await loadCornerLifecycleState(db, row.corner_id);
      if (run) {
        await projectRunState(db, row.corner_id, run.toState, run.outcome);
        return;
      }
      const corner = await loadCorner(db, row.corner_id);
      if (corner) await backfillRun(db, row.corner_id, corner);
    });
  }
  if (missing.rowCount)
    console.log(`backfillCornerLifecycleRuns: projected ${missing.rowCount} corner run(s)`);
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
