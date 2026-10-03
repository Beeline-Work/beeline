import { randomUUID } from 'node:crypto';
import { DELIVERY_PICKUP_WINDOW_MS } from './connection-presence.js';
import type { SqlDatabase } from './database.js';
import type { InstitutionalMemoryShadowConfig } from './institutional-memory-shadow.js';
import {
  refreshWorkspaceSkillAnchors,
  type InstitutionalSkillAnchorSource,
} from './institutional-skill-anchors.js';

/** How much time one repeat-evidence measurement covers, and its comparison. */
export const INSTITUTIONAL_REPEAT_WINDOW_DAYS = 28;
/** The per-turn institutional context budget the rollout gate holds p95 to. */
export const INSTITUTIONAL_CONTEXT_TOKEN_TARGET = 2_000;
/**
 * A sample covers at most this much time. The curator samples on the server's
 * reconciliation cadence, so a longer span means nothing watched the host and
 * the span must not be credited as available.
 */
export const AVAILABILITY_OBSERVATION_MAX_MS = 10 * 60_000;

/**
 * An authorized helper host that could serve this Workspace right now: a
 * current Workspace-member agent on a known machine whose authenticated
 * presence evidence is still fresh.
 */
const WORKSPACE_HOST_AVAILABLE_SQL = `EXISTS (
    SELECT 1
    FROM memberships member
    JOIN agents agent ON agent.agent_id=member.identity_id AND agent.machine_id IS NOT NULL
    JOIN live_outputs presence
      ON presence.agent_id=member.identity_id AND presence.kind='presence'
    WHERE member.workspace_id=$1 AND member.room_id IS NULL AND member.removed_at IS NULL
      AND presence.body->>'status'='online'
      AND (presence.body->>'held'='true'
        OR presence.updated_at>=$2::timestamptz-interval '${DELIVERY_PICKUP_WINDOW_MS} milliseconds')
  )`;

/** Seconds since `anchor` in which no authorized helper host was available. */
function unavailableSecondsSql(anchor: string): string {
  return `(SELECT COALESCE(sum(extract(epoch FROM (
              LEAST(gap.ended_at,$2::timestamptz)-GREATEST(gap.started_at,${anchor})))),0)
           FROM institutional_host_availability_gaps gap
           WHERE gap.workspace_id=$1 AND gap.ended_at>${anchor}
             AND gap.started_at<$2::timestamptz)`;
}

/** True once `anchor` is older than `$<days>` days of MEASURED availability. */
function agedBeyondSql(anchor: string, days: string): string {
  return `extract(epoch FROM ($2::timestamptz-${anchor}))
            -${unavailableSecondsSql(anchor)}>=(${days})::integer*86400`;
}

const ITEM_AGE_ANCHOR = `GREATEST(item.updated_at,COALESCE(item.last_served_at,item.updated_at))`;

/**
 * Sample whether an authorized helper host can serve this Workspace and record
 * every span that cannot be credited as available: an unavailable host, the
 * unobserved history before the first sample, and any span longer than the
 * sampling cadence. One contiguous span stays one row.
 */
export async function recordWorkspaceHostAvailability(
  database: SqlDatabase,
  workspaceId: string,
  now: Date,
): Promise<boolean> {
  // The gap write and the cursor advance are one transaction: a crash between
  // them would leave ended_at no longer equal to the next `since`, so the
  // extend would miss and a second overlapping gap would double-count.
  return database.transaction(async (db) => {
    const state = (
      await db.query<{ available: boolean; observed_at: Date | null; created_at: Date }>(
        `SELECT ${WORKSPACE_HOST_AVAILABLE_SQL} available,
                rollout.availability_observed_at observed_at,workspace.created_at
         FROM institutional_memory_workspace_rollouts rollout
         JOIN workspaces workspace ON workspace.id=rollout.workspace_id
         WHERE rollout.workspace_id=$1
         FOR UPDATE OF rollout`,
        [workspaceId, now],
      )
    ).rows[0];
    if (!state) return true;
    const since = state.observed_at ?? state.created_at;
    const credited =
      state.available &&
      state.observed_at !== null &&
      now.getTime() - since.getTime() <= AVAILABILITY_OBSERVATION_MAX_MS;
    if (!credited && since.getTime() < now.getTime()) {
      const extended = await db.query(
        `UPDATE institutional_host_availability_gaps SET ended_at=$3
         WHERE id=(SELECT id FROM institutional_host_availability_gaps
                   WHERE workspace_id=$1 AND ended_at=$2 ORDER BY started_at DESC LIMIT 1)`,
        [workspaceId, since, now],
      );
      if (!extended.rowCount) {
        await db.query(
          `INSERT INTO institutional_host_availability_gaps(id,workspace_id,started_at,ended_at)
           VALUES($1,$2,$3,$4)`,
          [randomUUID(), workspaceId, since, now],
        );
      }
    }
    await db.query(
      `UPDATE institutional_memory_workspace_rollouts SET availability_observed_at=$2
       WHERE workspace_id=$1`,
      [workspaceId, now],
    );
    return state.available;
  });
}

/**
 * Repeat evidence for one ledger and one window: events whose own lesson the
 * ledger ALREADY carried within the preceding window. Counting each event
 * against its own predecessor rather than grouping strictly inside the window is
 * what keeps a pair straddling the boundary from vanishing out of both
 * measurements; where the boundary falls must not move the measure.
 *
 * A repeat is counted at the scope the fact is served at: a workspace_fact is
 * shared, so two DIFFERENT people correcting one canonical key is the repeat the
 * system exists to reduce, while a human_profile_fact only repeats for its own
 * subject. Params: $1 Workspace, $2 window days.
 */
const CORRECTION_REPEAT = {
  table: 'institutional_memory_correction_events',
  eligible: 'true',
  sameLesson: `prior.memory_kind=event.memory_kind
             AND prior.canonical_key=event.canonical_key
             AND (event.memory_kind='workspace_fact'
                  OR prior.requester_identity_id=event.requester_identity_id)`,
} as const;

const REVIEW_FINDING_REPEAT = {
  table: 'institutional_review_findings',
  eligible: 'event.path IS NOT NULL',
  sameLesson: `prior.taxonomy=event.taxonomy AND prior.path=event.path`,
} as const;

function repeatedEventsSql(
  ledger: typeof CORRECTION_REPEAT | typeof REVIEW_FINDING_REPEAT,
  window: 'current' | 'prior',
): string {
  const range =
    window === 'current'
      ? `event.created_at>=now()-$2*interval '1 day'`
      : `event.created_at<now()-$2*interval '1 day'
             AND event.created_at>=now()-2*$2*interval '1 day'`;
  return `(SELECT count(*) FROM ${ledger.table} event
          WHERE event.workspace_id=$1 AND ${ledger.eligible} AND ${range}
            AND EXISTS (
              SELECT 1 FROM ${ledger.table} prior
              WHERE prior.workspace_id=event.workspace_id
                AND ${ledger.sameLesson}
                AND (prior.created_at,prior.id)<(event.created_at,event.id)
                AND prior.created_at>=event.created_at-$2*interval '1 day'))`;
}

export interface InstitutionalObjectiveDashboard {
  readonly workspaceId: string;
  readonly contextServes: number;
  readonly completedJobs: number;
  readonly completedTurns: number;
  readonly successfulTurns: number;
  readonly p95ContextBytes: number;
  /**
   * The institutional block's own prompt-token cost, measured from the
   * harness's REAL per-turn input tokens rather than the byte estimate that
   * could never cross the cap. A serve whose harness reported no usage still
   * falls back to `estimated_tokens`, so the sample never silently shrinks.
   */
  readonly p95ContextTokens: number;
  /** p95 of the turns' whole real prompt, the denominator of `tokenShare`. */
  readonly p95TurnInputTokens: number;
  /** Institutional tokens as a share of real input tokens, over sampled serves. */
  readonly tokenShare: number;
  /** Serves whose p95 token figure came from the harness rather than the estimate. */
  readonly tokenSampledServes: number;
  readonly skillCandidatesServed: number;
  readonly skillsLoaded: number;
  readonly searches: number;
  readonly deadJobs: number;
  /**
   * Served items still on record, and how many of those were ALREADY not
   * current at the moment they were served. Normal aging after a serve is not a
   * stale serve.
   */
  readonly servedItems: number;
  readonly staleServedItems: number;
  readonly staleServeRate: number;
  /**
   * Repeats beyond the first over the correction and review-finding ledgers,
   * within `repeatWindowDays` and within the equal window before it. The pair is
   * what makes a reduction readable; neither side is evidence of a cause.
   */
  readonly repeatWindowDays: number;
  readonly repeatedCorrections: number;
  readonly priorRepeatedCorrections: number;
  readonly repeatedReviewFindings: number;
  readonly priorRepeatedReviewFindings: number;
  /**
   * Recurring work is a repository's corners. Cycle time is corner created ->
   * merged, reported per cohort (was memory eligible for THIS corner) with its
   * sample size, and per repository only where both cohorts exist — a cluster
   * with one side empty is not a comparison.
   */
  readonly cycleTimeWindowDays: number;
  readonly cornerCycleTime: readonly InstitutionalCycleTimeCohort[];
  readonly comparableClusters: readonly InstitutionalClusterCycleTime[];
  /** Compounding yield: what each cohort's turns achieved and cost. */
  readonly yieldByCohort: readonly InstitutionalCohortYield[];
  readonly shadowReady: boolean;
  readonly rolloutReady: boolean;
}

export type InstitutionalMemoryCohort = 'served' | 'unserved';

export interface InstitutionalCycleTimeCohort {
  readonly cohort: InstitutionalMemoryCohort;
  readonly mergedCorners: number;
  readonly p50Minutes: number;
  readonly p90Minutes: number;
}

export interface InstitutionalClusterCycleTime {
  readonly repository: string;
  readonly served: InstitutionalCycleTimeCohort;
  readonly unserved: InstitutionalCycleTimeCohort;
}

export interface InstitutionalCohortYield {
  readonly cohort: InstitutionalMemoryCohort;
  /** Corners in this cohort, and the turns they actually ran. */
  readonly corners: number;
  readonly completedTurns: number;
  readonly successfulTurns: number;
  readonly successRate: number;
  /** Turns that reported a tool count, so the average states its own sample. */
  readonly measuredTurns: number;
  readonly toolCallsPerSuccessfulTurn: number;
  /** Turns that reported a duration, and the median minutes over those. */
  readonly timedTurns: number;
  readonly turnMinutesP50: number;
}

/**
 * How far back the recurring-work measures look. Long enough for a repository's
 * corners to recur, short enough that a stale rollout does not dilute today's
 * reading with work nobody can act on.
 */
export const INSTITUTIONAL_CYCLE_TIME_WINDOW_DAYS = 90;

/**
 * The two dimensions the objective functions name, measured over the SAME
 * cohorts so they can be read together.
 *
 * A cohort is a corner: "served" means a live institutional snapshot with
 * content actually reached that corner, "unserved" means one did not — the
 * plan's eligible-but-unserved comparison. Corners are the unit because the
 * question is whether the work went faster, and a corner is the unit of work.
 *
 * Cycle time is corner created -> merged, over corners whose merge landed inside
 * the window, and it is only published per repository when BOTH cohorts are
 * present: a cluster with an empty side is a total, not a comparison.
 *
 * Yield reads turn rows rather than serve rows on purpose. The serve ledger only
 * holds turns memory reached, which is exactly the half that would bias the
 * comparison; every corner's turns are there whether or not memory was involved.
 * Each average carries its own sample size, so a cohort that reported few
 * durations says so instead of implying it measured them all.
 */
async function institutionalCohortMeasures(
  database: SqlDatabase,
  workspaceId: string,
): Promise<{
  cycleTime: InstitutionalCycleTimeCohort[];
  clusters: InstitutionalClusterCycleTime[];
  yield: InstitutionalCohortYield[];
}> {
  const cornerScope = `
    WITH corner_scope AS (
      SELECT corner.id corner_id,corner.created_at created_at,
             COALESCE(NULLIF(corner.repository_key,''),NULLIF(parent.repository_key,''),'') repository,
             EXISTS (SELECT 1 FROM institutional_context_serves serve
                     WHERE serve.room_id=corner.id AND serve.mode='live' AND serve.served) served
      FROM rooms corner
      LEFT JOIN rooms parent ON parent.id=corner.parent_id
      WHERE corner.workspace_id=$1 AND corner.parent_id IS NOT NULL
    ),
    merged AS (
      SELECT scope.served,scope.repository,
             extract(epoch FROM (min(outcome.created_at)-scope.created_at))/60.0 minutes
      FROM corner_scope scope
      JOIN institutional_memory_outcomes outcome
        ON outcome.room_id=scope.corner_id AND outcome.kind='merged'
      WHERE outcome.created_at>=scope.created_at
        AND outcome.created_at>=now()-$2*interval '1 day'
      GROUP BY scope.corner_id,scope.served,scope.repository,scope.created_at
    )`;
  const cycle = (
    await database.query<CycleRow>(
      `${cornerScope}
       SELECT CASE WHEN served THEN 'served' ELSE 'unserved' END cohort,
              repository,count(*)::text merged_corners,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY minutes)::text p50_minutes,
              percentile_disc(0.9) WITHIN GROUP (ORDER BY minutes)::text p90_minutes
       FROM merged GROUP BY served,repository`,
      [workspaceId, INSTITUTIONAL_CYCLE_TIME_WINDOW_DAYS],
    )
  ).rows;
  const cycleTime: InstitutionalCycleTimeCohort[] = [];
  const byRepository = new Map<string, { served?: CycleRow; unserved?: CycleRow }>();
  for (const row of cycle) {
    if (!row.repository) {
      cycleTime.push(cycleCohort(row.cohort, row));
      continue;
    }
    const entry = byRepository.get(row.repository) ?? {};
    if (row.cohort === 'served') entry.served = row;
    else entry.unserved = row;
    byRepository.set(row.repository, entry);
    cycleTime.push(cycleCohort(row.cohort, row));
  }
  const clusters: InstitutionalClusterCycleTime[] = [...byRepository.entries()]
    .filter(([, entry]) => entry.served && entry.unserved)
    .map(([repository, entry]) => ({
      repository,
      served: cycleCohort('served', entry.served!),
      unserved: cycleCohort('unserved', entry.unserved!),
    }))
    .sort(
      (left, right) =>
        right.served.mergedCorners +
          right.unserved.mergedCorners -
          (left.served.mergedCorners + left.unserved.mergedCorners) ||
        left.repository.localeCompare(right.repository),
    );

  const yieldRows = (
    await database.query<YieldRow>(
      `${cornerScope},
       turn_scope AS (
         SELECT scope.served,scope.corner_id,turn.status,turn.tool_calls,
                GREATEST(0,extract(epoch FROM (turn.created_at-turn.started_at))) seconds
         FROM corner_scope scope
         JOIN agent_turns turn ON turn.room_id=scope.corner_id
         WHERE turn.status IN ('complete','failed')
       )
       SELECT CASE WHEN served THEN 'served' ELSE 'unserved' END cohort,
              count(DISTINCT corner_id)::text corners,
              count(*)::text completed_turns,
              count(*) FILTER (WHERE status='complete')::text successful_turns,
              count(*) FILTER (WHERE status='complete' AND tool_calls IS NOT NULL)::text measured_turns,
              COALESCE(sum(tool_calls) FILTER (WHERE status='complete' AND tool_calls IS NOT NULL),0)::text tool_calls,
              count(*) FILTER (WHERE seconds IS NOT NULL)::text timed_turns,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY seconds)::text p50_seconds
       FROM turn_scope GROUP BY served`,
      [workspaceId, INSTITUTIONAL_CYCLE_TIME_WINDOW_DAYS],
    )
  ).rows;
  return { cycleTime, clusters, yield: yieldRows.map(yieldCohort) };
}

interface CycleRow {
  cohort: 'served' | 'unserved';
  repository: string;
  merged_corners: string;
  p50_minutes: string | null;
  p90_minutes: string | null;
}

function cycleCohort(cohort: 'served' | 'unserved', row: CycleRow): InstitutionalCycleTimeCohort {
  return {
    cohort,
    mergedCorners: Number(row.merged_corners ?? 0),
    p50Minutes: Number(row.p50_minutes ?? 0),
    p90Minutes: Number(row.p90_minutes ?? 0),
  };
}

interface YieldRow {
  cohort: 'served' | 'unserved';
  corners: string;
  completed_turns: string;
  successful_turns: string;
  measured_turns: string;
  tool_calls: string;
  timed_turns: string;
  p50_seconds: string | null;
}

function yieldCohort(row: YieldRow): InstitutionalCohortYield {
  const completedTurns = Number(row.completed_turns ?? 0);
  const successfulTurns = Number(row.successful_turns ?? 0);
  const measuredTurns = Number(row.measured_turns ?? 0);
  return {
    cohort: row.cohort,
    corners: Number(row.corners ?? 0),
    completedTurns,
    successfulTurns,
    successRate: completedTurns ? successfulTurns / completedTurns : 0,
    measuredTurns,
    toolCallsPerSuccessfulTurn: measuredTurns ? Number(row.tool_calls ?? 0) / measuredTurns : 0,
    timedTurns: Number(row.timed_turns ?? 0),
    turnMinutesP50: Number(row.p50_seconds ?? 0) / 60,
  };
}

function utcWeekKey(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

export async function institutionalObjectiveDashboard(
  database: SqlDatabase,
  workspaceId: string,
): Promise<InstitutionalObjectiveDashboard> {
  const row = (
    await database.query<{
      context_serves: string;
      completed_jobs: string;
      completed_turns: string;
      successful_turns: string;
      p95_context_bytes: string;
      p95_context_tokens: string;
      p95_turn_input_tokens: string;
      token_share: string;
      token_sampled_serves: string;
      skill_candidates_served: string;
      skills_loaded: string;
      searches: string;
      dead_jobs: string;
      served_items: string;
      stale_served_items: string;
      repeated_corrections: string;
      prior_repeated_corrections: string;
      repeated_review_findings: string;
      prior_repeated_review_findings: string;
    }>(
      `SELECT
         (SELECT count(*) FROM institutional_context_serves
          WHERE workspace_id=$1 AND mode='live' AND served) context_serves,
         (SELECT count(*) FROM institutional_memory_outcomes
          WHERE workspace_id=$1 AND kind='turn_completed') completed_turns,
         (SELECT count(*) FROM institutional_memory_jobs
          WHERE workspace_id=$1 AND status='completed') completed_jobs,
         (SELECT count(*) FROM institutional_memory_outcomes
          WHERE workspace_id=$1 AND kind='turn_completed' AND success) successful_turns,
         COALESCE((SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY total_bytes)
          FROM institutional_context_serves WHERE workspace_id=$1 AND mode='live'),0) p95_context_bytes,
         COALESCE((SELECT percentile_disc(0.95) WITHIN GROUP (
            ORDER BY CASE
              WHEN actual_input_tokens IS NOT NULL AND prompt_bytes IS NOT NULL
              THEN LEAST(actual_input_tokens,
                         ceil(actual_input_tokens::numeric*total_bytes/prompt_bytes)::int)
              ELSE estimated_tokens END)
          FROM institutional_context_serves WHERE workspace_id=$1 AND mode='live'),0) p95_context_tokens,
         -- The denominator of the share, and the same figure in the raw: a
         -- Workspace whose real prompts are small is not the same finding as
         -- one whose block is a large part of them.
         COALESCE((SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY actual_input_tokens)
          FROM institutional_context_serves
          WHERE workspace_id=$1 AND mode='live' AND actual_input_tokens IS NOT NULL),0)
           p95_turn_input_tokens,
         COALESCE((SELECT sum(CASE
              WHEN actual_input_tokens IS NOT NULL AND prompt_bytes IS NOT NULL
              THEN LEAST(actual_input_tokens,
                         ceil(actual_input_tokens::numeric*total_bytes/prompt_bytes)::int)
              ELSE 0 END)::numeric / NULLIF(sum(actual_input_tokens),0)
          FROM institutional_context_serves WHERE workspace_id=$1 AND mode='live'),0) token_share,
         (SELECT count(*) FROM institutional_context_serves
          WHERE workspace_id=$1 AND mode='live' AND actual_input_tokens IS NOT NULL)
           token_sampled_serves,
         COALESCE((SELECT sum(cardinality(skill_candidates))
          FROM institutional_context_serves WHERE workspace_id=$1 AND mode='live'),0) skill_candidates_served,
         (SELECT count(*) FROM workspace_skill_uses WHERE workspace_id=$1) skills_loaded,
         (SELECT count(*) FROM institutional_history_searches WHERE workspace_id=$1) searches,
         (SELECT count(*) FROM institutional_memory_jobs
          WHERE workspace_id=$1 AND status='dead'
            AND updated_at>=now()-interval '24 hours') dead_jobs,
         -- Stale serve rate is "was this item ALREADY not current when we served
         -- it", never "has it aged since". A state transition is the only thing
         -- that moves updated_at, so a non-active item whose last transition
         -- predates the serve was stale at serve time; one that transitioned
         -- afterwards is the curator working exactly as specified. Both sides
         -- join the item, so a row later hard-deleted is unmeasurable rather
         -- than silently counted as current.
         (SELECT count(*) FROM institutional_context_serves serve
          CROSS JOIN LATERAL unnest(serve.item_ids) served(item_id)
          JOIN institutional_memory_items item ON item.id=served.item_id
          WHERE serve.workspace_id=$1 AND serve.mode='live' AND serve.served) served_items,
         (SELECT count(*) FROM institutional_context_serves serve
          CROSS JOIN LATERAL unnest(serve.item_ids) served(item_id)
          JOIN institutional_memory_items item ON item.id=served.item_id
          WHERE serve.workspace_id=$1 AND serve.mode='live' AND serve.served
            AND (item.state<>'active' OR item.deleted_at IS NOT NULL)
            AND item.updated_at<=serve.created_at) stale_served_items,
         -- Repeat evidence the criteria name, over ledgers that already have
         -- writers. Each counter is WINDOWED, and its immediately preceding
         -- window of equal length rides alongside it: a lifetime total only ever
         -- rises, so no single read of one could express the REDUCTION the
         -- criteria ask for. Two adjacent windows are a difference, not a cause.
         ${repeatedEventsSql(CORRECTION_REPEAT, 'current')} repeated_corrections,
         ${repeatedEventsSql(CORRECTION_REPEAT, 'prior')} prior_repeated_corrections,
         ${repeatedEventsSql(REVIEW_FINDING_REPEAT, 'current')} repeated_review_findings,
         ${repeatedEventsSql(REVIEW_FINDING_REPEAT, 'prior')} prior_repeated_review_findings`,
      [workspaceId, INSTITUTIONAL_REPEAT_WINDOW_DAYS],
    )
  ).rows[0];
  const contextServes = Number(row?.context_serves ?? 0);
  const completedJobs = Number(row?.completed_jobs ?? 0);
  const completedTurns = Number(row?.completed_turns ?? 0);
  const successfulTurns = Number(row?.successful_turns ?? 0);
  const p95ContextBytes = Number(row?.p95_context_bytes ?? 0);
  const p95ContextTokens = Number(row?.p95_context_tokens ?? 0);
  const deadJobs = Number(row?.dead_jobs ?? 0);
  const servedItems = Number(row?.served_items ?? 0);
  const staleServedItems = Number(row?.stale_served_items ?? 0);
  const cohorts = await institutionalCohortMeasures(database, workspaceId);
  return {
    workspaceId,
    contextServes,
    completedJobs,
    completedTurns,
    successfulTurns,
    p95ContextBytes,
    p95ContextTokens,
    p95TurnInputTokens: Number(row?.p95_turn_input_tokens ?? 0),
    tokenShare: Number(row?.token_share ?? 0),
    tokenSampledServes: Number(row?.token_sampled_serves ?? 0),
    skillCandidatesServed: Number(row?.skill_candidates_served ?? 0),
    skillsLoaded: Number(row?.skills_loaded ?? 0),
    searches: Number(row?.searches ?? 0),
    deadJobs,
    servedItems,
    staleServedItems,
    staleServeRate: servedItems ? staleServedItems / servedItems : 0,
    repeatWindowDays: INSTITUTIONAL_REPEAT_WINDOW_DAYS,
    repeatedCorrections: Number(row?.repeated_corrections ?? 0),
    priorRepeatedCorrections: Number(row?.prior_repeated_corrections ?? 0),
    repeatedReviewFindings: Number(row?.repeated_review_findings ?? 0),
    priorRepeatedReviewFindings: Number(row?.prior_repeated_review_findings ?? 0),
    cycleTimeWindowDays: INSTITUTIONAL_CYCLE_TIME_WINDOW_DAYS,
    cornerCycleTime: cohorts.cycleTime,
    comparableClusters: cohorts.clusters,
    yieldByCohort: cohorts.yield,
    shadowReady: completedJobs >= 20 && deadJobs === 0,
    rolloutReady:
      completedTurns >= 20 &&
      successfulTurns / Math.max(1, completedTurns) >= 0.9 &&
      p95ContextTokens <= INSTITUTIONAL_CONTEXT_TOKEN_TARGET &&
      deadJobs === 0,
  };
}

async function deterministicLifecycle(
  database: SqlDatabase,
  workspaceId: string,
  now: Date,
  expireAfterDays: number,
): Promise<{
  staleItems: number;
  archivedItems: number;
  staleSkills: number;
  archivedSkills: number;
}> {
  // Only what an agent saved on its own ages out. A fact someone asked to
  // keep (explicit_save) never expires; it changes only when corrected.
  const staleItems = await database.query(
    `UPDATE institutional_memory_items item
     SET state='stale',body='',deleted_at=$2,updated_at=$2
     WHERE item.workspace_id=$1 AND item.state='active' AND item.deleted_at IS NULL
       AND NOT item.explicit_save
       AND ${agedBeyondSql(ITEM_AGE_ANCHOR, '$3')}`,
    [workspaceId, now, expireAfterDays],
  );

  // Skills and workflows never expire: only memory items age out.
  return {
    staleItems: staleItems.rowCount,
    archivedItems: 0,
    staleSkills: 0,
    archivedSkills: 0,
  };
}

/** One idempotent weekly pass: deterministic aging first, then host-side consolidation jobs. */
export async function runInstitutionalCuratorCycle(
  database: SqlDatabase,
  config: InstitutionalMemoryShadowConfig,
  now = new Date(),
  options: { readonly anchors?: InstitutionalSkillAnchorSource } = {},
): Promise<number> {
  if (!config.enabled) return 0;
  const rollouts = await database.query<{
    workspace_id: string;
    stage: 'shadow' | 'pilot' | 'live';
    expire_after_days: number;
  }>(
    `SELECT workspace.id workspace_id,COALESCE(rollout.stage,'live') stage,
            COALESCE(rollout.expire_after_days,90) expire_after_days
     FROM workspaces workspace
     LEFT JOIN institutional_memory_workspace_rollouts rollout
       ON rollout.workspace_id=workspace.id
     WHERE COALESCE(rollout.stage,'live') IN ('shadow','pilot','live')
     ORDER BY workspace.id`,
  );
  for (const rollout of rollouts.rows) {
    try {
      if (config.live && rollout.stage !== 'shadow') {
        try {
          await refreshWorkspaceSkillAnchors(database, rollout.workspace_id, options.anchors, now);
        } catch (error) {
          console.error(`[server] institutional skill anchor pass failed (${rollout.workspace_id}):`, error);
        }
      }
      await recordWorkspaceHostAvailability(database, rollout.workspace_id, now);
      await database.transaction(async (db) => {
        await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `institutional-memory:${rollout.workspace_id}`,
        ]);
        const cycleKey = `weekly:${utcWeekKey(now)}`;
        const inserted = await db.query(
          `INSERT INTO institutional_curator_cycles(id,workspace_id,cycle_key)
           VALUES($1,$2,$3) ON CONFLICT(workspace_id,cycle_key) DO NOTHING`,
          [randomUUID(), rollout.workspace_id, cycleKey],
        );
        if (!inserted.rowCount) return;
        const lifecycle = !config.live || rollout.stage === 'shadow'
          ? { staleItems: 0, archivedItems: 0, staleSkills: 0, archivedSkills: 0 }
          : await deterministicLifecycle(db, rollout.workspace_id, now, rollout.expire_after_days);
        await db.query(
          `UPDATE institutional_curator_cycles
           SET queued_jobs=0,stale_items=$3,archived_items=0,stale_skills=$4,
               archived_skills=0,completed_at=$2
           WHERE workspace_id=$1 AND cycle_key=$5`,
          [rollout.workspace_id, now, lifecycle.staleItems, lifecycle.staleSkills, cycleKey],
        );
      });
    } catch (error) {
      console.error(`[server] institutional curator Workspace cycle failed (${rollout.workspace_id}):`, error);
    }
  }
  return 0;
}
