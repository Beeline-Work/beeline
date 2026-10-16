import { readFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import type { SqlDatabase } from './database.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';
import { freeAgentLimitsFromEnv } from './free-agent-limits.js';

// The same people cohort as the lifetime funnel. Device observations attribute
// people, never individual events; overlapping platform slices are not additive.
const ELIGIBLE = `WITH ${COHORT_SQL}, eligible AS MATERIALIZED (
  SELECT i.id, i.created_at FROM identities i
  JOIN production_identities pi ON pi.id=i.id
  WHERE i.kind='human' AND ($1::boolean
    OR EXISTS(SELECT 1 FROM push_devices d WHERE d.identity_id=i.id AND d.platform=ANY($2::text[]))
    OR EXISTS(SELECT 1 FROM device_update_receipts d WHERE d.identity_id=i.id
      AND d.receipt->>'platform'=ANY($2::text[])))
)`;
const DAY = (column: string) => `(${column} AT TIME ZONE 'UTC')::date::text`;
// Each aggregate scans a bounded ledger once. In particular, do not put a
// correlated first-reply scan inside a generated-day loop (production timeout).
const SERIES_SQL = {
  signups: `${ELIGIBLE} SELECT ${DAY('created_at')} date,count(*) value
    FROM eligible WHERE created_at >= $3::timestamptz AND created_at < $4::timestamptz+interval '1 day' GROUP BY 1`,
  workspaces: `${ELIGIBLE} SELECT ${DAY('w.created_at')} date,count(DISTINCT w.id) value
    FROM workspaces w JOIN production_workspaces pw ON pw.id=w.id
    JOIN memberships m ON m.workspace_id=w.id AND m.room_id IS NULL AND m.role='owner'
    JOIN eligible e ON e.id=m.identity_id WHERE w.created_at >= $3::timestamptz AND w.created_at < $4::timestamptz+interval '1 day' GROUP BY 1`,
  firstReply: `${ELIGIBLE}, firsts AS MATERIALIZED (
    SELECT a.owner_id,min(msg.created_at) at FROM messages msg
    JOIN rooms r ON r.id=msg.room_id JOIN production_workspaces w ON w.id=r.workspace_id
    JOIN agents a ON a.agent_id=msg.author_id JOIN production_identities ai ON ai.id=a.agent_id
    JOIN eligible e ON e.id=a.owner_id
    WHERE msg.created_at >= $3::timestamptz AND msg.created_at < $4::timestamptz+interval '1 day' AND msg.presentation='message' AND msg.deleted_at IS NULL
    GROUP BY a.owner_id
  ) SELECT ${DAY('at')} date,count(*) value FROM firsts GROUP BY 1`,
  friendsJoined: `${ELIGIBLE} SELECT ${DAY('m.joined_at')} date,count(DISTINCT m.identity_id) value
    FROM memberships m JOIN eligible e ON e.id=m.invited_by
    JOIN production_workspaces w ON w.id=m.workspace_id
    JOIN production_identities pi ON pi.id=m.identity_id JOIN identities i ON i.id=pi.id AND i.kind='human'
    WHERE m.joined_at >= $3::timestamptz AND m.joined_at < $4::timestamptz+interval '1 day' AND m.room_id IS NULL AND m.invited_by<>m.identity_id GROUP BY 1`,
  dau: `${ELIGIBLE} SELECT ${DAY('msg.created_at')} date,count(DISTINCT msg.author_id) value
    FROM messages msg JOIN rooms r ON r.id=msg.room_id
    JOIN production_workspaces w ON w.id=r.workspace_id JOIN eligible e ON e.id=msg.author_id
    WHERE msg.created_at >= $3::timestamptz AND msg.created_at < $4::timestamptz+interval '1 day' AND msg.presentation='message' AND msg.deleted_at IS NULL GROUP BY 1`,
  wau: `${ELIGIBLE}, activity AS MATERIALIZED (
    SELECT DISTINCT msg.author_id, (msg.created_at AT TIME ZONE 'UTC')::date date
    FROM messages msg JOIN rooms r ON r.id=msg.room_id
    JOIN production_workspaces w ON w.id=r.workspace_id JOIN eligible e ON e.id=msg.author_id
    WHERE msg.created_at >= $3::timestamptz AND msg.created_at < $4::timestamptz+interval '1 day'
      AND msg.presentation='message' AND msg.deleted_at IS NULL
  ), days AS (SELECT generate_series($3::date+6,$4::date,interval '1 day')::date date)
  SELECT days.date::text date,count(DISTINCT a.author_id) value FROM days
  LEFT JOIN activity a ON a.date BETWEEN days.date-6 AND days.date GROUP BY 1`,
};

type Point = { date: string; value: number };
type ReadState<T> =
  { state: 'measured'; measuredAt: string; data: T } | { state: 'unavailable'; measuredAt: null };
const numeric = (value: unknown) =>
  value === null || value === undefined
    ? null
    : Number.isFinite(Number(value)) && Number(value) >= 0
      ? Number(value)
      : null;
const dayMs = 86_400_000;
function dates(today: string, length: number): string[] {
  return Array.from({ length }, (_, i) =>
    new Date(Date.parse(today) - (length - 1 - i) * dayMs).toISOString().slice(0, 10),
  );
}
function weekly(points: Point[], metric: string): Point[] {
  const result: Point[] = [];
  // Trailing seven-day buckets, anchored at the measured date, not calendar weeks.
  for (let end = points.length; end > 0; end -= 7) {
    const group = points.slice(Math.max(0, end - 7), end);
    result.unshift({
      date: group.at(-1)!.date,
      value:
        metric === 'wau'
          ? group.at(-1)!.value
          : group.reduce((sum, p) => sum + p.value, 0) / (metric === 'dau' ? group.length : 1),
    });
  }
  return result;
}

export async function dashboardOverview(
  database: SqlDatabase,
  platforms: readonly string[],
  measuredAt: string,
) {
  const today = measuredAt.slice(0, 10);
  const days = dates(today, 90);
  const read = async <T>(
    sql: string,
    values: unknown[],
    map: (rows: Record<string, unknown>[]) => T,
  ): Promise<ReadState<T>> => {
    try {
      return { state: 'measured', measuredAt, data: map((await database.query(sql, values)).rows) };
    } catch {
      return { state: 'unavailable', measuredAt: null };
    }
  };
  const values = [
    platforms.length === 6,
    [...platforms],
    days[0] + 'T00:00:00.000Z',
    today + 'T00:00:00.000Z',
  ];
  const series: Record<string, ReadState<{ daily: Point[]; weekly: Point[] }>> = {};
  // Sequential reads keep an operator refresh from occupying the app pool.
  for (const [metric, sql] of Object.entries(SERIES_SQL)) {
    series[metric] = await read(sql, values, (rows) => {
      const counts = new Map(rows.map((row) => [String(row.date), Number(row.value)]));
      const daily = (metric === 'wau' ? days.slice(6) : days).map((date) => ({
        date,
        value: counts.get(date) ?? 0,
      }));
      return { daily, weekly: weekly(daily, metric) };
    });
  }
  const retention = await read(
    `${ELIGIBLE}, cohort AS (
    SELECT id, (created_at AT TIME ZONE 'UTC')::date joined FROM eligible
    WHERE created_at >= $3::timestamptz-interval '28 days'
      AND created_at < $3::timestamptz-interval '7 days'
  ), returned_people AS (
    SELECT DISTINCT msg.author_id FROM messages msg JOIN cohort c ON c.id=msg.author_id
    JOIN rooms r ON r.id=msg.room_id JOIN production_workspaces w ON w.id=r.workspace_id
    WHERE msg.created_at >= $3::timestamptz-interval '21 days' AND msg.created_at < $3::timestamptz
      AND msg.created_at >= (c.joined+7)::timestamp AT TIME ZONE 'UTC'
      AND msg.created_at < (c.joined+8)::timestamp AT TIME ZONE 'UTC'
      AND msg.presentation='message' AND msg.deleted_at IS NULL
  ) SELECT count(*) cohort,count(r.author_id) retained FROM cohort c LEFT JOIN returned_people r ON r.author_id=c.id`,
    [values[0], values[1], today + 'T00:00:00.000Z'],
    (rows) => {
      const cohort = Number(rows[0]?.cohort),
        retained = Number(rows[0]?.retained);
      return {
        cohort,
        retained,
        rate: cohort ? retained / cohort : null,
        day: 7,
        from: dates(today, 29)[0],
        through: dates(today, 9)[0],
      };
    },
  );
  const failures = await read(
    `SELECT ${DAY('created_at')} date,count(*) total,
    count(*) FILTER(WHERE status='failed') failed FROM agent_turns
    WHERE created_at >= $1::timestamptz GROUP BY 1 ORDER BY 1`,
    [days[0]],
    (rows) =>
      days.map((date) => {
        const row = rows.find((r) => r.date === date);
        const total = Number(row?.total ?? 0),
          failed = Number(row?.failed ?? 0);
        return { date, total, failed, rate: total ? failed / total : null };
      }),
  );
  const replyLatency = await read(
    `WITH ${COHORT_SQL}, paired AS (
    SELECT a.agent_id,min(t.created_at) at FROM agents a
    JOIN production_identities ai ON ai.id=a.agent_id
    JOIN production_identities pi ON pi.id=a.owner_id
    JOIN identities owner ON owner.id=pi.id AND owner.kind='human'
    JOIN daemon_tokens t ON t.agent_id=a.agent_id
    WHERE t.revoked_at IS NULL AND t.created_at >= $1::timestamptz GROUP BY a.agent_id
  ), replies AS (
    SELECT msg.author_id,min(msg.created_at) at FROM messages msg
    JOIN rooms r ON r.id=msg.room_id JOIN production_workspaces w ON w.id=r.workspace_id
    JOIN paired p ON p.agent_id=msg.author_id WHERE msg.created_at >= $1::timestamptz
      AND msg.presentation='message' AND msg.deleted_at IS NULL GROUP BY msg.author_id
  ) SELECT count(*) samples,percentile_cont(.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM r.at-p.at)*1000) median_ms
    FROM paired p JOIN replies r ON r.author_id=p.agent_id WHERE r.at>=p.at`,
    [values[2]],
    (rows) => {
      const samples = Number(rows[0]?.samples);
      return {
        samples,
        medianMs: samples >= 5 ? numeric(rows[0]?.median_ms) : null,
        windowDays: 90,
      };
    },
  );
  const helpers = await read(
    `WITH ${COHORT_SQL}, paired AS (
    SELECT DISTINCT a.agent_id FROM agents a JOIN production_identities ai ON ai.id=a.agent_id
    JOIN production_identities pi ON pi.id=a.owner_id JOIN identities i ON i.id=pi.id AND i.kind='human'
    JOIN daemon_tokens t ON t.agent_id=a.agent_id WHERE t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at>now())
  ) SELECT count(*) paired,count(*) FILTER(WHERE c.released_at IS NULL
    AND s.renewed_at>now()-interval '90 seconds') online FROM paired p
    LEFT JOIN agent_connections c ON c.agent_id=p.agent_id
    LEFT JOIN live_server_instances s ON s.instance_id=c.instance_id`,
    [],
    (rows) => {
      const paired = Number(rows[0]?.paired),
        online = Number(rows[0]?.online);
      return { paired, online, share: paired ? online / paired : null, renewalSeconds: 90 };
    },
  );
  const fleet = await read(
    `WITH ${COHORT_SQL} SELECT f.state,count(*) count FROM free_agents f
    JOIN production_workspaces w ON w.id=f.workspace_id
    JOIN production_identities pi ON pi.id=f.owner_id
    WHERE f.removed_at IS NULL GROUP BY f.state`,
    [],
    (rows) => rows.map((r) => ({ state: String(r.state), count: Number(r.count) })),
  );
  const spend = await read(
    `SELECT day::text date,usd FROM free_agent_budget WHERE day >= $1::date ORDER BY day`,
    [days[0]],
    (rows) => ({
      today,
      usd: numeric(rows.find((r) => r.date === today)?.usd),
      capUsd: freeAgentLimitsFromEnv(process.env).dailyBudgetUsd,
      history: rows.map((r) => ({ date: String(r.date), usd: numeric(r.usd) })),
    }),
  );
  const databaseCapacity = await read(
    `SELECT pg_database_size(current_database()) bytes,
    (SELECT count(*) FROM pg_stat_activity) connections,
    (SELECT count(*) FROM live_server_instances WHERE renewed_at>now()-interval '90 seconds') live_servers`,
    [],
    (rows) => ({
      bytes: numeric(rows[0]?.bytes),
      connections: numeric(rows[0]?.connections),
      liveServers: numeric(rows[0]?.live_servers),
    }),
  );
  let serverCapacity: ReadState<{
    memoryUsedShare: number;
    memoryTotalBytes: number;
    load1m: number;
    scope: 'responding_server';
  }>;
  try {
    const info = await readFile('/proc/meminfo', 'utf8');
    const total = Number(info.match(/^MemTotal:\s+(\d+)/m)?.[1]);
    const available = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
    if (!(total > 0) || !Number.isFinite(available) || available > total)
      throw new Error('No memory sample');
    serverCapacity = {
      state: 'measured',
      measuredAt,
      data: {
        memoryUsedShare: 1 - available / total,
        memoryTotalBytes: total * 1024,
        load1m: loadavg()[0]!,
        scope: 'responding_server',
      },
    };
  } catch {
    serverCapacity = { state: 'unavailable', measuredAt: null };
  }
  const releases = await read(
    `WITH ${COHORT_SQL} SELECT d.receipt->>'platform' platform,
    left(d.receipt->>'releaseVersion',40) version,count(*) devices FROM device_update_receipts d
    JOIN production_identities pi ON pi.id=d.identity_id WHERE d.reported_at >= $1::timestamptz-interval '30 days'
      AND d.receipt->>'platform' IN ('ios','android') GROUP BY 1,2 ORDER BY 1,2`,
    [measuredAt],
    (rows) =>
      rows.map((r) => ({
        platform: String(r.platform),
        version: r.version === null ? null : String(r.version),
        devices: Number(r.devices),
      })),
  );
  return {
    state: 'measured' as const,
    measuredAt,
    windowDays: 90,
    series,
    retention,
    failures,
    replyLatency,
    helpers,
    fleet,
    spend,
    capacity: { database: databaseCapacity, server: serverCapacity },
    releases,
    sources: {
      downloadsIos: { state: 'not_connected', source: 'App Store Connect download reports' },
      downloadsAndroid: { state: 'not_connected', source: 'Google Play Console download reports' },
      signIns: { state: 'not_connected', source: 'Platform-tagged authentication events' },
      sentry: { state: 'not_connected', source: 'Sentry and Telegram delivery verification' },
      providerBalances: {
        state: 'not_connected',
        source: 'OpenRouter credits, Groq transcription billing, Cloudflare Workers quotas',
      },
      upgradeForecast: {
        state: 'not_connected',
        source: 'Neon plan allowances and Fly metric history',
      },
      latestRelease: {
        state:
          process.env.BEELINE_DASHBOARD_LATEST_MOBILE_RELEASE &&
          process.env.BEELINE_DASHBOARD_LATEST_MOBILE_RELEASE !== 'development'
            ? 'connected'
            : 'not_connected',
        source: 'Configured latest mobile release and supported store runtimes',
      },
    },
  };
}
