import type { SqlDatabase } from './database.js';

type ScreenRow = {
  level: string; entityId: string; name: string; campaignId?: string; adGroupId?: string;
  spendMicros: number; impressions: number; linkClicks: number;
};
type ScreenReport = { day: string; currency: string; rows: ScreenRow[] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));

export function parseScreenReport(input: unknown, now = new Date()): ScreenReport | undefined {
  if (!object(input) || !keys(input, ['day', 'currency', 'rows']) ||
      typeof input.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.day) ||
      !Number.isFinite(Date.parse(input.day)) || new Date(input.day).toISOString().slice(0, 10) !== input.day ||
      input.day < '0001-01-01' || input.day > now.toISOString().slice(0, 10) ||
      typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency) ||
      !Array.isArray(input.rows) || input.rows.length > 500) return;
  const rows: ScreenRow[] = [];
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (!object(row) || !keys(row, ['level', 'entityId', 'name', 'campaignId', 'adGroupId', 'spend', 'spendMicros', 'impressions', 'linkClicks']) ||
        !['campaign', 'ad_group', 'ad'].includes(row.level as string) ||
        !text(row.entityId, 200) || !text(row.name, 500) ||
        (row.campaignId !== undefined && !text(row.campaignId, 200)) ||
        (row.adGroupId !== undefined && !text(row.adGroupId, 200)) ||
        !integer(row.impressions) || !integer(row.linkClicks) ||
        (('spend' in row) === ('spendMicros' in row))) return;
    let spendMicros = row.spendMicros;
    if ('spend' in row) {
      if (typeof row.spend !== 'number' || !Number.isFinite(row.spend) || row.spend < 0) return;
      const scaled = row.spend * 1_000_000;
      spendMicros = Math.round(scaled);
      if (Math.abs(scaled - (spendMicros as number)) > 0.000001) return;
    }
    if (!integer(spendMicros)) return;
    const key = JSON.stringify([row.level, row.entityId]);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ level: row.level as string, entityId: row.entityId, name: row.name,
      campaignId: row.campaignId as string | undefined, adGroupId: row.adGroupId as string | undefined,
      spendMicros, impressions: row.impressions, linkClicks: row.linkClicks });
  }
  return { day: input.day, currency: input.currency, rows };
}

export async function ingestScreenReport(database: SqlDatabase, report: ScreenReport) {
  return database.transaction(async db => {
    // Serialize daily snapshot replacements, including the first ingest.
    await db.query(`INSERT INTO x_ad_sync(id) VALUES('daily') ON CONFLICT DO NOTHING`);
    await db.query(`SELECT id FROM x_ad_sync WHERE id='daily' FOR UPDATE`);
    await db.query(`DELETE FROM x_ad_daily WHERE day=$1 AND source='screen'`, [report.day]);
    let written = 0;
    for (const row of report.rows) {
      const result = await db.query(
        `INSERT INTO x_ad_daily(day,level,entity_id,name,campaign_id,ad_group_id,currency,spend_micros,impressions,link_clicks,source)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'screen')
         ON CONFLICT(day,level,entity_id) DO UPDATE SET name=EXCLUDED.name,campaign_id=EXCLUDED.campaign_id,
         ad_group_id=EXCLUDED.ad_group_id,currency=EXCLUDED.currency,spend_micros=EXCLUDED.spend_micros,
         impressions=EXCLUDED.impressions,link_clicks=EXCLUDED.link_clicks WHERE x_ad_daily.source='screen'
         RETURNING entity_id`,
        [report.day,row.level,row.entityId,row.name,row.campaignId ?? null,row.adGroupId ?? null,
          report.currency,row.spendMicros,row.impressions,row.linkClicks]);
      written += result.rows.length;
    }
    await db.query(`UPDATE x_ad_sync SET completed_at=now(),failed_at=NULL WHERE id='daily'`);
    return { written, skipped: report.rows.length - written };
  });
}
