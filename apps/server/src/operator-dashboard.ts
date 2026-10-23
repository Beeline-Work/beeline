import { dashboardSigninFunnel } from './signin-funnel.js';
import { dashboardDownloads } from './operator-dashboard-downloads.js';
import type { SqlDatabase } from './database.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';
import { dashboardPeriods, dashboardPlatformBreakdown } from './operator-dashboard-periods.js';
import { dashboardOverview } from './operator-dashboard-overview.js';

export const DASHBOARD_PLATFORMS = ['ios', 'android', 'web', 'macos', 'windows', 'linux'] as const;
export type DashboardPlatform = (typeof DASHBOARD_PLATFORMS)[number];
export const DASHBOARD_STAGES = [
  'signup',
  'workspace',
  'paired',
  'reply',
  'corner',
  'merged',
] as const;

type CountRow = Record<(typeof DASHBOARD_STAGES)[number], string | number>;
const ALL = [...DASHBOARD_PLATFORMS];
const MIN_COHORT = 5;
const OBSERVED_FUNCTIONS = [
  'page_load',
  'message_delivery',
  'corner_open',
  'push_delivery',
  'attachment_upload',
];
const FUNCTION_WINDOW_MINUTES = 10;
let functionEventsWritten = 0;

export async function recordOperatorFunctionEvent(
  database: SqlDatabase,
  name: 'page_load' | 'message_delivery' | 'corner_open' | 'attachment_upload',
  durationMs: number,
  failed: boolean,
  networkRttResidualMs?: number,
): Promise<void> {
  const boundedDuration = Math.max(0, Math.min(600_000, Math.round(durationMs)));
  if (networkRttResidualMs === undefined) {
    await database.query(
      `INSERT INTO operator_function_events(function_name,duration_ms,failed) VALUES($1,$2,$3)`,
      [name, boundedDuration, failed],
    );
  } else {
    await database.query(
      `INSERT INTO operator_function_events(function_name,duration_ms,failed,network_rtt_residual_ms)
       VALUES($1,$2,$3,$4)`,
      [name, boundedDuration, failed, networkRttResidualMs],
    );
  }
  // Event-triggered retention keeps the operational ledger bounded without a
  // periodic collector. The read path remains read-only.
  if (++functionEventsWritten % 100 === 0) {
    void database
      .query(
        `DELETE FROM operator_function_events
      WHERE id IN (SELECT id FROM operator_function_events
        WHERE created_at < now()-interval '1 day' LIMIT 1000)`,
      )
      .catch(() => undefined);
  }
}
/** Exact aggregates for the private operator endpoint, including measured zeros. */
function measuredCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function number(value: unknown): number {
  return Number(value ?? 0);
}
function sectionError() {
  return { state: 'unavailable' as const, measuredAt: null };
}

export function parseDashboardPlatforms(raw: string | null): DashboardPlatform[] | null {
  if (raw === null) return ALL;
  const values = raw.split(',');
  if (
    !values.length ||
    values.some((value) => !DASHBOARD_PLATFORMS.includes(value as DashboardPlatform)) ||
    new Set(values).size !== values.length
  )
    return null;
  return DASHBOARD_PLATFORMS.filter((value) => values.includes(value));
}

const FUNNEL_SQL = `WITH ${COHORT_SQL}, agent_replies AS MATERIALIZED (
  SELECT DISTINCT author_id FROM messages msg JOIN rooms r ON r.id=msg.room_id
  JOIN production_workspaces w ON w.id=r.workspace_id
  WHERE presentation='message' AND deleted_at IS NULL
), eligible AS (
  SELECT i.id FROM identities i JOIN production_identities pi ON pi.id=i.id
  WHERE i.kind='human' AND (
    $1::boolean OR EXISTS (
      SELECT 1 FROM push_devices d WHERE d.identity_id=i.id AND d.platform=ANY($2::text[])
    ) OR EXISTS (
      SELECT 1 FROM device_update_receipts d WHERE d.identity_id=i.id
        AND d.receipt->>'platform'=ANY($2::text[])
    )
  )
), people AS (
  SELECT e.id,
    EXISTS(SELECT 1 FROM memberships m WHERE m.identity_id=e.id AND m.room_id IS NULL AND m.removed_at IS NULL AND m.workspace_id IN (SELECT id FROM production_workspaces)) workspace,
    EXISTS(SELECT 1 FROM agents a JOIN production_identities ai ON ai.id=a.agent_id JOIN daemon_tokens t ON t.agent_id=a.agent_id WHERE a.owner_id=e.id AND t.revoked_at IS NULL) paired,
    EXISTS(SELECT 1 FROM agents a JOIN production_identities ai ON ai.id=a.agent_id JOIN agent_replies m ON m.author_id=a.agent_id WHERE a.owner_id=e.id) reply,
    EXISTS(SELECT 1 FROM corner_facts f JOIN rooms cr ON cr.id=f.corner_id JOIN production_workspaces cw ON cw.id=cr.workspace_id WHERE f.commissioned_by=e.id) corner,
    EXISTS(SELECT 1 FROM corner_facts f JOIN rooms cr ON cr.id=f.corner_id JOIN production_workspaces cw ON cw.id=cr.workspace_id WHERE f.commissioned_by=e.id AND f.lifecycle->'pr'->>'mergedAt' IS NOT NULL) merged
  FROM eligible e
), agent_steps AS (
  SELECT a.agent_id,
    EXISTS(SELECT 1 FROM memberships m WHERE m.identity_id=a.agent_id AND m.room_id IS NULL AND m.removed_at IS NULL AND m.workspace_id IN (SELECT id FROM production_workspaces)) workspace,
    EXISTS(SELECT 1 FROM daemon_tokens t WHERE t.agent_id=a.agent_id AND t.revoked_at IS NULL) paired,
    EXISTS(SELECT 1 FROM agent_replies m WHERE m.author_id=a.agent_id) reply,
    EXISTS(SELECT 1 FROM corner_facts f JOIN rooms cr ON cr.id=f.corner_id JOIN production_workspaces cw ON cw.id=cr.workspace_id WHERE f.owner_agent_id=a.agent_id) corner,
    EXISTS(SELECT 1 FROM corner_facts f JOIN rooms cr ON cr.id=f.corner_id JOIN production_workspaces cw ON cw.id=cr.workspace_id WHERE f.owner_agent_id=a.agent_id AND f.lifecycle->'pr'->>'mergedAt' IS NOT NULL) merged
  FROM agents a JOIN eligible e ON e.id=a.owner_id JOIN identities i ON i.id=a.agent_id JOIN production_identities ai ON ai.id=i.id
)
SELECT 'people' kind, count(*) signup, count(*) FILTER(WHERE workspace) workspace,
  count(*) FILTER(WHERE workspace AND paired) paired,
  count(*) FILTER(WHERE workspace AND paired AND reply) reply,
  count(*) FILTER(WHERE workspace AND paired AND reply AND corner) corner,
  count(*) FILTER(WHERE workspace AND paired AND reply AND corner AND merged) merged
FROM people UNION ALL
SELECT 'agents' kind, count(*) signup, count(*) FILTER(WHERE workspace) workspace,
  count(*) FILTER(WHERE workspace AND paired) paired,
  count(*) FILTER(WHERE workspace AND paired AND reply) reply,
  count(*) FILTER(WHERE workspace AND paired AND reply AND corner) corner,
  count(*) FILTER(WHERE workspace AND paired AND reply AND corner AND merged) merged
FROM agent_steps`;

// Command provenance identifies the addressed free agent without inspecting content.
const ACTIVATION_SQL = `WITH ${COHORT_SQL}, eligible AS (
  SELECT i.id FROM identities i JOIN production_identities pi ON pi.id=i.id
  WHERE i.kind='human' AND ($1::boolean
    OR EXISTS(SELECT 1 FROM push_devices d WHERE d.identity_id=i.id AND d.platform=ANY($2::text[]))
    OR EXISTS(SELECT 1 FROM device_update_receipts d WHERE d.identity_id=i.id AND d.receipt->>'platform'=ANY($2::text[])))
), conversations AS (
  SELECT DISTINCT f.owner_id, c.result_message_id, c.state
  FROM free_agents f JOIN production_identities ai ON ai.id=f.agent_id
  JOIN production_workspaces fw ON fw.id=f.workspace_id
  JOIN eligible e ON e.id=f.owner_id
  JOIN agent_commands c ON c.agent_id=f.agent_id AND c.action='input'
  JOIN messages m ON m.id=c.source_message_id AND m.author_id=f.owner_id
  JOIN rooms r ON r.id=m.room_id JOIN production_workspaces w ON w.id=r.workspace_id
  WHERE m.presentation='message' AND m.deleted_at IS NULL
), replied AS (
  SELECT DISTINCT c.owner_id FROM conversations c
  JOIN messages reply ON reply.id=c.result_message_id
  JOIN free_agents f ON f.agent_id=reply.author_id AND f.owner_id=c.owner_id
  JOIN rooms r ON r.id=reply.room_id JOIN production_workspaces w ON w.id=r.workspace_id
  WHERE c.state='complete' AND reply.presentation='message' AND reply.deleted_at IS NULL
)
SELECT (SELECT count(DISTINCT owner_id) FROM conversations) free_agent_messaged,
  (SELECT count(*) FROM replied) free_agent_replied,
  (SELECT count(DISTINCT l.identity_id) FROM repository_link_successes l
    JOIN eligible e ON e.id=l.identity_id JOIN production_workspaces w ON w.id=l.workspace_id) repository_linked,
  (SELECT started_at FROM operator_metric_epochs WHERE metric='repository_link') repository_link_started_at`;

const FUNNEL_TIME_SQL = `WITH ${COHORT_SQL}, eligible AS (
  SELECT i.id, i.created_at FROM identities i JOIN production_identities pi ON pi.id=i.id WHERE i.kind='human' AND (
    $1::boolean OR EXISTS(SELECT 1 FROM push_devices d WHERE d.identity_id=i.id AND d.platform=ANY($2::text[]))
    OR EXISTS(SELECT 1 FROM device_update_receipts d WHERE d.identity_id=i.id
      AND d.receipt->>'platform'=ANY($2::text[]))
  )
), workspace_times AS (
  SELECT identity_id, min(joined_at) at FROM memberships
  WHERE room_id IS NULL AND removed_at IS NULL AND workspace_id IN (SELECT id FROM production_workspaces) GROUP BY identity_id
), paired_times AS (
  SELECT agent_id, min(created_at) at FROM daemon_tokens
  WHERE revoked_at IS NULL GROUP BY agent_id
), reply_times AS (
  SELECT author_id, min(msg.created_at) at FROM messages msg JOIN rooms r ON r.id=msg.room_id
  JOIN production_workspaces w ON w.id=r.workspace_id
  WHERE presentation='message' AND deleted_at IS NULL GROUP BY author_id
), corner_times AS (
  SELECT f.commissioned_by human_id, f.owner_agent_id agent_id,
    r.created_at opened_at,
    CASE WHEN f.lifecycle->'pr'->>'mergedAt' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
      THEN (f.lifecycle->'pr'->>'mergedAt')::timestamptz ELSE NULL END merged_at
  FROM corner_facts f JOIN rooms r ON r.id=f.corner_id JOIN production_workspaces cw ON cw.id=r.workspace_id
), timelines AS (
  SELECT 'people' kind, e.id actor_id, e.created_at signup_at,
    w.at workspace_at,
    (SELECT min(p.at) FROM agents a JOIN production_identities ai ON ai.id=a.agent_id JOIN paired_times p ON p.agent_id=a.agent_id WHERE a.owner_id=e.id) paired_at,
    (SELECT min(m.at) FROM agents a JOIN production_identities ai ON ai.id=a.agent_id JOIN reply_times m ON m.author_id=a.agent_id WHERE a.owner_id=e.id) reply_at,
    (SELECT min(c.opened_at) FROM corner_times c WHERE c.human_id=e.id) corner_at,
    (SELECT min(c.merged_at) FROM corner_times c WHERE c.human_id=e.id) merged_at
  FROM eligible e LEFT JOIN workspace_times w ON w.identity_id=e.id
  UNION ALL
  SELECT 'agents' kind, a.agent_id actor_id, i.created_at signup_at,
    w.at workspace_at, p.at paired_at, m.at reply_at,
    (SELECT min(c.opened_at) FROM corner_times c WHERE c.agent_id=a.agent_id) corner_at,
    (SELECT min(c.merged_at) FROM corner_times c WHERE c.agent_id=a.agent_id) merged_at
  FROM agents a JOIN eligible e ON e.id=a.owner_id
    JOIN identities i ON i.id=a.agent_id JOIN production_identities ai ON ai.id=i.id
    LEFT JOIN workspace_times w ON w.identity_id=a.agent_id
    LEFT JOIN paired_times p ON p.agent_id=a.agent_id
    LEFT JOIN reply_times m ON m.author_id=a.agent_id
), steps AS (
  SELECT kind, step.stage,
    EXTRACT(EPOCH FROM step.next_at-step.previous_at)*1000 elapsed_ms
  FROM timelines t CROSS JOIN LATERAL (VALUES
    ('workspace',t.signup_at,t.workspace_at),
    ('paired',t.workspace_at,t.paired_at),
    ('reply',t.paired_at,t.reply_at),
    ('corner',t.reply_at,t.corner_at),
    ('merged',t.corner_at,t.merged_at)
  ) step(stage,previous_at,next_at)
  WHERE step.previous_at IS NOT NULL AND step.next_at>=step.previous_at
) SELECT kind, stage, count(*) total,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms) median_ms
FROM steps GROUP BY kind,stage`;

export async function dashboardUsage(
  database: SqlDatabase,
  platforms: readonly DashboardPlatform[],
  measuredAt: string,
) {
  const all = platforms.length === ALL.length;
  const coverage = (
    await database.query<{ platform: DashboardPlatform }>(
      `WITH ${COHORT_SQL}, observed AS (
      SELECT d.platform FROM push_devices d JOIN production_identities i ON i.id=d.identity_id
      UNION SELECT d.receipt->>'platform' FROM device_update_receipts d
        JOIN production_identities i ON i.id=d.identity_id
    ) SELECT DISTINCT platform FROM observed WHERE platform=ANY($1::text[])`,
      [ALL],
    )
  ).rows.map((row) => row.platform);
  const rows = (
    await database.query<CountRow & { kind: 'people' | 'agents' }>(FUNNEL_SQL, [all, platforms])
  ).rows;
  const activation = (
    await database.query<{
      free_agent_messaged: string;
      free_agent_replied: string;
      repository_linked: string;
      repository_link_started_at: Date | string;
    }>(ACTIVATION_SQL, [all, platforms])
  ).rows[0];
  const timeRows = (
    await database
      .query<{
        kind: 'people' | 'agents';
        stage: string;
        total: string;
        median_ms: string;
      }>(FUNNEL_TIME_SQL, [all, platforms])
      .catch(() => ({ rows: [] }))
  ).rows;
  const stages = (kind: 'people' | 'agents') => {
    const row = rows.find((entry) => entry.kind === kind);
    const legacy = DASHBOARD_STAGES.map((stage, index) => {
      const timing = timeRows.find((entry) => entry.kind === kind && entry.stage === stage);
      const measured = number(timing?.total) >= MIN_COHORT;
      return {
        stage,
        count: measuredCount(row?.[stage]),
        previousStage: index ? DASHBOARD_STAGES[index - 1] : null,
        denominator: index ? measuredCount(row?.[DASHBOARD_STAGES[index - 1]!]) : null,
        medianTimeToStepMs: measured ? number(timing?.median_ms) : null,
        timeToStepState: measured ? ('measured' as const) : ('unmeasured' as const),
      };
    });
    if (kind === 'agents') return legacy;
    const newStages = [
      {
        stage: 'free_agent_messaged',
        label: 'Messaged their free agent',
        count: measuredCount(activation?.free_agent_messaged),
      },
      {
        stage: 'free_agent_replied',
        label: 'Free agent replied',
        count: measuredCount(activation?.free_agent_replied),
      },
      {
        stage: 'repository_linked',
        label: `Linked a repository (since ${new Date(activation!.repository_link_started_at).toISOString().slice(0, 10)})`,
        count: measuredCount(activation?.repository_linked),
      },
    ].map((entry) => ({
      ...entry,
      previousStage: 'workspace',
      denominator: measuredCount(row?.workspace),
      medianTimeToStepMs: null,
      timeToStepState: 'unmeasured' as const,
    }));
    return [...legacy.slice(0, 2), ...newStages, ...legacy.slice(2)];
  };
  return {
    state: 'measured' as const,
    measuredAt,
    platformCoverage: ALL.filter((platform) => coverage.includes(platform)),
    workspaces: measuredCount(
      (
        await database.query<{ total: string }>(
          `WITH ${COHORT_SQL} SELECT count(DISTINCT w.id) total FROM production_workspaces w
       JOIN memberships m ON m.workspace_id=w.id AND m.room_id IS NULL AND m.removed_at IS NULL
       JOIN identities i ON i.id=m.identity_id AND i.kind='human'
       JOIN production_identities pi ON pi.id=i.id
       WHERE $1::boolean OR EXISTS (SELECT 1 FROM push_devices d WHERE d.identity_id=i.id AND d.platform=ANY($2::text[]))
         OR EXISTS (SELECT 1 FROM device_update_receipts d WHERE d.identity_id=i.id AND d.receipt->>'platform'=ANY($2::text[]))`,
          [all, platforms],
        )
      ).rows[0]?.total,
    ),
    people: stages('people'),
    agents: stages('agents'),
  };
}

export async function dashboardHealth(database: SqlDatabase, measuredAt: string) {
  const serverRead = database.query('SELECT 1');
  const pool = database.poolCounts?.();
  const oldest = await database.oldestActiveQueryAgeMs?.().catch(() => null);
  const queryWindow = database.queryWindow?.();
  const queryMeasured =
    (queryWindow?.queryCount ?? 0) >= 20 && (queryWindow?.checkoutCount ?? 0) >= 20;
  const querySlow =
    queryMeasured && ((queryWindow?.queryP95Ms ?? 0) > 5000 || (queryWindow?.waitP95Ms ?? 0) > 100);
  const failuresRead = database.query<{ total: string; failed: string }>(
    `SELECT count(*) total, count(*) FILTER (WHERE status='failed') failed
     FROM agent_turns WHERE created_at>=now()-interval '24 hours'`,
  );
  const functionsRead = database.query<{
    function_name: string;
    total: string;
    failed: string;
    p95_ms: string;
    p99_ms: string;
  }>(`WITH events AS (
      SELECT function_name, duration_ms::numeric duration_ms, failed
      FROM operator_function_events
      WHERE created_at >= now() - interval '10 minutes'
      UNION ALL
      SELECT 'push_delivery',
        GREATEST(0,EXTRACT(EPOCH FROM completed_at-claimed_at)*1000),
        status='failed'
      FROM push_delivery_claims
      WHERE completed_at >= now() - interval '10 minutes'
        AND status IN ('delivered','failed')
    ) SELECT function_name, count(*) total,
      count(*) FILTER (WHERE failed) failed,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) p95_ms,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) p99_ms
    FROM events GROUP BY function_name`);
  const [serverResult, failuresResult, functionResult] = await Promise.allSettled([
    serverRead,
    failuresRead,
    functionsRead,
  ]);
  const failures = failuresResult.status === 'fulfilled' ? failuresResult.value.rows[0] : undefined;
  const total = number(failures?.total),
    failed = number(failures?.failed);
  const functionRows = functionResult.status === 'fulfilled' ? functionResult.value.rows : [];
  const functions = OBSERVED_FUNCTIONS.map((name) => {
    const row = functionRows.find((candidate) => candidate.function_name === name);
    const count = number(row?.total),
      failures = number(row?.failed);
    return {
      function: name,
      state:
        functionResult.status !== 'fulfilled'
          ? ('unavailable' as const)
          : count >= MIN_COHORT
            ? ('measured' as const)
            : ('unmeasured' as const),
      windowMinutes: FUNCTION_WINDOW_MINUTES,
      total: measuredCount(count),
      failed: measuredCount(failures),
      p95Ms: count >= MIN_COHORT ? number(row?.p95_ms) : null,
      p99Ms: count >= MIN_COHORT ? number(row?.p99_ms) : null,
      failureRate: count >= 20 ? failures / count : null,
      verdictSampleState: count >= 20 ? ('sufficient' as const) : ('insufficient' as const),
    };
  });
  const unmeasuredFunctions = functions
    .filter((entry) => entry.failureRate === null)
    .map((entry) => entry.function);
  const slowUnmeasuredFunctions = [
    ...(queryMeasured ? [] : ['database.query']),
    ...unmeasuredFunctions,
  ];
  const failingUnmeasuredFunctions = [
    ...(failuresResult.status === 'fulfilled' && total >= 20 ? [] : ['agent_turn']),
    ...unmeasuredFunctions,
  ];
  const slowFunction = functions.find(
    (entry) => entry.failureRate !== null && entry.p95Ms !== null && entry.p95Ms > 5000,
  )?.function;
  const failingFunction = functions.find(
    (entry) => entry.failureRate !== null && entry.failureRate >= 0.05,
  )?.function;
  const agentTurnRed =
    failuresResult.status === 'fulfilled' && total >= 20 && failed / total >= 0.05;
  return {
    state: serverResult.status === 'fulfilled' ? ('measured' as const) : ('unavailable' as const),
    measuredAt,
    server: {
      verdict: serverResult.status === 'fulfilled' ? ('green' as const) : ('red' as const),
      function: 'database.query',
    },
    slow: {
      verdict:
        querySlow || slowFunction
          ? ('red' as const)
          : slowUnmeasuredFunctions.length === 0
            ? ('green' as const)
            : ('unmeasured' as const),
      function: querySlow ? 'database.query' : (slowFunction ?? null),
      measuredFunctions: [
        ...(queryMeasured ? ['database.query'] : []),
        ...functions.filter((entry) => entry.failureRate !== null).map((entry) => entry.function),
      ],
      unmeasuredFunctions: slowUnmeasuredFunctions,
      windowMinutes: FUNCTION_WINDOW_MINUTES,
      thresholdMs: 5000,
      queryCount: queryWindow?.queryCount ?? null,
      queryP95Ms: queryWindow?.queryP95Ms ?? null,
      queryP99Ms: queryWindow?.queryP99Ms ?? null,
      checkoutCount: queryWindow?.checkoutCount ?? null,
      waitP95Ms: queryWindow?.waitP95Ms ?? null,
      waitP99Ms: queryWindow?.waitP99Ms ?? null,
      waiterP95: queryWindow?.waiterP95 ?? null,
      waiterP99: queryWindow?.waiterP99 ?? null,
      currentWaiters: pool?.waiting ?? null,
      oldestActiveQueryAgeMs: oldest ?? null,
    },
    failing: {
      verdict:
        agentTurnRed || failingFunction
          ? ('red' as const)
          : failingUnmeasuredFunctions.length === 0
            ? ('green' as const)
            : ('unmeasured' as const),
      function: agentTurnRed ? 'agent_turn' : (failingFunction ?? null),
      measuredFunctions:
        failuresResult.status === 'fulfilled' && total >= 20
          ? [
              'agent_turn',
              ...functions
                .filter((entry) => entry.failureRate !== null)
                .map((entry) => entry.function),
            ]
          : functions.filter((entry) => entry.failureRate !== null).map((entry) => entry.function),
      unmeasuredFunctions: failingUnmeasuredFunctions,
      windowHours: 24,
      failed: failuresResult.status === 'fulfilled' ? measuredCount(failed) : null,
      total: failuresResult.status === 'fulfilled' ? measuredCount(total) : null,
    },
    functions,
  };
}

export async function dashboardOps(
  database: SqlDatabase,
  measuredAt: string,
  releaseVersion: string,
  minRuntimes: { ios?: number; android?: number } = {},
) {
  const receiptsRead = database.query<{
    active: string;
    latest: string;
    unknown: string;
    store_only: string;
    unknown_runtime: string;
  }>(
    `WITH ${COHORT_SQL} SELECT count(*) active,
       count(*) FILTER(WHERE receipt->>'releaseVersion'=$1) latest,
       count(*) FILTER(WHERE NULLIF(receipt->>'releaseVersion','') IS NULL) unknown,
       count(*) FILTER(WHERE
         receipt->>'platform' IN ('ios','android') AND receipt->>'runtimeVersion' ~ '^[0-9]{1,9}$'
         AND CASE WHEN receipt->>'runtimeVersion' ~ '^[0-9]{1,9}$'
           THEN ((receipt->>'platform'='ios' AND (receipt->>'runtimeVersion')::int<$2::int)
             OR (receipt->>'platform'='android' AND (receipt->>'runtimeVersion')::int<$3::int))
           ELSE false END) store_only,
       count(*) FILTER(WHERE receipt->>'platform' NOT IN ('ios','android')
         OR receipt->>'platform' IS NULL OR receipt->>'runtimeVersion' !~ '^[0-9]{1,9}$'
         OR receipt->>'runtimeVersion' IS NULL) unknown_runtime
     FROM device_update_receipts d JOIN production_identities pi ON pi.id=d.identity_id
     WHERE reported_at>=now()-interval '30 days'
       AND receipt->>'platform' IN ('ios','android')`,
    [releaseVersion, minRuntimes.ios ?? null, minRuntimes.android ?? null],
  );
  const repeatsRead = database.query<{ current_count: string; prior_count: string }>(
    `WITH ${COHORT_SQL}, repeat_events AS (
       SELECT event.created_at FROM institutional_memory_correction_events event
       WHERE event.created_at>=now()-interval '60 days'
         AND event.workspace_id IN (SELECT id FROM production_workspaces)
         AND EXISTS (SELECT 1 FROM institutional_memory_correction_events prior
           WHERE prior.workspace_id=event.workspace_id AND prior.memory_kind=event.memory_kind
             AND prior.canonical_key=event.canonical_key
             AND (event.memory_kind='workspace_fact' OR prior.requester_identity_id=event.requester_identity_id)
             AND (prior.created_at,prior.id)<(event.created_at,event.id)
             AND prior.created_at>=event.created_at-interval '30 days')
     ) SELECT count(*) FILTER(WHERE created_at>=now()-interval '30 days') current_count,
              count(*) FILTER(WHERE created_at<now()-interval '30 days') prior_count FROM repeat_events`,
  );
  const [receiptResult, repeatResult] = await Promise.allSettled([receiptsRead, repeatsRead]);
  const receipts = receiptResult.status === 'fulfilled' ? receiptResult.value.rows[0] : undefined;
  const repeats = repeatResult.status === 'fulfilled' ? repeatResult.value.rows[0] : undefined;
  const active = number(receipts?.active),
    latest = number(receipts?.latest),
    unknown = number(receipts?.unknown),
    known = active - unknown;
  const storeMeasurable =
    receiptResult.status === 'fulfilled' &&
    minRuntimes.ios !== undefined &&
    minRuntimes.android !== undefined &&
    number(receipts?.unknown_runtime) === 0;
  const current = number(repeats?.current_count),
    prior = number(repeats?.prior_count);
  return {
    state: [receiptResult, repeatResult].some((result) => result.status === 'fulfilled')
      ? ('measured' as const)
      : ('unavailable' as const),
    measuredAt,
    release: {
      state:
        receiptResult.status === 'fulfilled' ? ('measured' as const) : ('unavailable' as const),
      latestVersion: releaseVersion === 'development' ? null : releaseVersion,
      activeWindowDays: 30,
      activePhones: receiptResult.status === 'fulfilled' ? measuredCount(active) : null,
      latestPhones: receiptResult.status === 'fulfilled' ? measuredCount(latest) : null,
      unknownBuildPhones: receiptResult.status === 'fulfilled' ? measuredCount(unknown) : null,
      // Receipts without a build version are reported as unknownBuildPhones
      // and left out of the share instead of blanking it.
      latestShare:
        receiptResult.status !== 'fulfilled' || releaseVersion === 'development' || known === 0
          ? null
          : latest / known,
      storeUpdateOnlyPhones: storeMeasurable ? measuredCount(receipts?.store_only) : null,
      storeUpdateState: storeMeasurable ? ('measured' as const) : ('unmeasured' as const),
    },
    memory: {
      repeatCorrections: {
        state:
          repeatResult.status === 'fulfilled' ? ('measured' as const) : ('unavailable' as const),
        windowDays: 30,
        current: repeatResult.status === 'fulfilled' ? measuredCount(current) : null,
        prior: repeatResult.status === 'fulfilled' ? measuredCount(prior) : null,
        trend:
          repeatResult.status === 'fulfilled' && prior > 0
            ? (measuredCount(current)! - measuredCount(prior)!) / measuredCount(prior)!
            : null,
      },
    },
  };
}

export async function readOperatorDashboard(
  database: SqlDatabase,
  platforms: readonly DashboardPlatform[],
  releaseVersion: string,
  minRuntimes: { ios?: number; android?: number } = {},
) {
  const measuredAt = new Date().toISOString();
  const [usage, health, ops] = await Promise.allSettled([
    dashboardUsage(database, platforms, measuredAt),
    dashboardHealth(database, measuredAt),
    dashboardOps(database, measuredAt, releaseVersion, minRuntimes),
  ]);
  const overview = await dashboardOverview(database, platforms, measuredAt).catch(sectionError);
  const periods = await dashboardPeriods(database, measuredAt).catch(sectionError);
  const platformBreakdown = await dashboardPlatformBreakdown(database).catch(sectionError);
  const downloads = await dashboardDownloads(database, platforms, measuredAt).catch(sectionError);
  const signinFunnel =
    'from' in downloads
      ? await dashboardSigninFunnel(
          database,
          platforms,
          measuredAt,
          downloads.from,
          downloads.through,
          downloads.count,
          Object.fromEntries(downloads.perPlatform.map((p) => [p.platform, p.count])),
        ).catch(sectionError)
      : sectionError();
  const downloadSource = (platform: string) => {
    const value =
      'perPlatform' in downloads
        ? downloads.perPlatform.find((p) => p.platform === platform)
        : undefined;
    return {
      state: value?.state ?? 'not_measured',
      source: value?.source ?? 'Store download reports',
      fetchedAt: value?.fetchedAt ?? null,
      lastCompleteDay: value?.lastCompleteDay ?? null,
    };
  };
  return {
    schemaVersion: 1,
    periods,
    platformBreakdown,
    downloads,
    signinFunnel,
    overview:
      'series' in overview
        ? {
            ...overview,
            series: {
              ...overview.series,
              downloads:
                'series' in downloads
                  ? {
                      state: downloads.state,
                      measuredAt,
                      data: { daily: downloads.series.daily, weekly: downloads.series.weekly },
                      from: downloads.from,
                      through: downloads.through,
                    }
                  : sectionError(),
            },
            sources: {
              ...overview.sources,
              downloadsIos: downloadSource('ios'),
              downloadsAndroid: downloadSource('android'),
            },
          }
        : overview,
    measuredAt,
    platforms: [...platforms],
    usage: usage.status === 'fulfilled' ? usage.value : sectionError(),
    health:
      health.status === 'fulfilled'
        ? health.value
        : {
            state: 'unavailable' as const,
            measuredAt: null,
            server: { verdict: 'red' as const, function: 'database.query' },
            slow: { verdict: 'unmeasured' as const, function: null, windowMinutes: 10 },
            failing: { verdict: 'unmeasured' as const, function: null },
            functions: [],
          },
    ops: ops.status === 'fulfilled' ? ops.value : sectionError(),
  };
}
