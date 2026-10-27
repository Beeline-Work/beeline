import type { SqlDatabase } from './database.js';

const platforms = ['ios', 'android', 'macos', 'windows', 'linux'] as const;
const sources = ['x', 'organic'] as const;
export function parseSiteDownloadTap(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    !platforms.includes(value.platform as never) ||
    !sources.includes(value.source as never)
  )
    return;
  return { platform: value.platform as string, source: value.source as string };
}

/** Aggregate cap, with no per-person identifiers or header storage. */
export async function recordSiteDownloadTap(
  database: SqlDatabase,
  tap: { platform: string; source: string },
) {
  const result = await database.query(
    `INSERT INTO site_download_tap_daily(day,platform,source,taps)
    VALUES((now() AT TIME ZONE 'UTC')::date,$1,$2,1)
    ON CONFLICT(day,platform,source) DO UPDATE SET taps=site_download_tap_daily.taps+1
    WHERE site_download_tap_daily.taps<100000 RETURNING taps`,
    [tap.platform, tap.source],
  );
  return !!result.rowCount;
}

export async function dashboardSiteDownloadTaps(
  database: SqlDatabase,
  measuredAt: string,
  visits: { daily: { date: string; siteVisits: number | null; allSiteVisits: number | null }[] },
) {
  const rows = (
    await database.query<{ date: string; platform: string; source: string; taps: string }>(
      `SELECT to_char(day,'YYYY-MM-DD') date,platform,source,taps FROM site_download_tap_daily
     WHERE day>=($1::timestamptz AT TIME ZONE 'UTC')::date-89
     AND day<=($1::timestamptz AT TIME ZONE 'UTC')::date ORDER BY day,platform,source`,
      [measuredAt],
    )
  ).rows;
  const end = Date.parse(`${measuredAt.slice(0, 10)}T00:00:00Z`);
  const daily = Array.from({ length: 90 }, (_, i) => {
    const date = new Date(end - (89 - i) * 86400000).toISOString().slice(0, 10);
    const counts = platforms.flatMap((platform) =>
      sources.map((source) => ({
        platform,
        source,
        taps: Number(
          rows.find((r) => r.date === date && r.platform === platform && r.source === source)
            ?.taps ?? 0,
        ),
      })),
    );
    const total = counts.reduce((sum, r) => sum + r.taps, 0);
    const x = counts.filter((r) => r.source === 'x').reduce((sum, r) => sum + r.taps, 0);
    const v = visits.daily.find((r) => r.date === date);
    return {
      date,
      counts,
      total,
      x,
      organic: total - x,
      allSiteVisits: v?.allSiteVisits ?? null,
      xSiteVisits: v?.siteVisits ?? null,
      allVisitToTapRate: v?.allSiteVisits ? total / v.allSiteVisits : null,
      xVisitToTapRate: v?.siteVisits ? x / v.siteVisits : null,
    };
  });
  const summarize = (days: typeof daily) => {
    const total = days.reduce((sum, d) => sum + d.total, 0);
    const x = days.reduce((sum, d) => sum + d.x, 0);
    const allVisits = days.every((d) => d.allSiteVisits !== null)
      ? days.reduce((sum, d) => sum + d.allSiteVisits!, 0)
      : null;
    const xVisits = days.every((d) => d.xSiteVisits !== null)
      ? days.reduce((sum, d) => sum + d.xSiteVisits!, 0)
      : null;
    return {
      total,
      x,
      organic: total - x,
      counts: platforms.flatMap((platform) =>
        sources.map((source) => ({
          platform,
          source,
          taps: days.reduce(
            (sum, d) =>
              sum + d.counts.find((r) => r.platform === platform && r.source === source)!.taps,
            0,
          ),
        })),
      ),
      allSiteVisits: allVisits,
      xSiteVisits: xVisits,
      allVisitToTapRate: allVisits ? total / allVisits : null,
      xVisitToTapRate: xVisits ? x / xVisits : null,
    };
  };
  return {
    state: 'measured' as const,
    timeZone: 'UTC',
    daily,
    last7: summarize(daily.slice(-8, -1)),
    prior7: summarize(daily.slice(-15, -8)),
    windows: 'Last 7 and prior 7 complete UTC days; today is partial in daily.',
    ratesEstimated: true,
    sampling:
      'Indicative only: visits are Cloudflare lite mode (about 10% sampled), unscaled; taps are unsampled. X visits include organic X referrals, not only ads.',
    scope:
      'Download taps, not installs or unique visitors. Per platform/source daily cap: 100000. No historical backfill.',
  };
}
