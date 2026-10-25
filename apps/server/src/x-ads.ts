import { createHash } from 'node:crypto';
import { parseXAttribution, X_PIXEL_ID } from '@beeline/api-contract/x-attribution';
import type { SqlDatabase } from './database.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';

export function xSignupEventId(): string | undefined {
  const value = process.env.BEELINE_X_SIGNUP_EVENT_ID ?? 'tw-rhefr-rhym5';
  return value && new RegExp(`^tw-${X_PIXEL_ID}-[a-z0-9]+$`).test(value) ? value : undefined;
}

/** Called in the identity-insert transaction, only if INSERT actually created it. */
export async function recordXSignup(
  database: SqlDatabase,
  identityId: string,
  input: unknown,
  now: Date,
) {
  const context = parseXAttribution(input, now.getTime());
  if (!context) return;
  const conversionId = createHash('sha256')
    .update(`beeline:x-signup:v1:${identityId}`)
    .digest('hex');
  const eventId = xSignupEventId();
  await database.query(
    `INSERT INTO x_ad_signups(identity_id,twclid,campaign_id,ad_id,ad_group_id,captured_at,created_at,conversion_id,event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(identity_id) DO NOTHING`,
    [
      identityId,
      context.twclid ?? null,
      context.campaignId ?? null,
      context.adId ?? null,
      context.adGroupId ?? null,
      new Date(context.capturedAt),
      now,
      conversionId,
      eventId ?? null,
    ],
  );
  return context.twclid && eventId ? { eventId, conversionId } : undefined;
}

/** Leased, bounded outbox. A crash after X accepts retries the same deduplication ID. */
export async function deliverXSignups(
  database: SqlDatabase,
  token = process.env.BEELINE_X_PIXEL_TOKEN,
  send: typeof fetch = fetch,
): Promise<number> {
  if (!token || !xSignupEventId()) return 0;
  const rows = (
    await database.query<{
      identity_id: string;
      twclid: string;
      conversion_id: string;
      event_id: string;
      created_at: Date;
    }>(
      `UPDATE x_ad_signups SET attempts=attempts+1,next_attempt_at=now()+interval '5 minutes',
       event_id=COALESCE(event_id,$1)
     WHERE identity_id IN (SELECT identity_id FROM x_ad_signups
       WHERE sent_at IS NULL AND twclid IS NOT NULL AND attempts<10 AND next_attempt_at<=now()
         AND created_at>now()-interval '2 days'
       ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
     RETURNING identity_id,twclid,conversion_id,event_id,created_at`,
      [xSignupEventId()],
    )
  ).rows;
  let sent = 0;
  for (const row of rows) {
    try {
      const response = await send(
        `https://ads-api.x.com/12/measurement/conversions/${X_PIXEL_ID}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Pixel-Token': token },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            conversions: [
              {
                conversion_time: new Date(row.created_at).toISOString(),
                event_id: row.event_id,
                conversion_id: row.conversion_id,
                identifiers: [{ twclid: row.twclid }],
              },
            ],
          }),
        },
      );
      const payload = (await response.json()) as {
        errors?: unknown[];
        data?: { conversions_processed?: number };
      };
      if (!response.ok || payload.errors?.length || payload.data?.conversions_processed !== 1)
        throw new Error('X conversion refused');
      await database.query(
        `UPDATE x_ad_signups SET sent_at=now() WHERE identity_id=$1 AND sent_at IS NULL`,
        [row.identity_id],
      );
      sent++;
    } catch {
      // Never retain provider responses, tokens or identifiers in error logs.
      await database.query(`UPDATE x_ad_signups SET delivery_failed=true WHERE identity_id=$1`, [
        row.identity_id,
      ]);
    }
  }
  return sent;
}

export async function dashboardXAds(database: SqlDatabase, measuredAt: string) {
  const signups = (
    await database.query<{
      date: string;
      campaign_id: string | null;
      ad_id: string | null;
      ad_group_id: string | null;
      signups: number;
    }>(
      `WITH ${COHORT_SQL} SELECT to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') date,
       campaign_id,ad_id,ad_group_id,count(*)::int signups
     FROM x_ad_signups s JOIN production_identities i ON i.id=s.identity_id
     WHERE s.created_at>=now()-interval '90 days' GROUP BY 1,2,3,4`,
    )
  ).rows;
  const coverage = (
    await database.query<{ total: number; attributed: number }>(`WITH ${COHORT_SQL}
    SELECT count(*)::int total,count(s.identity_id)::int attributed FROM identities i
    JOIN production_identities p ON p.id=i.id LEFT JOIN x_ad_signups s ON s.identity_id=i.id
    WHERE i.kind='human' AND i.created_at>=now()-interval '90 days'`)
  ).rows[0]!;
  const stats = (
    await database.query<{
      date: string;
      level: string;
      entity_id: string;
      name: string;
      campaign_id: string | null;
      ad_group_id: string | null;
      currency: string;
      spend_micros: string;
      impressions: string;
      link_clicks: string;
    }>(`SELECT to_char(day,'YYYY-MM-DD') date,level,entity_id,name,campaign_id,ad_group_id,currency,
      spend_micros,impressions,link_clicks FROM x_ad_daily WHERE day>=current_date-89 ORDER BY day DESC,level,entity_id`)
  ).rows;
  const sync = (
    await database.query<{ completed_at: Date | null; failed_at: Date | null }>(
      `SELECT completed_at,failed_at FROM x_ad_sync WHERE id='daily'`,
    )
  ).rows[0];
  const rows = stats.map((s) => {
    const count = signups
      .filter(
        (a) =>
          a.date === s.date &&
          (s.level === 'campaign'
            ? a.campaign_id === s.entity_id
            : s.level === 'ad_group'
              ? a.ad_group_id === s.entity_id
              : a.ad_id === s.entity_id),
      )
      .reduce((n, a) => n + a.signups, 0);
    const spend = Number(s.spend_micros) / 1e6,
      clicks = Number(s.link_clicks);
    return {
      date: s.date,
      level: s.level,
      id: s.entity_id,
      name: s.name,
      campaignId: s.campaign_id,
      adGroupId: s.ad_group_id,
      currency: s.currency,
      spend,
      impressions: Number(s.impressions),
      linkClicks: clicks,
      signups: count,
      costPerClick: clicks ? spend / clicks : null,
      costPerSignup: count ? spend / count : null,
    };
  });
  return {
    state: 'measured' as const,
    measuredAt,
    scope: 'web signups only',
    timeZone: 'UTC',
    adsState: sync?.completed_at
      ? sync.failed_at ||
        Date.parse(measuredAt) - new Date(sync.completed_at).getTime() > 36 * 3_600_000
        ? 'stale'
        : 'measured'
      : sync?.failed_at
        ? 'unavailable'
        : 'not_connected',
    lastSyncedAt: sync?.completed_at ?? null,
    rows,
    signups,
    coverage: {
      total: coverage.total,
      attributed: coverage.attributed,
      unattributedShare: coverage.total
        ? (coverage.total - coverage.attributed) / coverage.total
        : null,
    },
  };
}
