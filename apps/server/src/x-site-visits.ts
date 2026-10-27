import type { SqlDatabase } from './database.js';

const ACCOUNT = '6e97e79c389234e4c8aa7837ee3e2a94';
const SITE = '6fb0afa9be844bc787f6f9db3c0726b3';
const LIMIT = 10_000;
const DAY = 86_400_000;
const X_REFERRERS = new Set(['t.co', 'x.com', 'com.twitter.android']);
type Group = {
  dimensions: { date: string; refererHost: string; requestPath: string };
  sum: { visits: number };
};

/** Independent of Ads API credentials: refresh the last seven complete UTC dates. */
export async function syncXSiteVisits(
  database: SqlDatabase,
  token = process.env.CLOUDFLARE_ANALYTICS_TOKEN,
  send: typeof fetch = fetch,
  now = new Date(),
): Promise<void> {
  const claimed = await database.query(
    `INSERT INTO x_ad_sync(id,next_attempt_at) VALUES('site-visits',$1::timestamptz+interval '1 hour')
     ON CONFLICT(id) DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at
     WHERE x_ad_sync.next_attempt_at<=$1 RETURNING id`, [now],
  );
  if (!claimed.rowCount) return;
  try {
    if (!token) {
      await database.query(`UPDATE x_ad_sync SET failed_at=$1 WHERE id='site-visits'`, [now]);
      return;
    }
    const end = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    const start = new Date(end.getTime() - 7 * DAY);
    const last = new Date(end.getTime() - DAY).toISOString().slice(0, 10);
    const first = start.toISOString().slice(0, 10);
    const response = await send('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ query: `{viewer{accounts(filter:{accountTag:"${ACCOUNT}"}){
        rumPageloadEventsAdaptiveGroups(limit:${LIMIT},filter:{siteTag:"${SITE}",date_geq:"${first}",date_leq:"${last}"}){
          dimensions{date refererHost requestPath} sum{visits}
        }}}}` }),
    });
    if (!response.ok) throw new Error('Cloudflare site visits unavailable');
    const result = await response.json() as {
      errors?: unknown[] | null;
      data?: { viewer?: { accounts?: { rumPageloadEventsAdaptiveGroups?: Group[] }[] } };
    };
    const accounts = result.data?.viewer?.accounts;
    const groups = accounts?.[0]?.rumPageloadEventsAdaptiveGroups;
    if (
      (result.errors != null && (!Array.isArray(result.errors) || result.errors.length > 0)) ||
      accounts?.length !== 1 || !Array.isArray(groups) || groups.length >= LIMIT
    )
      throw new Error('Cloudflare site visits incomplete');
    const days = new Map<string, { visits: number; ads: Map<string, number> }>();
    for (const group of groups) {
      const d = group?.dimensions;
      const visits = group?.sum?.visits;
      if (!d || typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
          d.date < first || d.date > last ||
          new Date(`${d.date}T00:00:00Z`).toISOString().slice(0, 10) !== d.date || typeof d.refererHost !== 'string' ||
          typeof d.requestPath !== 'string' || !Number.isSafeInteger(visits) || visits < 0)
        throw new Error('Cloudflare site visits invalid');
      const day = days.get(d.date) ?? { visits: 0, ads: new Map<string, number>() };
      // A path and an X referrer on the same visit count only once.
      const ad = /^\/x\/([a-zA-Z0-9_-]+)\/?$/.exec(d.requestPath)?.[1];
      if (ad || X_REFERRERS.has(d.refererHost.toLowerCase())) {
        day.visits += visits;
        if (!Number.isSafeInteger(day.visits)) throw new Error('Cloudflare site visits overflow');
        if (ad) day.ads.set(ad, (day.ads.get(ad) ?? 0) + visits);
      }
      days.set(d.date, day);
    }
    await database.transaction(async (db) => {
      await db.query(`DELETE FROM x_site_visit_daily WHERE day>=$1 AND day<$2`, [start, end]);
      for (const [date, day] of days) {
        await db.query(
          `INSERT INTO x_site_visit_daily(day,site_visits,by_ad) VALUES($1,$2,$3::jsonb)`,
          [date, day.visits, JSON.stringify([...day.ads].sort(([a], [b]) => a.localeCompare(b))
            .map(([adPath, siteVisits]) => ({ adPath: `/x/${adPath}`, siteVisits })))],
        );
      }
      await db.query(`UPDATE x_ad_sync SET completed_at=$1,failed_at=NULL,
        next_attempt_at=$1::timestamptz+interval '1 day' WHERE id='site-visits'`, [now]);
    });
  } catch {
    await database.query(`UPDATE x_ad_sync SET failed_at=$1 WHERE id='site-visits'`, [now]);
    // No upstream body, request headers or credentials reach logs.
    throw new Error('Cloudflare site visits unavailable');
  }
}

export async function dashboardXSiteVisits(database: SqlDatabase, measuredAt: string) {
  const sync = (await database.query<{ completed_at: Date | null; failed_at: Date | null }>(
    `SELECT completed_at,failed_at FROM x_ad_sync WHERE id='site-visits'`,
  )).rows[0];
  const available = !!sync?.completed_at && !sync.failed_at &&
    Date.parse(measuredAt) - new Date(sync.completed_at).getTime() <= 36 * 3_600_000;
  const rows = (await database.query<{
    date: string; site_visits: string; by_ad: { adPath: string; siteVisits: number }[];
  }>(`SELECT to_char(day,'YYYY-MM-DD') date,site_visits,by_ad
      FROM x_site_visit_daily WHERE day>=($1::timestamptz AT TIME ZONE 'UTC')::date-89 ORDER BY day`,
    [measuredAt],
  )).rows;
  const end = Date.parse(`${measuredAt.slice(0, 10)}T00:00:00Z`);
  return {
    state: available && rows.length > 0 ? ('estimated' as const) : ('unavailable' as const),
    lastSyncedAt: sync?.completed_at ?? null,
    source: 'cloudflare_web_analytics' as const,
    estimated: true,
    sampling: 'Site uses lite mode (about 10% sampled); counts are returned as supplied, without scaling.',
    scope: 'X referrers (including organic) or /x/<ad> landing paths; not verified paid conversions.',
    daily: Array.from({ length: 90 }, (_, i) => {
      const date = new Date(end - (89 - i) * DAY).toISOString().slice(0, 10);
      const row = available ? rows.find(r => r.date === date) : undefined;
      return {
        date,
        siteVisits: row ? Number(row.site_visits) : null,
        byAd: row ? row.by_ad : null,
      };
    }),
  };
}
