import { createHmac, randomBytes } from 'node:crypto';
import type { SqlDatabase } from './database.js';

type Entity = {
  id: string;
  name?: string;
  campaign_id?: string;
  line_item_id?: string;
  tweet_id?: string;
};
type Metrics = {
  data: {
    id: string;
    id_data: { segment: unknown; metrics: Record<string, (number | null)[] | null> }[];
  }[];
};
export type XAdsGet = <T>(path: string, query?: Record<string, string>) => Promise<T>;
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** OAuth 1.0 user context, kept on the server; no provider secret in dashboard DTOs. */
export function xAdsGet(
  env: NodeJS.ProcessEnv = process.env,
  send: typeof fetch = fetch,
): XAdsGet | undefined {
  const {
    BEELINE_X_CONSUMER_KEY: key,
    BEELINE_X_CONSUMER_SECRET: secret,
    BEELINE_X_ACCESS_TOKEN: token,
    BEELINE_X_ACCESS_SECRET: tokenSecret,
  } = env;
  if (!key || !secret || !token || !tokenSecret) return;
  return async <T>(path: string, query: Record<string, string> = {}) => {
    const url = new URL(`https://ads-api.x.com/12/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const oauth: Record<string, string> = {
      oauth_consumer_key: key,
      oauth_token: token,
      oauth_nonce: randomBytes(16).toString('hex'),
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_version: '1.0',
    };
    const params = [...url.searchParams.entries(), ...Object.entries(oauth)]
      .map(([k, v]) => [encode(k), encode(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
      .map((p) => p.join('='))
      .join('&');
    const base = `GET&${encode(url.origin + url.pathname)}&${encode(params)}`;
    oauth.oauth_signature = createHmac('sha1', `${encode(secret)}&${encode(tokenSecret)}`)
      .update(base)
      .digest('base64');
    const authorization =
      'OAuth ' +
      Object.entries(oauth)
        .map(([k, v]) => `${encode(k)}="${encode(v)}"`)
        .join(', ');
    const response = await send(url, {
      headers: { authorization },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`X ad report HTTP ${response.status}`);
    return (await response.json()) as T;
  };
}

async function entities(get: XAdsGet, path: string): Promise<Entity[]> {
  const result: Entity[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await get<{ data: Entity[]; next_cursor?: string }>(path, {
      count: '200',
      with_deleted: 'true',
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(response.data)) throw new Error('Invalid X entity response');
    result.push(...response.data);
    cursor = response.next_cursor;
    if (!cursor || cursor === '0') return result;
  }
  throw new Error('X inventory exceeds bounded sync');
}

export async function syncXAdReports(
  database: SqlDatabase,
  get = xAdsGet(),
  account = process.env.BEELINE_X_AD_ACCOUNT_ID,
  now = new Date(),
): Promise<void> {
  if (!get || !account || !/^[a-z0-9]+$/.test(account)) return;
  const claimed = await database.query(
    `INSERT INTO x_ad_sync(id,next_attempt_at) VALUES('daily',$1::timestamptz+interval '1 hour')
    ON CONFLICT(id) DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at
    WHERE x_ad_sync.next_attempt_at<=$1 RETURNING id`,
    [now],
  );
  if (!claimed.rowCount) return;
  try {
    const provider = get;
    const deadline = Date.now() + 5 * 60_000;
    const read: XAdsGet = async <T>(path: string, query?: Record<string, string>) => {
      if (Date.now() >= deadline) throw new Error('X reporting sync exceeded its time budget');
      return provider<T>(path, query);
    };
    const info = await read<{ data: { currency: string } }>(`accounts/${account}`);
    const currency = info.data.currency;
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid X account currency');
    const campaigns = await entities(read, `accounts/${account}/campaigns`);
    const groups = await entities(read, `accounts/${account}/line_items`);
    const ads = await entities(read, `accounts/${account}/promoted_tweets`);
    const through = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    const start = new Date(through.getTime() - 7 * 86_400_000);
    const rows: {
      day: string;
      level: string;
      id: string;
      name: string;
      campaign: string | null;
      group: string | null;
      spend: number;
      impressions: number;
      clicks: number;
    }[] = [];
    const levels = [
      ['campaign', 'CAMPAIGN', campaigns],
      ['ad_group', 'LINE_ITEM', groups],
      ['ad', 'PROMOTED_TWEET', ads],
    ] as const;
    for (const [level, entity, inventory] of levels) {
      for (let offset = 0; offset < inventory.length; offset += 20) {
        const batch = inventory.slice(offset, offset + 20);
        const totals = new Map<string, (typeof rows)[number]>();
        // HOUR avoids account-midnight/DST alignment; aggregate explicitly to UTC days.
        for (const placement of ['ALL_ON_TWITTER', 'SPOTLIGHT', 'TREND']) {
          const stats = await read<Metrics>(`stats/accounts/${account}`, {
            entity,
            entity_ids: batch.map((e) => e.id).join(','),
            start_time: start.toISOString(),
            end_time: through.toISOString(),
            granularity: 'HOUR',
            placement,
            metric_groups: 'BILLING,ENGAGEMENT',
          });
          if (!Array.isArray(stats.data)) throw new Error('Invalid X metrics response');
          for (const e of batch) {
            const data = stats.data.find((s) => s.id === e.id);
            if (!data || data.id_data.length !== 1 || data.id_data[0]!.segment !== null)
              throw new Error('Incomplete X metrics response');
            const m = data.id_data[0]!.metrics;
            const metric = (key: string, i: number) => {
              const values = m[key];
              if (values === undefined || (values !== null && values.length !== 168))
                throw new Error('Incomplete X metric series');
              const value = values?.[i] ?? 0;
              if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid X metric');
              return value;
            };
            for (let i = 0; i < 168; i++) {
              const day = new Date(start.getTime() + i * 3_600_000).toISOString().slice(0, 10),
                key = `${e.id}:${day}`;
              const group =
                level === 'ad' ? groups.find((g) => g.id === e.line_item_id) : undefined;
              const row = totals.get(key) ?? {
                day,
                level,
                id: e.id,
                name: e.name ?? e.tweet_id ?? e.id,
                campaign:
                  level === 'campaign' ? e.id : (e.campaign_id ?? group?.campaign_id ?? null),
                group: level === 'ad_group' ? e.id : (e.line_item_id ?? null),
                spend: 0,
                impressions: 0,
                clicks: 0,
              };
              row.spend += metric('billed_charge_local_micro', i);
              row.impressions += metric('impressions', i);
              row.clicks += metric('url_clicks', i);
              totals.set(key, row);
            }
          }
        }
        rows.push(...totals.values());
      }
    }
    await database.transaction(async (db) => {
      await db.query(`DELETE FROM x_ad_daily WHERE day>=$1 AND day<$2`, [start, through]);
      for (const r of rows)
        await db.query(
          `INSERT INTO x_ad_daily(day,level,entity_id,name,campaign_id,ad_group_id,currency,spend_micros,impressions,link_clicks)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            r.day,
            r.level,
            r.id,
            r.name,
            r.campaign,
            r.group,
            currency,
            r.spend,
            r.impressions,
            r.clicks,
          ],
        );
      await db.query(
        `UPDATE x_ad_sync SET completed_at=$1,failed_at=NULL,next_attempt_at=$1::timestamptz+interval '1 day' WHERE id='daily'`,
        [now],
      );
    });
  } catch (error) {
    // Retry once per hour; never log upstream bodies or auth material.
    await database.query(`UPDATE x_ad_sync SET failed_at=$1 WHERE id='daily'`, [now]);
    throw error;
  }
}
