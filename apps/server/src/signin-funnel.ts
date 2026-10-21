import {
  parseSigninFunnelEvent,
  type SigninFunnelEvent,
  type FunnelAuthObservation,
} from '@beeline/api-contract/signin-funnel';
import type { SqlDatabase } from './database.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';

const lastCompaction = new WeakMap<SqlDatabase, string>();

// Only these confirmed operator accounts are excluded; customer Workspace owners are not internal.
const TEAM_HANDLES = ['lunchboxfortwo', 'bananaman614305', 'moonscannerai'];
export class FunnelRateLimit {
  private readonly clients = new Map<string, { start: number; count: number }>();
  allow(ip: string, now = Date.now()): boolean {
    const row = this.clients.get(ip);
    if (!row || now - row.start >= 60_000) {
      if (this.clients.size >= 10_000) {
        for (const [key, value] of this.clients)
          if (now - value.start >= 60_000) this.clients.delete(key);
        if (this.clients.size >= 10_000) return false;
      }
      this.clients.set(ip, { start: now, count: 1 });
      return true;
    }
    return ++row.count <= 60;
  }
}
export async function recordSigninFunnelEvent(
  database: SqlDatabase,
  event: SigninFunnelEvent,
  source: 'client' | 'server' = 'client',
  identityId?: string,
) {
  if (
    event.environment !== 'production' ||
    /(?:^|[.-])(dev|development|preview|lab)(?:[.-]|$)/i.test(event.version)
  )
    return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastCompaction.get(database) !== today) {
    lastCompaction.set(database, today);
    try {
      await compactSigninFunnel(database);
    } catch (error) {
      lastCompaction.delete(database);
      throw error;
    }
  }
  if (source === 'client' && event.event === 'signed_in' && !identityId) return;
  let internal = false;
  if (identityId) {
    const row = (
      await database.query<{ internal: boolean }>(
        `WITH ${COHORT_SQL}
      SELECT (i.hidden_from_roster OR COALESCE(lower(i.handle)=ANY($2::text[]),false) OR NOT EXISTS(SELECT 1 FROM production_identities pi WHERE pi.id=i.id)) internal
      FROM identities i WHERE i.id=$1`,
        [identityId, TEAM_HANDLES],
      )
    ).rows[0];
    internal = row?.internal ?? true;
  }
  await database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO signin_funnel_installs(install_id,internal) VALUES($1,$2)
      ON CONFLICT(install_id) DO UPDATE SET internal=signin_funnel_installs.internal OR EXCLUDED.internal,seen_at=now()`,
      [event.installId, internal],
    );
    await tx.query(
      `INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,provider,outcome,error_code,source,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(install_id,attempt_id,event,provider)
      DO UPDATE SET outcome=EXCLUDED.outcome,error_code=EXCLUDED.error_code,source=EXCLUDED.source
      WHERE EXCLUDED.source='server' AND signin_funnel_events.source='client'`,
      [
        event.installId,
        event.attemptId,
        event.event,
        event.platform,
        event.version,
        event.provider ?? '',
        event.outcome ?? '',
        event.errorCode ?? null,
        source,
      ],
    );
  });
}
export async function observeFunnelAuth(database: SqlDatabase, input: FunnelAuthObservation) {
  if (input.phase === 'start') {
    const event = parseSigninFunnelEvent(input.context);
    if (
      !event ||
      event.event !== 'provider_tapped' ||
      event.environment !== 'production' ||
      event.provider !== input.provider
    )
      return;
    await database.query(
      `INSERT INTO signin_funnel_auth_flows(flow_hash,context,expires_at) VALUES($1,$2::jsonb,now()+interval '30 minutes') ON CONFLICT DO NOTHING`,
      [input.flowHash, JSON.stringify(event)],
    );
    await recordSigninFunnelEvent(database, event, 'server');
  } else {
    const row = (
      await database.query<{ context: SigninFunnelEvent }>(
        `DELETE FROM signin_funnel_auth_flows WHERE flow_hash=$1 AND expires_at>now() RETURNING context`,
        [input.flowHash],
      )
    ).rows[0];
    if (!row || row.context.provider !== input.provider || !input.outcome) return;
    await recordSigninFunnelEvent(
      database,
      {
        ...row.context,
        event: 'callback_result',
        outcome: input.outcome,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        timestamp: new Date().toISOString(),
      },
      'server',
    );
  }
}
/** Request-triggered compaction. Only anonymous daily counts survive 90 days. */
export async function compactSigninFunnel(database: SqlDatabase) {
  await database.transaction(async (tx) => {
    await tx.query(`WITH expired AS (
      DELETE FROM signin_funnel_events WHERE occurred_at < (now() AT TIME ZONE 'UTC')::date-89 RETURNING *
    ), counts AS (
      SELECT (e.occurred_at AT TIME ZONE 'UTC')::date AS day,e.platform,e.event,e.provider,e.outcome,count(DISTINCT e.install_id) installs
      FROM expired e JOIN signin_funnel_installs i ON i.install_id=e.install_id WHERE NOT i.internal GROUP BY 1,2,3,4,5
    ) INSERT INTO signin_funnel_daily SELECT * FROM counts ON CONFLICT(day,platform,event,provider,outcome)
      DO UPDATE SET installs=signin_funnel_daily.installs+EXCLUDED.installs`);
    await tx.query(`DELETE FROM signin_funnel_auth_flows WHERE expires_at<=now()`);
    await tx.query(`DELETE FROM signin_funnel_installs WHERE seen_at < now()-interval '90 days'
      AND NOT EXISTS(SELECT 1 FROM signin_funnel_events e WHERE e.install_id=signin_funnel_installs.install_id)`);
  });
}
export async function dashboardSigninFunnel(
  database: SqlDatabase,
  platforms: readonly string[],
  measuredAt: string,
  from: string,
  through: string,
  downloads: number | null,
  downloadCounts: Record<string, number | null> = {},
) {
  await compactSigninFunnel(database);
  const coverageStart =
    (
      await database.query<{ day: string | null }>(
        `SELECT (min(occurred_at) AT TIME ZONE 'UTC')::date::text AS day FROM signin_funnel_events`,
      )
    ).rows[0]?.day ?? null;
  const requestedFrom = from;
  if (coverageStart && coverageStart <= through && coverageStart > from) {
    from = coverageStart;
    const expectedDays = Math.round((Date.parse(through) - Date.parse(from)) / 86400000) + 1;
    const stores = (
      await database.query<{ platform: string; days: string; installs: string | null }>(
        `SELECT platform,count(installs) days,sum(installs) installs FROM store_download_days
      WHERE platform=ANY($1::text[]) AND day BETWEEN $2::date AND $3::date GROUP BY platform`,
        [[...platforms], from, through],
      )
    ).rows;
    downloadCounts = Object.fromEntries(
      platforms.map((platform) => {
        const row = stores.find((r) => r.platform === platform);
        return [platform, row && Number(row.days) === expectedDays ? Number(row.installs) : null];
      }),
    );
    const mobile = platforms.filter((p) => p === 'ios' || p === 'android');
    downloads =
      mobile.length && mobile.every((p) => downloadCounts[p] !== null)
        ? mobile.reduce((sum, p) => sum + downloadCounts[p]!, 0)
        : null;
  }
  const rows = (
    await database.query<{
      platform: string;
      event: string;
      provider: string;
      outcome: string;
      installs: string;
      date: string;
      period: string;
    }>(
      `WITH eligible AS (
    SELECT e.* FROM signin_funnel_events e JOIN signin_funnel_installs i ON i.install_id=e.install_id
    WHERE NOT i.internal AND e.platform=ANY($1::text[]) AND e.occurred_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
      AND e.occurred_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC')
  ), periods AS (
    SELECT *, 'window' period, '' date FROM eligible UNION ALL
    SELECT *, 'daily', (occurred_at AT TIME ZONE 'UTC')::date::text FROM eligible UNION ALL
    SELECT *, 'weekly', ($3::date - (((($3::date-(occurred_at AT TIME ZONE 'UTC')::date)/7)::int)*7))::text FROM eligible
  ) SELECT COALESCE(platform,'all') platform,event,COALESCE(provider,'all') provider,COALESCE(outcome,'all') outcome,period,date,count(DISTINCT install_id) installs
    FROM periods GROUP BY GROUPING SETS ((platform,event,provider,outcome,period,date),(event,provider,outcome,period,date),(platform,event,period,date),(event,period,date))`,
      [[...platforms], from, through],
    )
  ).rows;
  const stages = [
    'app_opened',
    'signin_screen_shown',
    'provider_tapped',
    'callback_result',
    'signed_in',
  ] as const;
  const slices = ['all', ...platforms];
  const totals = rows.filter(
    (r) => r.period === 'window' && r.provider === 'all' && r.outcome === 'all',
  );
  const byPlatform = slices.map((platform) => {
    const result = stages.map((stage) => ({
      stage,
      count: 0,
      denominator: null as number | null,
      dropOffCount: null as number | null,
      dropOffRate: null as number | null,
    }));
    let previous =
      platform === 'all'
        ? platforms.every((p) => p === 'ios' || p === 'android')
          ? downloads
          : null
        : (downloadCounts[platform] ?? null);
    for (const stage of result) {
      stage.count = Number(
        totals.find((r) => r.platform === platform && r.event === stage.stage)?.installs ?? 0,
      );
      stage.denominator = previous;
      stage.dropOffCount = previous === null ? null : previous - stage.count;
      stage.dropOffRate = previous ? (previous - stage.count) / previous : null;
      previous = stage.count;
    }
    const providers = ['github', 'google'].map((provider) => {
      const started = rows.find(
        (r) =>
          r.platform === platform &&
          r.provider === provider &&
          r.event === 'provider_tapped' &&
          r.period === 'window',
      );
      const completed = rows.find(
        (r) =>
          r.platform === platform &&
          r.provider === provider &&
          r.event === 'signed_in' &&
          r.period === 'window',
      );
      const starts = Number(started?.installs ?? 0),
        completions = Number(completed?.installs ?? 0);
      return {
        provider,
        starts,
        completions,
        completionRate: starts ? completions / starts : null,
        outcomes: ['success', 'cancelled', 'error'].map((outcome) => ({
          outcome,
          count: Number(
            rows.find(
              (r) =>
                r.platform === platform &&
                r.provider === provider &&
                r.event === 'callback_result' &&
                r.outcome === outcome &&
                r.period === 'window',
            )?.installs ?? 0,
          ),
        })),
        series: rows
          .filter(
            (r) => r.platform === platform && r.provider === provider && r.period !== 'window',
          )
          .map((r) => ({
            period: r.period,
            date: r.date,
            stage: r.event,
            outcome: r.outcome,
            count: Number(r.installs),
          })),
      };
    });
    return {
      platform,
      stages: result,
      providers,
      series: rows
        .filter(
          (r) =>
            r.platform === platform &&
            r.provider === 'all' &&
            r.outcome === 'all' &&
            r.period !== 'window',
        )
        .map((r) => ({
          period: r.period,
          date: r.date,
          stage: r.event,
          count: Number(r.installs),
        })),
    };
  });
  const signupCounts = new Map<string, number>();
  for (const selection of ['all', ...platforms]) {
    const selected = selection === 'all' ? [...platforms] : [selection];
    const row = (
      await database.query<{ count: string }>(
        `WITH ${COHORT_SQL} SELECT count(*) count
      FROM identities i JOIN production_identities pi ON pi.id=i.id WHERE i.kind='human'
      AND i.created_at >= ($2::date::timestamp AT TIME ZONE 'UTC') AND i.created_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC')
      AND ($4::boolean OR EXISTS(SELECT 1 FROM push_devices d WHERE d.identity_id=i.id AND d.platform=ANY($1::text[]))
        OR EXISTS(SELECT 1 FROM device_update_receipts d WHERE d.identity_id=i.id AND d.receipt->>'platform'=ANY($1::text[])))`,
        [selected, from, through, selected.length === 6],
      )
    ).rows[0];
    signupCounts.set(selection, Number(row?.count ?? 0));
  }
  return {
    state: coverageStart && through >= coverageStart ? 'measured' : 'not_measured',
    measuredAt,
    from,
    requestedFrom,
    through,
    downloads: {
      stage: 'downloads',
      count: coverageStart && through >= coverageStart ? downloads : null,
      perPlatform: downloadCounts,
    },
    unit: 'installs',
    source:
      'Client action events; validated server OAuth starts and callbacks override client reports; authenticated signed-in events exclude internal installs.',
    note: 'Stages count distinct installs within the window, not a joined person cohort. Retries and different providers can overlap. Collection begins with this release; earlier dates are unmeasured.',
    coverageStart,
    perPlatform: byPlatform.map((p) => ({
      ...p,
      signup: {
        stage: 'signup',
        unit: 'people',
        count:
          coverageStart && through >= coverageStart ? (signupCounts.get(p.platform) ?? null) : null,
        source: 'Existing production human identity creation, over this same window',
      },
      stages: p.stages.map((s) => ({
        ...s,
        count: coverageStart && through >= coverageStart ? s.count : null,
        denominator: coverageStart && through >= coverageStart ? s.denominator : null,
        dropOffCount: coverageStart && through >= coverageStart ? s.dropOffCount : null,
        dropOffRate: coverageStart && through >= coverageStart ? s.dropOffRate : null,
      })),
    })),
    dailyAggregatesRetainedAfterDays: 90,
  };
}
