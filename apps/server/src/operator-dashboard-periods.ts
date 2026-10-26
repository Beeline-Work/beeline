import type { SqlDatabase } from './database.js';
import { dashboardOnboarding } from './signin-funnel.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';

// Materialize human activity once, then aggregate the four windows. Never rescan
// message history for each chart bucket or each signup's first reply.
const PERIOD_SQL = `WITH ${COHORT_SQL}, eligible AS MATERIALIZED (
  SELECT i.id,i.created_at FROM identities i JOIN production_identities p ON p.id=i.id
  WHERE i.kind='human' AND i.created_at<$1::timestamptz
), windows AS (
  SELECT '24h' key,$1::timestamptz-interval '24 hours' since,'hour' unit
  UNION ALL SELECT '7d',$1::timestamptz-interval '168 hours','day'
  UNION ALL SELECT '28d',$1::timestamptz-interval '672 hours','day'
  UNION ALL SELECT 'all',coalesce(min(created_at),$1::timestamptz),'week' FROM eligible
), human_messages AS MATERIALIZED (
  SELECT m.author_id,m.created_at FROM messages m
  JOIN eligible e ON e.id=m.author_id JOIN rooms r ON r.id=m.room_id
  JOIN production_workspaces w ON w.id=r.workspace_id
  WHERE m.presentation='message' AND m.deleted_at IS NULL AND m.created_at<$1::timestamptz
), first_messages AS (
  SELECT author_id,min(created_at) first_at,max(created_at) last_at FROM human_messages GROUP BY 1
), replies AS MATERIALIZED (
  SELECT DISTINCT a.owner_id FROM messages m JOIN agents a ON a.agent_id=m.author_id
  JOIN first_messages f ON f.author_id=a.owner_id AND m.created_at>f.first_at
  JOIN rooms r ON r.id=m.room_id JOIN production_workspaces w ON w.id=r.workspace_id
  WHERE m.presentation='message' AND m.deleted_at IS NULL AND m.created_at<$1::timestamptz
), joined AS (
  SELECT DISTINCT m.identity_id FROM memberships m JOIN production_workspaces w ON w.id=m.workspace_id
  WHERE m.room_id IS NULL AND m.removed_at IS NULL
), signup_facts AS MATERIALIZED (
  SELECT e.*,j.identity_id IS NOT NULL joined,f.first_at IS NOT NULL messaged,
    r.owner_id IS NOT NULL replied,f.last_at >= $1::timestamptz-interval '168 hours' recent
  FROM eligible e LEFT JOIN joined j ON j.identity_id=e.id
  LEFT JOIN first_messages f ON f.author_id=e.id LEFT JOIN replies r ON r.owner_id=e.id
), workspace_facts AS MATERIALIZED (
  SELECT w.id,w.created_at FROM workspaces w JOIN production_workspaces p ON p.id=w.id
  WHERE w.created_at<$1::timestamptz
), activity AS MATERIALIZED (
  SELECT w.key,w.unit,m.author_id,m.created_at,
    CASE WHEN w.unit='hour' THEN date_trunc('hour',m.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    ELSE date_trunc(w.unit,m.created_at AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' END start
  FROM windows w JOIN human_messages m ON m.created_at>=w.since
), signups AS MATERIALIZED (
  SELECT w.key,e.*,
    CASE WHEN w.unit='hour' THEN date_trunc('hour',e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    ELSE date_trunc(w.unit,e.created_at AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' END start
  FROM windows w JOIN signup_facts e ON e.created_at>=w.since
), active_totals AS (
  SELECT key,count(DISTINCT author_id) people,count(*) messages FROM activity GROUP BY 1
), signup_totals AS (
  SELECT key,count(*) new_people,count(*) FILTER(WHERE joined) joined,
    count(*) FILTER(WHERE joined AND messaged) messaged,
    count(*) FILTER(WHERE joined AND messaged AND replied) replied,
    count(*) FILTER(WHERE joined AND messaged AND replied AND recent) recent FROM signups GROUP BY 1
), workspace_totals AS (
  SELECT w.key,count(f.id) workspaces FROM windows w LEFT JOIN workspace_facts f ON f.created_at>=w.since GROUP BY 1
), active_buckets AS (
  SELECT key,start,count(DISTINCT author_id) value FROM activity GROUP BY 1,2
), signup_buckets AS (
  SELECT key,start,count(*) value FROM signups GROUP BY 1,2
), buckets AS (
  SELECT w.key,CASE WHEN unit='hour' THEN g.start AT TIME ZONE 'UTC'
    ELSE g.start AT TIME ZONE 'America/New_York' END start FROM windows w
  CROSS JOIN LATERAL generate_series(
    date_trunc(unit,since AT TIME ZONE CASE WHEN unit='hour' THEN 'UTC' ELSE 'America/New_York' END),
    date_trunc(unit,($1::timestamptz-interval '1 microsecond') AT TIME ZONE CASE WHEN unit='hour' THEN 'UTC' ELSE 'America/New_York' END),
    CASE unit WHEN 'hour' THEN interval '1 hour' WHEN 'day' THEN interval '1 day' ELSE interval '1 week' END
  ) g(start)
), series AS (
  SELECT b.key,jsonb_agg(jsonb_build_object('start',b.start,'value',coalesce(a.value,0)) ORDER BY b.start) active_series,
    jsonb_agg(jsonb_build_object('start',b.start,'value',coalesce(s.value,0)) ORDER BY b.start) growth_series
  FROM buckets b LEFT JOIN active_buckets a USING(key,start) LEFT JOIN signup_buckets s USING(key,start) GROUP BY 1
)
SELECT w.key,w.unit,coalesce(a.people,0) people,coalesce(a.messages,0) messages,
  coalesce(s.new_people,0) new_people,coalesce(s.joined,0) joined,coalesce(s.messaged,0) messaged,
  coalesce(s.replied,0) replied,coalesce(s.recent,0) recent,t.workspaces,
  coalesce(b.active_series,'[]'::jsonb) active_series,coalesce(b.growth_series,'[]'::jsonb) growth_series
FROM windows w LEFT JOIN active_totals a USING(key) LEFT JOIN signup_totals s USING(key)
JOIN workspace_totals t USING(key) LEFT JOIN series b USING(key)`;

const PLATFORM_SQL = `WITH ${COHORT_SQL}, observations AS (
  SELECT identity_id,platform,updated_at at, 'push:'||token tie FROM push_devices
  UNION ALL SELECT identity_id,receipt->>'platform',reported_at,'receipt:'||device_id FROM device_update_receipts
), latest AS (
  SELECT DISTINCT ON(identity_id) identity_id,platform FROM observations
  ORDER BY identity_id,at DESC,tie
)
SELECT CASE WHEN l.platform IN ('ios','android','web','macos','windows','linux') THEN l.platform ELSE 'unknown' END platform,
  count(*) people FROM identities i JOIN production_identities p ON p.id=i.id
LEFT JOIN latest l ON l.identity_id=i.id WHERE i.kind='human'
GROUP BY 1 ORDER BY 1`;

const stages = [
  ['signed_up', 'Signed up', 'new_people'],
  ['joined_workspace', 'Joined a workspace', 'joined'],
  ['first_message', 'Sent a first message', 'messaged'],
  ['agent_reply', 'Got an agent reply', 'replied'],
  ['active_7d', 'Active in the last 7 days', 'recent'],
] as const;

export async function dashboardPeriods(database: SqlDatabase, measuredAt: string) {
  const rows = (await database.query(PERIOD_SQL, [measuredAt])).rows;
  return Object.fromEntries(
    await Promise.all(rows.map(async (row) => {
      const steps = stages.map(([key, label, column]) => ({
        key,
        label,
        count: Number(row[column]),
      }));
      let biggestDrop: { key: string; lost: number } | null = null;
      for (let i = 1; i < steps.length; i++) {
        const lost = steps[i - 1]!.count - steps[i]!.count;
        if (lost > 0 && (!biggestDrop || lost >= biggestDrop.lost))
          biggestDrop = { key: steps[i]!.key, lost };
      }
      const hours = { '24h': 24, '7d': 168, '28d': 672 }[String(row.key)];
      const since = hours ? new Date(Date.parse(measuredAt) - hours * 3_600_000).toISOString() : null;
      const onboardingFunnel = await dashboardOnboarding(database, since, measuredAt)
        .catch(() => ({ state: 'unavailable' as const, measuredAt: null }));
      return [
        String(row.key),
        {
          active: {
            people: Number(row.people),
            messages: Number(row.messages),
            unit: String(row.unit),
            series: row.active_series,
          },
          growth: {
            newPeople: Number(row.new_people),
            workspaces: Number(row.workspaces),
            series: row.growth_series,
          },
          funnel: { steps, biggestDrop },
          onboardingFunnel,
        },
      ];
    })),
  );
}

export async function dashboardPlatformBreakdown(database: SqlDatabase) {
  const rows = (await database.query(PLATFORM_SQL)).rows;
  return {
    basis: 'last_device' as const,
    counts: rows.map((r) => ({ platform: String(r.platform), people: Number(r.people) })),
  };
}
