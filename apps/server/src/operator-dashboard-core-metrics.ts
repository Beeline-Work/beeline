import type { SqlDatabase } from './database.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';

const TIME_ZONE = 'America/New_York';
const ELIGIBLE = `WITH ${COHORT_SQL}, eligible AS MATERIALIZED (
  SELECT i.id, i.created_at FROM identities i
  JOIN production_identities pi ON pi.id=i.id
  WHERE i.kind='human' AND ($1::boolean
    OR EXISTS(SELECT 1 FROM push_devices d WHERE d.identity_id=i.id AND d.platform=ANY($2::text[]))
    OR EXISTS(SELECT 1 FROM device_update_receipts d WHERE d.identity_id=i.id
      AND d.receipt->>'platform'=ANY($2::text[])))
)`;
const DAY = (column: string) => `(${column} AT TIME ZONE '${TIME_ZONE}')::date`;
const IN_WINDOW = (column: string) =>
  `${column} >= ($3::date::timestamp AT TIME ZONE '${TIME_ZONE}') AND ${column} < (($4::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')`;
const ON_OR_AFTER_EPOCH = (column: string, epoch = 'epoch') =>
  `${DAY(column)} >= (SELECT ${DAY('started_at')} FROM ${epoch})`;

type ReadState<T> =
  | { state: 'measured'; measuredAt: string; data: T }
  | { state: 'unavailable'; measuredAt: null };
type Count = number | null;
type SqlRow = {
  kind: string;
  date: string | null;
  value: number | string | null;
  last7: number | string | null;
  prior7: number | string | null;
  since: Date | string | null;
};

const dayMs = 86_400_000;
function dates(today: string, length: number): string[] {
  return Array.from({ length }, (_, i) =>
    new Date(Date.parse(`${today}T00:00:00.000Z`) - (length - 1 - i) * dayMs).toISOString().slice(0, 10),
  );
}
function easternDate(instant: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(instant));
}
function asNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function asInstant(value: Date | string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function series(rows: SqlRow[], dayKind: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === dayKind && row.date) counts.set(row.date, asNumber(row.value));
  }
  return counts;
}
function windowCount(row: SqlRow | undefined, field: 'last7' | 'prior7', slice: string[], since: string | null): Count {
  if (since === null || slice.every((date) => date < since)) return null;
  return asNumber(row?.[field]);
}
function peopleWindows(rows: SqlRow[], kind: string) {
  return rows.find((row) => row.kind === kind);
}

const INVITES_SQL = `/* core-metric:invites */ ${ELIGIBLE},
epoch AS (SELECT started_at FROM operator_metric_epochs WHERE metric='invite'),
created AS MATERIALIZED (
  SELECT i.created_by person, ${DAY('i.created_at')} metric_day
  FROM invites i
  JOIN eligible e ON e.id=i.created_by
  JOIN production_workspaces w ON w.id=i.workspace_id
  WHERE i.created_at IS NOT NULL AND ${ON_OR_AFTER_EPOCH('i.created_at')} AND ${IN_WINDOW('i.created_at')}
),
accepted AS MATERIALIZED (
  SELECT m.invited_by person, ${DAY('m.joined_at')} metric_day
  FROM memberships m
  JOIN eligible e ON e.id=m.invited_by
  JOIN production_workspaces w ON w.id=m.workspace_id
  JOIN production_identities pi ON pi.id=m.identity_id
  JOIN identities invitee ON invitee.id=pi.id AND invitee.kind='human'
  WHERE m.room_id IS NULL AND m.invited_by<>m.identity_id AND ${IN_WINDOW('m.joined_at')}
)
SELECT 'created_day'::text kind, metric_day::text date, count(DISTINCT person)::int value,
  NULL::int last7, NULL::int prior7, NULL::timestamptz since FROM created GROUP BY metric_day
UNION ALL
SELECT 'created_window', NULL::text, NULL::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 6) AND $4::date))::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 13) AND ($4::date - 7)))::int,
  NULL::timestamptz FROM created
UNION ALL
SELECT 'accepted_day', metric_day::text, count(DISTINCT person)::int, NULL::int, NULL::int, NULL::timestamptz
  FROM accepted GROUP BY metric_day
UNION ALL
SELECT 'accepted_window', NULL::text, NULL::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 6) AND $4::date))::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 13) AND ($4::date - 7)))::int,
  NULL::timestamptz FROM accepted
UNION ALL
SELECT 'epoch', NULL::text, NULL::int, NULL::int, NULL::int, started_at FROM epoch`;

const ONBOARDING_SQL = `/* core-metric:onboarding */ ${ELIGIBLE},
signups AS MATERIALIZED (
  SELECT e.id, ${DAY('e.created_at')} signup_day FROM eligible e WHERE ${IN_WINDOW('e.created_at')}
),
replied AS MATERIALIZED (
  SELECT DISTINCT a.owner_id
  FROM messages msg
  JOIN rooms r ON r.id=msg.room_id
  JOIN production_workspaces w ON w.id=r.workspace_id
  JOIN agents a ON a.agent_id=msg.author_id
  JOIN signups s ON s.id=a.owner_id
  JOIN production_identities ai ON ai.id=a.agent_id
  WHERE msg.presentation='message' AND msg.deleted_at IS NULL AND ${IN_WINDOW('msg.created_at')}
),
returned AS MATERIALIZED (
  SELECT DISTINCT msg.author_id
  FROM messages msg
  JOIN signups s ON s.id=msg.author_id
  JOIN rooms r ON r.id=msg.room_id
  JOIN production_workspaces w ON w.id=r.workspace_id
  WHERE msg.presentation='message' AND msg.deleted_at IS NULL
    AND ${DAY('msg.created_at')}=s.signup_day + 1
    AND msg.created_at >= ($3::date::timestamp AT TIME ZONE '${TIME_ZONE}')
    AND msg.created_at < (($4::date + 2)::timestamp AT TIME ZONE '${TIME_ZONE}')
)
SELECT s.signup_day::text date,
  (count(*) FILTER (WHERE rep.owner_id IS NOT NULL))::int completed,
  (count(*) FILTER (WHERE rep.owner_id IS NOT NULL AND s.signup_day <= $4::date - 2))::int eligible,
  (count(*) FILTER (WHERE rep.owner_id IS NOT NULL AND s.signup_day <= $4::date - 2 AND ret.author_id IS NOT NULL))::int returned
FROM signups s
LEFT JOIN replied rep ON rep.owner_id=s.id
LEFT JOIN returned ret ON ret.author_id=s.id
GROUP BY s.signup_day`;

const OWN_AGENTS_SQL = `/* core-metric:own-agents */ ${ELIGIBLE},
epoch AS (SELECT started_at FROM operator_metric_epochs WHERE metric='agent_pairing'),
attempted AS MATERIALIZED (
  SELECT c.created_by person, ${DAY('c.created_at')} metric_day
  FROM agent_pairing_codes c
  JOIN eligible e ON e.id=c.created_by
  JOIN production_workspaces w ON w.id=c.workspace_id
  WHERE c.created_at IS NOT NULL AND ${ON_OR_AFTER_EPOCH('c.created_at')} AND ${IN_WINDOW('c.created_at')}
),
first_token AS MATERIALIZED (
  SELECT a.owner_id person, min(t.created_at) at
  FROM daemon_tokens t
  JOIN agents a ON a.agent_id=t.agent_id
  JOIN eligible e ON e.id=a.owner_id
  JOIN production_identities ai ON ai.id=a.agent_id
  WHERE t.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM free_agents f WHERE f.agent_id=a.agent_id)
    AND EXISTS (
      SELECT 1 FROM memberships m
      JOIN production_workspaces w ON w.id=m.workspace_id
      WHERE m.identity_id=a.agent_id AND m.room_id IS NULL AND m.removed_at IS NULL
    )
  GROUP BY a.owner_id
),
succeeded AS MATERIALIZED (
  SELECT person, ${DAY('at')} metric_day FROM first_token WHERE ${IN_WINDOW('at')}
)
SELECT 'attempted_day'::text kind, metric_day::text date, count(DISTINCT person)::int value,
  NULL::int last7, NULL::int prior7, NULL::timestamptz since FROM attempted GROUP BY metric_day
UNION ALL
SELECT 'attempted_window', NULL::text, NULL::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 6) AND $4::date))::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 13) AND ($4::date - 7)))::int,
  NULL::timestamptz FROM attempted
UNION ALL
SELECT 'succeeded_day', metric_day::text, count(DISTINCT person)::int, NULL::int, NULL::int, NULL::timestamptz
  FROM succeeded GROUP BY metric_day
UNION ALL
SELECT 'succeeded_window', NULL::text, NULL::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 6) AND $4::date))::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 13) AND ($4::date - 7)))::int,
  NULL::timestamptz FROM succeeded
UNION ALL
SELECT 'epoch', NULL::text, NULL::int, NULL::int, NULL::int, started_at FROM epoch`;

const REPOSITORIES_SQL = `/* core-metric:repositories */ ${ELIGIBLE},
attempted AS MATERIALIZED (
  SELECT msg.card->>'requesterId' person, ${DAY('msg.created_at')} metric_day
  FROM messages msg
  JOIN rooms r ON r.id=msg.room_id
  JOIN production_workspaces w ON w.id=r.workspace_id
  JOIN eligible e ON e.id=msg.card->>'requesterId'
  WHERE msg.card_type='repository-onboarding' AND msg.card->>'kind'='repository'
    AND msg.deleted_at IS NULL AND ${IN_WINDOW('msg.created_at')}
),
succeeded AS MATERIALIZED (
  SELECT l.identity_id person, ${DAY('l.first_linked_at')} metric_day
  FROM repository_link_successes l
  JOIN eligible e ON e.id=l.identity_id
  JOIN production_workspaces w ON w.id=l.workspace_id
  WHERE ${IN_WINDOW('l.first_linked_at')}
)
SELECT 'attempted_day'::text kind, metric_day::text date, count(DISTINCT person)::int value,
  NULL::int last7, NULL::int prior7, NULL::timestamptz since FROM attempted GROUP BY metric_day
UNION ALL
SELECT 'attempted_window', NULL::text, NULL::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 6) AND $4::date))::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 13) AND ($4::date - 7)))::int,
  NULL::timestamptz FROM attempted
UNION ALL
SELECT 'succeeded_day', metric_day::text, count(DISTINCT person)::int, NULL::int, NULL::int, NULL::timestamptz
  FROM succeeded GROUP BY metric_day
UNION ALL
SELECT 'succeeded_window', NULL::text, NULL::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 6) AND $4::date))::int,
  (count(DISTINCT person) FILTER (WHERE metric_day BETWEEN ($4::date - 13) AND ($4::date - 7)))::int,
  NULL::timestamptz FROM succeeded`;

const TOKENS_SQL = `/* core-metric:tokens */ ${ELIGIBLE},
free_days AS MATERIALIZED (
  SELECT ${DAY('event.at')} metric_day,
    CASE WHEN event.detail->>'tokens' ~ '^[0-9]+$' THEN (event.detail->>'tokens')::bigint ELSE NULL END tokens
  FROM free_agent_events event
  JOIN free_agents f ON f.agent_id=event.agent_id
  JOIN eligible owner ON owner.id=f.owner_id
  JOIN production_workspaces w ON w.id=f.workspace_id
  WHERE event.kind='model_usage' AND ${IN_WINDOW('event.at')}
),
own_turns AS MATERIALIZED (
  SELECT ${DAY('t.created_at')} metric_day,
    CASE WHEN t.input_tokens IS NULL AND t.output_tokens IS NULL THEN NULL
         ELSE COALESCE(t.input_tokens,0)::bigint + COALESCE(t.output_tokens,0)::bigint END tokens
  FROM agent_turns t
  JOIN agents a ON a.agent_id=t.agent_id
  JOIN eligible e ON e.id=a.owner_id
  JOIN rooms r ON r.id=t.room_id
  JOIN production_workspaces w ON w.id=r.workspace_id
  JOIN production_identities ai ON ai.id=a.agent_id
  WHERE NOT EXISTS (SELECT 1 FROM free_agents f WHERE f.agent_id=t.agent_id)
    AND ${IN_WINDOW('t.created_at')}
)
SELECT 'free'::text kind, metric_day::text date, COALESCE(sum(tokens),0)::text value, 0::int unmeasured
  FROM free_days GROUP BY metric_day
UNION ALL
SELECT 'own', metric_day::text,
  CASE WHEN count(tokens)=0 THEN NULL ELSE COALESCE(sum(tokens),0)::text END,
  (count(*) FILTER (WHERE tokens IS NULL))::int
  FROM own_turns GROUP BY metric_day`;

function fillEpoch(days: string[], counts: Map<string, number>, sinceDate: string | null): Count[] {
  return days.map((date) => {
    if (sinceDate === null || date < sinceDate) return null;
    return counts.get(date) ?? 0;
  });
}
function fillZero(days: string[], counts: Map<string, number>): number[] {
  return days.map((date) => counts.get(date) ?? 0);
}
function sinceFrom(rows: SqlRow[]): { since: string | null; sinceDate: string | null } {
  const since = asInstant(rows.find((row) => row.kind === 'epoch')?.since ?? null);
  return { since, sinceDate: since ? easternDate(since) : null };
}
function change(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return (current - prior) / prior;
}

const unavailable = { state: 'unavailable' as const, measuredAt: null };
export function unavailableCoreMetrics() {
  return {
    invites: unavailable,
    onboarding: unavailable,
    ownAgents: unavailable,
    repositories: unavailable,
    tokens: unavailable,
  };
}

export async function dashboardCoreMetrics(
  database: SqlDatabase,
  platforms: readonly string[],
  measuredAt: string,
) {
  const today = easternDate(measuredAt);
  const days = dates(today, 90);
  const last7 = days.slice(-7);
  const prior7 = days.slice(-14, -7);
  const values = [platforms.length === 6, [...platforms], days[0], today];
  const read = async <T>(sql: string, map: (rows: SqlRow[]) => T): Promise<ReadState<T>> => {
    try {
      return {
        state: 'measured',
        measuredAt,
        data: map((await database.query<SqlRow>(sql, values)).rows),
      };
    } catch {
      return { state: 'unavailable', measuredAt: null };
    }
  };
  const sumDays = (daily: { date: string; completedOnboarding: number; returnedNextDay: number; eligible: number }[], slice: string[]) => {
    const picked = daily.filter((point) => slice.includes(point.date));
    return {
      completedOnboarding: picked.reduce((sum, point) => sum + point.completedOnboarding, 0),
      returnedNextDay: picked.reduce((sum, point) => sum + point.returnedNextDay, 0),
      eligible: picked.reduce((sum, point) => sum + point.eligible, 0),
    };
  };

  const invites = await read(INVITES_SQL, (rows) => {
    const { since, sinceDate } = sinceFrom(rows);
    const created = series(rows, 'created_day');
    const accepted = series(rows, 'accepted_day');
    const daily = days.map((date, index) => ({
      date,
      inviters: fillEpoch(days, created, sinceDate)[index]!,
      invitesAccepted: fillZero(days, accepted)[index]!,
    }));
    const createdWindow = peopleWindows(rows, 'created_window');
    const acceptedWindow = peopleWindows(rows, 'accepted_window');
    return {
      since,
      timeZone: TIME_ZONE,
      daily,
      last7: {
        inviters: windowCount(createdWindow, 'last7', last7, sinceDate),
        invitesAccepted: asNumber(acceptedWindow?.last7),
      },
      prior7: {
        inviters: windowCount(createdWindow, 'prior7', prior7, sinceDate),
        invitesAccepted: asNumber(acceptedWindow?.prior7),
      },
    };
  });
  const onboarding = await read(ONBOARDING_SQL, (rows) => {
    const byDate = new Map(rows.map((row) => [String(row.date), row]));
    const daily = days.map((date) => {
      const row = byDate.get(date) as { completed?: unknown; eligible?: unknown; returned?: unknown } | undefined;
      return {
        date,
        completedOnboarding: asNumber(row?.completed),
        returnedNextDay: asNumber(row?.returned),
        eligible: asNumber(row?.eligible),
      };
    });
    return {
      timeZone: TIME_ZONE,
      daily,
      last7: sumDays(daily, last7),
      prior7: sumDays(daily, prior7),
    };
  });
  const ownAgents = await read(OWN_AGENTS_SQL, (rows) => {
    const { since, sinceDate } = sinceFrom(rows);
    const attempted = series(rows, 'attempted_day');
    const succeeded = series(rows, 'succeeded_day');
    const daily = days.map((date, index) => ({
      date,
      connectAttempted: fillEpoch(days, attempted, sinceDate)[index]!,
      connectSucceeded: fillZero(days, succeeded)[index]!,
    }));
    const attemptedWindow = peopleWindows(rows, 'attempted_window');
    const succeededWindow = peopleWindows(rows, 'succeeded_window');
    return {
      since,
      timeZone: TIME_ZONE,
      daily,
      last7: {
        connectAttempted: windowCount(attemptedWindow, 'last7', last7, sinceDate),
        connectSucceeded: asNumber(succeededWindow?.last7),
      },
      prior7: {
        connectAttempted: windowCount(attemptedWindow, 'prior7', prior7, sinceDate),
        connectSucceeded: asNumber(succeededWindow?.prior7),
      },
    };
  });
  const repositories = await read(REPOSITORIES_SQL, (rows) => {
    const attempted = series(rows, 'attempted_day');
    const succeeded = series(rows, 'succeeded_day');
    const daily = days.map((date, index) => ({
      date,
      linkAttempted: fillZero(days, attempted)[index]!,
      linkSucceeded: fillZero(days, succeeded)[index]!,
    }));
    const attemptedWindow = peopleWindows(rows, 'attempted_window');
    const succeededWindow = peopleWindows(rows, 'succeeded_window');
    return {
      timeZone: TIME_ZONE,
      daily,
      last7: {
        linkAttempted: asNumber(attemptedWindow?.last7),
        linkSucceeded: asNumber(succeededWindow?.last7),
      },
      prior7: {
        linkAttempted: asNumber(attemptedWindow?.prior7),
        linkSucceeded: asNumber(succeededWindow?.prior7),
      },
    };
  });
  const tokens = await read(TOKENS_SQL, (rows) => {
    const free = new Map<string, number>();
    const own = new Map<string, number | null>();
    const unmeasured = new Map<string, number>();
    for (const row of rows) {
      if (!row.date) continue;
      if (row.kind === 'free') free.set(row.date, asNumber(row.value));
      if (row.kind === 'own') {
        own.set(row.date, row.value === null || row.value === undefined ? null : asNumber(row.value));
        unmeasured.set(row.date, asNumber((row as { unmeasured?: unknown }).unmeasured));
      }
    }
    const daily = days.map((date) => ({
      date,
      freeAgentTokens: free.get(date) ?? 0,
      ownAgentTokens: own.has(date) ? own.get(date)! : 0,
      ownAgentTurnsUnmeasured: unmeasured.get(date) ?? 0,
    }));
    const period = (slice: string[]) => {
      const points = daily.filter((point) => slice.includes(point.date));
      // A missing ledger day is no turns, filled as 0 on the daily series.
      // It is not a measured figure, so it must not turn an all-unmeasured
      // week into zero. A day the ledger returned, including an explicit 0, is.
      let measured = 0;
      let sawMeasured = false;
      let unmeasuredTurns = 0;
      for (const point of points) {
        unmeasuredTurns += point.ownAgentTurnsUnmeasured;
        if (own.has(point.date) && point.ownAgentTokens !== null) {
          sawMeasured = true;
          measured += point.ownAgentTokens;
        }
      }
      return {
        freeAgentTokens: points.reduce((sum, point) => sum + point.freeAgentTokens, 0),
        ownAgentTokens: sawMeasured ? measured : unmeasuredTurns > 0 ? null : 0,
        ownAgentTurnsUnmeasured: unmeasuredTurns,
      };
    };
    const todayPoint = daily.at(-1)!;
    const yesterdayPoint = daily.at(-2)!;
    const recent = period(last7);
    const previous = period(prior7);
    return {
      timeZone: TIME_ZONE,
      daily,
      last7: recent,
      prior7: previous,
      change: {
        freeAgentTokens: {
          dayOverDay: change(todayPoint.freeAgentTokens, yesterdayPoint.freeAgentTokens),
          weekOverWeek: change(recent.freeAgentTokens, previous.freeAgentTokens),
        },
        ownAgentTokens: {
          dayOverDay: change(todayPoint.ownAgentTokens, yesterdayPoint.ownAgentTokens),
          weekOverWeek: change(recent.ownAgentTokens, previous.ownAgentTokens),
        },
      },
    };
  });
  return { invites, onboarding, ownAgents, repositories, tokens };
}
