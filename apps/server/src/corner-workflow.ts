import { createHash, randomBytes } from 'node:crypto';
import type { WorkflowContract, WorkflowTerminalState } from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { CORNER_WORKFLOW_HANDOFF_CARD_TYPE } from './room-choice.js';
import { ensureSystemIdentity, systemLine, type SystemLineInput } from './system-line.js';
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
 * workflow — ARE the real, intended visible handoff notice, not corner-style
 * redundant bookkeeping over an unrelated real conversation.
 */

/**
 * The corner lifecycle expressed as the same declarative workflow contract a
 * saved skill uses (see `packages/api-contract/src/workflow-contracts.ts`),
 * seeded once per Workspace so it is discoverable and loadable exactly like
 * any other workflow. Nothing about corner behavior is driven by this
 * contract or by anything in this file: `createCorner`, `upgradeCornerLane`,
 * the GitHub webhook handlers, `routeSystemCommand`, and `closeCornerState`
 * remain the sole authority for every real dispatch, mutation and merge
 * decision, exactly as documented in AGENTS.md and unchanged by this feature
 * (report: data/beeline-workflow-contracts-design/report.md, section E
 * finding 2). This file only RECORDS those existing decisions as durable
 * `workflow-handoff` cards, in the same shape and room the generic
 * `save_workflow`/`start_workflow`/`handoff` engine (`workflow-runs.ts`)
 * already produces, so a corner's current step is queryable the same way any
 * other workflow run's is: the most recent `workflow-handoff` card citing its
 * runId (which is simply the corner's own room id — a corner has exactly one
 * run, for its whole life).
 *
 * Every export here is defensive by construction: a failure in this file
 * must never break the real corner operation it is merely describing, so
 * every entry point catches and logs instead of throwing.
 */
export const CORNER_WORKFLOW_SLUG = 'corner';

export const CORNER_WORKFLOW_CONTRACT: WorkflowContract = {
  version: 1,
  name: CORNER_WORKFLOW_SLUG,
  description: 'Corner lifecycle: implement, check, review, land, or close',
  roles: ['implementer', 'reviewer'],
  start: 'opened',
  handoffs: {
    // Lane is decided by `createCorner` itself, in the same transaction that
    // opens the Room (daemon-service.ts ~5982-6156) — never a later agent
    // choice, so this state and its outcome are both server-authored.
    opened: {
      kind: 'server',
      requires: [],
      on: { no_code: 'no_code_work', code: 'implement', research: 'investigate' },
    },
    // No dedicated server op moves work here; it is the opener's own turn.
    // The only programmatic exit is a human asking for the code upgrade.
    no_code_work: { role: 'implementer', requires: [], on: { upgrade_requested: 'upgrade_to_code' } },
    // `upgradeCornerLane` (daemon-service.ts): one human-authored command,
    // atomic lane flip + feature-branch write (which IS the CI callback
    // registration — GitHub webhook matching joins on it) + brief synthesis.
    upgrade_to_code: {
      kind: 'server',
      requires: ['branch', 'repositoryRoute', 'ciCallbackRegistered', 'mergeTarget'],
      on: { upgraded: 'implement' },
    },
    // A research-lane corner never merges (`pr_checks_status` holds it
    // unconditionally); it only ever leaves through a human close.
    investigate: { kind: 'waiting', role: 'implementer' },
    // The implementer's own turn; a push is observed by the GitHub webhook
    // (github-operations.ts `processCornerEvent`'s push handling), not by
    // any direct mutation at push time itself.
    implement: { role: 'implementer', requires: ['summary'], on: { pushed: 'checks' } },
    // `routeSystemCommand`'s check-passed/check-failed dispatch (agent-command.ts)
    // decides passing/failing/no_reviewer; nothing here duplicates that cap,
    // the corner's own checks-failing retry genuinely has no limit today, so
    // this loop cap is a documented outer bound the real dispatch never
    // itself enforces.
    checks: {
      kind: 'server',
      requires: [],
      on: { passing: 'review', failing: 'implement', no_reviewer: 'implement' },
      loop: { onEdge: 'failing', cap: 100, onExceeded: 'ask_human' },
    },
    // The reviewer role resolves LIVE from the parent Room's current
    // `reviewer_agent_id` at every dispatch (report finding 1) — never
    // pinned at start, since `reconcileConfiguredCornerReviewers` can repair
    // or reassign it on an already-open corner. The real cap is
    // `REVIEW_HANDBACK_LIMIT` in `queueCornerWorkerAfterReview`
    // (agent-command.ts); this loop mirrors that exact value for the
    // contract's own reachability/cycle validation, it does not recompute it.
    review: {
      role: 'reviewer',
      roleBinding: 'live:parent.reviewer_agent_id',
      requires: ['verdict'],
      on: { approved: 'land', changes_requested: 'implement', exceeded: 'ask_human' },
      loop: { onEdge: 'changes_requested', cap: 3, onExceeded: 'ask_human' },
    },
    // The handback-limit escalation: a plain informational line naming the
    // commissioning human today, not a choice card (report section B).
    ask_human: { kind: 'waiting' },
    // Reached only on review approval. The implementer runs `gh pr merge`
    // itself; the server never merges. Left however long that takes — the
    // only way out is the merge webhook (implicit edge to `landed`) or a
    // close (implicit edge to `closed`), from here exactly like from
    // anywhere else (report finding 3).
    land: { kind: 'waiting', role: 'implementer' },
    landed: { kind: 'terminal', status: 'done' },
    closed: { kind: 'terminal', status: 'abandoned' },
  },
  // The merge webhook and a close request archive a corner from wherever it
  // sits — mid-review, mid-checks, even `no_code_work` — never only from
  // `land`/a dedicated pre-close state (report finding 3).
  implicitEdges: ['landed', 'closed'],
};

type CornerWorkflowRunState = {
  toState: string;
  roleBindings: Record<string, string>;
  workflowVersion: number;
  seq: number;
};

/**
 * `startCornerWorkflowRun` and `upgradeCornerLane`'s bookkeeping each write
 * TWO cards back to back, inside one transaction — close enough in time that
 * Postgres can give both the identical `created_at` (millisecond
 * resolution), at which point `ORDER BY created_at,id` ties on the RAW id
 * string. This corner's own bookkeeping ids are a mix of the corner's uuid
 * (the start card) and sha256 hex hashes (every card after it), so that tie
 * would sort by an accident of hex digits rather than write order — the
 * exact failure mode AGENTS.md's system-line bullet calls out generally
 * ("never encode ordering into id tie-breaks or same-second expectations").
 * Ordering here is instead this file's own monotonic `seq` embedded in the
 * card, independent of wall-clock resolution or the generic engine's cause
 * cascade (whose bounded depth is meant for agent wake fan-out, not a single
 * run's own potentially long transition history).
 */

/**
 * Serializes one corner run's whole read-current-state -> write-next-card
 * sequence, exactly mirroring `workflow-runs.ts`'s `lockWorkflowRun` (same
 * key format, `pg_advisory_xact_lock(hashtext('workflow-run:'+runId))`, so a
 * hypothetical id collision between a corner's own room-id-as-runId and a
 * generic engine run just serializes harmlessly against the same lock rather
 * than silently disagreeing about the key). Taken as the transaction's FIRST
 * statement. Without this, two independent round trips against the same
 * corner (a push landing the same moment as a close, or a redelivered
 * webhook) can both read the same prior `seq` before either write commits,
 * and both insert a card at `seq+1` — `ORDER BY (card->>'seq')::int DESC`
 * has no secondary key, so which one reads as "current" is arbitrary.
 */
async function lockCornerWorkflowRun(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [workflowRunLockKey(cornerId)]);
}

async function loadCornerWorkflowRunState(
  db: SqlDatabase,
  cornerId: string,
): Promise<CornerWorkflowRunState | undefined> {
  const row = (
    await db.query<{
      to_state: string;
      role_bindings: Record<string, string> | null;
      workflow_version: number | null;
      seq: number | null;
    }>(
      `SELECT card->>'toState' to_state, card->'roleBindings' role_bindings,
              (card->>'workflowVersion')::int workflow_version, (card->>'seq')::int seq
       FROM messages
       WHERE room_id=$1::uuid AND card_type=$2 AND card->>'runId'=$1::text
       ORDER BY (card->>'seq')::int DESC LIMIT 1`,
      [cornerId, CORNER_WORKFLOW_HANDOFF_CARD_TYPE],
    )
  ).rows[0];
  if (!row?.to_state) return undefined;
  return {
    toState: row.to_state,
    roleBindings: row.role_bindings ?? {},
    workflowVersion: row.workflow_version ?? 1,
    seq: row.seq ?? 0,
  };
}

/**
 * Every corner-workflow card is authored by `@system`, never by the corner's
 * own implementer or reviewer agent — a card "written" by the same agent id
 * a query elsewhere counts as that agent's own conversational messages (a
 * tagged-question count, a per-agent transcript scan) would otherwise inflate
 * that count with bookkeeping noise the agent never actually said. `@system`
 * rows are already the established shape for exactly this kind of structural
 * fact and are excluded or specially handled everywhere that distinction
 * matters (AGENTS.md's system-identity bullet).
 */
async function cornerBookkeepingSubject(db: SqlDatabase): Promise<SystemLineInput['subject']> {
  await ensureSystemIdentity(db);
  return { kind: 'system', id: SYSTEM_IDENTITY_ID, name: '@system' };
}

async function currentCornerWorkflowVersion(db: SqlDatabase, workspaceId: string): Promise<number> {
  const row = (
    await db.query<{ current_version: number }>(
      `SELECT current_version FROM workspace_skills
       WHERE workspace_id=$1 AND slug=$2 AND kind='workflow'`,
      [workspaceId, CORNER_WORKFLOW_SLUG],
    )
  ).rows[0];
  return row?.current_version ?? 1;
}

function terminalStatus(toState: string): WorkflowTerminalState['status'] | undefined {
  const state = CORNER_WORKFLOW_CONTRACT.handoffs[toState];
  return state?.kind === 'terminal' ? state.status : undefined;
}

/**
 * Starts this corner's one lifelong bookkeeping run and immediately records
 * its lane outcome — both as one fact about what `createCorner` already
 * decided, not a dispatch. Call from within `createCorner`'s own transaction,
 * once, right after the lane is chosen. Never throws.
 */
export async function startCornerWorkflowRun(
  db: SqlDatabase,
  input: {
    cornerId: string;
    workspaceId: string;
    lane: 'no_code' | 'code' | 'research';
    implementerAgentId: string;
  },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
    await lockCornerWorkflowRun(tx, input.cornerId);
    const workflowVersion = await currentCornerWorkflowVersion(tx, input.workspaceId);
    const roleBindings = {
      implementer: input.implementerAgentId,
      // Never a real agent id — a documented marker so the generic
      // handoff() engine's own authorization check (`boundAgentId !==
      // command.agent_id`) can never match it, even if an agent found and
      // called that tool against this run's id (report finding 1).
      reviewer: 'live:parent.reviewer_agent_id',
    };
    const subject = await cornerBookkeepingSubject(tx);
    await systemLine(tx, {
      // Deterministic: the corner's own id doubles as its start card's id,
      // exactly as `startWorkflow` uses the run id for the same card
      // (workflow-runs.ts) — a retried `createCorner` transaction can never
      // duplicate this row.
      id: input.cornerId,
      roomId: input.cornerId,
      authorId: SYSTEM_IDENTITY_ID,
      subject,
      verb: 'started workflow',
      object: CORNER_WORKFLOW_CONTRACT.name,
      kind: WORKFLOW_HANDOFF_CARD_TYPE,
      // A corner already has its own rich real conversation, and this
      // bookkeeping is purely an additional, SQL-queryable record of what
      // already happened there — never something a human is meant to read as
      // a chat line. `CORNER_WORKFLOW_HANDOFF_CARD_TYPE` (its own card_type,
      // distinct from the generic engine's) is what `hiddenWakeCardSql`
      // excludes from `PhoneService.readRoom`'s transcript queries.
      presentation: 'card',
      cardType: CORNER_WORKFLOW_HANDOFF_CARD_TYPE,
      card: {
        runId: input.cornerId,
        workflowSlug: CORNER_WORKFLOW_CONTRACT.name,
        workflowVersion,
        roleBindings,
        toState: 'opened',
        seq: 0,
      },
    });
    const toState =
      input.lane === 'no_code' ? 'no_code_work' : input.lane === 'research' ? 'investigate' : 'implement';
    await writeCornerWorkflowCard(tx, {
      cornerId: input.cornerId,
      fromState: 'opened',
      outcome: input.lane,
      toState,
      roleBindings,
      workflowVersion,
      seq: 1,
      contents: {},
      subject,
      dedupeKey: 'opened',
    });
    });
  } catch (error) {
    console.error('[corner-workflow] failed to start bookkeeping run', input.cornerId, error);
  }
}

async function writeCornerWorkflowCard(
  db: SqlDatabase,
  input: {
    cornerId: string;
    fromState: string;
    outcome: string;
    toState: string;
    roleBindings: Record<string, string>;
    workflowVersion: number;
    seq: number;
    contents: Record<string, unknown>;
    subject: SystemLineInput['subject'];
    dedupeKey: string;
  },
): Promise<void> {
  const status = terminalStatus(input.toState);
  await systemLine(db, {
    id: createHash('sha256')
      .update(`beeline:corner-workflow:${input.cornerId}:${input.fromState}:${input.outcome}:${input.dedupeKey}`)
      .digest('hex'),
    roomId: input.cornerId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: input.subject,
    verb: 'handed off',
    object: input.toState,
    kind: WORKFLOW_HANDOFF_CARD_TYPE,
    // Bookkeeping only: the real dispatch for every corner transition
    // already happened through the existing corner machinery before this
    // card is written, so this card must never itself wake anyone (no
    // `wakes`) — doing so would dispatch a second, redundant turn for
    // something the corner already handled (report finding 2). Never shown
    // to a human either — see the identical note on the start card above.
    presentation: 'card',
    cardType: CORNER_WORKFLOW_HANDOFF_CARD_TYPE,
    card: {
      runId: input.cornerId,
      workflowSlug: CORNER_WORKFLOW_CONTRACT.name,
      workflowVersion: input.workflowVersion,
      roleBindings: input.roleBindings,
      fromState: input.fromState,
      outcome: input.outcome,
      toState: input.toState,
      contents: input.contents,
      seq: input.seq,
      ...(status ? { status } : {}),
    },
  });
}

/**
 * Records an ordinary `on`-edge transition the real corner machinery already
 * made. A no-op (logged) when the run isn't currently sitting in
 * `expectedFromState` — a stale or out-of-order call must never fabricate a
 * misleading card. Never throws.
 */
export async function noteCornerWorkflowTransition(
  db: SqlDatabase,
  input: {
    cornerId: string;
    expectedFromState: string;
    outcome: string;
    toState: string;
    contents: Record<string, unknown>;
    /** Distinguishes repeat trips around a loop (e.g. a push's head sha). */
    dedupeKey?: string;
  },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await lockCornerWorkflowRun(tx, input.cornerId);
      const run = await loadCornerWorkflowRunState(tx, input.cornerId);
      if (!run || run.toState !== input.expectedFromState) return;
      const state = CORNER_WORKFLOW_CONTRACT.handoffs[input.expectedFromState];
      if (!state || state.kind === 'terminal' || !('on' in state) || !Object.hasOwn(state.on, input.outcome))
        return;
      const subject = await cornerBookkeepingSubject(tx);
      await writeCornerWorkflowCard(tx, {
        cornerId: input.cornerId,
        fromState: input.expectedFromState,
        outcome: input.outcome,
        toState: input.toState,
        roleBindings: run.roleBindings,
        workflowVersion: run.workflowVersion,
        seq: run.seq + 1,
        contents: input.contents,
        subject,
        dedupeKey: input.dedupeKey ?? randomBytes(16).toString('hex'),
      });
    });
  } catch (error) {
    console.error(
      '[corner-workflow] failed to record transition',
      input.cornerId,
      input.expectedFromState,
      input.outcome,
      error,
    );
  }
}

/**
 * Records a review verdict's outcome specifically. Unlike
 * `noteCornerWorkflowTransition`, this accepts the run currently sitting in
 * EITHER `review` or `implement`: a handback round that repeats over the same
 * head with nothing new pushed (`queueCornerWorkerAfterReview`'s own cap
 * counts exactly these, independent of any push) re-dispatches the reviewer
 * over an ordinary tagged reply, never through this file, so the bookkeeping
 * run can still legitimately read `implement` — this round's own prior
 * `changes_requested` card — when the next verdict comes in, not `review`.
 * The outcome is always validated against `review`'s own declared edges;
 * only the recorded `fromState` reflects wherever the run actually was.
 */
export async function noteCornerWorkflowReviewOutcome(
  db: SqlDatabase,
  input: {
    cornerId: string;
    outcome: string;
    toState: string;
    contents: Record<string, unknown>;
    dedupeKey: string;
  },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await lockCornerWorkflowRun(tx, input.cornerId);
      const run = await loadCornerWorkflowRunState(tx, input.cornerId);
      if (!run || (run.toState !== 'review' && run.toState !== 'implement')) return;
      const reviewState = CORNER_WORKFLOW_CONTRACT.handoffs.review;
      if (!reviewState || !('on' in reviewState) || !Object.hasOwn(reviewState.on, input.outcome)) return;
      const subject = await cornerBookkeepingSubject(tx);
      await writeCornerWorkflowCard(tx, {
        cornerId: input.cornerId,
        fromState: run.toState,
        outcome: input.outcome,
        toState: input.toState,
        roleBindings: run.roleBindings,
        workflowVersion: run.workflowVersion,
        seq: run.seq + 1,
        contents: input.contents,
        subject,
        dedupeKey: input.dedupeKey,
      });
    });
  } catch (error) {
    console.error('[corner-workflow] failed to record review outcome', input.cornerId, input.outcome, error);
  }
}

/**
 * Records the merge webhook or a close reaching this corner from WHATEVER
 * state it currently sits in (report finding 3) — never validated against a
 * specific `fromState`. A no-op once the run is already at a terminal
 * (idempotent against a retried webhook delivery). Never throws.
 */
export async function noteCornerWorkflowImplicitEdge(
  db: SqlDatabase,
  input: {
    cornerId: string;
    toState: 'landed' | 'closed';
    contents?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    if (!CORNER_WORKFLOW_CONTRACT.implicitEdges?.includes(input.toState)) return;
    await db.transaction(async (tx) => {
      await lockCornerWorkflowRun(tx, input.cornerId);
      const run = await loadCornerWorkflowRunState(tx, input.cornerId);
      if (!run) return;
      if (terminalStatus(run.toState)) return; // already terminal; nothing to close over
      const subject = await cornerBookkeepingSubject(tx);
      await writeCornerWorkflowCard(tx, {
        cornerId: input.cornerId,
        fromState: run.toState,
        outcome: input.toState,
        toState: input.toState,
        roleBindings: run.roleBindings,
        workflowVersion: run.workflowVersion,
        seq: run.seq + 1,
        contents: input.contents ?? {},
        subject,
        dedupeKey: input.toState,
      });
    });
  } catch (error) {
    console.error('[corner-workflow] failed to record implicit edge', input.cornerId, input.toState, error);
  }
}

/**
 * Seeds the built-in Corner workflow for one Workspace, idempotently. Bypasses
 * `applySkillRevision`'s active-count/byte caps deliberately: this is a
 * system-owned bootstrap row, not user-authored content competing for a
 * user-facing budget, and it must never fail to seed because unrelated
 * procedures already filled a Workspace's cap.
 */
export async function ensureCornerWorkflowSeeded(
  db: SqlDatabase,
  workspaceId: string,
  sourceRoomId: string,
): Promise<void> {
  await insertCornerWorkflowSkill(db, workspaceId, sourceRoomId);
}

async function insertCornerWorkflowSkill(
  db: SqlDatabase,
  workspaceId: string,
  sourceRoomId: string,
): Promise<void> {
  const markdown = JSON.stringify(CORNER_WORKFLOW_CONTRACT);
  const contentHash = createHash('sha256').update(markdown).digest('hex');
  const skillId = randomBytes(16).toString('hex');
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO workspace_skills
       (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
        repository,target_commit,path,kind)
     SELECT $1::uuid,$2,$3,$4,'active',1,1,$5,'','',NULL,'workflow'
     WHERE NOT EXISTS (SELECT 1 FROM workspace_skills WHERE workspace_id=$2 AND slug=$3)
     RETURNING id`,
    [skillId, workspaceId, CORNER_WORKFLOW_SLUG, CORNER_WORKFLOW_CONTRACT.description, sourceRoomId],
  );
  const newSkillId = inserted.rows[0]?.id;
  if (!newSkillId) return; // already seeded
  await db.query(
    `INSERT INTO workspace_skill_versions
       (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
        repository,target_commit,path,extractor_version,model)
     VALUES($1,1,$2,$3,NULL,$4,'','',NULL,'corner-workflow-v1','n/a')`,
    [newSkillId, markdown, contentHash, ['system:corner-workflow-seed']],
  );
}

/**
 * Backfills the built-in Corner workflow into every Workspace created before
 * this feature shipped, run once from `migrateData()`. Every existing
 * Workspace already has at least one top-level Room from its own creation
 * (`ensureFirstRoom`); the oldest one stands in as the seed's required
 * `source_room_id`.
 */
export async function backfillCornerWorkflowSeed(database: SqlDatabase): Promise<number> {
  const missing = await database.query<{ workspace_id: string; source_room_id: string }>(
    `SELECT w.id workspace_id,room.id source_room_id
     FROM workspaces w
     JOIN LATERAL (
       SELECT id FROM rooms
       WHERE workspace_id=w.id AND parent_id IS NULL AND direct_participants IS NULL
       ORDER BY created_at,id LIMIT 1
     ) room ON true
     WHERE NOT EXISTS (
       SELECT 1 FROM workspace_skills skill WHERE skill.workspace_id=w.id AND skill.slug=$1
     )`,
    [CORNER_WORKFLOW_SLUG],
  );
  for (const row of missing.rows) {
    await database.transaction((db) => insertCornerWorkflowSkill(db, row.workspace_id, row.source_room_id));
  }
  if (missing.rowCount)
    console.log(`backfillCornerWorkflowSeed: seeded ${missing.rowCount} Workspace(s)`);
  return missing.rowCount;
}
