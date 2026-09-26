import type { SqlDatabase } from './database.js';

export const DASHBOARD_PLATFORMS = ['ios', 'android', 'macos', 'windows', 'linux'] as const;
export type DashboardPlatform = (typeof DASHBOARD_PLATFORMS)[number];
export const DASHBOARD_STAGES = ['signup', 'workspace', 'paired', 'reply', 'corner', 'merged'] as const;

type CountRow = Record<(typeof DASHBOARD_STAGES)[number], string | number>;
const ALL = [...DASHBOARD_PLATFORMS];
const MIN_COHORT = 5;
/** Round released counts to 5-person buckets and suppress small cells. */
function privateCount(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= MIN_COHORT ? Math.floor(n / MIN_COHORT) * MIN_COHORT : null;
}
function number(value: unknown): number { return Number(value ?? 0); }
function sectionError() { return { state: 'unavailable' as const, measuredAt: null }; }

export function parseDashboardPlatforms(raw: string | null): DashboardPlatform[] | null {
  if (raw === null) return ALL;
  const values = raw.split(',');
  if (!values.length || values.some((value) => !DASHBOARD_PLATFORMS.includes(value as DashboardPlatform)) || new Set(values).size !== values.length)
    return null;
  return DASHBOARD_PLATFORMS.filter((value) => values.includes(value));
}

const FUNNEL_SQL = `WITH eligible AS (
  SELECT i.id FROM identities i
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
    EXISTS(SELECT 1 FROM memberships m WHERE m.identity_id=e.id AND m.room_id IS NULL AND m.removed_at IS NULL) workspace,
    EXISTS(SELECT 1 FROM agents a JOIN daemon_tokens t ON t.agent_id=a.agent_id WHERE a.owner_id=e.id AND t.revoked_at IS NULL) paired,
    EXISTS(SELECT 1 FROM agents a JOIN messages m ON m.author_id=a.agent_id WHERE a.owner_id=e.id AND m.presentation='message' AND m.deleted_at IS NULL) reply,
    EXISTS(SELECT 1 FROM corner_facts f WHERE f.commissioned_by=e.id) corner,
    EXISTS(SELECT 1 FROM corner_facts f WHERE f.commissioned_by=e.id AND f.lifecycle->'pr'->>'mergedAt' IS NOT NULL) merged
  FROM eligible e
), agent_steps AS (
  SELECT a.agent_id,
    EXISTS(SELECT 1 FROM memberships m WHERE m.identity_id=a.agent_id AND m.room_id IS NULL AND m.removed_at IS NULL) workspace,
    EXISTS(SELECT 1 FROM daemon_tokens t WHERE t.agent_id=a.agent_id AND t.revoked_at IS NULL) paired,
    EXISTS(SELECT 1 FROM messages m WHERE m.author_id=a.agent_id AND m.presentation='message' AND m.deleted_at IS NULL) reply,
    EXISTS(SELECT 1 FROM corner_facts f WHERE f.owner_agent_id=a.agent_id) corner,
    EXISTS(SELECT 1 FROM corner_facts f WHERE f.owner_agent_id=a.agent_id AND f.lifecycle->'pr'->>'mergedAt' IS NOT NULL) merged
  FROM agents a JOIN eligible e ON e.id=a.owner_id JOIN identities i ON i.id=a.agent_id AND NOT i.hidden_from_roster
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

export async function dashboardUsage(database: SqlDatabase, platforms: readonly DashboardPlatform[], measuredAt: string) {
  const all = platforms.length === ALL.length;
  const coverage = (await database.query<{ platform: string }>(
    `SELECT DISTINCT receipt->>'platform' platform FROM device_update_receipts
     WHERE receipt->>'platform'=ANY($1::text[])
     UNION SELECT DISTINCT platform FROM push_devices WHERE platform=ANY($1::text[])`, [ALL],
  )).rows.map((row) => row.platform);
  const unobserved = !all && platforms.some((p) => !['ios', 'android'].includes(p) && !coverage.includes(p));
  if (unobserved) return {
    state: 'unmeasured' as const, measuredAt, reason: 'desktop_platform_not_recorded',
    platformCoverage: coverage, people: null, agents: null,
  };
  const rows = (await database.query<CountRow & { kind: 'people' | 'agents' }>(FUNNEL_SQL, [all, platforms])).rows;
  const stages = (kind: 'people' | 'agents') => {
    const row = rows.find((entry) => entry.kind === kind);
    return DASHBOARD_STAGES.map((stage, index) => ({
      stage, count: privateCount(row?.[stage]),
      previousStage: index ? DASHBOARD_STAGES[index - 1] : null,
      denominator: index ? privateCount(row?.[DASHBOARD_STAGES[index - 1]!]) : null,
    }));
  };
  return {
    state: 'measured' as const, measuredAt,
    platformCoverage: coverage,
    people: stages('people'), agents: stages('agents'),
  };
}

export async function dashboardHealth(database: SqlDatabase, measuredAt: string) {
  await database.query('SELECT 1');
  const pool = database.poolCounts?.() ?? { total: 0, idle: 0, waiting: 0 };
  const oldest = await database.oldestActiveQueryAgeMs?.();
  const slow = pool.waiting > 0 || (oldest !== undefined && oldest !== null && oldest > 5000);
  const failures = (await database.query<{ total: string; failed: string }>(
    `SELECT count(*) total, count(*) FILTER (WHERE status='failed') failed
     FROM agent_turns WHERE created_at>=now()-interval '24 hours'`,
  )).rows[0];
  const total = number(failures?.total), failed = number(failures?.failed);
  return {
    state: 'measured' as const, measuredAt,
    server: { verdict: 'green' as const, function: 'database.query' },
    slow: { verdict: oldest === undefined && pool.total === 0 ? 'unmeasured' as const : slow ? 'red' as const : 'green' as const, function: slow ? 'database.query' : null,
      thresholdMs: 5000, oldestActiveQueryAgeMs: oldest ?? null },
    failing: { verdict: total < 20 ? 'unmeasured' as const : failed / total >= 0.05 ? 'red' as const : 'green' as const,
      function: failed >= MIN_COHORT ? 'agent_turn' : null, windowHours: 24,
      failed: privateCount(failed), total: privateCount(total) },
  };
}

export async function dashboardOps(database: SqlDatabase, measuredAt: string, releaseVersion: string, minRuntimes: { ios?: number; android?: number } = {}) {
  const receipts = (await database.query<{ active: string; latest: string; unknown: string; store_only: string; unknown_runtime: string }>(
    `SELECT count(*) active,
       count(*) FILTER(WHERE receipt->>'releaseVersion'=$1) latest,
       count(*) FILTER(WHERE NULLIF(receipt->>'releaseVersion','') IS NULL) unknown,
       count(*) FILTER(WHERE
         receipt->>'platform' IN ('ios','android') AND receipt->>'runtimeVersion' ~ '^[0-9]+$'
         AND CASE WHEN receipt->>'runtimeVersion' ~ '^[0-9]+$'
           THEN ((receipt->>'platform'='ios' AND (receipt->>'runtimeVersion')::int<$2::int)
             OR (receipt->>'platform'='android' AND (receipt->>'runtimeVersion')::int<$3::int))
           ELSE false END) store_only,
       count(*) FILTER(WHERE receipt->>'platform' NOT IN ('ios','android')
         OR receipt->>'platform' IS NULL OR receipt->>'runtimeVersion' !~ '^[0-9]+$'
         OR receipt->>'runtimeVersion' IS NULL) unknown_runtime
     FROM device_update_receipts
     WHERE reported_at>=now()-interval '30 days'`, [releaseVersion, minRuntimes.ios ?? null, minRuntimes.android ?? null],
  )).rows[0];
  const active = number(receipts?.active), latest = number(receipts?.latest), unknown = number(receipts?.unknown);
  const storeMeasurable = minRuntimes.ios !== undefined && minRuntimes.android !== undefined &&
    number(receipts?.unknown_runtime) === 0;
  const repeats = (await database.query<{ current_count: string; prior_count: string }>(
    `WITH repeat_events AS (
       SELECT event.created_at FROM institutional_memory_correction_events event
       WHERE event.created_at>=now()-interval '60 days'
         AND EXISTS (SELECT 1 FROM institutional_memory_correction_events prior
           WHERE prior.workspace_id=event.workspace_id AND prior.memory_kind=event.memory_kind
             AND prior.canonical_key=event.canonical_key
             AND (event.memory_kind='workspace_fact' OR prior.requester_identity_id=event.requester_identity_id)
             AND (prior.created_at,prior.id)<(event.created_at,event.id)
             AND prior.created_at>=event.created_at-interval '30 days')
     ) SELECT count(*) FILTER(WHERE created_at>=now()-interval '30 days') current_count,
              count(*) FILTER(WHERE created_at<now()-interval '30 days') prior_count FROM repeat_events`,
  )).rows[0];
  const current = number(repeats?.current_count), prior = number(repeats?.prior_count);
  const tokens = (await database.query<{ sampled: string; missing: string; memory_tokens: string; total_tokens: string }>(
    `SELECT count(*) FILTER(WHERE actual_input_tokens IS NOT NULL AND prompt_bytes IS NOT NULL) sampled,
       count(*) FILTER(WHERE actual_input_tokens IS NULL OR prompt_bytes IS NULL) missing,
       COALESCE(sum(LEAST(actual_input_tokens,ceil(actual_input_tokens::numeric*total_bytes/NULLIF(prompt_bytes,0))::int))
         FILTER(WHERE actual_input_tokens IS NOT NULL AND prompt_bytes IS NOT NULL),0) memory_tokens,
       COALESCE(sum(actual_input_tokens) FILTER(WHERE actual_input_tokens IS NOT NULL AND prompt_bytes IS NOT NULL),0) total_tokens
     FROM institutional_context_serves WHERE mode='live' AND served AND created_at>=now()-interval '30 days'`,
  )).rows[0];
  const sampled = number(tokens?.sampled), missing = number(tokens?.missing), totalTokens = number(tokens?.total_tokens);
  return {
    state: 'measured' as const, measuredAt,
    release: {
      latestVersion: releaseVersion === 'development' ? null : releaseVersion,
      activeWindowDays: 30, activePhones: privateCount(active), latestPhones: privateCount(latest),
      unknownBuildPhones: privateCount(unknown),
      latestShare: releaseVersion === 'development' || unknown > 0 || latest < MIN_COHORT || active - latest < MIN_COHORT
        ? null : privateCount(latest)! / privateCount(active)!,
      storeUpdateOnlyPhones: storeMeasurable ? privateCount(receipts?.store_only) : null,
      storeUpdateState: storeMeasurable ? 'measured' as const : 'unmeasured' as const,
    },
    memory: {
      repeatCorrections: { windowDays: 30, current: privateCount(current), prior: privateCount(prior),
        trend: prior >= MIN_COHORT && current >= MIN_COHORT ? (current - prior) / prior : null },
      tokenShare: { windowDays: 30, share: sampled >= MIN_COHORT && missing === 0 && totalTokens > 0
        ? number(tokens?.memory_tokens) / totalTokens : null,
        state: sampled >= MIN_COHORT && missing === 0 && totalTokens > 0 ? 'measured' as const : 'unmeasured' as const,
        sampledServes: privateCount(sampled), missingServes: privateCount(missing) },
    },
  };
}

export async function readOperatorDashboard(database: SqlDatabase, platforms: readonly DashboardPlatform[], releaseVersion: string,
  minRuntimes: { ios?: number; android?: number } = {}) {
  const measuredAt = new Date().toISOString();
  const [usage, health, ops] = await Promise.allSettled([
    dashboardUsage(database, platforms, measuredAt),
    dashboardHealth(database, measuredAt),
    dashboardOps(database, measuredAt, releaseVersion, minRuntimes),
  ]);
  return {
    schemaVersion: 1, measuredAt, platforms: [...platforms],
    usage: usage.status === 'fulfilled' ? usage.value : sectionError(),
    health: health.status === 'fulfilled' ? health.value : {
      state: 'unavailable' as const, measuredAt: null,
      server: { verdict: 'red' as const, function: 'database.query' },
      slow: { verdict: 'unmeasured' as const, function: null },
      failing: { verdict: 'unmeasured' as const, function: null },
    },
    ops: ops.status === 'fulfilled' ? ops.value : sectionError(),
  };
}
