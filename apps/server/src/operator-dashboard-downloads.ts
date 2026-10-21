import type { SqlDatabase } from './database.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';
import {
  storeDownloadFetcher,
  type DownloadFetcher,
  type StorePlatform,
} from './store-download-reports.js';

const DAY = 86_400_000;
const shift = (day: string, n: number) =>
  new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);
const sources = {
  android: 'Google Play Daily User Installs (overview CSV)',
  ios: 'App Store Connect SALES/SUMMARY/DAILY (1, 1F, 1T)',
};
type CachedDay = {
  day: string;
  installs: number | null;
  fetched_at: string | null;
  attempted_at: string;
  final: boolean;
};
const sum = (values: (number | null)[]) =>
  values.some((v) => v === null) ? null : values.reduce<number>((a, b) => a + b!, 0);
function weekly(daily: { date: string; value: number | null }[]) {
  const result = [];
  for (let end = daily.length; end > 0; end -= 7) {
    const group = daily.slice(Math.max(0, end - 7), end);
    result.unshift({ date: group.at(-1)!.date, value: sum(group.map((p) => p.value)) });
  }
  return result;
}
export async function dashboardDownloads(
  database: SqlDatabase,
  platforms: readonly string[],
  measuredAt: string,
  fetcher: DownloadFetcher = storeDownloadFetcher(process.env),
) {
  const today = measuredAt.slice(0, 10),
    from = shift(today, -89);
  const stores = platforms.filter((p): p is StorePlatform => p === 'ios' || p === 'android');
  // A common cutoff prevents comparing yesterday's iOS signups with older Play data.
  const through = shift(today, stores.includes('android') ? -2 : -1);
  const days = Array.from(
    { length: Math.round((Date.parse(through) - Date.parse(from)) / DAY) + 1 },
    (_, i) => shift(from, i),
  );
  const note =
    'Downloads count store installs, not people. Reinstalls and several devices per person mean the drop-off is an estimate. Platform slices can overlap; the total deduplicates signups.';
  const refresh = async (platform: StorePlatform) => {
    // The upsert is a cross-process hourly claim, including failed attempts.
    const claimed = (
      await database.query<{ day: string }>(
        `INSERT INTO store_download_days(platform,day,source,attempted_at)
      SELECT $1,d::date,$3,$4::timestamptz FROM unnest($2::text[]) d
      ON CONFLICT(platform,day) DO UPDATE SET attempted_at=EXCLUDED.attempted_at
      WHERE NOT store_download_days.final AND store_download_days.attempted_at <= $4::timestamptz-interval '1 hour'
      RETURNING day::text`,
        [platform, days, sources[platform], measuredAt],
      )
    ).rows.map((r) => r.day);
    if (claimed.length) {
      const signal = AbortSignal.timeout(8000);
      const groups =
        platform === 'android'
          ? [...new Set(claimed.map((d) => d.slice(0, 7)))].map((m) =>
              claimed.filter((d) => d.startsWith(m)),
            )
          : claimed.map((d) => [d]);
      let next = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (next < groups.length && !signal.aborted) {
            const group = groups[next++]!;
            try {
              const fetched = await fetcher(platform, group, signal);
              for (const day of group) {
                const installs = fetched.get(day);
                if (installs === undefined || !Number.isSafeInteger(installs) || installs < 0)
                  continue;
                await database.query(
                  `UPDATE store_download_days SET installs=$3,fetched_at=$4::timestamptz,final=($2::date <= $5::date)
                WHERE platform=$1 AND day=$2::date`,
                  [platform, day, installs, measuredAt, shift(today, -3)],
                );
              }
            } catch {
              /* Failed days retain their cached value and hourly claim. */
            }
          }
        }),
      );
    }
    const rows = (
      await database.query<CachedDay>(
        `SELECT day::text,installs,fetched_at::text,attempted_at::text,final
      FROM store_download_days WHERE platform=$1 AND day BETWEEN $2::date AND $3::date ORDER BY day`,
        [platform, from, through],
      )
    ).rows;
    const indexed = new Map(rows.map((r) => [r.day, r]));
    const daily = days.map((date) => ({
      date,
      value: indexed.get(date)?.installs == null ? null : Number(indexed.get(date)!.installs),
    }));
    const missing = daily.some((p) => p.value === null);
    const stale = rows.some(
      (r) =>
        r.installs !== null &&
        (!r.fetched_at ||
          Date.parse(r.attempted_at) > Date.parse(r.fetched_at) ||
          (!r.final && Date.parse(measuredAt) - Date.parse(r.fetched_at) >= 3600000)),
    );
    return {
      platform,
      state: missing ? 'missing' : stale ? 'stale' : 'measured',
      count: sum(daily.map((p) => p.value)),
      source: sources[platform],
      lastCompleteDay: [...daily].reverse().find((p) => p.value !== null)?.date ?? null,
      fetchedAt:
        rows
          .map((r) => r.fetched_at)
          .filter((d): d is string => d !== null)
          .sort()
          .at(-1) ?? null,
      daily,
      weekly: weekly(daily),
    };
  };
  const perPlatform = [];
  for (const platform of platforms) {
    if (platform !== 'ios' && platform !== 'android') {
      perPlatform.push({
        platform,
        state: 'not_measured',
        count: null,
        source: 'No store downloads',
        lastCompleteDay: null,
        fetchedAt: null,
        daily: [] as { date: string; value: number | null }[],
        weekly: [] as { date: string; value: number | null }[],
      });
    } else {
      try {
        perPlatform.push(await refresh(platform));
      } catch {
        perPlatform.push({
          platform,
          state: 'missing',
          count: null,
          source: sources[platform],
          lastCompleteDay: null,
          fetchedAt: null,
          daily: days.map((date) => ({ date, value: null })),
          weekly: weekly(days.map((date) => ({ date, value: null }))),
        });
      }
    }
  }
  const signupSeries = async (selection: string[]) => {
    try {
      const rows = (
        await database.query<{ date: string; value: string }>(
          `WITH ${COHORT_SQL}, eligible AS (
        SELECT i.id,i.created_at FROM identities i JOIN production_identities pi ON pi.id=i.id
        WHERE i.kind='human' AND (EXISTS(SELECT 1 FROM push_devices d WHERE d.identity_id=i.id AND d.platform=ANY($1::text[]))
        OR EXISTS(SELECT 1 FROM device_update_receipts d WHERE d.identity_id=i.id AND d.receipt->>'platform'=ANY($1::text[]))))
        SELECT (created_at AT TIME ZONE 'UTC')::date::text date,count(*) value FROM eligible
        WHERE created_at >= ($2::date::timestamp AT TIME ZONE 'UTC') AND created_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC') GROUP BY 1`,
          [selection, from, through],
        )
      ).rows;
      const counts = new Map(rows.map((r) => [r.date, Number(r.value)]));
      return days.map((date) => ({ date, value: counts.get(date) ?? 0 }));
    } catch {
      return days.map((date) => ({ date, value: null }));
    }
  };
  const dropoff = (downloads: number | null, signups: number | null) => ({
    downloads,
    signups,
    dropOffCount: downloads === null || signups === null ? null : downloads - signups,
    dropOffRate:
      downloads === null || signups === null || downloads === 0
        ? null
        : (downloads - signups) / downloads,
  });
  const measuredStores = perPlatform.filter((p) => stores.includes(p.platform as StorePlatform));
  const daily = days.map((date, i) => ({
    date,
    value: stores.length ? sum(measuredStores.map((p) => p.daily[i]?.value ?? null)) : null,
  }));
  const signups = stores.length ? await signupSeries(stores) : [];
  const count = stores.length ? sum(daily.map((p) => p.value)) : null;
  const comparisons = [];
  for (const platform of measuredStores) {
    const series = await signupSeries([platform.platform]);
    comparisons.push({
      platform: platform.platform,
      ...dropoff(platform.count, sum(series.map((p) => p.value))),
    });
  }
  return {
    stage: 'downloads',
    label: 'Downloads (store installs)',
    previousStage: null,
    nextStage: 'signup',
    state: !stores.length
      ? 'not_measured'
      : measuredStores.some((p) => p.state === 'missing')
        ? 'missing'
        : measuredStores.some((p) => p.state === 'stale')
          ? 'stale'
          : 'measured',
    measuredAt,
    from,
    through,
    note,
    count,
    perPlatform,
    comparison: {
      ...dropoff(count, stores.length ? sum(signups.map((p) => p.value)) : null),
      platforms: stores,
      perPlatform: comparisons,
    },
    series: { daily, weekly: weekly(daily), signups: { daily: signups, weekly: weekly(signups) } },
  };
}
