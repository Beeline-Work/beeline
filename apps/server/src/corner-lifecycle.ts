import { cornerLifecycleSql } from './corner-github-cache.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerReviewerSql } from './corner-reviewer.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { createHash } from 'node:crypto';
import { type CornerLifecycleContract, type WorkflowTerminalState } from '@beeline/api-contract/daemon';
import { cornerRunFromLifecycle, type CornerLifecycleView } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import { cornerImplementerSql } from './corner-worker.js';
import { firstHealthyAgent } from './agent-health.js';
import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';
import { ensureSystemIdentity, systemLine, type SystemLineInput } from './system-line.js';
import { workflowRunLockKey } from './workflow-runs.js';
import { wake, ensureReviewDispatch, checksReported, approvalRecorded, mergeRefused, blockingReview, CornerMergeGate, CornerMergeabilityInput, cornerMergeability } from './corner-lifecycle-checks-reported.js';
import { cornerMergeGate, confirmCornerMergeAuthority, backfillCornerLifecycleRuns, deleteStoredCornerWorkflows } from './corner-lifecycle-corner-merge-gate.js';



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
 * `closeCornerState`, and the merge in
 * `GitHubOperations.landCorner`) only REPORT their event. Under the run lock,
 * `advanceCorner` reads the run's current state, validates the edge against
 * `CORNER_LIFECYCLE_CONTRACT`, writes the
 * handoff card, and performs the edge's side effect — the one wake of the
 * next role. People are asked only for an explicit agent decision or a failed
 * agent wake. An event the current state does not allow changes nothing and is logged. No other code path
 * issues a corner lifecycle wake.
 *
 * The merge rule is one sentence: a pull request merges when its checks are
 * green on the current head (read live from GitHub) and a yes was said on
 * that head, unless a hold stands. The yes is a configured reviewer agent's
 * `approve_merge` PASS or a Workspace owner or admin's order
 * (`order_corner_merge` or the phone's approve call); the server lands either
 * at once through `GitHubOperations.landCorner`. A yes given while checks run
 * wakes the implementer to call `merge_corner` once they pass. A new commit cancels the yes; a
 * brief edit does not. The server does not referee who a reviewer is allowed
 * to be — a reviewer that wrote the code it is PASSing is a prompt
 * discipline, not a server gate. With no reviewer configured, green checks go
 * to review and wake the implementer to arrange review or explicitly ask for a
 * decision. A refused merge returns the corner to `implement` with GitHub's reason; the merge webhook moves it to
 * `landed`.
 *
 * The contract is plain TypeScript. It is not a Workspace workflow: it is
 * never stored in `workspace_skills`, never listed or started as one, and a
 * Workspace workflow saved with the slug `corner` has no effect on corners.
 * Its schema is separate from saved workflows. A
 * corner's run id is its own room id — one run for its whole life — and its
 * current state is the newest card citing that run (`corner-run.ts`); nothing
 * copies it onto the corner row.
 */
export const CORNER_LIFECYCLE_SLUG = 'corner';


export const CORNER_LIFECYCLE_CONTRACT: CornerLifecycleContract = {
  version: 1,
  name: CORNER_LIFECYCLE_SLUG,
  description: 'Corner lifecycle: build, check, get a yes, merge, or close',
  summary: 'Build the agreed change, check it, get a yes, and land it.',
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
    // configured later).
    implement: { does: 'Build and prove the agreed change.',
      role: 'implementer',
      requires: [],
      on: { pushed: 'checks', rechecked: 'checks', merge_refused: 'implement', pr_closed: 'implement' },
    },
    // Green wakes the reviewer (live from the parent Room's
    // `reviewer_agent_id`, or the corner override); with no reviewer
    // configured, zero checks ask the commander for a yes; other green heads
    // return the missing review decision to the implementer. Red wakes the
    // implementer, for every failing run, without a human escalation cap.
    checks: { does: 'Check the proposed change.',
      kind: 'server',
      requires: [],
      on: { passing: 'review', no_reviewer: 'review', failing: 'implement', pr_closed: 'implement' },
    },
    // Waiting for a yes on the current head. A reviewer's PASS
    // (`approve_merge`) or a person's order takes `approved`, and its caller
    // lands the corner at once. A reviewer turn that
    // ends without a PASS changes nothing: the reviewer's own message carries
    // any requested change to the implementer, whose next push restarts
    // checks. The merge webhook takes the implicit edge to `landed`; GitHub
    // refusing the merge returns to the implementer.
    review: { does: 'Wait for a yes on the current head.',
      role: 'reviewer',
      roleBinding: 'live:parent.reviewer_agent_id',
      requires: [],
      on: {
        approved: 'review',
        pr_closed: 'implement',
        pushed: 'checks',
        rechecked: 'checks',
        merge_refused: 'implement',
      },
    },
    landed: { does: 'The change has landed.', kind: 'terminal', status: 'done' },
    closed: { does: 'The corner has closed.', kind: 'terminal', status: 'abandoned' },
  },
  // The merge webhook and a close request end a corner from wherever it sits.
  implicitEdges: ['landed', 'closed'],
  // Only an event from outside the run takes these: a new commit on the
  // branch, a check verdict re-reported on the same head, a yes after a
  // handback, or GitHub refusing the merge.
  externalOutcomes: ['pushed', 'rechecked', 'merge_refused', 'pr_closed'],
};


/** Everything that can move a corner. Each adapter reports exactly one of these. */
export type CornerEvent =
  | { kind: 'open'; workspaceId: string; implementerAgentId: string }
  | { kind: 'push'; headSha: string; contents: Record<string, unknown> }
  | { kind: 'checks'; result: 'passing' | 'failing'; sourceMessageId: string; followup?: boolean }
  | {
      kind: 'brief-revised';
      revision: number;
      sourceMessageId: string;
      command: CommandRow;
    }
  /** Checks started again on the same head (a re-run); the verdict that follows is reported as `checks`. */
  | { kind: 'checks-pending' }
  /** A yes on this head: a reviewer's PASS or a person's order, landed by the caller. */
  | { kind: 'approval'; headSha: string; by: 'reviewer' | 'person' }
  | { kind: 'merge-refused'; headSha: string; reason: string; confirmedUnmerged?: boolean }
  | { kind: 'merged'; contents: Record<string, unknown> }
  | { kind: 'pull-request-closed'; number: number }
  | { kind: 'closed' };


export type RevisionWake = { queued: boolean; agentId?: string; reason?: string };

export type CornerAdvance = {
  wake?: RevisionWake;
  /** The run's state after the event, or undefined when the corner has no run. */
  state: string | undefined;
  /** False when the event was not allowed from the current state (logged). */
  accepted: boolean;
};


export type RunState = {
  toState: string;
  outcome: string | undefined;
  /** The PR head the newest card was written for. */
  headSha: string | undefined;
  roleBindings: Record<string, string>;
  seq: number;
};


export type CornerRow = {
  parent_id: string;
  workspace_id: string;
  worker_agent_id: string | null;
  lifecycle: CornerLifecycleView;
  archived: boolean;
  locked: boolean;
  configured_reviewer_id: string | null;
  configured_reviewer_kind: string | null;
  configured_reviewer_name: string | null;
  reviewer_parent_member: boolean;
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
 * Expand step for `corner_github_cache` (created in the server schema): copy the
 * old column once, then mirror both ways while older replicas still read and
 * write corner_facts.lifecycle. The IS DISTINCT FROM guards end the recursion.
 * The mirror is removed together with the corner_facts.lifecycle column.
 */
export const CORNER_GITHUB_CACHE_MIRROR_SQL = `
INSERT INTO corner_github_cache(corner_id,lifecycle)
  SELECT corner_id,lifecycle FROM corner_facts ON CONFLICT(corner_id) DO NOTHING;
CREATE OR REPLACE FUNCTION corner_facts_lifecycle_mirror() RETURNS trigger LANGUAGE plpgsql AS $mirror$
BEGIN
  INSERT INTO corner_github_cache(corner_id,lifecycle) VALUES(NEW.corner_id,NEW.lifecycle)
  ON CONFLICT(corner_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle
    WHERE corner_github_cache.lifecycle IS DISTINCT FROM EXCLUDED.lifecycle;
  RETURN NULL;
END $mirror$;
DROP TRIGGER IF EXISTS corner_facts_lifecycle_mirror ON corner_facts;
CREATE TRIGGER corner_facts_lifecycle_mirror AFTER INSERT OR UPDATE OF lifecycle ON corner_facts
  FOR EACH ROW EXECUTE FUNCTION corner_facts_lifecycle_mirror();
CREATE OR REPLACE FUNCTION corner_github_cache_mirror() RETURNS trigger LANGUAGE plpgsql AS $mirror$
BEGIN
  UPDATE corner_facts SET lifecycle=NEW.lifecycle
    WHERE corner_id=NEW.corner_id AND lifecycle IS DISTINCT FROM NEW.lifecycle;
  RETURN NULL;
END $mirror$;
DROP TRIGGER IF EXISTS corner_github_cache_mirror ON corner_github_cache;
CREATE TRIGGER corner_github_cache_mirror AFTER INSERT OR UPDATE OF lifecycle ON corner_github_cache
  FOR EACH ROW EXECUTE FUNCTION corner_github_cache_mirror();
`;


/**
 * The corner's own row: created once with the corner, then changed only by
 * this module (its lock and its reviewer). Its GitHub display cache row starts
 * with it and is then written only from GitHub (`corner_github_cache`).
 */
export async function createCornerFacts(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query(
    `INSERT INTO corner_facts(corner_id,lifecycle)
     VALUES($1,'{"lifecycle":"working","checks":"unknown"}') ON CONFLICT(corner_id) DO NOTHING`,
    [cornerId],
  );
  await db.query(`INSERT INTO corner_github_cache(corner_id) VALUES($1) ON CONFLICT(corner_id) DO NOTHING`, [cornerId]);
}


/** A person's lock: merges then keep the corner open (`corner lock`). */
export async function setCornerLockedFact(db: SqlDatabase, cornerId: string, locked: boolean): Promise<void> {
  await db.query(`UPDATE corner_facts SET locked=$2 WHERE corner_id=$1`, [cornerId, locked]);
}


/** Account deletion: corners whose own reviewer was a deleted agent fall back to their Room's. */
export async function clearCornerReviewers(db: SqlDatabase, agentIds: string[]): Promise<void> {
  await db.query(`UPDATE corner_facts SET reviewer_agent_id=NULL WHERE reviewer_agent_id=ANY($1)`, [agentIds]);
}


/** The corner's own reviewer; returns whether it changed. Callers check authority first. */
export async function setCornerReviewerFact(db: SqlDatabase, cornerId: string, reviewerId: string): Promise<boolean> {
  return ((await db.query(
    `UPDATE corner_facts SET reviewer_agent_id=$2
     WHERE corner_id=$1 AND reviewer_agent_id IS DISTINCT FROM $2 RETURNING corner_id`, [cornerId, reviewerId],
  )).rowCount ?? 0) > 0;
}


/**
 * The newest card wins. Ordering is this file's own monotonic `seq` embedded
 * in the card, never `created_at` (two cards written in one transaction can
 * share a timestamp) or the ids (a uuid start card and sha256 later cards).
 */
export async function loadCornerLifecycleState(
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


export async function loadCorner(db: SqlDatabase, cornerId: string): Promise<CornerRow | undefined> {
    db = new CornerAccessDatabase(db);
  return (
    await db.query<CornerRow>(
      `SELECT corner.parent_id,parent.workspace_id,
              ${cornerImplementerSql('fact', 'corner')} worker_agent_id,
              ${cornerLifecycleSql('fact.corner_id')},fact.locked,
              corner.archived_at IS NOT NULL archived,
              ${cornerReviewerSql()} configured_reviewer_id,
              configured.kind configured_reviewer_kind,
              configured.name configured_reviewer_name,
              EXISTS (
                SELECT 1 FROM memberships reviewer_membership
                JOIN identities reviewer ON reviewer.id=reviewer_membership.identity_id
                  AND reviewer.kind='agent'
                WHERE reviewer_membership.room_id=parent.id
                  AND reviewer_membership.identity_id=${cornerReviewerSql()}
                  AND reviewer_membership.removed_at IS NULL
              ) reviewer_parent_member
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       LEFT JOIN identities configured ON configured.id=${cornerReviewerSql()}
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
export async function cornerBookkeepingSubject(db: SqlDatabase): Promise<SystemLineInput['subject']> {
  await ensureSystemIdentity(db);
  return { kind: 'system', id: SYSTEM_IDENTITY_ID, name: systemMessage("corner-lifecycle.system") };
}


export function terminalStatus(toState: string): WorkflowTerminalState['status'] | undefined {
  const state = CORNER_LIFECYCLE_CONTRACT.handoffs[toState];
  return state?.kind === 'terminal' ? state.status : undefined;
}


/** The declared `on` edges of a state; empty for waiting and terminal states. */
export function edgesOf(stateName: string): Readonly<Record<string, string>> {
  // Historical cards can still name the removed automatic escalation state.
  if (stateName === 'ask_human') return {
    pushed: 'checks', rechecked: 'checks', revision_work: 'implement', merge_refused: 'implement', pr_closed: 'implement',
  };
  const state = CORNER_LIFECYCLE_CONTRACT.handoffs[stateName];
  return state && 'on' in state ? state.on : {};
}


export const REVIEWER_ROLE_BINDING = 'live:parent.reviewer_agent_id';


/**
 * Starts the run card (seq 0). `id` is the corner's own id, as `startWorkflow`
 * uses the run id, so a retried `createCorner` transaction cannot duplicate it.
 */
export async function writeStartCard(
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
    verb: systemMessage("corner-lifecycle.opened"),
    object: systemMessage("corner-lifecycle.corner"),
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
}


/**
 * One validated transition inside an `advanceCorner` transaction. The edge
 * must be declared on the current state (or be an implicit edge).
 */
export class Transition {
  constructor(
    private readonly db: SqlDatabase,
    private readonly cornerId: string,
    public run: RunState,
    /** The corner's current PR head; every card records the head it was written for. */
    private readonly headSha: string | undefined,
  ) {
    this.db = new CornerAccessDatabase(db);}

  /** The handoff card the last `take` wrote. */
  lastCardId: string | undefined;

  get state(): string {
    return this.run.toState;
  }

  allows(outcome: string): boolean {
    return Object.hasOwn(edgesOf(this.run.toState), outcome);
  }

  async take(
    outcome: string,
    contents: Record<string, unknown> = {},
  ): Promise<string> {
    const fromState = this.run.toState;
    const implicit = CORNER_LIFECYCLE_CONTRACT.implicitEdges?.includes(outcome) ?? false;
    if (!implicit && !this.allows(outcome))
      throw new Error(`corner contract has no ${fromState} --${outcome}--> edge`);
    const toState = implicit ? outcome : edgesOf(fromState)[outcome]!;
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
      verb: systemMessage("corner-lifecycle.handed-off"),
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


export function rejected(cornerId: string, event: CornerEvent, state: string | undefined, why: string) {
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
export async function backfillRun(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
): Promise<RunState> {
  const derived = cornerRunFromLifecycle({ archived: corner.archived, locked: corner.locked, lifecycle: corner.lifecycle });
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


export async function checksVerdictDispatched(
  db: SqlDatabase,
  cornerId: string,
  kind: 'check-passed' | 'check-failed',
  reason: string,
): Promise<boolean> {
  const dispatched = await db.query(
    `SELECT 1 FROM agent_commands command
     JOIN messages source ON source.id=command.source_message_id
     JOIN corner_github_cache fact ON fact.corner_id=command.room_id
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
      return { state: await transition.take(systemMessage("corner-lifecycle.opened")), accepted: true };
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
    // A green review state must carry a reviewer command even when the state
    // was entered while checks were already green or an earlier wake was lost.
    const reviewWake = transition.state === 'review' && !accepted.wake?.queued
      ? await ensureReviewDispatch(db, cornerId, corner, transition)
      : undefined;
    const wake = accepted.wake?.queued ? accepted.wake : reviewWake?.ok ? reviewWake.wake : accepted.wake;
    return { state: transition.state, accepted: true, ...(wake ? { wake } : {}) };
  });
}


export type Applied = { ok: true; wake?: RevisionWake } | { ok: false; why: string };

export const OK: Applied = { ok: true };

export const no = (why: string): Applied => ({ ok: false, why });


export async function applyEvent(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  transition: Transition,
  event: Exclude<CornerEvent, { kind: 'open' }>,
): Promise<Applied> {
  switch (event.kind) {
    case 'push':
      if (!transition.allows('pushed')) return no('no push edge');
      await transition.take(systemMessage("corner-lifecycle.pushed"), event.contents);
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
        await transition.take(systemMessage("corner-lifecycle.revision-work"), { briefRevision: event.revision });
      return { ok: true, wake: { queued: true, agentId } };
    }
    case 'checks-pending': {
      if (corner.lifecycle.checks !== 'pending' &&
          !corner.lifecycle.checksSummary?.checks?.some(check => check.status === 'pending'))
        return no(`checks are ${corner.lifecycle.checks}`);
      const verdictHolds =
        transition.state === 'review' || transition.state === 'ask_human' ||
        (transition.state === 'implement' &&
          transition.run.outcome === 'failing');
      if (!verdictHolds) return no('no checks verdict to re-run');
      await transition.take(systemMessage("corner-lifecycle.rechecked"));
      return OK;
    }
    case 'approval':
      return approvalRecorded(db, cornerId, corner, transition, event);
    case 'merge-refused':
      return mergeRefused(db, cornerId, corner, transition, event);
    case 'merged':
      // Landing wakes no one in the parent Room: the merge card announces it,
      // and an agent with work left after the merge subscribes to `merged`.
      await transition.take(corner.locked ? systemMessage("corner-lifecycle.pr-closed") : systemMessage("corner-lifecycle.landed"), event.contents);
      return OK;
    case 'pull-request-closed':
      if (corner.lifecycle.pr) return no('the corner still has a pull request');
      if (!transition.allows('pr_closed')) return no('no pull request close edge');
      await transition.take(systemMessage("corner-lifecycle.pr-closed"), { pullRequestNumber: event.number });
      return OK;
    case 'closed':
      await transition.take(systemMessage("corner-lifecycle.closed"));
      return OK;
  }
}


/** Where a checks verdict leads, decided before any card is written. */
export type ChecksPlan =
  | { outcome: 'failing' }
  | { outcome: 'no_reviewer' }
  | { outcome: 'passing'; approved: true }
  | { outcome: 'passing'; approved: false; reviewerAgentId: string };
export { blockingReview } from './corner-lifecycle-checks-reported.js';
export type { CornerMergeGate } from './corner-lifecycle-checks-reported.js';
export type { CornerMergeabilityInput } from './corner-lifecycle-checks-reported.js';
export { cornerMergeability } from './corner-lifecycle-checks-reported.js';
export { cornerMergeGate } from './corner-lifecycle-corner-merge-gate.js';
export { confirmCornerMergeAuthority } from './corner-lifecycle-corner-merge-gate.js';
export { backfillCornerLifecycleRuns } from './corner-lifecycle-corner-merge-gate.js';
export { deleteStoredCornerWorkflows } from './corner-lifecycle-corner-merge-gate.js';
